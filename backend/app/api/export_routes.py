"""Маршруты выгрузки проекта в Excel и PDF.

Свой файл по тому же правилу, что у скоркарда и предложения: у выгрузки свой
слой домена (`app/export`) и свой характер ответа — не JSON, а файл.

Состав файла выбирает человек, а масштаб ленты — правило (`app/export/budget`):
`zoom` можно не передавать, и тогда его считает сервер. Умолчание живёт здесь,
а не в окне экспорта, потому что маршрут зовут и мимо окна — закладкой,
скриптом, публичной ссылкой.
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

#: Потолок по числу задач. Сборка PDF — работа процессора, а на Vercel у
#: функции тридцать секунд: упереться в них молча хуже, чем честно отказать.
MAX_TASKS = 2000

#: Не больше стольких выгрузок в минуту с одного адреса. Счётчик в памяти, а
#: не в базе (app/throttle): выгрузка — не про безопасность, и переживать
#: перезапуск этому потолку незачем.
EXPORTS_PER_MINUTE = 10
_MINUTE = 60.0

_limiter: SlidingWindow | None = None


def export_limiter() -> SlidingWindow:
    global _limiter
    if _limiter is None:
        _limiter = SlidingWindow(limit=EXPORTS_PER_MINUTE, window=_MINUTE)
    return _limiter


def refuse(error: ExportError) -> HTTPException:
    """Отказ домена → отказ HTTP той же логикой, что у мутаций: несуществующее
    — 404, неисполнимое — 422."""
    if error.code == "export_label_missing":
        # Дырка в словаре — не вина спрашивающего: это поломка установки.
        return HTTPException(status_code=500, detail=error.code)
    return HTTPException(status_code=422, detail=error.code)


def _sections(raw: list[str] | None, *, client_copy: bool) -> frozenset[ExportSection]:
    """Что положить в файл.

    Пустой список — не «всё», а отказ: молча отдать всё в ответ на «ничего не
    выбрано» значило бы выдать клиенту разделы, которых он не просил.
    """
    if not raw:
        raise ExportError("export_empty_selection", "не выбран ни один раздел")
    try:
        sections = frozenset(ExportSection(value) for value in raw)
    except ValueError as error:
        # Публичные адреса разбирают строку запроса руками, и незнакомый
        # раздел доходит сюда живым значением. Для участника то же самое
        # отсекает схема FastAPI — но полагаться на неё одну нельзя: у отказа
        # должен быть один код на оба входа.
        raise ExportError("validation_error", f"неизвестный раздел: {error}") from error
    if client_copy:
        # Внутренние разделы не отказ, а вычет: клиент, попросивший историю
        # правок, получит файл без неё, а не пустой ответ.
        sections -= INTERNAL_SECTIONS
    if not sections:
        raise ExportError("export_empty_selection", "все выбранные разделы недоступны")
    return sections


def _today(project: Project, org: Organization) -> date:
    """Сегодня по таймзоне проекта, а не сервера: просрочка считается от даты,
    и на границе суток она у заказчика и у сервера разная."""
    try:
        tz = ZoneInfo(resolve_timezone(project, org))
    except (KeyError, ValueError):
        tz = ZoneInfo("UTC")
    return datetime.now(tz).date()


def _locale(request: Request, asked: str | None, profile: str | None) -> str:
    """Язык документа.

    Порядок: явно попрошенный в адресе (окно шлёт язык интерфейса, на котором
    человек сейчас смотрит на проект) → язык профиля → `Accept-Language` →
    язык установки. Профиль важнее заголовка по тому же правилу, что и везде
    в продукте: заголовок решает только при первом появлении человека
    (см. app/locales.py), дальше — только то, что он выбрал сам.
    """
    supported = get_settings().locales
    for candidate in (asked, profile):
        if candidate in supported:
            return candidate
    return locale_from_request(request.headers.get("accept-language"))


def _disposition(stem: str, extension: str) -> str:
    """Имя файла в заголовке — дважды: ASCII-заглушка для старых клиентов и
    RFC 5987 для настоящего имени. Имя проекта бывает кириллицей, а голый
    `filename=` её не переживает."""
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
    """Общее тело обоих форматов и обоих входов — участника и гостя по ссылке.

    Живёт здесь, а не в каждом маршруте: четыре маршрута с копией этой сборки
    разошлись бы первой же правкой, и разошлись бы именно в том, что видно
    клиенту.
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
            f"{len(document.tasks)} задач при потолке {MAX_TASKS}",
        )
    return document


