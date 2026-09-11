import asyncio
import time
import uuid
from collections.abc import Callable
from contextlib import AbstractContextManager
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, WebSocket
from sqlalchemy.orm import Session as DbSession
from starlette.websockets import WebSocketDisconnect

from app.access import Action, can, parse_role, visible_op
from app.api.deps import project_granted as has_project_grant
from app.auth import SESSION_COOKIE, session_for_token
from app.config import get_settings
from app.db import SessionLocal
from app.live import Subscriber, hub
from app.models import Project, Role
from app.orgs import active_membership

router = APIRouter(tags=["live"])

# Close codes from the range reserved for applications (4000-4999). The standard
# 1008 "policy violation" is the same for "did not identify themselves" and for
# "no such project", while to a client those differ: on the first, reconnecting is
# pointless, on the second even more so, whereas on a dropped connection it is
# essential.
CLOSE_UNAUTHENTICATED = 4401
CLOSE_NOT_FOUND = 4404
CLOSE_LAGGING = 4409

# How often to remind of oneself when nothing is happening in the project. It is
# needed not by the server but by the client: half of all drops are not a closed
# connection but a silenced one (a laptop gone to sleep, a changed network), and
# telling that apart from silence in the project is only possible by the absence
# of an expected message.
HEARTBEAT_SECONDS = 25

HEARTBEAT = {"type": "heartbeat"}

# How often to re-check that the subscriber may still read the project. A socket
# lives for hours, and a permission gets revoked in that time: a person is removed
# from the organization, a session is closed by "sign out on all devices".
# Checking on every message means a trip to the database for every revision for
# every reader; once a minute means at most a minute of life for revoked access.
RECHECK_SECONDS = 60.0


def _origin_allowed(websocket: WebSocket) -> bool:
    """Whether the handshake came from our own page.

    The cookie rides out with a WebSocket handshake from any site: SameSite=Lax
    counts it as top-level navigation. Without an Origin check, a foreign page
    opens a socket on behalf of a signed-in visitor and reads the live feed of
    their project. The browser does not let Origin be forged; a request with no
    Origin is not a browser and CSRF does not threaten it (the cookie is not
    attached by itself), so a missing header means pass.
    """
    origin = websocket.headers.get("origin")
    if origin is None:
        return True
    source = urlsplit(origin).hostname
    if source is None:
        return False
    allowed = {
        urlsplit(f"//{websocket.headers.get('host', '')}").hostname,
        urlsplit(f"//{websocket.headers.get('x-forwarded-host', '')}").hostname,
        urlsplit(get_settings().public_base_url).hostname,
    }
    allowed.discard(None)
    return source.lower() in allowed


def db_scope() -> Callable[[], AbstractContextManager[DbSession]]:
    """A factory for a short-lived database session.

    Not `Depends(get_db)` as in ordinary routes, and that is no trifle: that
    session lives as long as the handler, and a socket handler lives exactly as
    long as the tab is open. Pool connections held by every open project would run
    out at a dozen and a half readers — and not because of load but because they
    are simply watching.

    A separate dependency rather than a direct SessionLocal call, so that a test
    has something to substitute.
    """
    return SessionLocal


def _for_role(message: dict, role: Role | str | None, granted: bool) -> dict:
    """A message in the form this subscriber is entitled to see it.

    It is filtered on the way out to a specific socket rather than on the way into
    the room: an editor and a client sit in one room, and an internal note must
    reach the first and must not reach the second.
    """
    if message.get("type") != "revision":
        return message
    return {**message, "op": visible_op(message["op"], role, project_granted=granted)}


async def _refuse(websocket: WebSocket, code: int) -> None:
    """Refuse in a way that lets the client learn the reason.

    accept() before close() is not ceremony. A socket closed before acceptance is
    a handshake that never happened, and the browser gets code 1006, the same for
    "not letting you in" and for "the network dropped": the client is doomed to
    reconnect to a place it will never be let into. By accepting and immediately
    closing, the server conveys its code. Nothing is ever sent in the process — the
    one refused learns exactly what the same request over HTTP would have told them.
    """
    await websocket.accept()
    await websocket.close(code=code)


async def _drain(websocket: WebSocket) -> None:
    """Reads and discards everything the client says.

    Over this socket the client says nothing: the only way to change a project is a
    mutation POST, where the permission is checked. But reading is still necessary
    — notification of a disconnect arrives by the same road as data, and a handler
    that only writes learns of a closed tab only when it wants to send something
    itself.
    """
    while True:
        message = await websocket.receive()
        if message["type"] == "websocket.disconnect":
            return


