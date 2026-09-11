"""Shared route dependencies: the caller's organization and the project context.

They lived inside `project_routes` for as long as there were few routes around
a single project. Once there were three of them — state, link, comments — a
copy of the "is this the project, is there a right to read it" check in every
file would have drifted apart on the first edit.
"""

import uuid
from dataclasses import dataclass

from fastapi import Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.access import Action, can, parse_role
from app.auth import current_user
from app.db import get_db
from app.models import Membership, Organization, Project, ProjectAccess, Role, User
from app.orgs import current_membership

# Membership is taken from app.orgs rather than looked up here: with
# invitations, a second membership became an everyday thing, and "which
# organization is this request running in" is decided by a choice living in the
# session — one answer for the whole application.
__all__ = ["ProjectContext", "current_membership", "project_context", "project_granted"]


def project_granted(db: DbSession, project_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    """Whether this person was invited to this particular project.

    It is asked for every role, not only for `client`: the decision about which
    role needs a grant belongs to `access.py`, and a route deciding it on its
    own would be a second place where the permission matrix lives.
    """
    return (
        db.scalar(
            select(ProjectAccess.id).where(
                ProjectAccess.project_id == project_id, ProjectAccess.user_id == user_id
            )
        )
        is not None
    )


@dataclass(frozen=True)
class ProjectContext:
    """The project, its organization and the caller's rights to it.

    Assembled once per request: without this every route fetches the membership,
    the project and the organization anew — three queries repeated as many times
    as the project has routes.
    """

    user: User
    membership: Membership
    org: Organization
    project: Project
    granted: bool

    @property
    def role(self) -> Role | str | None:
        return parse_role(self.membership.role)

    @property
    def scoped(self) -> bool:
        return self.membership.project_scoped

    def can(self, action: Action) -> bool:
        return can(self.role, action, project_granted=self.granted, scoped=self.scoped)

    def require(self, action: Action) -> None:
        """A refusal is a 403: the caller has already passed the project's
        address, so they may read it, and there is no longer anyone to hide the
        project's existence from."""
        if not self.can(action):
            raise HTTPException(status_code=403, detail="forbidden")


def project_context(
    project_id: uuid.UUID,
    user: User = Depends(current_user),
    membership: Membership = Depends(current_membership),
    db: DbSession = Depends(get_db),
) -> ProjectContext:
    """The project at this address — together with the right to read it.

    Someone else's project, a nonexistent project and a project this person was
    not invited to all answer the same way: 404. Different answers would turn
    the address into a way of enumerating other people's projects — and the
    `client` role sees exactly the ones it was invited to and must not know that
    the rest exist.
    """
    project = db.get(Project, project_id)
    if project is None or project.org_id != membership.org_id:
        raise HTTPException(status_code=404, detail="project_not_found")

    context = ProjectContext(
        user=user,
        membership=membership,
        org=db.get(Organization, project.org_id),
        project=project,
        granted=project_granted(db, project.id, user.id),
    )
    if not context.can(Action.PROJECT_READ):
        raise HTTPException(status_code=404, detail="project_not_found")
    return context
