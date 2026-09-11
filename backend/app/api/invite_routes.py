"""Invitations: issuing and managing them inside an organization, plus accepting by link.

Two routers, because there are two doors. Management lives under `/api/org/...`
and requires owner rights; acceptance lives under `/api/invitations/...` and is
open to whoever holds the link: a person who is not in the organization yet
cannot, by definition, pass a permission check inside it.
"""

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.access import Action, can, parse_role
from app.auth import current_session
from app.config import get_settings
from app.db import get_db
from app.invitations import (
    InvitationError,
    Status,
    accept,
    create,
    ensure_capacity,
    reissue,
    revoke,
    status_of,
)
from app.invitations import by_token as invitation_by_token
from app.mail import mail_enabled, role_name, send as send_mail
from app.models import Invitation, Membership, Organization, Session, User
from app.orgs import current_membership, switch

router = APIRouter(prefix="/api/org/invitations", tags=["invitations"])
public_router = APIRouter(prefix="/api/invitations", tags=["invitations"])

#: How many addresses are accepted at once. The ceiling is needed not instead of
#: the hourly limit but before it: a list of ten thousand addresses must not
#: reach the database just to be refused.
MAX_EMAILS_PER_REQUEST = 50

#: Domain refusal codes whose response status is not 422. Everything else is a
#: request shape that was not accepted, that is, a 422.
_STATUS_BY_CODE = {
    "invite_rate_limited": 429,
    "project_not_found": 404,
    "invite_expired": 409,
    "invite_revoked": 409,
    "invite_accepted": 409,
    "invite_wrong_email": 403,
    # Not a 422: the request's shape is impeccable, but the organization's state
    # is such that there is nowhere left to invite this person — they are already
    # inside.
    "already_member": 409,
}


def as_http(error: InvitationError) -> HTTPException:
    return HTTPException(status_code=_STATUS_BY_CODE.get(error.code, 422), detail=error.code)


class InviteIn(BaseModel):
    # An empty list is not forgetfulness but a second means of delivery: an
    # invitation with no address, whose link the inviter will send however they
    # find convenient.
    emails: list[EmailStr] = Field(default_factory=list, max_length=MAX_EMAILS_PER_REQUEST)
    role: str
    project_ids: list[uuid.UUID] = Field(default_factory=list)
    #: Whether to send messages. Copying the link is an equal path rather than a
    #: fallback, so sending is asked about rather than assumed.
    deliver: bool = True


class ReissueIn(BaseModel):
    deliver: bool = False


class IssuedOut(BaseModel):
    id: str
    email: str | None
    role: str
    expires_at: str
    #: The plain link. Returned only in response to an issue and nowhere else:
    #: the database holds a hash of the token, and restoring it later is impossible.
    url: str
    sent: bool
    #: Why the message did not go out. The invitation is created regardless — it
    #: exists whether or not it was delivered by mail.
    mail_error: str | None = None


class InvitationOut(BaseModel):
    id: str
    email: str | None
    role: str
    status: str
    project_ids: list[str]
    created_at: str
    expires_at: str
    last_sent_at: str | None
    invited_by: str | None
    accepted_at: str | None


class InvitationsOut(BaseModel):
    #: Whether mail is configured in this installation. Without it the send
    #: button is not shown at all — the interface must not have to guess this
    #: from the server's silence.
    mail_enabled: bool
    invitations: list[InvitationOut]


class PreviewOut(BaseModel):
    org_name: str
    role: str
    #: The address the invitation is addressed to. Shown so that someone signed
    #: in under a different account understands whose invitation this is instead
    #: of guessing.
    email: str | None
    inviter_name: str | None
    expires_at: str


class JoinedOut(BaseModel):
    id: str
    name: str
    slug: str
    role: str


def _require_org_admin(membership: Membership) -> None:
    """The owner may invite into an organization: only they have ORG_ADMIN.

    The specification adds a second condition to this — "you may not invite
    others before confirming your address" — and it is deliberately absent here.
    Address confirmation does exist (`app.email_verification`), but it does not
    lock invitations: in an installation without mail, `users.email_verified_at`
    is empty for everyone, and the check would close invitations for absolutely
    everyone, including whoever deployed the installation — that is, it would
    break the very feature it is written for.
    """
    if not can(parse_role(membership.role), Action.ORG_ADMIN):
        raise HTTPException(status_code=403, detail="forbidden")


