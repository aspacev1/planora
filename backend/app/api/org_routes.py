import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as DbSession

from app.access import Action, can, parse_role
from app.auth import current_session
from app.db import get_db
from app.models import Membership, Organization, Role, Session, User
from app.orgs import (
    LastOwner,
    current_membership,
    member_of,
    memberships_of,
    remove_membership,
    set_role,
    switch,
)
from app.settings_input import OrganizationSettingsIn, changes
from app.slugs import slug_check

router = APIRouter(prefix="/api/org", tags=["org"])


class MemberOut(BaseModel):
    id: str
    name: str
    email: str
    role: str


class OrganizationSettingsOut(BaseModel):
    """The organization's defaults — the very ones the projects inherit.

    Returned to any member of it, not only to the owner: working days and
    holidays are seen by everyone who sees the chart — it is filled with them.
    Only the owner may edit them, and that is decided on the write, not on the
    read.
    """

    default_locale: str
    default_timezone: str
    working_days: int
    week_start: int
    holiday_calendar: list[str]
    default_shift_threshold_days: int
    public_sharing_enabled: bool
    default_comments_enabled: bool


class OrganizationOut(BaseModel):
    id: str
    name: str
    slug: str
    #: The caller's role in this organization rather than a property of the
    #: organization itself: the interface will ask for it with the next request
    #: anyway to decide what to show, and a second trip to the server for one
    #: word gains nothing.
    role: str
    settings: OrganizationSettingsOut


class SwitchIn(BaseModel):
    org_id: uuid.UUID


class MemberRoleIn(BaseModel):
    role: str


def _to_out(org: Organization, role: str) -> OrganizationOut:
    return OrganizationOut(
        id=str(org.id),
        name=org.name,
        slug=org.slug,
        role=role,
        settings=OrganizationSettingsOut(
            default_locale=org.default_locale,
            default_timezone=org.default_timezone,
            working_days=org.working_days,
            week_start=org.week_start,
            holiday_calendar=list(org.holiday_calendar or []),
            default_shift_threshold_days=org.default_shift_threshold_days,
            public_sharing_enabled=org.public_sharing_enabled,
            default_comments_enabled=org.default_comments_enabled,
        ),
    )


@router.get("", response_model=OrganizationOut)
def current_organization(
    membership: Membership = Depends(current_membership), db: DbSession = Depends(get_db)
):
    """The organization a person is in right now.

    No permissions are checked here: the name of their own organization is
    visible to any member of it, including the `client` role. There is nobody to
    hide it from — it signs every screen the person is entitled to enter anyway.
    """
    return _to_out(db.get(Organization, membership.org_id), membership.role)


@router.get("/list", response_model=list[OrganizationOut])
def list_organizations(
    session: Session = Depends(current_session), db: DbSession = Depends(get_db)
):
    """The organizations a person belongs to — the contents of the switcher.

    The list is returned even when there is only one organization: deciding
    whether to show the switcher is the interface's business, not the server's,
    and an "and what if there is only one" branch introduced here would repeat in
    every client.
    """
    return [_to_out(org, membership.role) for membership, org in memberships_of(db, session.user_id)]


@router.post("/switch", response_model=OrganizationOut)
def switch_organization(
    payload: SwitchIn,
    session: Session = Depends(current_session),
    db: DbSession = Depends(get_db),
):
    """Switches the session to another organization.

    Someone else's organization is indistinguishable from a nonexistent one: 404,
    not 403 — otherwise enumerating addresses turns into a way of finding out
    which organizations exist in the installation at all.
    """
    membership = switch(db, session, payload.org_id)
    if membership is None:
        raise HTTPException(status_code=404, detail="organization_not_found")
    return _to_out(db.get(Organization, membership.org_id), membership.role)


def _slug_taken(db: DbSession, slug: str, *, except_id) -> bool:
    query = select(Organization.id).where(Organization.slug == slug)
    if except_id is not None:
        query = query.where(Organization.id != except_id)
    return db.scalar(query) is not None


@router.patch("", response_model=OrganizationOut)
def update_organization(
    payload: OrganizationSettingsIn,
    membership: Membership = Depends(current_membership),
    db: DbSession = Depends(get_db),
):
    """Level 2 of the settings: the defaults all projects inherit.

    Edited by the owner. The production calendar lives here specifically rather
    than on a project: nobody is going to type the Novruz dates into every new
    project by hand, and a forgotten holiday silently shifts every deadline.

    Values are changed in place rather than copied into projects: a project
    stores `null` — "inherit" — and an edit to a default reaches everyone who has
    not overridden it. Copying at creation time would look the same right up to
    the first edit of a default, and would diverge forever after.
    """
    if not can(parse_role(membership.role), Action.ORG_ADMIN):
        raise HTTPException(status_code=403, detail="forbidden")

    org = db.get(Organization, membership.org_id)
    updates = changes(payload)

    if "slug" in updates and _slug_taken(db, updates["slug"], except_id=org.id):
        # A taken slug is not a crash but a reason to show a free variant, and
        # the interface will ask for it through a separate route. An honest
        # refusal is enough here.
        raise HTTPException(status_code=409, detail="slug_taken")

    for field, value in updates.items():
        setattr(org, field, value)

    try:
        db.flush()
    except IntegrityError:
        # A race between the check and the write: uniqueness is held by the
        # database rather than by the check above — that one merely spares a
        # refusal in the ordinary case.
        db.rollback()
        raise HTTPException(status_code=409, detail="slug_taken")

    return _to_out(org, membership.role)


