from datetime import datetime, timezone

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Cookie,
    Depends,
    Header,
    HTTPException,
    Request,
    Response,
)
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as DbSession

from app.api.invite_routes import as_http
from app.auth import (
    SESSION_COOKIE,
    SESSION_TTL,
    authenticate,
    change_password,
    close_other_sessions,
    close_session,
    current_user,
    open_session,
    register,
)
from app.config import get_settings
from app.db import get_db
from app.director import is_director
from app.email_verification import (
    VerificationError,
    confirm_email,
    send_verification,
    sent_recently,
)
from app.invitations import InvitationError, Status, by_token, check_recipient, status_of
from app.locales import locale_from_request
from app.models import Invitation, User
from app import password_reset
from app.rate_limit import client_key
from app.settings_input import check_locale, check_timezone
from app.text import normalize_email
from app import throttle

router = APIRouter(prefix="/api/auth", tags=["auth"])


class RegisterIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    email: EmailStr
    password: str = Field(min_length=8, max_length=200)
    #: The company name — that is what the organization registration creates
    #: alongside the account is called. The field is not Field(min_length=1): an
    #: empty string is normalized by the validator below, while being mandatory is
    #: checked in the route rather than here — that is decided by the invitation
    #: (see company_name_required), which the schema itself cannot see.
    company_name: str | None = Field(default=None, max_length=200)
    #: The invitation a person came with. With it the account is created right
    #: inside the inviting organization — and it is created even in an installation
    #: where free registration is turned off.
    invite_token: str | None = None

    @field_validator("company_name")
    @classmethod
    def _blank_company_name_is_no_company_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class VerifyEmailIn(BaseModel):
    token: str = Field(min_length=1, max_length=200)


class UserOut(BaseModel):
    id: str
    name: str
    email: str
    locale: str
    # `null` means "no timezone chosen, ask the browser". Returning a derived
    # timezone instead is not allowed: all the server knows about the browser is
    # the address the request came from, and the timezone is guessed wrongly from
    # an address for exactly the people who need this setting — those who have
    # moved and those sitting behind a VPN.
    timezone: str | None
    # Not a date but a flag: the interface needs to decide whether to show the
    # "confirm your address" bar, and it needs the exact confirmation time for
    # nothing at all — which is not worth parsing a date format on the client for.
    email_verified: bool
    #: Whether this person holds the director role — the only installation-wide
    #: role (see app.director) rather than an organization one. It decides whether
    #: the "Admin panel" item is visible in the column; the panel's own route
    #: checks the same rule (see app.api.admin_routes.current_director) — it is
    #: duplicated here only so that the column does not show a menu item leading to
    #: a certain refusal.
    is_director: bool


class MailResultOut(BaseModel):
    """Whether the message went out. Lying "sent" is not allowed: the person will wait."""

    sent: bool


class VerifyEmailOut(BaseModel):
    """The outcome of redeeming a link.

    A flag rather than two different answers: the address is confirmed in both
    cases, and the interface only needs to pick the words — "the address is
    confirmed" or "the address is already confirmed".
    """

    already_verified: bool


def _cookie_is_secure(request: Request) -> bool:
    """Whether to put the Secure flag on the cookie.

    The order of sources runs from explicit to derived. COOKIE_SECURE, if set,
    decides everything: it is the switch for installations where the automatic
    choice gets it wrong. Next comes the request itself: an https scheme or
    X-Forwarded-Proto from the proxy means the cookie will travel over a secure
    channel, whatever PUBLIC_BASE_URL says (it is sometimes not set at all — and
    then the previous "from it alone" derivation sent a production installation's
    cookie without Secure). PUBLIC_BASE_URL remains the last source — for requests
    that arrived bypassing the proxy.
    """
    settings = get_settings()
    if settings.cookie_secure is not None:
        return settings.cookie_secure
    if request.url.scheme == "https":
        return True
    if request.headers.get("x-forwarded-proto", "").split(",")[0].strip() == "https":
        return True
    return settings.public_base_url.startswith("https://")


def _cookie_attributes(request: Request) -> dict:
    """The cookie attributes shared by setting and deleting.

    In one dictionary, because a browser deletes a cookie only when the attributes
    match: delete_cookie with a different set leaves the old cookie alive.
    """
    return {
        "httponly": True,
        "samesite": "lax",
        "secure": _cookie_is_secure(request),
    }