def as_response(document: ExportDocument, fmt: str) -> Response:
    body = pdf.render(document) if fmt == "pdf" else xlsx.render(document)
    return Response(
        content=body,
        media_type=PDF_MIME if fmt == "pdf" else XLSX_MIME,
        headers={
            "Content-Disposition": _disposition(document.file_stem(), fmt),
            # Файл собран под конкретного спрашивающего и его права — общий
            # кэш посередине отдал бы внутренние заметки клиенту.
            "Cache-Control": "private, no-store",
        },
    )


#: Описание ответа для снимка OpenAPI: без него FastAPI объявил бы, что
#: маршрут отдаёт JSON, и генератор типов на фронте поверил бы ему. Открыто
#: наружу — тем же описанием пользуются публичные адреса (public_routes).
FILE_RESPONSES = {
    "xlsx": {200: {"content": {XLSX_MIME: {"schema": {"type": "string", "format": "binary"}}}}},
    "pdf": {200: {"content": {PDF_MIME: {"schema": {"type": "string", "format": "binary"}}}}},
}


@router.get("/{project_id}/export/facts", summary="Что в проекте есть для выгрузки")
def export_facts(
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
) -> dict:
    """Чем наполнены разделы — чтобы окно не предлагало пустых.

    Отдельный маршрут, а не поля в состоянии проекта: эти числа нужны раз в
    жизни экрана, при открытии окна, а состояние проекта читается на каждый
    кадр ленты. Заодно отсюда приходят границы плана и «сегодня» по таймзоне
    проекта — те самые, от которых сервер считает страницы, так что число на
    кнопке масштаба не может разойтись с числом в файле.
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
    # Конец плана — по последней задаче; точная дата окончания считается
    # календарём, но для оценки числа страниц хватает старта: разница в
    # несколько дней не переводит масштаб через границу.
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
    """Один обработчик на оба формата: они различаются ровно рисовальщиком."""

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
        # Клиентский экземпляр — не отдельная ветка сборки, а те же два флага,
        # что уже решают состав публичной страницы.
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
    summary="Выгрузить проект книгой Excel",
    responses=FILE_RESPONSES["xlsx"],
    response_class=Response,
)
router.add_api_route(
    "/{project_id}/export.pdf",
    _export("pdf"),
    methods=["GET"],
    summary="Выгрузить проект документом PDF",
    responses=FILE_RESPONSES["pdf"],
    response_class=Response,
)


@router.get(
    "/{project_id}/proposal/export.pdf",
    summary="Скачать коммерческое предложение документом для клиента",
    responses=FILE_RESPONSES["pdf"],
    response_class=Response,
)
def export_proposal_pdf(
    request: Request,
    locale: str | None = Query(default=None),
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
) -> Response:
    """Предложение целиком одним файлом — тем, что уйдёт клиенту.

    Не раздел общей выгрузки, а свой документ: у него другой читатель и другой
    состав (см. app/export/proposal_pdf.py). Два права: читать предложение —
    у клиента и гостя его нет, им обещаны сроки, а не ставки; и выносить
    файлом — тот же рычаг, что у выгрузки проекта. Счётчик выгрузок общий:
    для сервера это такая же сборка PDF.
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
            # Дата документа — сегодня по таймзоне проекта: собственной даты
            # отправки у предложения нет.
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
