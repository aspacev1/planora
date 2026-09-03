"""Маршруты коммерческого предложения.

Свой файл, а не хвост project_routes: у предложения свой слой домена
(app/proposals) и свой характер записи — правки без журнала ревизий, как у
комментариев. Единственный маршрут, который трогает план, — перенос строк в
задачи, и он один ходит в слой мутаций.

Читать предложение вправе не всякий, кто читает проект: клиент и гость по
ссылке видят план, но не смету с её ставками и рисками (см.
Action.PROPOSAL_READ). Поэтому чтение здесь проверяется явно, а не
наследуется от project_context.
"""

import uuid
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.access import Action
from app.api.deps import ProjectContext, project_context
from app.db import get_db
from app.live import hub
from app.models import ProposalComment, User
from app.mutations import MutationError, NotFoundInProject
from app.proposals import (
    ProposalError,
    add_category,
    add_task,
    add_task_comment,
    ensure_proposal,
    get_proposal,
    require_category,
    list_task_comments,
    proposal_state,
    push_to_plan,
    require_task,
)

router = APIRouter(prefix="/api/projects", tags=["proposal"])


class ProposalSettingsIn(BaseModel):
    """Настройки сметы. Каждое поле — по желанию: правится то, что прислано."""

    effort_unit: Literal["days", "hours"] | None = None
    hours_per_day: int | None = Field(default=None, ge=1, le=24)
    tax_rate_pct: float | None = Field(default=None, ge=0, le=100)
    currency: str | None = Field(default=None, min_length=3, max_length=3)
    #: Допущения и примечания предложения целиком. Пустая строка — стереть;
    #: None — не трогать.
    notes: str | None = None


class ProposalCategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""


class ProposalCategoryPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None


class ProposalTaskIn(BaseModel):
    name: str = Field(min_length=1, max_length=300)


class ProposalTaskPatch(BaseModel):
    """Правка строки: присланные поля меняются, остальные не трогаются.

    Потолки чисел повторяют ширину колонок Numeric: значение шире уехало бы
    в базу ошибкой усечения — пятисоткой вместо честного отказа.
    """

    name: str | None = Field(default=None, min_length=1, max_length=300)
    description: str | None = None
    details: str | None = None
    role: str | None = Field(default=None, max_length=120)
    effort: float | None = Field(default=None, ge=0, le=999_999)
    rate: float | None = Field(default=None, ge=0, le=9_999_999_999)
    notes: str | None = None
    risks: str | None = None
    assumptions: str | None = None


class ProposalCommentIn(BaseModel):
    body: str = Field(min_length=1)


def _refuse(error: ProposalError | MutationError) -> HTTPException:
    """Отказ домена → отказ HTTP, той же логикой, что у мутаций: чужая или
    несуществующая сущность — 404, всё остальное — 422."""
    if isinstance(error, NotFoundInProject) or error.code in {
        "proposal_category_not_found",
        "proposal_task_not_found",
    }:
        return HTTPException(status_code=404, detail=error.code)
    return HTTPException(status_code=422, detail=error.code)


def _publish(
    background: BackgroundTasks, db: DbSession, project_id: uuid.UUID, event: dict
) -> None:
    # Тот же порядок, что у мутаций: сперва коммит, затем рассылка — получив
    # сигнал, клиент перечитывает данные и до коммита перечитал бы старое.
    db.commit()
    background.add_task(hub.publish, project_id, event)


#: Событие для соседних вкладок: «предложение изменилось, перечитай».
#: Текст не рассылается — клиент дочитает по HTTP, как и у комментариев.
_CHANGED = {"type": "proposal"}


@router.get("/{project_id}/proposal")
def get_project_proposal(
    context: ProjectContext = Depends(project_context), db: DbSession = Depends(get_db)
):
    """Предложение целиком: настройки, разделы, строки со счётчиками реплик.

    Итоги (сумма, налог, всего) считает клиент: это произведение и сумма уже
    присланных чисел, и сервер, пересказывающий их, был бы вторым местом с
    той же арифметикой.
    """
    context.require(Action.PROPOSAL_READ)
    return proposal_state(db, context.project)