def _set_cookie(response: Response, request: Request, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        # Exactly as long as the session itself lives in the database: two numbers
        # set separately will one day diverge, and the cookie will outlive the
        # session (or the other way round) with not a single sign of it in the code.
        max_age=int(SESSION_TTL.total_seconds()),
        **_cookie_attributes(request),
    )


def _to_out(user: User) -> UserOut:
    return UserOut(
        id=str(user.id),
        name=user.name,
        email=user.email,
        locale=user.locale,
        timezone=user.timezone,
        email_verified=user.email_verified_at is not None,
        is_director=is_director(user.email),
    )


def _invitation_for_signup(db: DbSession, payload: RegisterIn) -> Invitation | None:
    """The invitation from the registration form, checked before the account is created.

    The check happens here rather than inside register(): a person whose link has
    expired must read about the link rather than create an account and get a
    refusal afterwards. The same set of codes as for accepting by link — the
    registration screen and the invitation screen explain the same thing the same
    way.
    """
    if not payload.invite_token:
        return None

    invitation = by_token(db, payload.invite_token)
    if invitation is None:
        raise HTTPException(status_code=404, detail="invite_not_found")

    state = status_of(invitation, datetime.now(timezone.utc))
    if state is not Status.PENDING:
        raise HTTPException(status_code=409, detail=f"invite_{state.value}")

    try:
        # The invitation's address is not editable: the form fills it in, and the
        # server does not trust the form. Otherwise an invitation with an address
        # becomes an invitation to the bearer, which is exactly what it must not allow.
        check_recipient(invitation, str(payload.email))
    except InvitationError as error:
        raise as_http(error)
    return invitation


@router.post("/register", response_model=UserOut, status_code=201)
def register_route(
    payload: RegisterIn,
    response: Response,
    request: Request,
    background: BackgroundTasks,
    db: DbSession = Depends(get_db),
    accept_language: str | None = Header(default=None),
):
    settings = get_settings()
    mode = settings.signup_mode
    # `closed` is checked before the invitation: in such an installation there is
    # no registration at all, and there is no reason to answer it by parsing
    # somebody's link.
    if mode == "closed":
        raise HTTPException(status_code=403, detail="signup_disabled")

    # The limit comes before any checks and before anything is created: mass
    # account creation is spam in the database and a stream of confirmation
    # messages from our own sender.
    if not throttle.hit(
        db,
        f"signup:ip:{client_key(request)}",
        limit=settings.signup_rate_limit_per_ip,
        window_seconds=settings.auth_rate_window_seconds,
    ):
        raise HTTPException(status_code=429, detail="too_many_requests")

    invitation = _invitation_for_signup(db, payload)
    if mode == "invite_only" and invitation is None:
        raise HTTPException(status_code=403, detail="signup_disabled")

    # The company name is mandatory exactly where registration creates an
    # organization of its own. Someone arriving by invitation already has one —
    # asking for the name of an organization they are not creating would be a
    # question beside the point.
    if invitation is None and payload.company_name is None:
        raise HTTPException(status_code=422, detail="company_name_required")

    try:
        user = register(
            db,
            name=payload.name,
            email=payload.email,
            password=payload.password,
            company_name=payload.company_name,
            # The only place where the header is read at all: the language on a
            # person's first appearance. After that it lives in the profile.
            locale=locale_from_request(accept_language),
            invitation=invitation,
        )
    except InvitationError as error:
        raise as_http(error)
    except ValueError:
        raise HTTPException(status_code=409, detail="email_taken")
    except IntegrityError:
        # A safety net for a race not caught inside register() (for example, if the
        # set of inserts there changes in the future): without a rollback the
        # session stays in an aborted state, and without this branch the client
        # would get a 500 instead of an honest "the address is taken".
        db.rollback()
        raise HTTPException(status_code=409, detail="email_taken")
    _set_cookie(
        response,
        request,
        open_session(db, user, active_org_id=invitation.org_id if invitation else None),
    )
    # The message goes out after the answer rather than inside it: an SMTP server
    # is allowed to think for up to ten seconds, and all that time a person would
    # be staring at a frozen registration screen. The message does not decide the
    # fate of the registration and never did: a delivery failure is written to the
    # log inside mail.send, and a resend is available through a separate route. The
    # commit comes before the task is scheduled: a background task runs before the
    # get_db dependency is closed, and the account must be in the database
    # regardless of the message's fate.
    db.commit()
    background.add_task(send_verification, db, user)
    return _to_out(user)


