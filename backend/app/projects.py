import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.models import Project
from app.slugs import insert_with_unique_slug


def _slug_taken(db: DbSession, org_id: uuid.UUID, slug: str) -> bool:
    return (
        db.scalar(select(Project.id).where(Project.org_id == org_id, Project.slug == slug))
        is not None
    )


def create_project(db: DbSession, *, org_id: uuid.UUID, name: str) -> Project:
    """Project creation as a domain action, not as entity assembly in the HTTP
    layer. The slug is unique within an organization, and that uniqueness is
    held by a database constraint rather than by a check before the insert: two
    simultaneous creations with the same name used to produce a 500."""
    return insert_with_unique_slug(
        db,
        lambda slug: Project(org_id=org_id, name=name, slug=slug),
        name=name,
        is_taken=lambda slug: _slug_taken(db, org_id, slug),
    )


def lock_project(db: DbSession, project: Project) -> None:
    """Takes the project's row lock and reloads the row under it.

    Every writer that serializes on a project takes this lock. The reload is the
    half that is easy to miss: `project` was loaded by the route's dependency
    before the lock, and a bare `SELECT id ... FOR UPDATE` does not touch the copy
    already in the session. Whoever waited on the lock would then compute from the
    state the previous holder has just changed — `plan_version + 1` from a stale
    version is the same number twice, and a unique violation for the loser.

    Pending changes are flushed first: a refresh overwrites unflushed attributes.
    """
    db.flush()
    db.refresh(project, with_for_update=True)