@router.patch("/{project_id}/proposal")
def update_proposal_settings(
    payload: ProposalSettingsIn,
    background: BackgroundTasks,
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    context.require(Action.PROJECT_WRITE)
    proposal = ensure_proposal(db, context.project)
    changes = payload.model_dump(exclude_unset=True, exclude_none=True)
    if "effort_unit" in changes:
        proposal.effort_unit = changes["effort_unit"]
    if "hours_per_day" in changes:
        proposal.hours_per_day = changes["hours_per_day"]
    if "tax_rate_pct" in changes:
        # Decimal из строки, а не из float: Decimal(0.1) — это
        # 0.1000000000000000055…, и налог перестал бы быть круглым.
        proposal.tax_rate_pct = Decimal(str(changes["tax_rate_pct"]))
    if "currency" in changes:
        proposal.currency = changes["currency"].upper()
    if "notes" in changes:
        proposal.notes = changes["notes"]
    db.flush()
    _publish(background, db, context.project.id, _CHANGED)
    return proposal_state(db, context.project)


@router.post("/{project_id}/proposal/categories", status_code=201)
def create_proposal_category(
    payload: ProposalCategoryIn,
    background: BackgroundTasks,
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    context.require(Action.PROJECT_WRITE)
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="validation_error")
    category = add_category(
        db, ensure_proposal(db, context.project), name, payload.description
    )
    response = {"id": str(category.id), "name": category.name, "position": category.position}
    _publish(background, db, context.project.id, _CHANGED)
    return response


@router.patch("/{project_id}/proposal/categories/{category_id}")
def update_proposal_category(
    category_id: uuid.UUID,
    payload: ProposalCategoryPatch,
    background: BackgroundTasks,
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    context.require(Action.PROJECT_WRITE)
    changes = payload.model_dump(exclude_unset=True, exclude_none=True)
    if "name" in changes and not changes["name"].strip():
        raise HTTPException(status_code=422, detail="validation_error")
    try:
        category = require_category(db, ensure_proposal(db, context.project), category_id)
    except ProposalError as error:
        raise _refuse(error)
    if "name" in changes:
        category.name = changes["name"].strip()
    if "description" in changes:
        category.description = changes["description"]
    db.flush()
    response = {"id": str(category.id), "name": category.name, "position": category.position}
    _publish(background, db, context.project.id, _CHANGED)
    return response


@router.delete("/{project_id}/proposal/categories/{category_id}", status_code=204)
def delete_proposal_category(
    category_id: uuid.UUID,
    background: BackgroundTasks,
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    """Удаляет раздел вместе со строками: смета — черновик, и правило плана
    «сначала вынеси задачи» здесь было бы ритуалом без выгоды."""
    context.require(Action.PROJECT_WRITE)
    try:
        category = require_category(db, ensure_proposal(db, context.project), category_id)
    except ProposalError as error:
        raise _refuse(error)
    db.delete(category)
    db.flush()
    _publish(background, db, context.project.id, _CHANGED)


@router.post("/{project_id}/proposal/categories/{category_id}/tasks", status_code=201)
def create_proposal_task(
    category_id: uuid.UUID,
    payload: ProposalTaskIn,
    background: BackgroundTasks,
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    context.require(Action.PROJECT_WRITE)
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="validation_error")
    try:
        task = add_task(db, ensure_proposal(db, context.project), category_id, name)
    except ProposalError as error:
        raise _refuse(error)
    response = {"id": str(task.id), "category_id": str(task.category_id), "name": task.name}
    _publish(background, db, context.project.id, _CHANGED)
    return response


@router.patch("/{project_id}/proposal/tasks/{task_id}")
def update_proposal_task(
    task_id: uuid.UUID,
    payload: ProposalTaskPatch,
    background: BackgroundTasks,
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    context.require(Action.PROJECT_WRITE)
    try:
        task = require_task(db, get_proposal(db, context.project), task_id)
    except ProposalError as error:
        raise _refuse(error)
    changes = payload.model_dump(exclude_unset=True, exclude_none=True)
    if "name" in changes and not changes["name"].strip():
        raise HTTPException(status_code=422, detail="validation_error")
    for field in ("name", "description", "details", "role", "notes", "risks", "assumptions"):
        if field in changes:
            setattr(task, field, changes[field].strip() if field == "name" else changes[field])
    for field in ("effort", "rate"):
        if field in changes:
            setattr(task, field, Decimal(str(changes[field])))
    db.flush()
    _publish(background, db, context.project.id, _CHANGED)
    return proposal_state(db, context.project)


@router.delete("/{project_id}/proposal/tasks/{task_id}", status_code=204)
def delete_proposal_task(
    task_id: uuid.UUID,
    background: BackgroundTasks,
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    context.require(Action.PROJECT_WRITE)
    try:
        task = require_task(db, get_proposal(db, context.project), task_id)
    except ProposalError as error:
        raise _refuse(error)
    db.delete(task)
    db.flush()
    _publish(background, db, context.project.id, _CHANGED)


@router.get("/{project_id}/proposal/tasks/{task_id}/comments")
def list_proposal_task_comments(
    task_id: uuid.UUID,
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    context.require(Action.PROPOSAL_READ)
    try:
        comments = list_task_comments(db, get_proposal(db, context.project), task_id)
    except ProposalError as error:
        raise _refuse(error)
    names = {
        user.id: user.name
        for user in db.scalars(
            select(User).where(User.id.in_({c.author_user_id for c in comments}))
        ).all()
    }
    return [_comment_out(comment, names) for comment in comments]


@router.post("/{project_id}/proposal/tasks/{task_id}/comments", status_code=201)
def create_proposal_task_comment(
    task_id: uuid.UUID,
    payload: ProposalCommentIn,
    background: BackgroundTasks,
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    # Обе проверки: реплику к строке пишет тот, кто вправе и комментировать,
    # и видеть смету. Одного COMMENT мало — он есть и у клиента.
    context.require(Action.PROPOSAL_READ)
    context.require(Action.COMMENT)
    try:
        comment = add_task_comment(
            db, get_proposal(db, context.project), task_id, context.user, payload.body
        )
    except ProposalError as error:
        raise _refuse(error)
    response = _comment_out(comment, {context.user.id: context.user.name})
    _publish(background, db, context.project.id, _CHANGED)
    return response


def _comment_out(comment: ProposalComment, names: dict[uuid.UUID, str]) -> dict:
    # Та же форма, что у ленты проекта (comments_out): клиент рисует обе одним
    # компонентом, и вторая форма означала бы вторую ленту.
    return {
        "id": str(comment.id),
        "task_id": str(comment.proposal_task_id),
        "author": {"name": names.get(comment.author_user_id, ""), "guest": False},
        "body": comment.body,
        "created_at": comment.created_at.isoformat(),
    }


@router.post("/{project_id}/proposal/push-to-plan", status_code=201)
def push_proposal_to_plan(
    background: BackgroundTasks,
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    """Переносит смету в план: раздел — категорией, строка — задачей.

    Пачка ревизий с общим batch_id: в истории перенос читается одной записью
    и снимается одной отменой. Задачи встают на старт плана — раскладку по
    оси человек делает сам.
    """
    context.require(Action.PROJECT_WRITE)
    try:
        result = push_to_plan(db, context.project, context.user.id)
    except (ProposalError, MutationError) as error:
        raise _refuse(error)
    # Ревизии уже в журнале — соседям достаточно факта «план изменился»:
    # состояние они перечитывают целиком, как и после обычной мутации.
    _publish(background, db, context.project.id, {"type": "revision"})
    return result