@router.post("/login", response_model=UserOut)
def login_route(
    payload: LoginIn, response: Response, request: Request, db: DbSession = Depends(get_db)
):
    """Sign-in. Two rate limits, for two different kinds of guessing.

    By IP every attempt is counted: one address hammering the sign-in is
    dictionary password guessing, whatever addresses it tries. By account only
    failures are: that is password guessing against one particular person from many
    addresses, and successes must not be counted here — a successful sign-in from
    two devices would lock the owner out. The counters live in the database rather
    than in the process's memory: a restart or a second replica must not reset the
    limit (see app.throttle).
    """
    settings = get_settings()
    if not throttle.hit(
        db,
        f"login:ip:{client_key(request)}",
        limit=settings.login_rate_limit_per_ip,
        window_seconds=settings.auth_rate_window_seconds,
    ):
        raise HTTPException(status_code=429, detail="too_many_requests")

    account_bucket = f"login:account:{normalize_email(str(payload.email))}"
    if not throttle.check(
        db,
        account_bucket,
        limit=settings.login_rate_limit_per_account,
        window_seconds=settings.auth_rate_window_seconds,
    ):
        raise HTTPException(status_code=429, detail="too_many_requests")

    user = authenticate(db, email=payload.email, password=payload.password)
    if user is None:
        throttle.note(db, account_bucket)
        raise HTTPException(status_code=401, detail="bad_credentials")
    _set_cookie(response, request, open_session(db, user))
    return _to_out(user)


@router.post("/logout", status_code=204)
def logout_route(
    response: Response,
    request: Request,
    db: DbSession = Depends(get_db),
    planora_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
):
    if planora_session:
        close_session(db, planora_session)
    # The same attributes as when setting it: the browser compares them and with a
    # different set would leave the cookie in place.
    response.delete_cookie(SESSION_COOKIE, **_cookie_attributes(request))


@router.get("/me", response_model=UserOut)
def me_route(user: User = Depends(current_user)):
    return _to_out(user)


class PasswordIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    current_password: str
    new_password: str = Field(min_length=8, max_length=200)


@router.post("/password", status_code=204)
def change_password_route(
    payload: PasswordIn,
    user: User = Depends(current_user),
    db: DbSession = Depends(get_db),
    planora_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
):
    """Changing the password. It requires the previous one: a session alone is not
    enough for this — otherwise a stolen cookie would change the owner's password.

    The other sessions are closed right away: changing a password is usually an
    answer to a suspicion that it has leaked, and leaving other people's sign-ins
    alive would mean pretending the change solved something. The current session
    stays.
    """
    try:
        change_password(
            db, user, current=payload.current_password, new=payload.new_password
        )
    except ValueError:
        raise HTTPException(status_code=403, detail="bad_credentials")
    close_other_sessions(db, user, keep_raw_token=planora_session)


class ForgotPasswordIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: EmailStr


class ResetPasswordIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=8, max_length=200)


@router.post("/password/forgot", status_code=204)
def forgot_password_route(
    payload: ForgotPasswordIn,
    request: Request,
    background: BackgroundTasks,
    db: DbSession = Depends(get_db),
):
    """A request for a password-recovery message. It requires no cookie.

    The answer is the same for any address — 204: the form does not report whether
    such an account exists. Otherwise it would be a directory of "who is registered
    here", the very one authenticate() hides at the cost of a dummy hash. For the
    same reason the pause between repeats does not answer 429: a silent 204 is the
    answer. The IP limit is one for all addresses — every request, whatever address
    stands in it, turns into a message from our sender.
    """
    settings = get_settings()
    if not throttle.hit(
        db,
        f"password-reset:ip:{client_key(request)}",
        limit=settings.password_reset_rate_limit_per_ip,
        window_seconds=settings.auth_rate_window_seconds,
    ):
        raise HTTPException(status_code=429, detail="too_many_requests")

    user = db.scalar(
        select(User).where(User.email == normalize_email(str(payload.email)))
    )
    if user is None or password_reset.sent_recently(db, user):
        return

    # The message goes out after the answer, in the same order as at registration:
    # SMTP thinks for up to ten seconds, and the response time must not reveal
    # whether a message went out at all. The commit comes before the task is
    # scheduled (see register_route).
    db.commit()
    background.add_task(password_reset.send_reset, db, user)


