"""Routes for exporting a project to Excel and PDF.

Its own file by the same rule as the scorecard and the proposal: the export has
its own domain layer (`app/export`) and its own kind of answer — a file rather
than JSON.

A person chooses the file's contents, while the chart's scale is chosen by a
rule (`app/export/budget`): `zoom` may be omitted, and then the server computes
it. The default lives here rather than in the export dialog, because the route
is also called from outside the dialog — by a bookmark, a script, a public link.
"""

from datetime import date, datetime
from urllib.parse import quote
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from app.access import Action
from app.api.deps import ProjectContext, project_context
from app.config import get_settings
from app.db import get_db
from app.export import pdf, proposal_pdf, xlsx
from app.export.budget import Orientation, Period, Zoom
from app.export.document import (
    INTERNAL_SECTIONS,
    ExportDocument,
    ExportSection,
    build_document,
)
from app.export.errors import ExportError
from app.locales import locale_from_request
from app.models import (
    Category,
    Comment,
    Dependency,
    Organization,
    Project,
    Proposal,
    ProposalCategory,
    ProposalTask,
    Revision,
    ScheduleMode,
    ScorecardMetric,
    Task,
)
from app.rate_limit import SlidingWindow, client_key
from app.settings_resolution import resolve_timezone

router = APIRouter(prefix="/api/projects", tags=["export"])

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
PDF_MIME = "application/pdf"

#: A ceiling on the number of tasks. Assembling a PDF is processor work, and on
#: Vercel a function has thirty seconds: hitting them silently is worse than
#: refusing honestly.
MAX_TASKS = 2000

#: No more than this many exports per minute from one address. The counter lives
#: in memory rather than in the database (app/throttle): an export is not about
#: security, and this ceiling has no reason to survive a restart.
EXPORTS_PER_MINUTE = 10
_MINUTE = 60.0

_limiter: SlidingWindow | None = None


def export_limiter() -> SlidingWindow:
    global _limiter
    if _limiter is None:
        _limiter = SlidingWindow(limit=EXPORTS_PER_MINUTE, window=_MINUTE)
    return _limiter


def refuse(error: ExportError) -> HTTPException:
    """A domain refusal becomes an HTTP refusal by the same logic as mutations:
    a nonexistent thing is a 404, an unfeasible one is a 422."""
    if error.code == "export_label_missing":
        # A hole in the dictionary is not the caller's fault: it is a broken installation.
        return HTTPException(status_code=500, detail=error.code)
    return HTTPException(status_code=422, detail=error.code)


def _sections(raw: list[str] | None, *, client_copy: bool) -> frozenset[ExportSection]:
    """What to put into the file.

    An empty list is not "everything" but a refusal: silently returning
    everything in answer to "nothing was selected" would mean handing the client
    sections they did not ask for.
    """
    if not raw:
        raise ExportError("export_empty_selection", "no section was selected")
    try:
        sections = frozenset(ExportSection(value) for value in raw)
    except ValueError as error:
        # The public addresses parse the query string by hand, and an unknown
        # section arrives here as a live value. For a member the same thing is cut
        # off by the FastAPI schema — but relying on that alone will not do: a
        # refusal must have one code for both entrances.
        raise ExportError("validation_error", f"unknown section: {error}") from error
    if client_copy:
        # Internal sections are not a refusal but a deduction: a client who asked
        # for the edit history gets a file without it rather than an empty answer.
        sections -= INTERNAL_SECTIONS
    if not sections:
        raise ExportError("export_empty_selection", "every selected section is unavailable")
    return sections


def _today(project: Project, org: Organization) -> date:
    """Today in the project's timezone, not the server's: being overdue is
    counted from a date, and at the day boundary it differs between the orderer
    and the server."""
    try:
        tz = ZoneInfo(resolve_timezone(project, org))
    except (KeyError, ValueError):
        tz = ZoneInfo("UTC")
    return datetime.now(tz).date()


def _locale(request: Request, asked: str | None, profile: str | None) -> str:
    """The document's language.

    The order: explicitly asked for in the address (the dialog sends the
    interface language the person is currently looking at the project in) -> the
    profile's language -> `Accept-Language` -> the installation's language. The
    profile outranks the header by the same rule as everywhere else in the
    product: the header decides only on a person's first appearance (see
    app/locales.py), and after that only what they chose themselves.
    """
    supported = get_settings().locales
    for candidate in (asked, profile):
        if candidate in supported:
            return candidate
    return locale_from_request(request.headers.get("accept-language"))


