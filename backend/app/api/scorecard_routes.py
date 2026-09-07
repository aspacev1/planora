"""Маршруты скоркарда проекта.

Свой файл по тому же правилу, что у предложения: у скоркарда свой слой домена
(app/scorecard) и свой характер записи — снимки и конфиги метрик живут вне
журнала ревизий; через слой мутаций ходит только задача, создаваемая правилом
«красная 2 недели подряд», и это делает сам домен.

Чтение — у всякого, кто видит проект, и оно с побочным эффектом: первый GET
после границы недели дозаписывает недельные снимки (ленивая фиксация — см.
app.scorecard). Запись (пересчёт, настройка метрик) — право записи в проект.
"""

import uuid
from datetime import date

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DbSession

from app.access import Action
from app.api.deps import ProjectContext, project_context
from app.db import get_db
from app.live import hub
from app.scorecard import (
    DEFAULT_WEEKS,
    ScorecardError,
    metric_tasks,
    patch_metric,
    scorecard_state,
)
from app.throttle import hit

router = APIRouter(prefix="/api/projects", tags=["scorecard"])

#: Пересчитывать чаще минуты бессмысленно — кэш текущей недели и так пять
#: минут, а кнопка не должна превращаться в способ грузить базу.
RECALC_LIMIT_PER_MINUTE = 1


class ScorecardMetricPatch(BaseModel):
    """Правка метрики: присланные поля меняются, остальные не трогаются.

    owner_user_id принимает явный null — «снять владельца»; отличие «не
    прислано» от «прислано null» делает exclude_unset в маршруте.
    """

    owner_user_id: uuid.UUID | None = None
    target_value: float | None = Field(default=None, ge=0, le=99_999_999)
    enabled: bool | None = None


def _refuse(error: ScorecardError) -> HTTPException:
    """Отказ домена → отказ HTTP той же логикой, что у мутаций: чужая или
    несуществующая сущность — 404, всё остальное — 422."""
    if error.code == "metric_not_found":
        return HTTPException(status_code=404, detail=error.code)
    return HTTPException(status_code=422, detail=error.code)


def _publish(
    background: BackgroundTasks, db: DbSession, project_id: uuid.UUID, event: dict
) -> None:
    # Тот же порядок, что у мутаций: сперва коммит, затем рассылка.
    db.commit()
    background.add_task(hub.publish, project_id, event)


#: Событие для соседних вкладок: «скоркард изменился, перечитай».
_CHANGED = {"type": "scorecard"}


def _visibility(context: ProjectContext) -> dict:
    """Что из разреза по людям положено этому читателю. Решается здесь, по
    матрице прав, — клиент получает уже урезанный ответ."""
    return {
        "include_team": context.can(Action.TEAM_PACE_READ),
        "include_assessment": context.can(Action.TEAM_ASSESSMENT_READ),
    }


@router.get("/{project_id}/scorecard")
def get_project_scorecard(
    weeks: int = Query(default=DEFAULT_WEEKS, ge=1, le=26),
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    """Скоркард целиком: метрики с историей, события, качество данных.

    Побочный эффект — ленивая фиксация недель: планировщика в архитектуре
    нет, и дозаписывает снимки первый читатель после границы недели.
    """
    return scorecard_state(
        db, context.project, context.org, weeks=weeks, **_visibility(context)
    )


@router.post("/{project_id}/scorecard/recalculate")
def recalculate_project_scorecard(
    background: BackgroundTasks,
    weeks: int = Query(default=DEFAULT_WEEKS, ge=1, le=26),
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    """Пересчёт текущей недели мимо кэша. Только текущей: прошлые снимки
    неизменяемы, и никакая кнопка их не трогает."""
    context.require(Action.PROJECT_WRITE)
    if not hit(
        db,
        f"scorecard_recalc:{context.project.id}",
        limit=RECALC_LIMIT_PER_MINUTE,
        window_seconds=60,
    ):
        raise HTTPException(status_code=429, detail="rate_limited")
    state = scorecard_state(
        db, context.project, context.org, weeks=weeks,
        actor_id=context.user.id, force=True, **_visibility(context),
    )
    _publish(background, db, context.project.id, _CHANGED)
    return state


@router.patch("/{project_id}/scorecard/metrics/{metric_key}")
def update_scorecard_metric(
    metric_key: str,
    payload: ScorecardMetricPatch,
    background: BackgroundTasks,
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    """Настройка метрики этого проекта: владелец, цель, включённость.

    Направление не правится — оно жёстко следует из ключа. После правки
    текущая неделя пересчитывается сразу: статус зависит от цели, и экран не
    должен показывать старый цвет при новой цели.
    """
    context.require(Action.PROJECT_WRITE)
    changes = payload.model_dump(exclude_unset=True)
    try:
        patch_metric(db, context.project, context.org, metric_key, changes)
    except ScorecardError as error:
        raise _refuse(error)
    state = scorecard_state(
        db, context.project, context.org, actor_id=context.user.id, force=True,
        **_visibility(context),
    )
    _publish(background, db, context.project.id, _CHANGED)
    return state


@router.get("/{project_id}/scorecard/metrics/{metric_key}/tasks")
def get_scorecard_metric_tasks(
    metric_key: str,
    week: date | None = Query(default=None),
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    """Drill-down метрики: задачи недели. Прошлые недели — из снимка,
    текущая — живой расчёт без записи."""
    try:
        return metric_tasks(db, context.project, context.org, metric_key, week)
    except ScorecardError as error:
        raise _refuse(error)
