import uuid
from datetime import datetime, timedelta, timezone

from fastapi import Cookie, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.db import get_db
from app.invitations import accept as accept_invitation
from app.models import Invitation, Membership, Organization, Role, Session, User
from app.security import hash_password, hash_token, new_token, verify_password
from app.slugs import insert_with_unique_slug
from app.text import normalize_email

SESSION_COOKIE = "planora_session"
SESSION_TTL = timedelta(days=30)

# A session that goes unused dies before its expiry date: a stolen cookie from an
# abandoned device must not live for a month merely because it was issued once.
# Idleness is counted from the last request.
SESSION_IDLE_TTL = timedelta(days=7)

# The "used" mark is written no more often than this step: otherwise every read
# of a project is also an UPDATE on the sessions table. For a timeout measured in
# days, quarter-hour precision is more than enough.
_LAST_USED_WRITE_STEP = timedelta(minutes=15)

# Computed once at module import rather than per request: it is used in the
# authenticate() branch where the user is not found, so that this branch costs
# the same in time as the branch with a wrong password for an existing user.
# Without it, the difference in /api/auth/login response time reveals by
# enumeration which addresses are registered.
_DUMMY_PASSWORD_HASH = hash_password("timing-safety-dummy-password")


def _org_slug_taken(db: DbSession, slug: str) -> bool:
    return db.scalar(select(Organization.id).where(Organization.slug == slug)) is not None


def register(
    db: DbSession,
    *,
    name: str,
    email: str,
    password: str,
    locale: str | None = None,
    company_name: str | None = None,
    invitation: Invitation | None = None,
) -> User:
    """Creates an account. With an invitation in hand — straight into the
    inviting organization; without one — with an organization of their own.

    Someone arriving by link does not get an organization of their own. It would
    be a dummy with them alone inside, and in a closed installation
    (`SIGNUP_MODE=invite_only`) it would additionally make every invitee an owner
    — of their own organization, granted, but with the right to invite anyone
    into it, that is, around the closure. The rule "registration creates your own
    organization" describes free entry off the street; entry by invitation is a
    different door.

    `company_name` names this new organization. The HTTP route always requires it
    when an organization is genuinely created (see auth_routes.py,
    company_name_required), while here the parameter stays optional: this function
    is also used by callers below the route — tests, for instance, which do not
    care about the organization's name — and without a company they still get an
    organization named after the person themselves.
    """
    normalized = normalize_email(email)
    if db.scalar(select(User).where(User.email == normalized)) is not None:
        raise ValueError("that address is already taken")

    settings = get_settings()
    user = User(
        email=normalized,
        password_hash=hash_password(password),
        name=name.strip(),
        # The language on first appearance comes from the browser's header, if it
        # asks for one of the supported ones. After that only a person changes
        # this value: the header is never consulted again, otherwise changing the
        # language in the browser would silently overwrite a deliberate choice.
        locale=locale or settings.default_locale,
    )
    try:
        # SAVEPOINT: if a concurrent request managed to insert the same address
        # between the check above and this flush(), only this insert is rolled
        # back — not the session's whole transaction.
        with db.begin_nested():
            db.add(user)
            db.flush()
    except IntegrityError as exc:
        raise ValueError("that address is already taken") from exc

    if invitation is not None:
        accept_invitation(db, invitation, user=user, now=datetime.now(timezone.utc))
        return user

    org_name = (company_name or name).strip()
    # The organization's language is its founder's language rather than the
    # model's default value. The organization's messages go out in this language,
    # and invitations above all: their language was taken from
    # `organizations.default_locale`, where registration put nothing — and a
    # Russian-speaking owner sent the team invitations in Azerbaijani with no way
    # to notice it from the interface. The person's language is already known at
    # that moment and sits in their profile.
    org = insert_with_unique_slug(
        db,
        lambda slug: Organization(name=org_name, slug=slug, default_locale=user.locale),
        name=org_name,
        is_taken=lambda slug: _org_slug_taken(db, slug),
        fallback="org",
    )

    db.add(Membership(org_id=org.id, user_id=user.id, role=Role.OWNER))
    db.flush()
    return user


def authenticate(db: DbSession, *, email: str, password: str) -> User | None:
    user = db.scalar(select(User).where(User.email == normalize_email(email)))
    if user is None:
        verify_password(password, _DUMMY_PASSWORD_HASH)
        return None
    return user if verify_password(password, user.password_hash) else None


