"""A project's public page: reading by link and guest comments.

The only part of the API that works without a session. Hence three rules that
are not debated in this file but observed:

1. Permission is asked of `access.py` with the role `None` — a guest. The link
   is the very grant on a project that the permission matrix knows about; there
   are no decisions of the form "a guest may do this" here.
2. Internal notes and the organization's membership do not go outward at all
   (see `project_state`).
3. A refusal is always one and the same — 404 `link_not_found`. Distinguishing
   "there is no such project" from "the link was revoked" is not allowed: the
   difference turns the address into a way of enumerating other people's
   projects by slug.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DbSession

from app.access import Action, can
from app.api import export_routes
from app.api.serialization import comments_out, project_state
from app.calendar import CalendarError
from app.comments import CommentRejected, add_comment, comment_counts, list_comments
from app.config import get_settings
from app.db import get_db
from app.export.budget import Orientation, Period, Zoom
from app.export.errors import ExportError
from app.models import Organization, Project, ShareLink
from app.rate_limit import SlidingWindow, client_key
from app.sharing import TOKEN_PARAM, resolve

router = APIRouter(prefix="/api/public", tags=["public"])

_HOUR = 3600.0
_guest_comments: SlidingWindow | None = None


def guest_comment_limiter() -> SlidingWindow:
    """The guest comment counter, assembled on first demand.

    Not at module level: `GUEST_COMMENT_RATE_LIMIT` is read from the settings,
    and at import time the settings may not be assembled yet — and then the
    ceiling would be frozen at its default value forever.
    """
    global _guest_comments
    if _guest_comments is None:
        _guest_comments = SlidingWindow(
            limit=get_settings().guest_comment_rate_limit, window=_HOUR
        )
    return _guest_comments


# client_key moved to app.rate_limit: sign-in and registration
# (app.api.auth_routes) are counted the same way, not only guest comments.


class GuestCommentIn(BaseModel):
    # A guest's name is a mandatory field: an unsigned remark on a public page
    # is indistinguishable from someone else's.
    name: str = Field(min_length=1, max_length=80)
    body: str = Field(min_length=1)
    task_id: uuid.UUID | None = None


class SharedProject:
    """A project opened through a valid link."""

    def __init__(self, org: Organization, project: Project, link: ShareLink) -> None:
        self.org = org
        self.project = project
        self.link = link


def shared_project(
    org_slug: str,
    project_slug: str,
    token: str = Query(default="", alias=TOKEN_PARAM),
    db: DbSession = Depends(get_db),
) -> SharedProject:
    found = resolve(db, org_slug=org_slug, project_slug=project_slug, token=token)
    if found is None:
        raise HTTPException(status_code=404, detail="link_not_found")
    if not can(None, Action.PROJECT_READ, project_granted=True):
        # The permission matrix is the only place where "is this allowed" is
        # decided: if guests are one day denied reading, this route closes along
        # with it rather than remaining a hole everybody forgot about.
        raise HTTPException(status_code=404, detail="link_not_found")
    return SharedProject(*found)


@router.get("/{org_slug}/{project_slug}")
def public_project(
    shared: SharedProject = Depends(shared_project), db: DbSession = Depends(get_db)
):
    """The same layout as on the working screen, but without internal notes and
    without assignees."""
    try:
        state = project_state(
            db,
            shared.project,
            shared.org,
            show_notes=can(None, Action.READ_INTERNAL_NOTE, project_granted=True),
            show_people=False,
        )
    except CalendarError as error:
        raise HTTPException(status_code=422, detail=error.code)

    return {
        **state,
        # The organization's name signs the page: a guest must see whose plan
        # this is before commenting on anything in it.
        "org": {"name": shared.org.name, "slug": shared.org.slug},
        "comments_enabled": shared.link.comments_enabled
        and can(None, Action.COMMENT, project_granted=True),
    }


@router.get("/{org_slug}/{project_slug}/comments")
def public_comments(
    task_id: uuid.UUID | None = None,
    limit: int = Query(default=100, ge=1, le=200),
    before: uuid.UUID | None = None,
    shared: SharedProject = Depends(shared_project),
    db: DbSession = Depends(get_db),
):
    """The feed is visible even when comments are turned off.

    Turned-off comments are a ban on writing, not an order to hide what has
    already been said: a conversation the client saw yesterday must not vanish at
    the flick of a toggle.

    A guest does not see internal remarks: that is the team's conversation
    "aside", not part of the public page.
    """
    try:
        rows = list_comments(
            db,
            shared.project,
            task_id=task_id,
            include_internal=False,
            limit=limit,
            before=before,
        )
    except CommentRejected as error:
        raise HTTPException(status_code=404, detail=error.code)
    return comments_out(db, rows)


@router.get("/{org_slug}/{project_slug}/comments/counts")
def public_comment_counts(
    shared: SharedProject = Depends(shared_project), db: DbSession = Depends(get_db)
):
    """The remark counter on the rows of the public chart — without internal ones.

    The same filter as on the feed above: a guest does not see internal remarks,
    and the number next to a task must not let slip what is not in their feed at
    all.
    """
    counts = comment_counts(db, shared.project, include_internal=False)
    return {str(task_id): count for task_id, count in counts.items()}


@router.post("/{org_slug}/{project_slug}/comments", status_code=201)
def add_public_comment(
    payload: GuestCommentIn,
    request: Request,
    shared: SharedProject = Depends(shared_project),
    db: DbSession = Depends(get_db),
):
    if not can(None, Action.COMMENT, project_granted=True) or not shared.link.comments_enabled:
        raise HTTPException(status_code=403, detail="comments_closed")

    if not guest_comment_limiter().allow(client_key(request)):
        raise HTTPException(status_code=429, detail="too_many_comments")

    try:
        comment = add_comment(
            db,
            shared.project,
            body=payload.body,
            task_id=payload.task_id,
            guest_name=payload.name,
        )
    except CommentRejected as error:
        status = 404 if error.code == "task_not_found" else 422
        raise HTTPException(status_code=status, detail=error.code)
    return comments_out(db, [comment])[0]


# --- export through a public link ---------------------------------------------
#
# A guest receives the client copy: no internal notes, assignees, baseline plan
# or edit journal. Exactly the same trimming as on the page above — and it is not
# repeated here by hand but derived from the permission matrix by the same two
# flags that are passed into project_state.


def _export_shared(request: Request, shared: SharedProject, db: DbSession, fmt: str):
    if not can(None, Action.PROJECT_EXPORT, project_granted=True):
        raise HTTPException(status_code=404, detail="link_not_found")

    show_notes = can(None, Action.READ_INTERNAL_NOTE, project_granted=True)
    try:
        document = export_routes.build(
            db,
            shared.project,
            shared.org,
            request=request,
            sections_raw=request.query_params.getlist("include") or None,
            zoom=_enum_param(request, "zoom", Zoom),
            period=_enum_param(request, "period", Period) or Period.ALL,
            orientation=_enum_param(request, "orientation", Orientation)
            or Orientation.LANDSCAPE,
            locale=request.query_params.get("locale"),
            show_notes=show_notes,
            show_people=False,
            client_copy=not show_notes,
        )
    except ExportError as error:
        raise export_routes.refuse(error) from error
    return export_routes.as_response(document, fmt)


def _enum_param(request: Request, name: str, enum):
    """An enum value from a query string — or a 422 refusal.

    Parsed by hand, because both public routes are declared by one function: the
    FastAPI signatures it builds its validation from are absent here.
    """
    raw = request.query_params.get(name)
    if raw is None:
        return None
    try:
        return enum(raw)
    except ValueError:
        raise HTTPException(status_code=422, detail="validation_error") from None


@router.get(
    "/{org_slug}/{project_slug}/export.xlsx",
    summary="Export the project through a public link as an Excel workbook",
    responses=export_routes.FILE_RESPONSES["xlsx"],
    response_class=Response,
)
def public_export_xlsx(
    request: Request,
    shared: SharedProject = Depends(shared_project),
    db: DbSession = Depends(get_db),
) -> Response:
    return _export_shared(request, shared, db, "xlsx")


@router.get(
    "/{org_slug}/{project_slug}/export.pdf",
    summary="Export the project through a public link as a PDF document",
    responses=export_routes.FILE_RESPONSES["pdf"],
    response_class=Response,
)
def public_export_pdf(
    request: Request,
    shared: SharedProject = Depends(shared_project),
    db: DbSession = Depends(get_db),
) -> Response:
    return _export_shared(request, shared, db, "pdf")