@router.post("/password/reset", status_code=204)
def reset_password_route(payload: ResetPasswordIn, db: DbSession = Depends(get_db)):
    """Redeeming the link from the message: a new password instead of a forgotten one.

    It requires no cookie for the same reason as address confirmation: the link is
    opened wherever the mail arrived. It does not open a session: the password has
    just been set and signing in with it is a matter of a second, whereas every
    previous session dies inside redeem_token — recovery is used precisely when the
    password appears to have leaked.
    """
    try:
        password_reset.redeem_token(db, payload.token, new_password=payload.new_password)
    except password_reset.ResetError as exc:
        raise HTTPException(status_code=400, detail=exc.code)


class SessionsClosedOut(BaseModel):
    closed: int


@router.post("/sessions/close-others", response_model=SessionsClosedOut)
def close_other_sessions_route(
    user: User = Depends(current_user),
    db: DbSession = Depends(get_db),
    planora_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
):
    """"Sign out on all devices" except this one."""
    return SessionsClosedOut(
        closed=close_other_sessions(db, user, keep_raw_token=planora_session)
    )


@router.post("/verify-email", response_model=VerifyEmailOut)
def verify_email_route(payload: VerifyEmailIn, db: DbSession = Depends(get_db)):
    """Redeeming the link from the message. It requires no cookie.

    The link is opened in the browser the mail arrived in, not necessarily in the
    one where a session is open. Requiring a sign-in would mean breaking the most
    ordinary scenario — the message on a phone, the work on a laptop; the token
    itself is single-use, lives for a day and is long enough that it cannot be
    guessed.

    Opening it again is not a refusal but the same success with a caveat: a link
    from a message is followed twice, and the second visit must speak of a
    confirmed address rather than of an invalid link.
    """
    try:
        confirmation = confirm_email(db, payload.token)
    except VerificationError as exc:
        raise HTTPException(status_code=400, detail=exc.code)
    return VerifyEmailOut(already_verified=confirmation.already_verified)


@router.post("/verify-email/resend", response_model=MailResultOut)
def resend_verification_route(
    user: User = Depends(current_user),
    db: DbSession = Depends(get_db),
):
    if user.email_verified_at is not None:
        raise HTTPException(status_code=409, detail="already_verified")
    if sent_recently(db, user):
        raise HTTPException(status_code=429, detail="too_many_requests")
    return MailResultOut(sent=send_verification(db, user))


class ProfileIn(BaseModel):
    """Level 4 of the settings: the interface language and the timezone.

    The name next to them is not a setting but a property of the person, yet it is
    edited in the same place and by the same request: introducing a second route
    for one field would mean pretending these are different screens.

    `timezone` is the only field for which `null` means something: "count days by
    the browser". Telling it apart from "the field was not sent" is made possible
    by `model_fields_set` — the same technique as with a project's overrides, and
    for the same reason: without it, clearing a choice would be inexpressible.
    """

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=200)
    locale: str | None = None
    timezone: str | None = None

    @field_validator("timezone")
    @classmethod
    def _timezone(cls, value: str | None) -> str | None:
        return None if value is None else check_timezone(value)


@router.patch("/me", response_model=UserOut)
def update_me(
    payload: ProfileIn, user: User = Depends(current_user), db: DbSession = Depends(get_db)
):
    """Editing one's own profile.

    The language is checked against the list of supported ones: an unvalidated
    value would land in the profile, and the interface would silently fall back to
    the default language on every sign-in without explaining why. The timezone is
    validated by parsing the body — by a name from the IANA database rather than as
    a free string: the reader's days are counted by it, and a typo in it would
    shift "today" for as long as it went unnoticed.
    """
    if payload.locale is not None:
        try:
            user.locale = check_locale(payload.locale)
        except ValueError:
            raise HTTPException(status_code=422, detail="unsupported_locale")
    if "timezone" in payload.model_fields_set:
        user.timezone = payload.timezone
    if payload.name is not None:
        user.name = payload.name.strip()
    db.flush()
    return _to_out(user)
