"""Invitations into an organization: issuing, revoking, reissuing and accepting.

The module knows nothing about HTTP: it raises `InvitationError` with a machine
code, and turning a code into a response status is the route's business.
Mutations are arranged in exactly the same way, and for the same reason: the same
thing will be needed by accepting an invitation at registration, where the HTTP
layer is different.
"""

import uuid
from datetime import datetime, timedelta
from enum import StrEnum

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.models import Invitation, Membership, Project, ProjectAccess, Role, User
from app.security import hash_token, new_token
from app.text import normalize_email

# The window of the invitation ceiling. The hour is hard-coded rather than
# configurable: the setting names the ceiling itself (`INVITE_RATE_LIMIT`), and a
# second number next to it turns a clear "so many per hour" into a multiplication
# problem.
RATE_LIMIT_WINDOW = timedelta(hours=1)


class InvitationError(Exception):
    """A refusal from the invitation domain, named by a machine code.

    There is deliberately no human-language text here: the reader's language is
    decided in the browser, and one and the same refusal must read in three
    languages.
    """

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class Status(StrEnum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    REVOKED = "revoked"
    EXPIRED = "expired"


def status_of(invitation: Invitation, now: datetime) -> Status:
    """An invitation's state at a given moment.

    The order of the checks is not accidental: an accepted invitation stays
    accepted after it expires too, and a person opening their own old link must
    read "you are already in the organization" rather than "it has expired" — on
    the latter they would go and ask for a new link instead of simply signing in.
    """
    if invitation.accepted_at is not None:
        return Status.ACCEPTED
    if invitation.revoked_at is not None:
        return Status.REVOKED
    if invitation.expires_at <= now:
        return Status.EXPIRED
    return Status.PENDING


def _unavailable(state: Status) -> InvitationError:
    """A refusal that names the reason rather than "the link is invalid".

    Three states, three different codes: on "expired" a person asks for a new
    link, on "accepted" they simply sign in, on "revoked" they go to whoever
    invited them. One generic message lets them choose none of the three actions.
    """
    return InvitationError(f"invite_{state.value}")


#: The roles an invitation does not hand out. An owner governs the whole
#: organization — deletes projects, re-approves plans, invites anyone — and an
#: invitation with no address additionally goes to whoever presents it: the owner
#: would become anyone who opened a forwarded link. An owner is appointed by an
#: owner, over an existing member and as a separate action — the very
#: `PATCH /api/org/members/{user_id}`, where the recipient is named individually.
NOT_INVITABLE: frozenset[Role] = frozenset({Role.OWNER})


def _parse_role(raw: str) -> Role:
    try:
        role = Role(raw)
    except ValueError as error:
        raise InvitationError("unknown_role") from error
    if role in NOT_INVITABLE:
        raise InvitationError("role_not_invitable")
    return role


def _checked_project_ids(
    db: DbSession, *, org_id: uuid.UUID, project_ids: list[uuid.UUID]
) -> list[str]:
    """The projects an invitation grants access to right away.

    Available to any invitable role, not only `client`: the selected projects
    narrow the membership as a whole (see Membership.project_scoped in app.models)
    — that is, they make it possible to invite an editor or a viewer into
    particular projects rather than into the whole organization at once. An empty
    list narrows nothing: the role keeps its own behaviour — a `client` still sees
    no project until invited individually, while an `editor`/`viewer` see the whole
    organization, just as without this capability.
    """
    if not project_ids:
        return []

    found = set(
        db.scalars(
            select(Project.id).where(Project.org_id == org_id, Project.id.in_(project_ids))
        ).all()
    )
    if len(found) != len(set(project_ids)):
        # Someone else's project is indistinguishable from a nonexistent one — by
        # the same principle as in the project routes.
        raise InvitationError("project_not_found")
    return [str(project_id) for project_id in project_ids]


def issued_within_window(db: DbSession, *, org_id: uuid.UUID, now: datetime) -> int:
    """How many invitations the organization has issued in the last hour.

    Two events are counted, each of which may send a message: creating a row and
    sending a message for an existing one. Issuing a link to copy does not count
    towards the ceiling — no message goes out with it, and the ceiling stands
    precisely against the installation turning into a free mailer from someone
    else's domain.
    """
    since = now - RATE_LIMIT_WINDOW
    return db.scalar(
        select(func.count())
        .select_from(Invitation)
        .where(
            Invitation.org_id == org_id,
            or_(Invitation.created_at >= since, Invitation.last_sent_at >= since),
        )
    )


def ensure_capacity(db: DbSession, *, org_id: uuid.UUID, now: datetime, wanted: int) -> None:
    limit = get_settings().invite_rate_limit
    if issued_within_window(db, org_id=org_id, now=now) + wanted > limit:
        raise InvitationError("invite_rate_limited")


def _expiry(now: datetime) -> datetime:
    return now + timedelta(days=get_settings().invite_ttl_days)


def _is_member(db: DbSession, *, org_id: uuid.UUID, email: str) -> bool:
    """Whether the holder of this address is already in the organization.

    It is asked before issuing rather than after accepting: an invitation to an
    existing member changes nothing — `accept` does not touch the role — but looks
    like an action. An inviter who picked the wrong line in a list of addresses
    would see "the invitation was sent" and would start waiting for the person to
    "come in", while they have been inside since yesterday. The refusal puts that
    into words.
    """
    return (
        db.scalar(
            select(Membership.id)
            .join(User, User.id == Membership.user_id)
            .where(Membership.org_id == org_id, User.email == email)
        )
        is not None
    )


def _pending_for(
    db: DbSession, *, org_id: uuid.UUID, email: str, now: datetime
) -> Invitation | None:
    for invitation in db.scalars(
        select(Invitation).where(Invitation.org_id == org_id, Invitation.email == email)
    ).all():
        if status_of(invitation, now) is Status.PENDING:
            return invitation
    return None


def create(
    db: DbSession,
    *,
    org_id: uuid.UUID,
    inviter_id: uuid.UUID,
    role: str,
    emails: list[str],
    project_ids: list[uuid.UUID],
    now: datetime,
) -> list[tuple[Invitation, str]]:
    """Issues invitations and returns them together with the plain tokens.

    The plain token is returned only from here and nowhere else: the database
    holds a hash, and restoring the link later is impossible — it is shown once.

    An empty list of addresses is not an error but a second means of delivery: one
    invitation with no address, whose link the inviter will send however they find
    convenient. Such an invitation goes to whoever presents it, and that is a
    deliberate trade-off.
    """
    parsed_role = _parse_role(role)
    stored_projects = _checked_project_ids(db, org_id=org_id, project_ids=project_ids)

    normalized: list[str | None] = []
    for raw in emails:
        address = normalize_email(raw)
        if not address:
            raise InvitationError("invalid_email")
        # A refusal for the whole list rather than skipping one address: the list
        # is assembled by pasting from an email, and "five were invited and the
        # sixth silently was not" would surface a week later through the person's
        # absence. The check runs before the rows are created — otherwise some
        # invitations would already exist by the time of the refusal, and resending
        # the corrected list would issue them a second time.
        if _is_member(db, org_id=org_id, email=address):
            raise InvitationError("already_member")
        if address not in normalized:
            normalized.append(address)
    recipients: list[str | None] = normalized or [None]

    ensure_capacity(db, org_id=org_id, now=now, wanted=len(recipients))

    issued: list[tuple[Invitation, str]] = []
    for address in recipients:
        # A live invitation to the same address is reissued rather than duplicated:
        # two valid tokens for one address mean that "that particular email" can no
        # longer be revoked — exactly what resending kills the previous token for.
        existing = (
            None if address is None else _pending_for(db, org_id=org_id, email=address, now=now)
        )
        if existing is not None:
            existing.role = parsed_role.value
            existing.project_ids = stored_projects
            issued.append((existing, reissue(db, existing, now=now)))
            continue

        raw, hashed = new_token()
        invitation = Invitation(
            org_id=org_id,
            email=address,
            role=parsed_role.value,
            project_ids=stored_projects,
            token_hash=hashed,
            invited_by=inviter_id,
            # The moment is set explicitly rather than taken from the database: the
            # link's lifetime and the hourly ceiling are counted from it, and three
            # different notions of "now" in one row will one day diverge — first in
            # the tests, then on an installation where the application server and
            # the database server sit in different timezones.
            created_at=now,
            expires_at=_expiry(now),
        )
        db.add(invitation)
        issued.append((invitation, raw))

    db.flush()
    return issued


def reissue(db: DbSession, invitation: Invitation, *, now: datetime) -> str:
    """Issues a new link in place of the previous one and returns the plain token.

    The previous token dies at that same moment: without this, revoking an
    already sent message becomes impossible — the old link would keep working
    alongside the new one. The lifetime is counted anew: a link issued today must
    live as long as any other issued today.
    """
    state = status_of(invitation, now)
    if state in (Status.ACCEPTED, Status.REVOKED):
        raise _unavailable(state)

    raw, hashed = new_token()
    invitation.token_hash = hashed
    invitation.expires_at = _expiry(now)
    db.flush()
    return raw


def revoke(db: DbSession, invitation: Invitation, *, now: datetime) -> None:
    """Kills an unused invitation. The link stops working immediately.

    An accepted invitation is not revoked: the membership has already been
    created, and removing it is a different action on a different entity. A
    repeated revocation is not an error: it changes nothing, and requiring the
    interface to guess the button's state for the sake of a 409 means breaking it
    on any race between two tabs.
    """
    state = status_of(invitation, now)
    if state is Status.ACCEPTED:
        raise _unavailable(state)
    if state is Status.REVOKED:
        return
    invitation.revoked_at = now
    db.flush()


def by_token(db: DbSession, raw_token: str) -> Invitation | None:
    """An invitation by plain token. The database holds a hash — we look it up by that."""
    if not raw_token:
        return None
    return db.scalar(select(Invitation).where(Invitation.token_hash == hash_token(raw_token)))


def check_recipient(invitation: Invitation, email: str) -> None:
    """Whether this is the address the invitation is addressed to.

    An invitation with no address goes to whoever presents it — there is nothing
    to check. One with an address is bound to it for good: otherwise a forwarded
    link lets anyone at all into the organization, and that is exactly what an
    invitation with an address must not allow.
    """
    if invitation.email is not None and invitation.email != normalize_email(email):
        raise InvitationError("invite_wrong_email")


def accept(db: DbSession, invitation: Invitation, *, user: User, now: datetime) -> Membership:
    """Accepts an invitation: the membership, project access, the accepted mark.

    An existing membership's role is left alone. An invitation is a way of
    inviting a person, not a way of rewriting the role of someone already inside:
    otherwise an invitation written to one's own address and accepted carelessly
    would demote the organization's last owner, and there would be nobody left to
    fix it. For the same reason the narrowing (project_scoped) of an existing
    membership is left alone too: an invitation with selected projects, accepted by
    someone who already saw the whole organization, must not silently trim them
    down to that list.
    """
    state = status_of(invitation, now)
    if state is not Status.PENDING:
        raise _unavailable(state)
    check_recipient(invitation, user.email)

    membership = db.scalar(
        select(Membership).where(
            Membership.org_id == invitation.org_id, Membership.user_id == user.id
        )
    )
    if membership is None:
        membership = Membership(
            org_id=invitation.org_id,
            user_id=user.id,
            role=invitation.role,
            # The projects selected in the invitation narrow the new membership as
            # a whole, whatever the role: an empty list narrows nothing — the role
            # keeps its default behaviour (see _checked_project_ids).
            project_scoped=bool(invitation.project_ids),
        )
        db.add(membership)

    grant_project_access(db, user_id=user.id, project_ids=invitation.project_ids)

    invitation.accepted_at = now
    invitation.accepted_by = user.id
    db.flush()
    return membership


def grant_project_access(db: DbSession, *, user_id: uuid.UUID, project_ids: list) -> None:
    """Grants individual access to the projects, skipping what is already granted.

    The projects are checked against the database once more rather than taken from
    the invitation on trust: days pass between issuing a link and accepting it, and
    a project may have been deleted in that time. A reference to a vanished project
    is no reason to refuse a person entry into the organization.
    """
    wanted = {uuid.UUID(str(project_id)) for project_id in project_ids}
    if not wanted:
        return

    alive = set(db.scalars(select(Project.id).where(Project.id.in_(wanted))).all())
    already = set(
        db.scalars(
            select(ProjectAccess.project_id).where(
                ProjectAccess.user_id == user_id, ProjectAccess.project_id.in_(alive)
            )
        ).all()
    )
    for project_id in sorted(alive - already, key=str):
        db.add(ProjectAccess(project_id=project_id, user_id=user_id))
    db.flush()
