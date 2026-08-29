"""Публичная страница проекта: чтение по ссылке и гостевые комментарии.

Единственная часть API, которая работает без сессии. Отсюда три правила,
которые в этом файле не обсуждаются, а соблюдаются:

1. Право спрашивается у `access.py` с ролью `None` — гость. Ссылка и есть тот
   самый грант на проект, о котором знает матрица прав; собственных решений
   «гостю можно вот это» здесь нет.
2. Внутренние заметки и состав организации наружу не выходят вовсе
   (см. `project_state`).
3. Отказ всегда один и тот же — 404 `link_not_found`. Отличать «нет такого
   проекта» от «ссылка отозвана» нельзя: разница превращает адрес в способ
   перебирать чужие проекты по слагам.
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
    """Счётчик гостевых комментариев, собранный по первому требованию.

    Не на уровне модуля: `GUEST_COMMENT_RATE_LIMIT` читается из настроек, а
    настройки на момент импорта могут быть ещё не собраны — и тогда потолок
    навсегда застыл бы на значении по умолчанию.
    """
    global _guest_comments
    if _guest_comments is None:
        _guest_comments = SlidingWindow(
            limit=get_settings().guest_comment_rate_limit, window=_HOUR
        )
    return _guest_comments


# client_key переехал в app.rate_limit: тем же способом считаются и вход с
# регистрацией (app.api.auth_routes), а не только гостевые комментарии.


class GuestCommentIn(BaseModel):
    # Имя гостя — обязательное поле: неподписанная реплика на публичной
    # странице неотличима от чужой.
    name: str = Field(min_length=1, max_length=80)
    body: str = Field(min_length=1)
    task_id: uuid.UUID | None = None


class SharedProject:
    """Проект, открытый по действующей ссылке."""

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
        # Матрица прав — единственное место, где решается «можно ли»: если
        # гостю однажды закроют чтение, этот маршрут закроется вместе с ней,
        # а не останется дырой, о которой все забыли.
        raise HTTPException(status_code=404, detail="link_not_found")
    return SharedProject(*found)


@router.get("/{org_slug}/{project_slug}")
def public_project(
    shared: SharedProject = Depends(shared_project), db: DbSession = Depends(get_db)
):
    """Та же раскладка, что и на рабочем экране, но без внутренних заметок и
    без исполнителей."""
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
        # Название организации подписывает страницу: гость должен видеть, чей
        # это план, прежде чем что-то в нём комментировать.
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
    """Лента видна и при выключенных комментариях.

    Выключенные комментарии — это запрет писать, а не приказ спрятать уже
    сказанное: разговор, который клиент видел вчера, не должен исчезнуть от
    щелчка переключателем.

    Внутренние реплики гость не видит: это разговор команды «в сторону»,
    а не часть публичной страницы.
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
    """Счётчик реплик на строках публичной ленты — без внутренних.

    Тот же фильтр, что и у ленты выше: гость внутренних реплик не видит, и
    число рядом с задачей не должно проговариваться о том, чего в его ленте
    нет вовсе.
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


# --- выгрузка по публичной ссылке ---------------------------------------------
#
# Гость получает клиентский экземпляр: без внутренних заметок, исполнителей,
# базового плана и журнала правок. Ровно тот же урез, что и на странице выше, —
# и он не повторён здесь руками, а выведен из матрицы прав теми же двумя
# флагами, что передаются в project_state.


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
    """Значение перечислимого из строки запроса — или отказ 422.

    Разбирается вручную, потому что оба публичных маршрута объявлены одной
    функцией: подписи FastAPI, из которых он строит проверку, здесь нет.
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
    summary="Выгрузить проект по публичной ссылке книгой Excel",
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
    summary="Выгрузить проект по публичной ссылке документом PDF",
    responses=export_routes.FILE_RESPONSES["pdf"],
    response_class=Response,
)
def public_export_pdf(
    request: Request,
    shared: SharedProject = Depends(shared_project),
    db: DbSession = Depends(get_db),
) -> Response:
    return _export_shared(request, shared, db, "pdf")