def _disposition(stem: str, extension: str) -> str:
    """The file name in the header — twice: an ASCII placeholder for old clients
    and RFC 5987 for the real name. A project name is sometimes in Cyrillic, and
    a bare `filename=` does not survive it."""
    name = f"{stem}.{extension}"
    fallback = name.encode("ascii", "replace").decode("ascii").replace("?", "_")
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(name)}"


def build(
    db: DbSession,
    project: Project,
    org: Organization,
    *,
    request: Request,
    sections_raw: list[str] | None,
    zoom: Zoom | None,
    period: Period,
    orientation: Orientation,
    locale: str | None,
    profile_locale: str | None = None,
    show_notes: bool,
    show_people: bool,
    client_copy: bool,
) -> ExportDocument:
    """The shared body of both formats and both entrances — a member and a guest with a link.

    It lives here rather than in every route: four routes with a copy of this
    assembly would drift apart on the first edit, and would drift apart in
    exactly what the client sees.
    """
    if not export_limiter().allow(client_key(request)):
        raise HTTPException(status_code=429, detail="rate_limited")

    sections = _sections(sections_raw, client_copy=client_copy)
    chosen_locale = _locale(request, locale, profile_locale)

    document = build_document(
        db,
        project,
        org,
        sections=sections,
        locale=chosen_locale,
        show_notes=show_notes,
        show_people=show_people,
        client_copy=client_copy,
        today=_today(project, org),
        period=period,
        zoom=zoom,
        orientation=orientation,
    )
    if len(document.tasks) > MAX_TASKS:
        raise ExportError(
            "export_too_large",
            f"{len(document.tasks)} tasks against a ceiling of {MAX_TASKS}",
        )
    return document


def as_response(document: ExportDocument, fmt: str) -> Response:
    body = pdf.render(document) if fmt == "pdf" else xlsx.render(document)
    return Response(
        content=body,
        media_type=PDF_MIME if fmt == "pdf" else XLSX_MIME,
        headers={
            "Content-Disposition": _disposition(document.file_stem(), fmt),
            # The file is assembled for a specific caller and their permissions —
            # a shared cache in between would hand internal notes to a client.
            "Cache-Control": "private, no-store",
        },
    )


#: The response description for the OpenAPI snapshot: without it FastAPI would
#: declare that the route returns JSON, and the type generator on the frontend
#: would believe it. Exposed outward — the public addresses (public_routes) use
#: the same description.
FILE_RESPONSES = {
    "xlsx": {200: {"content": {XLSX_MIME: {"schema": {"type": "string", "format": "binary"}}}}},
    "pdf": {200: {"content": {PDF_MIME: {"schema": {"type": "string", "format": "binary"}}}}},
}


@router.get("/{project_id}/export/facts", summary="What the project holds for export")
def export_facts(
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
) -> dict:
    """What the sections contain — so that the dialog does not offer empty ones.

    A separate route rather than fields in the project's state: these numbers are
    needed once in a screen's lifetime, when the dialog opens, while the
    project's state is read for every frame of the chart. The plan's bounds and
    "today" in the project's timezone come from here too — the very ones the
    server counts pages from, so the number on the scale button cannot diverge
    from the number in the file.
    """
    context.require(Action.PROJECT_EXPORT)
    internal = context.can(Action.READ_INTERNAL_NOTE)
    return facts(db, context.project, context.org, internal_allowed=internal)