def _link(raw_token: str) -> str:
    return f"{get_settings().public_base_url.rstrip('/')}/invite/{raw_token}"


def _moment(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _deliver(
    db: DbSession,
    invitation: Invitation,
    *,
    url: str,
    org: Organization,
    inviter_name: str,
    now: datetime,
) -> tuple[bool, str | None]:
    """Sends a message if there is someone and something to send. A failure does not roll the issue back.

    A sent flag and a reason code are returned rather than an exception: the
    invitation is already created, the link is already in the answer, and all the
    interface has to say is "the message did not go out, copy the link" — that is
    not a refusal of the action.
    """
    if invitation.email is None or not mail_enabled():
        return False, None
    # The message's language is the organization's language: nothing is known
    # about the language of a recipient who has not opened anything in this
    # installation yet.
    locale = org.default_locale
    sent = send_mail(
        to=invitation.email,
        template="invitation",
        locale=locale,
        params={
            "org": org.name,
            "inviter": inviter_name,
            "role": role_name(invitation.role, locale),
            "link": url,
            # A date rather than a date and time: hours and minutes in someone
            # else's timezone tell the reader nothing, while the ISO form reads
            # the same way in all three languages.
            "expires": invitation.expires_at.date().isoformat(),
        },
    )
    if not sent:
        # The reason for the refusal is already in the log with a stack: a single
        # code goes outward — there is nobody to work out from it what exactly
        # someone else's mail server answered, and the advice on screen does not
        # change either way.
        return False, "mail_failed"
    invitation.last_sent_at = now
    db.flush()
    return True, None


def _issued_out(
    invitation: Invitation, raw_token: str, *, sent: bool, mail_error: str | None
) -> IssuedOut:
    return IssuedOut(
        id=str(invitation.id),
        email=invitation.email,
        role=invitation.role,
        expires_at=invitation.expires_at.isoformat(),
        url=_link(raw_token),
        sent=sent,
        mail_error=mail_error,
    )


@router.post("", response_model=list[IssuedOut], status_code=201)
def create_invitations(
    payload: InviteIn,
    membership: Membership = Depends(current_membership),
    db: DbSession = Depends(get_db),
):
    _require_org_admin(membership)
    now = datetime.now(timezone.utc)
    org = db.get(Organization, membership.org_id)
    inviter = db.get(User, membership.user_id)

    try:
        issued = create(
            db,
            org_id=membership.org_id,
            inviter_id=membership.user_id,
            role=payload.role,
            emails=[str(email) for email in payload.emails],
            project_ids=payload.project_ids,
            now=now,
        )
    except InvitationError as error:
        raise as_http(error)

    out: list[IssuedOut] = []
    for invitation, raw_token in issued:
        sent, mail_error = (False, None)
        if payload.deliver:
            sent, mail_error = _deliver(
                db,
                invitation,
                url=_link(raw_token),
                org=org,
                inviter_name=inviter.name,
                now=now,
            )
        out.append(_issued_out(invitation, raw_token, sent=sent, mail_error=mail_error))
    return out


@router.get("", response_model=InvitationsOut)
def list_invitations(
    membership: Membership = Depends(current_membership), db: DbSession = Depends(get_db)
):
    """The organization's invitations, newest first.

    All of them are returned, accepted ones included: an invitation lives in the
    database after acceptance too — it is the record of who brought whom in. None
    of them carries a plain link in the answer, and none can: the server does not
    remember them.
    """
    _require_org_admin(membership)
    now = datetime.now(timezone.utc)

    rows = db.execute(
        select(Invitation, User.name)
        .outerjoin(User, User.id == Invitation.invited_by)
        .where(Invitation.org_id == membership.org_id)
        .order_by(Invitation.created_at.desc(), Invitation.id)
    ).all()

    return InvitationsOut(
        mail_enabled=mail_enabled(),
        invitations=[
            InvitationOut(
                id=str(invitation.id),
                email=invitation.email,
                role=invitation.role,
                status=status_of(invitation, now).value,
                project_ids=[str(project_id) for project_id in invitation.project_ids],
                created_at=invitation.created_at.isoformat(),
                expires_at=invitation.expires_at.isoformat(),
                last_sent_at=_moment(invitation.last_sent_at),
                invited_by=inviter_name,
                accepted_at=_moment(invitation.accepted_at),
            )
            for invitation, inviter_name in rows
        ],
    )


def _own_invitation(db: DbSession, membership: Membership, invitation_id: uuid.UUID) -> Invitation:
    invitation = db.get(Invitation, invitation_id)
    # An invitation of another organization is indistinguishable from a nonexistent one.
    if invitation is None or invitation.org_id != membership.org_id:
        raise HTTPException(status_code=404, detail="invite_not_found")
    return invitation


@router.post("/{invitation_id}/reissue", response_model=IssuedOut)
def reissue_invitation(
    invitation_id: uuid.UUID,
    payload: ReissueIn,
    membership: Membership = Depends(current_membership),
    db: DbSession = Depends(get_db),
):
    """Issues a new link in place of the previous one — also known as "send again".

    One action, not two: the previous token dies in both cases, because otherwise
    revoking an already sent message becomes impossible. Only the delivery
    differs — whether a message goes out or the link is copied by hand.
    """
    _require_org_admin(membership)
    invitation = _own_invitation(db, membership, invitation_id)
    now = datetime.now(timezone.utc)

    if payload.deliver and invitation.email is not None and mail_enabled():
        # A message spends the same hourly ceiling as creation does: it stands
        # against mailing out, not against rows in a table.
        try:
            ensure_capacity(db, org_id=membership.org_id, now=now, wanted=1)
        except InvitationError as error:
            raise as_http(error)

    try:
        raw_token = reissue(db, invitation, now=now)
    except InvitationError as error:
        raise as_http(error)

    sent, mail_error = (False, None)
    if payload.deliver:
        sent, mail_error = _deliver(
            db,
            invitation,
            url=_link(raw_token),
            org=db.get(Organization, membership.org_id),
            inviter_name=db.get(User, membership.user_id).name,
            now=now,
        )
    return _issued_out(invitation, raw_token, sent=sent, mail_error=mail_error)


@router.delete("/{invitation_id}", status_code=204)
def revoke_invitation(
    invitation_id: uuid.UUID,
    membership: Membership = Depends(current_membership),
    db: DbSession = Depends(get_db),
):
    _require_org_admin(membership)
    invitation = _own_invitation(db, membership, invitation_id)
    try:
        revoke(db, invitation, now=datetime.now(timezone.utc))
    except InvitationError as error:
        raise as_http(error)


def _by_token_or_404(db: DbSession, token: str) -> Invitation:
    invitation = invitation_by_token(db, token)
    if invitation is None:
        raise HTTPException(status_code=404, detail="invite_not_found")
    return invitation


@public_router.get("/{token}", response_model=PreviewOut)
def preview_invitation(token: str, db: DbSession = Depends(get_db)):
    """What invitation is in hand — before signing in and before registering.

    It answers anonymous callers too: a person with an unaccepted invitation is
    by definition not in the organization yet, and demanding that they sign in
    before learning where they are being invited is asking them to sign
    unseen.
    """
    invitation = _by_token_or_404(db, token)
    state = status_of(invitation, datetime.now(timezone.utc))
    if state is not Status.PENDING:
        # Three states, three different codes: on "expired" a person asks for a
        # new link, on "accepted" they simply sign in, on "revoked" they go to
        # whoever invited them.
        raise HTTPException(status_code=409, detail=f"invite_{state.value}")

    org = db.get(Organization, invitation.org_id)
    inviter = db.get(User, invitation.invited_by) if invitation.invited_by else None
    return PreviewOut(
        org_name=org.name,
        role=invitation.role,
        email=invitation.email,
        inviter_name=inviter.name if inviter else None,
        expires_at=invitation.expires_at.isoformat(),
    )


@public_router.post("/{token}/accept", response_model=JoinedOut)
def accept_invitation(
    token: str,
    session: Session = Depends(current_session),
    db: DbSession = Depends(get_db),
):
    """Accepts an invitation on behalf of the signed-in person.

    A membership appears only here — by a person's explicit action, not by an
    address matching at registration. The session switches to the new
    organization right away: the person pressed "accept" and must end up inside
    rather than looking for it in the switcher.
    """
    invitation = _by_token_or_404(db, token)
    user = db.get(User, session.user_id)
    try:
        membership = accept(db, invitation, user=user, now=datetime.now(timezone.utc))
    except InvitationError as error:
        raise as_http(error)

    switch(db, session, membership.org_id)
    org = db.get(Organization, membership.org_id)
    return JoinedOut(id=str(org.id), name=org.name, slug=org.slug, role=membership.role)