@router.get("/slug-check")
def check_org_slug(
    slug: str = Query(min_length=1, max_length=100),
    membership: Membership = Depends(current_membership),
    db: DbSession = Depends(get_db),
):
    """Whether such a slug is free — and what to offer if it is taken.

    Asked from the input field before the form is submitted: "a taken slug
    suggests a free variant right in the field". The slug is also normalized
    here, so the answer additionally shows what the entered name turns into.
    """
    org = db.get(Organization, membership.org_id)

    def taken(candidate: str) -> bool:
        # One's own slug does not count as taken: otherwise the form would tell
        # whoever holds the name that the name is taken.
        return _slug_taken(db, candidate, except_id=org.id)

    return slug_check(slug, is_taken=taken, fallback="org")


@router.get("/members", response_model=list[MemberOut])
def list_members(
    membership: Membership = Depends(current_membership), db: DbSession = Depends(get_db)
):
    """The people who can be made assignees.

    A refusal here is a 403, not a 404, unlike the project routes: the address
    names no entity whose existence would be worth hiding, and the caller sees
    their own organization anyway. Per the specification the client role does not
    get the organization's membership at all — and its lack of PROJECT_READ
    without granted access to a project means exactly that.
    """
    if not can(parse_role(membership.role), Action.PROJECT_READ):
        raise HTTPException(status_code=403, detail="forbidden")

    rows = db.execute(
        select(User, Membership.role)
        .join(Membership, Membership.user_id == User.id)
        .where(Membership.org_id == membership.org_id)
        .order_by(User.name, User.id)
    ).all()
    return [
        MemberOut(id=str(person.id), name=person.name, email=person.email, role=role)
        for person, role in rows
    ]


def _target(db: DbSession, membership: Membership, user_id: uuid.UUID) -> Membership:
    """The membership, in the caller's organization, of the person in question.

    A member of another organization is indistinguishable from a nonexistent one:
    404 for both cases — otherwise enumerating addresses turns into a way of
    finding out who exists in this installation at all.
    """
    found = member_of(db, org_id=membership.org_id, user_id=user_id)
    if found is None:
        raise HTTPException(status_code=404, detail="member_not_found")
    return found


def _parse_assignable_role(raw: str) -> Role:
    """The role from the request. Owner is admissible here — unlike in an invitation.

    An invitation does not hand out ownership (NOT_INVITABLE in app.invitations):
    a link with no address goes to whoever presents it, and the owner would
    become anyone who opened it. Here the recipient is an existing member, named
    individually by someone who already governs the whole organization; this is
    the very "separate action" for whose sake an invitation to ownership is
    forbidden.
    """
    try:
        return Role(raw)
    except ValueError as error:
        raise HTTPException(status_code=422, detail="unknown_role") from error


@router.patch("/members/{user_id}", response_model=MemberOut)
def update_member_role(
    user_id: uuid.UUID,
    payload: MemberRoleIn,
    membership: Membership = Depends(current_membership),
    db: DbSession = Depends(get_db),
):
    """Changes a member's role. The owner edits it, and only the owner.

    An owner may change their own role — while they are not the last one.
    Forbidding that separately is pointless: while there are two owners, the
    second one can undo the demotion, and on the last one the same protection
    fires as on every other path to being left without an owner.
    """
    if not can(parse_role(membership.role), Action.ORG_ADMIN):
        raise HTTPException(status_code=403, detail="forbidden")

    role = _parse_assignable_role(payload.role)
    target = _target(db, membership, user_id)
    try:
        set_role(db, target, role)
    except LastOwner:
        raise HTTPException(status_code=409, detail="last_owner")

    person = db.get(User, target.user_id)
    return MemberOut(
        id=str(person.id), name=person.name, email=person.email, role=target.role
    )


@router.delete("/members/{user_id}", status_code=204)
def remove_member(
    user_id: uuid.UUID,
    membership: Membership = Depends(current_membership),
    db: DbSession = Depends(get_db),
):
    """Removes a person from the organization — or lets them leave themselves.

    One route for both actions, because the action really is one: the membership
    is gone. The only thing that makes them different is who may perform it — the
    owner over anyone, or a person over themselves. Leaving by one's own hand
    requires no permissions in the organization at all: the `client` role does not
    even see its membership, and it has no separate "leave" permission and must
    not have one — otherwise whoever was once invited stays inside forever.
    """
    leaving = user_id == membership.user_id
    if not leaving and not can(parse_role(membership.role), Action.ORG_ADMIN):
        raise HTTPException(status_code=403, detail="forbidden")

    target = _target(db, membership, user_id)
    try:
        remove_membership(db, target)
    except LastOwner:
        raise HTTPException(status_code=409, detail="last_owner")
