from contextlib import nullcontext

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.api.live_routes import CLOSE_NOT_FOUND, CLOSE_UNAUTHENTICATED, db_scope
from app.db import get_db
from app.main import app


@pytest.fixture
def client(db):
    """A TestClient in context-manager mode — and that is mandatory here.

    Without `with`, TestClient creates an event loop of its own per request, and the
    socket ends up in one loop while the mutation route's background task is in
    another. The broadcast then puts a message into another loop's queue from another
    thread and does not wake it: the test hangs for no reason.

    `db_scope` is substituted with the same session as `get_db`: the socket closes its
    own session, and a closed fixture session would roll back the test's transaction
    together with everything the test had created.
    """

    def _override_get_db():
        yield db

    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[db_scope] = lambda: (lambda: nullcontext(db))
    try:
        with TestClient(app) as instance:
            yield instance
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(db_scope, None)


@pytest.fixture
def authed(client):
    client.post(
        "/api/auth/register",
        json={
            "name": "Alex",
            "email": "alex@example.com",
            "password": "s3cret-pass",
            "company_name": "Acme",
        },
    )
    return client


@pytest.fixture
def project_id(authed):
    return authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]


def make_category(client, project_id, name="Design"):
    return client.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "create_category", "name": name, "color": "#3b82f6"}},
    ).json()["op"]["category_id"]


def refusal_code(client, project_id) -> int:
    """The code the server closed the socket with.

    The refusal comes after acceptance — only that way does the browser learn a code
    rather than seeing the same "the handshake did not happen" in every case.
    """
    with client.websocket_connect(f"/api/projects/{project_id}/live") as socket:
        with pytest.raises(WebSocketDisconnect) as refusal:
            socket.receive_json()
    return refusal.value.code


def test_a_mutation_reaches_a_connected_client(authed, project_id):
    with authed.websocket_connect(f"/api/projects/{project_id}/live") as socket:
        make_category(authed, project_id, "Design")

        event = socket.receive_json()
        assert event["type"] == "revision"
        assert event["seq"] == 1
        assert event["op"]["type"] == "create_category"
        assert event["op"]["name"] == "Design"
        assert event["actor"]["name"] == "Alex"


def test_every_listener_of_the_project_gets_the_revision(authed, project_id):
    """Two connections are not enough for "a broadcast" if only one of them is checked."""
    with (
        authed.websocket_connect(f"/api/projects/{project_id}/live") as first,
        authed.websocket_connect(f"/api/projects/{project_id}/live") as second,
    ):
        make_category(authed, project_id)

        assert first.receive_json()["op"]["type"] == "create_category"
        assert second.receive_json()["op"]["type"] == "create_category"


def test_a_change_in_another_project_does_not_reach_this_socket(authed, project_id):
    other = authed.post("/api/projects", json={"name": "Другой"}).json()["id"]

    with authed.websocket_connect(f"/api/projects/{other}/live") as socket:
        make_category(authed, project_id, "Чужая")
        # A message about one's own project arrives next: without it the test would not
        # tell "did not send someone else's" from "did not send anything at all".
        make_category(authed, other, "Своя")

        event = socket.receive_json()
        assert event["op"]["name"] == "Своя"


def test_the_event_carries_the_reason_as_written(authed, project_id):
    category_id = make_category(authed, project_id)
    task_id = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {
                "type": "create_task",
                "category_id": category_id,
                "name": "Logo",
                "start_date": "2026-03-06",
                "duration_days": 3,
            }
        },
    ).json()["op"]["task_id"]

    with authed.websocket_connect(f"/api/projects/{project_id}/live") as socket:
        authed.post(
            f"/api/projects/{project_id}/mutations",
            json={
                "op": {"type": "move_task", "task_id": task_id, "start_date": "2026-03-13"},
                "reason": "заказчик не прислал брендбук",
            },
        )

        event = socket.receive_json()
        assert event["reason"] == "заказчик не прислал брендбук"
        assert event["op"]["type"] == "move_task"


def test_the_socket_reminds_of_itself_while_the_project_is_quiet(authed, project_id, monkeypatch):
    """A silent socket and a broken socket must be distinguishable.

    Without this reminder a client cannot tell "nothing is happening in the project"
    from "there has been no connection for a while": in half of all drops (a laptop gone
    to sleep, a changed network) no connection close happens at all.
    """
    import app.api.live_routes as live_routes

    monkeypatch.setattr(live_routes, "HEARTBEAT_SECONDS", 0.05)

    with authed.websocket_connect(f"/api/projects/{project_id}/live") as socket:
        assert socket.receive_json() == {"type": "heartbeat"}


