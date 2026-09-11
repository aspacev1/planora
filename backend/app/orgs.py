"""The organization a person is in right now.

Before invitations appeared there was no question: there was exactly one
membership, and any route took whichever came first. An invitation makes a
second membership an everyday thing — and "which organization is this request
running in" becomes a real question that must have one answer for the whole
application.
"""

import uuid

from fastapi import Depends, HTTPException
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session as DbSession

from app.auth import current_session
from app.db import get_db
from app.models import Membership, Organization, Project, ProjectAccess, Role, Session


def memberships_of(db: DbSession, user_id: uuid.UUID) -> list[tuple[Membership, Organization]]:
    """All of a person's organizations, in a stable order.

    Ordered by name rather than by the time they joined: the list is shown in
    the switcher, and a person looks for a familiar word in it rather than
    recalling when they were invited where.
    """
    return list(
        db.execute(
            select(Membership, Organization)
            .join(Organization, Organization.id == Membership.org_id)
            .where(Membership.user_id == user_id)
            .order_by(Organization.name, Organization.id)
        ).all()
    )


def active_membership(db: DbSession, session: Session) -> Membership | None:
    """The membership this session's request runs under.

    The chosen organization may turn out to be unavailable — the person was
    removed from it while the tab was open. That is no reason to answer with a
    refusal: the request runs under the first available membership, and the
    person sees an organization they still belong to instead of an error screen.
    """
    if session.active_org_id is not None:
        chosen = db.scalar(
            select(Membership).where(
                Membership.user_id == session.user_id,
                Membership.org_id == session.active_org_id,
            )
        )
        if chosen is not None:
            return chosen

    # The order is set explicitly so that "the first" is the same one from
    # request to request rather than whichever the planner returned first.
    return db.scalar(
        select(Membership)
        .where(Membership.user_id == session.user_id)
        .order_by(Membership.id)
    )


def switch(db: DbSession, session: Session, org_id: uuid.UUID) -> Membership | None:
    """Switches the session to another organization. None means they are not a member.

    The choice lives until the end of the session rather than until the end of
    the page: a person working in someone else's organization must not be
    returned to their own on every reload.
    """
    membership = db.scalar(
        select(Membership).where(
            Membership.user_id == session.user_id, Membership.org_id == org_id
        )
    )
    if membership is None:
        return None
    session.active_org_id = org_id
    db.flush()
    return membership


def current_membership(
    session: Session = Depends(current_session), db: DbSession = Depends(get_db)
) -> Membership:
    """A route dependency: the membership instead of the user.

    Routes ask for the membership specifically, because both data visibility
    (the organization) and permissions (the role) depend on exactly that;
    `user_id` is in it too. A separate "who is this" question remains only where
    a name or an address is needed.
    """
    membership = active_membership(db, session)
    if membership is None:
        raise HTTPException(status_code=403, detail="no_organization")
    return membership


# ---- composition: roles and removal from an organization -------------------


class LastOwner(Exception):
    """The organization would be left without an owner, with nobody able to fix it.

    The owner is the only role that edits settings, invites people and hands out
    roles. An organization that has lost its last owner is not demoted but
    locked forever: there is no longer anything in it with which to appoint a
    new owner. Hence a refusal rather than a warning — and hence the fact that it
    is the same for a demotion, a removal by someone else's hand and a departure
    by one's own.
    """


def owner_count(db: DbSession, org_id: uuid.UUID) -> int:
    return db.scalar(
        select(func.count())
        .select_from(Membership)
        .where(Membership.org_id == org_id, Membership.role == Role.OWNER.value)
    )


def is_last_owner(db: DbSession, membership: Membership) -> bool:
    """Whether the organization rests on this one person."""
    return membership.role == Role.OWNER.value and owner_count(db, membership.org_id) == 1


def member_of(db: DbSession, *, org_id: uuid.UUID, user_id: uuid.UUID) -> Membership | None:
    return db.scalar(
        select(Membership).where(Membership.org_id == org_id, Membership.user_id == user_id)
    )


def set_role(db: DbSession, membership: Membership, role: Role) -> None:
    """Changes a member's role. The last owner cannot be demoted.

    Appointing an owner lives here specifically, not in an invitation: an
    invitation without an address goes to whoever presents it, and the owner
    would become anyone who opened a forwarded link (see NOT_INVITABLE in
    app.invitations). Here the recipient is named individually — they are an
    existing member whom the inviter sees in the list.
    """
    if role is not Role.OWNER and is_last_owner(db, membership):
        raise LastOwner()
    membership.role = role.value
    db.flush()


def remove_membership(db: DbSession, membership: Membership) -> None:
    """Removes a person from an organization. The last owner cannot be removed.

    Individually granted access to this organization's projects goes away with
    the membership: without that it would mean "invite them back and they see
    everything they saw before", and silently at that. Task assignments, on the
    contrary, remain: they can be cleared even for someone who has left (see
    UnassignUser in app.mutations), and quietly wiping an assignee from all
    their tasks means rewriting the plan in response to a staffing decision.

    The chosen organization is reset in the departed person's sessions: without
    that their session would keep pointing at an organization they no longer
    belong to. This does not turn into a refusal — active_membership takes the
    first available one anyway — but a pointer at someone else's place is better
    removed right away.
    """
    if is_last_owner(db, membership):
        raise LastOwner()

    org_projects = select(Project.id).where(Project.org_id == membership.org_id)
    db.execute(
        delete(ProjectAccess).where(
            ProjectAccess.user_id == membership.user_id,
            ProjectAccess.project_id.in_(org_projects),
        )
    )
    db.execute(
        update(Session)
        .where(
            Session.user_id == membership.user_id,
            Session.active_org_id == membership.org_id,
        )
        .values(active_org_id=None)
    )
    db.delete(membership)
    db.flush()