def open_session(db: DbSession, user: User, *, active_org_id: uuid.UUID | None = None) -> str:
    now = datetime.now(timezone.utc)
    # A cleanup along the way: this person's expired sessions are of no use to
    # anyone, and an architecture without a scheduler has no other regular place
    # to sweep them. Sign-in is the natural moment: it writes to the table anyway.
    db.execute(
        Session.__table__.delete().where(
            Session.user_id == user.id,
            Session.expires_at < now,
        )
    )
    # Signing in and registering are activity too. Without this line a fresh
    # account would show "never visited" in the director's panel for the whole
    # first refresh step (see _LAST_USED_WRITE_STEP) — until the first read, which
    # happens later than a quarter of an hour after signing in.
    user.last_active_at = now
    raw, hashed = new_token()
    db.add(
        Session(
            user_id=user.id,
            token_hash=hashed,
            expires_at=now + SESSION_TTL,
            # Set when signing in through an invitation: the person has just
            # entered someone else's organization and must see that one rather
            # than whichever came first in order.
            active_org_id=active_org_id,
        )
    )
    db.flush()
    return raw


def close_other_sessions(db: DbSession, user: User, *, keep_raw_token: str | None) -> int:
    """"Sign out on all devices": closes every session except the current one.

    The current one stays: a person who pressed the button after changing their
    password must not be thrown out themselves — otherwise the button looks like a
    breakage.
    """
    query = Session.__table__.delete().where(Session.user_id == user.id)
    if keep_raw_token:
        query = query.where(Session.token_hash != hash_token(keep_raw_token))
    result = db.execute(query)
    return result.rowcount or 0


def change_password(db: DbSession, user: User, *, current: str, new: str) -> None:
    """Changing the password, with the previous one verified.

    The previous password is mandatory: changing the password is exactly the
    action that renders a stolen session useless, and it must not be performed on
    the strength of a session alone. ValueError means a wrong previous password.
    """
    if not verify_password(current, user.password_hash):
        raise ValueError("the previous password did not match")
    user.password_hash = hash_password(new)
    db.flush()


def close_session(db: DbSession, raw_token: str) -> None:
    record = db.scalar(select(Session).where(Session.token_hash == hash_token(raw_token)))
    if record is not None:
        db.delete(record)


def session_for_token(db: DbSession, raw_token: str | None) -> Session | None:
    """The session row for a raw cookie token. `None` means there is no token, it
    cannot be found, or it has expired.

    Separate from current_session, because a WebSocket has neither a response
    status nor headers: a refusal there is a socket close code. The shared part
    has to be one function, otherwise the expiry check will one day diverge and an
    expired session will be rejected over HTTP but let through into the socket.

    The row is returned rather than only its owner: the chosen organization lives
    on it, and the socket needs it for the same reason the HTTP routes do — to
    answer within the organization the person chose.
    """
    if not raw_token:
        return None

    record = db.scalar(select(Session).where(Session.token_hash == hash_token(raw_token)))
    now = datetime.now(timezone.utc)
    if record is None or record.expires_at < now:
        return None

    # The idle timeout: the session went unused for longer than SESSION_IDLE_TTL —
    # it is dead, whatever its formal expiry date.
    if record.last_used_at is not None and now - record.last_used_at > SESSION_IDLE_TTL:
        db.delete(record)
        db.flush()
        return None

    # The "used" mark — by a step rather than on every request (see the constant).
    if record.last_used_at is None or now - record.last_used_at > _LAST_USED_WRITE_STEP:
        record.last_used_at = now
        # The person's own last activity is refreshed by the same step — it
        # outlives the cleanup of session rows (see the comment at
        # User.last_active_at in models.py) and feeds the director's panel.
        user = db.get(User, record.user_id)
        if user is not None:
            user.last_active_at = now
        db.flush()

    return record


def current_session(
    planora_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
    db: DbSession = Depends(get_db),
) -> Session:
    """The session row rather than only its owner: the chosen organization lives
    on it, and the switcher needs the row itself in order to rewrite it."""
    # A missing cookie and a bad cookie are different codes: the first means "sign
    # in", the second "sign in again", and to a person those are different messages.
    if not planora_session:
        raise HTTPException(status_code=401, detail="not_authenticated")

    record = session_for_token(db, planora_session)
    if record is None:
        raise HTTPException(status_code=401, detail="session_expired")

    return record


def current_user(
    planora_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
    db: DbSession = Depends(get_db),
) -> User:
    return db.get(User, current_session(planora_session, db).user_id)