def test_the_socket_does_not_take_orders(authed, project_id):
    """A listening socket is listening only.

    The only road to a change is a mutation POST, where the permission is checked. What
    is sent into the socket must be discarded rather than parsed and applied.
    """
    with authed.websocket_connect(f"/api/projects/{project_id}/live") as socket:
        socket.send_json({"type": "create_category", "name": "Взлом", "color": "#000000"})
        make_category(authed, project_id, "Настоящая")

        event = socket.receive_json()
        assert event["op"]["name"] == "Настоящая"

    assert authed.get(f"/api/projects/{project_id}").json()["categories"] == [
        {
            "id": event["op"]["category_id"],
            "name": "Настоящая",
            "color": "#3b82f6",
            "position": 0,
        }
    ]


def test_the_revision_is_committed_before_it_is_broadcast(authed, project_id, db, monkeypatch):
    """The order "into the database first, on the air second" is not an implementation detail.

    On a signal the client re-requests the whole project. Arriving before the commit it
    would not see the change, and there will be no second signal — the screen would stay
    stale until the next edit by someone else.

    It is the order of the calls that is checked: the broadcast at that moment puts a
    dict into memory, and "would they have seen it" is not observable from a test.
    """
    from app.live import hub

    order: list[str] = []
    real_commit = db.commit

    def recording_commit():
        order.append("commit")
        real_commit()

    async def recording_publish(project_id, message):
        order.append("publish")

    monkeypatch.setattr(db, "commit", recording_commit)
    monkeypatch.setattr(hub, "publish", recording_publish)

    make_category(authed, project_id)

    assert order == ["commit", "publish"]


def test_an_unauthenticated_socket_is_closed(client, db):
    from app.models import Organization, Project

    org = Organization(name="Globex", slug="globex")
    db.add(org)
    db.flush()
    project = Project(org_id=org.id, name="Secret", slug="secret")
    db.add(project)
    db.flush()

    assert refusal_code(client, project.id) == CLOSE_UNAUTHENTICATED


def test_a_project_of_another_organization_is_closed_as_missing(authed, db):
    """Someone else's project is indistinguishable from a nonexistent one here too, not only over HTTP."""
    from app.models import Organization, Project

    org = Organization(name="Globex", slug="globex")
    db.add(org)
    db.flush()
    project = Project(org_id=org.id, name="Secret", slug="secret")
    db.add(project)
    db.flush()

    assert refusal_code(authed, project.id) == CLOSE_NOT_FOUND

    missing = "00000000-0000-0000-0000-000000000000"
    assert refusal_code(authed, missing) == CLOSE_NOT_FOUND


def test_a_role_without_read_permission_is_closed_as_missing(authed, project_id, monkeypatch):
    """A role with no right to read a project must not learn that it exists.

    Today such a role cannot be reproduced through the socket: `client` and a guest read
    a project only under an issued grant, and there are no grants yet (plan 5). So the
    decision itself is substituted — the route's code is what is checked rather than the
    future grant infrastructure. The same technique as in test_project_api.
    """
    import app.api.live_routes as live_routes

    monkeypatch.setattr(live_routes, "can", lambda *args, **kwargs: False)

    assert refusal_code(authed, project_id) == CLOSE_NOT_FOUND


def test_the_internal_note_is_stripped_for_a_role_that_may_not_read_it(authed, project_id, monkeypatch):
    """A note must not ride out into the socket to someone who is not shown it over HTTP.

    The permission is substituted for the same reason as in the test above.
    """
    import app.access as access

    category_id = make_category(authed, project_id)
    real_can = access.can

    def fake_can(role, action, *, project_granted=False):
        if action is access.Action.READ_INTERNAL_NOTE:
            return False
        return real_can(role, action, project_granted=project_granted)

    with authed.websocket_connect(f"/api/projects/{project_id}/live") as socket:
        monkeypatch.setattr(access, "can", fake_can)
        authed.post(
            f"/api/projects/{project_id}/mutations",
            json={
                "op": {
                    "type": "create_task",
                    "category_id": category_id,
                    "name": "Logo",
                    "start_date": "2026-03-06",
                    "duration_days": 3,
                    "internal_note": "тайный план",
                }
            },
        )

        event = socket.receive_json()
        assert event["op"]["type"] == "create_task"
        assert "internal_note" not in event["op"]


# --- wave 2.10: Origin on the handshake ---------------------------------------


def test_a_socket_from_a_foreign_origin_is_refused(authed, project_id):
    """The cookie rides out with a handshake from any site (SameSite=Lax counts it as
    navigation), and without an Origin check a foreign page would read the live feed on
    behalf of a signed-in visitor."""
    with authed.websocket_connect(
        f"/api/projects/{project_id}/live", headers={"origin": "https://evil.example"}
    ) as socket:
        with pytest.raises(WebSocketDisconnect) as refusal:
            socket.receive_json()
    assert refusal.value.code == CLOSE_UNAUTHENTICATED


def test_a_socket_from_our_own_origin_connects(authed, project_id):
    with authed.websocket_connect(
        f"/api/projects/{project_id}/live", headers={"origin": "http://testserver"}
    ):
        pass  # the handshake happened — that is enough