async def _pump(
    websocket: WebSocket,
    subscriber: Subscriber,
    role: Role | str | None,
    granted: bool,
    still_allowed: Callable[[], bool] | None = None,
) -> None:
    reader = asyncio.create_task(_drain(websocket))
    last_recheck = time.monotonic()
    try:
        while True:
            incoming = asyncio.create_task(subscriber.next())
            done, _ = await asyncio.wait(
                {reader, incoming},
                timeout=HEARTBEAT_SECONDS,
                return_when=asyncio.FIRST_COMPLETED,
            )

            if reader in done:
                # The client has left. Cancelling the queue wait is safe: a
                # message, if it has already been placed, stays in the queue, and
                # the queue goes away together with the subscription.
                incoming.cancel()
                return

            # Re-authorization: both before a broadcast and while idle — a socket
            # that may no longer be open is closed no later than RECHECK_SECONDS
            # after the permission is revoked rather than "some time on a reload".
            if still_allowed is not None and time.monotonic() - last_recheck >= RECHECK_SECONDS:
                last_recheck = time.monotonic()
                if not still_allowed():
                    incoming.cancel()
                    await websocket.close(code=CLOSE_UNAUTHENTICATED)
                    return

            if incoming not in done:
                incoming.cancel()
                await websocket.send_json(HEARTBEAT)
                continue

            if subscriber.lagging:
                # A fragment of the feed must not be sent on to someone who has
                # fallen behind: they would apply part of the changes and consider
                # themselves up to date. We close — the client will reconnect and
                # re-read the whole project (§12).
                await websocket.close(code=CLOSE_LAGGING)
                return

            await websocket.send_json(_for_role(incoming.result(), role, granted))
    except WebSocketDisconnect:
        return
    finally:
        reader.cancel()


@router.websocket("/api/projects/{project_id}/live")
async def project_live(
    websocket: WebSocket,
    project_id: uuid.UUID,
    session_scope: Callable[[], AbstractContextManager[DbSession]] = Depends(db_scope),
):
    """The project's live feed: revisions as they appear.

    Permissions are checked once, at connection time. A role that changed during
    the socket's lifetime will catch up with a person on the next page reload:
    making that a reason to re-check the membership on every revision would mean a
    trip to the database for every message for every reader.
    """
    # Origin comes before everything else: a foreign page has no business even
    # learning whether the visitor has a session.
    if not _origin_allowed(websocket):
        await _refuse(websocket, CLOSE_UNAUTHENTICATED)
        return

    token = websocket.cookies.get(SESSION_COOKIE)
    with session_scope() as db:
        session = session_for_token(db, token)
        if session is None:
            await _refuse(websocket, CLOSE_UNAUTHENTICATED)
            return

        # The organization is the same as over HTTP: the one chosen by the
        # switcher, not whichever came first. Otherwise a person who switched to
        # their second organization would be listening to a project in the first.
        membership = active_membership(db, session)
        project = None if membership is None else db.get(Project, project_id)
        if project is not None and project.org_id != membership.org_id:
            project = None
        role = None if membership is None else parse_role(membership.role)
        scoped = membership is not None and membership.project_scoped
        granted = project is not None and has_project_grant(db, project.id, session.user_id)
        # A read refusal is the same close as "no such project", by the same
        # principle as a 404 instead of a 403 in the HTTP routes: whoever is not
        # shown a project must not learn that it exists. A role invited into
        # projects individually (or whose membership is narrowed) does not get here
        # without a granted access.
        if project is None or not can(role, Action.PROJECT_READ, project_granted=granted, scoped=scoped):
            await _refuse(websocket, CLOSE_NOT_FOUND)
            return

    def still_allowed() -> bool:
        """The right to read the project, re-checked — for re-authorization.

        A short database session per check, by the same technique as at connection
        time: holding a pool connection under a socket that lives for hours is not
        an option, while opening and closing one once a minute costs nothing.
        """
        with session_scope() as db:
            fresh = session_for_token(db, token)
            if fresh is None:
                return False
            membership = active_membership(db, fresh)
            if membership is None:
                return False
            current = db.get(Project, project_id)
            if current is None or current.org_id != membership.org_id:
                return False
            return can(
                parse_role(membership.role),
                Action.PROJECT_READ,
                project_granted=has_project_grant(db, project_id, fresh.user_id),
                scoped=membership.project_scoped,
            )

    # The session is closed before accept(): from then on the handler only waits,
    # and there is no reason to hold a database connection behind that wait.
    await websocket.accept()
    with hub.subscribe(project_id) as subscriber:
        await _pump(websocket, subscriber, role, granted, still_allowed)
