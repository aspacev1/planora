"""Managing a project's public link. Everything here is available to whoever
may administer the project — the owner and an editor.

A separate file rather than four more routes in `project_routes`: publishing a
project outward is a decision in its own right with its own switches, and
mixing it with reading the plan means hiding it among everything else.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session as DbSession

from app.access import Action
from app.api.deps import ProjectContext, project_context
from app.db import get_db
from app.models import ShareLink
from app.sharing import (
    AlreadyShared,
    NotShared,
    SharingDisabled,
    active_link,
    create_link,
    public_url,
    revoke_link,
    rotate_link,
    set_comments_enabled,
    sharing_allowed,
)

router = APIRouter(prefix="/api/projects", tags=["sharing"])


class ShareOut(BaseModel):
    """The project's publication state.

    `allowed` is always returned, even when there is no link: the interface must
    distinguish "not published yet" from "publishing is forbidden by the
    installation" — otherwise the "publish" button promises an action that will
    end in a refusal.
    """

    allowed: bool
    url: str | None
    comments_enabled: bool
    created_at: str | None


class CommentsIn(BaseModel):
    comments_enabled: bool


def _out(context: ProjectContext, link: ShareLink | None) -> ShareOut:
    allowed = sharing_allowed(context.org)
    if link is None:
        return ShareOut(
            allowed=allowed,
            url=None,
            # While there is no link, what is shown is what a new one would
            # inherit: the toggle in the interface must not jump at the moment
            # the link is issued.
            comments_enabled=context.org.default_comments_enabled,
            created_at=None,
        )
    return ShareOut(
        allowed=allowed,
        url=public_url(context.org, context.project, link),
        comments_enabled=link.comments_enabled,
        created_at=link.created_at.isoformat(),
    )


@router.get("/{project_id}/share", response_model=ShareOut)
def get_share(context: ProjectContext = Depends(project_context), db: DbSession = Depends(get_db)):
    context.require(Action.PROJECT_ADMIN)
    return _out(context, active_link(db, context.project))


@router.post("/{project_id}/share", response_model=ShareOut, status_code=201)
def issue_share(
    context: ProjectContext = Depends(project_context), db: DbSession = Depends(get_db)
):
    """The first issue of a link. If one already exists — 409, not a silent
    reissue: a repeated request (a double click, a network retry) must not kill
    an address that has just been sent around. Reissuing is a separate route
    below."""
    context.require(Action.PROJECT_ADMIN)
    try:
        link = create_link(db, context.project, context.org)
    except SharingDisabled:
        raise HTTPException(status_code=403, detail="sharing_disabled")
    except AlreadyShared:
        raise HTTPException(status_code=409, detail="share_link_exists")
    return _out(context, link)


@router.post("/{project_id}/share/rotate", response_model=ShareOut, status_code=201)
def rotate_share(
    context: ProjectContext = Depends(project_context), db: DbSession = Depends(get_db)
):
    """Reissue: the previous address dies at that same moment."""
    context.require(Action.PROJECT_ADMIN)
    try:
        link = rotate_link(db, context.project, context.org)
    except SharingDisabled:
        raise HTTPException(status_code=403, detail="sharing_disabled")
    except NotShared:
        raise HTTPException(status_code=404, detail="share_link_not_found")
    return _out(context, link)


@router.patch("/{project_id}/share", response_model=ShareOut)
def update_share(
    payload: CommentsIn,
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    context.require(Action.PROJECT_ADMIN)
    link = set_comments_enabled(db, context.project, payload.comments_enabled)
    if link is None:
        raise HTTPException(status_code=404, detail="share_link_not_found")
    return _out(context, link)


@router.delete("/{project_id}/share", status_code=204)
def revoke_share(
    context: ProjectContext = Depends(project_context), db: DbSession = Depends(get_db)
):
    context.require(Action.PROJECT_ADMIN)
    revoke_link(db, context.project)