def facts(
    db: DbSession, project: Project, org: Organization, *, internal_allowed: bool
) -> dict:
    def count(model, *where) -> int:
        return db.scalar(select(func.count()).select_from(model).where(*where)) or 0

    bounds = db.execute(
        select(func.min(Task.start_date), func.max(Task.start_date)).where(
            Task.project_id == project.id
        )
    ).one()
    today = _today(project, org)
    start, last_start = bounds
    # The plan's end comes from the last task; the exact finish date is computed
    # by the calendar, but the start is enough to estimate the number of pages: a
    # difference of a few days does not push the scale across a boundary.
    end = max(last_start, start) if start else today

    comments = count(
        Comment,
        Comment.project_id == project.id,
        *([] if internal_allowed else [Comment.internal.is_(False)]),
    )
    return {
        "start": (start or today).isoformat(),
        "end": end.isoformat(),
        "today": today.isoformat(),
        "dated": project.schedule_mode == ScheduleMode.CALENDAR,
        "tasks": count(Task, Task.project_id == project.id),
        "categories": count(Category, Category.project_id == project.id),
        "links": count(Dependency, Dependency.project_id == project.id),
        "comments": comments,
        "proposal_lines": db.scalar(
            select(func.count())
            .select_from(ProposalTask)
            .join(ProposalCategory, ProposalCategory.id == ProposalTask.category_id)
            .join(Proposal, Proposal.id == ProposalCategory.proposal_id)
            .where(Proposal.project_id == project.id)
        )
        or 0,
        "scorecard_metrics": count(
            ScorecardMetric,
            ScorecardMetric.project_id == project.id,
            ScorecardMetric.enabled.is_(True),
        ),
        "history_events": (
            count(Revision, Revision.project_id == project.id) if internal_allowed else 0
        ),
        "internal_allowed": internal_allowed,
    }


def _export(fmt: str):
    """One handler for both formats: they differ in exactly the renderer."""

    def handler(
        request: Request,
        include: list[ExportSection] = Query(default=None),
        zoom: Zoom | None = Query(default=None),
        period: Period = Query(default=Period.ALL),
        orientation: Orientation = Query(default=Orientation.LANDSCAPE),
        locale: str | None = Query(default=None),
        context: ProjectContext = Depends(project_context),
        db: DbSession = Depends(get_db),
    ) -> Response:
        context.require(Action.PROJECT_EXPORT)
        # The client copy is not a separate assembly branch but the same two
        # flags that already decide the contents of the public page.
        show_notes = context.can(Action.READ_INTERNAL_NOTE)
        client_copy = not show_notes
        try:
            document = build(
                db,
                context.project,
                context.org,
                request=request,
                sections_raw=[section.value for section in include] if include else None,
                zoom=zoom,
                period=period,
                orientation=orientation,
                locale=locale,
                profile_locale=context.user.locale,
                show_notes=show_notes,
                show_people=show_notes,
                client_copy=client_copy,
            )
        except ExportError as error:
            raise refuse(error) from error
        return as_response(document, fmt)

    handler.__name__ = f"export_project_{fmt}"
    return handler


router.add_api_route(
    "/{project_id}/export.xlsx",
    _export("xlsx"),
    methods=["GET"],
    summary="Export the project as an Excel workbook",
    responses=FILE_RESPONSES["xlsx"],
    response_class=Response,
)
router.add_api_route(
    "/{project_id}/export.pdf",
    _export("pdf"),
    methods=["GET"],
    summary="Export the project as a PDF document",
    responses=FILE_RESPONSES["pdf"],
    response_class=Response,
)


@router.get(
    "/{project_id}/proposal/export.pdf",
    summary="Download the commercial proposal as a document for the client",
    responses=FILE_RESPONSES["pdf"],
    response_class=Response,
)
def export_proposal_pdf(
    request: Request,
    locale: str | None = Query(default=None),
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
) -> Response:
    """The whole proposal as one file — the one that will go to the client.

    Not a section of the general export but a document of its own: it has a
    different reader and different contents (see app/export/proposal_pdf.py). Two
    permissions: reading the proposal — which a client and a guest do not have,
    since they were promised deadlines, not rates; and carrying it out as a file
    — the same lever as the project export. The export counter is shared: for the
    server this is the same kind of PDF assembly.
    """
    context.require(Action.PROPOSAL_READ)
    context.require(Action.PROJECT_EXPORT)
    if not export_limiter().allow(client_key(request)):
        raise HTTPException(status_code=429, detail="rate_limited")
    try:
        document = proposal_pdf.build_document(
            db,
            context.project,
            context.org,
            locale=_locale(request, locale, context.user.locale),
            # The document's date is today in the project's timezone: a proposal
            # has no send date of its own.
            issued=_today(context.project, context.org),
        )
    except ExportError as error:
        raise refuse(error) from error
    return Response(
        content=proposal_pdf.render(document),
        media_type=PDF_MIME,
        headers={
            "Content-Disposition": _disposition(document.file_stem(), "pdf"),
            "Cache-Control": "private, no-store",
        },
    )
