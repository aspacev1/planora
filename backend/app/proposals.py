"""Коммерческое предложение проекта: смета до плана.

Предложение — черновик сделки, а не состояние плана: его правки не имеют
обратных операций, не попадают в журнал ревизий и не двигают диаграмму.
Поэтому оно живёт своим модулем — тем же образом, что и комментарии, — а не
ветками в реестре операций, где обязателен `inverse`.

Единственное место, где предложение касается плана, — перенос строк сметы в
задачи диаграммы (push_to_plan). Он как раз идёт через слой мутаций одной
пачкой: созданные задачи — уже состояние плана, и человек вправе отменить
перенос одной кнопкой.
"""

import math
import uuid
from collections.abc import Iterable
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from app.export.labels import term

from app.models import (
    Category,
    Project,
    Proposal,
    ProposalCategory,
    ProposalComment,
    ProposalTask,
    Task,
    User,
)
from app.mutations import CreateCategory, CreateTask, apply_op
from app.schedule import RELATIVE_EPOCH


class ProposalError(Exception):
    """Отказ предложения — машинным кодом, как у мутаций и комментариев."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def get_proposal(db: DbSession, project: Project) -> Proposal | None:
    return db.scalar(select(Proposal).where(Proposal.project_id == project.id))


def ensure_proposal(db: DbSession, project: Project) -> Proposal:
    """Строка предложения — при первом изменении, а не при создании проекта.

    Гонку двух первых правок разрешает блокировка строки проекта: обе правки
    берут её раньше, чем спрашивают о предложении, и вторая находит строку,
    созданную первой. Тот же замок, что у мутаций, — предложение принадлежит
    проекту, и второго замка для него не нужно.
    """
    db.execute(select(Project.id).where(Project.id == project.id).with_for_update())
    proposal = get_proposal(db, project)
    if proposal is None:
        proposal = Proposal(project_id=project.id)
        db.add(proposal)
        db.flush()
    return proposal


def require_category(
    db: DbSession, proposal: Proposal, category_id: uuid.UUID
) -> ProposalCategory:
    # Раздел чужого предложения неотличим от несуществующего — тем же
    # принципом, что у задач в маршрутах мутаций.
    category = db.get(ProposalCategory, category_id)
    if category is None or category.proposal_id != proposal.id:
        raise ProposalError("proposal_category_not_found", "раздел не найден в этом предложении")
    return category


def require_task(db: DbSession, proposal: Proposal | None, task_id: uuid.UUID) -> ProposalTask:
    task = db.get(ProposalTask, task_id)
    if task is None or proposal is None or task.proposal_id != proposal.id:
        raise ProposalError("proposal_task_not_found", "строка не найдена в этом предложении")
    return task


def _next_position(db: DbSession, model, owner_column, owner_id: uuid.UUID) -> int:
    # max + 1, а не COUNT(*): удаление пробивает дыру в нумерации, и COUNT
    # после удаления вновь выдал бы уже занятый номер.
    return db.scalar(
        select(func.coalesce(func.max(model.position), -1) + 1).where(owner_column == owner_id)
    )


def add_category(
    db: DbSession, proposal: Proposal, name: str, description: str = ""
) -> ProposalCategory:
    category = ProposalCategory(
        proposal_id=proposal.id,
        name=name,
        description=description,
        position=_next_position(db, ProposalCategory, ProposalCategory.proposal_id, proposal.id),
    )
    db.add(category)
    db.flush()
    return category


def add_task(
    db: DbSession, proposal: Proposal, category_id: uuid.UUID, name: str
) -> ProposalTask:
    category = require_category(db, proposal, category_id)
    task = ProposalTask(
        proposal_id=proposal.id,
        category_id=category.id,
        name=name,
        position=_next_position(db, ProposalTask, ProposalTask.category_id, category.id),
    )
    db.add(task)
    db.flush()
    return task


def list_task_comments(
    db: DbSession, proposal: Proposal | None, task_id: uuid.UUID
) -> list[ProposalComment]:
    task = require_task(db, proposal, task_id)
    return list(
        db.scalars(
            select(ProposalComment)
            .where(ProposalComment.proposal_task_id == task.id)
            .order_by(ProposalComment.created_at, ProposalComment.id)
        ).all()
    )


def add_task_comment(
    db: DbSession, proposal: Proposal | None, task_id: uuid.UUID, author: User, body: str
) -> ProposalComment:
    task = require_task(db, proposal, task_id)
    text = body.strip()
    if not text:
        raise ProposalError("comment_empty", "пустой комментарий")
    comment = ProposalComment(proposal_task_id=task.id, author_user_id=author.id, body=text)
    db.add(comment)
    db.flush()
    return comment


#: Сколько ролей подсказывать при вводе строки. Организация с длинной
#: историей смет накапливает десятки написаний, а строка ввода вмещает
#: несколько — и лишние всё равно отсеет набор.
ROLE_SUGGESTIONS_LIMIT = 20


def role_suggestions(db: DbSession, project: Project) -> list[dict]:
    """Роли, которые организация уже писала в сметах, с последней ставкой каждой.

    По всей организации, а не по проекту: ставка дизайнера одна на студию, и
    во втором проекте её не должны набирать заново. Свежесть — по created_at
    строки: последняя написанная ставка и есть действующая. Регистр и
    пробелы не плодят ролей — «Дизайнер» и « дизайнер » одна роль, показанная
    самым свежим написанием. Нулевая ставка роль не отбрасывает (имя всё
    равно стоит подсказать), но ненулевая, если она была, выигрывает.
    """
    rows = db.execute(
        select(ProposalTask.role, ProposalTask.rate)
        .join(Proposal, Proposal.id == ProposalTask.proposal_id)
        .join(Project, Project.id == Proposal.project_id)
        .where(Project.org_id == project.org_id, ProposalTask.role != "")
        .order_by(ProposalTask.created_at.desc(), ProposalTask.id)
    ).all()
    latest: dict[str, dict] = {}
    for role, rate in rows:
        name = role.strip()
        key = name.casefold()
        if not key:
            continue
        known = latest.get(key)
        if known is None:
            latest[key] = {"role": name, "rate": float(rate)}
        elif known["rate"] == 0 and rate:
            known["rate"] = float(rate)
    return list(latest.values())[:ROLE_SUGGESTIONS_LIMIT]


def plan_facts(db: DbSession, project: Project) -> dict:
    """Сколько в плане категорий и задач.

    Нужно пустому предложению: оно предлагает собрать смету из плана и обязано
    назвать, из чего именно, — «3 категории и 9 задач», а не «что-то есть».
    """
    return {
        "categories": db.scalar(
            select(func.count()).select_from(Category).where(Category.project_id == project.id)
        )
        or 0,
        "tasks": db.scalar(
            select(func.count()).select_from(Task).where(Task.project_id == project.id)
        )
        or 0,
    }


def _comment_counts(db: DbSession, proposal: Proposal) -> dict[uuid.UUID, int]:
    """Сколько реплик у каждой строки — одним запросом на предложение."""
    rows = db.execute(
        select(ProposalComment.proposal_task_id, func.count())
        .join(ProposalTask, ProposalTask.id == ProposalComment.proposal_task_id)
        .where(ProposalTask.proposal_id == proposal.id)
        .group_by(ProposalComment.proposal_task_id)
    ).all()
    return {task_id: count for task_id, count in rows}


def proposal_state(db: DbSession, project: Project) -> dict:
    """Предложение целиком: настройки, разделы, строки.

    Проекта без строки предложения это тоже касается: отдаются значения по
    умолчанию, и клиент не отличает «ещё не заводили» от «завели и не
    трогали» — различие это ничего ему не говорит.

    Итоги (часы, сумма, налог) намеренно не считаются здесь: они — простое
    произведение и сумма показанных чисел, и сервер, пересказывающий их,
    завёл бы второе место, где живёт та же арифметика.

    Счётчики переноса — исключение из этого правила, и оно оправдано: «сколько
    строк уже в плане» и «сколько можно перенести» клиент мог бы вывести из
    ссылок сам, но полоса этапов и главная кнопка спрашивают их первыми, ещё
    до таблицы, и два места с одним правилом «оценённая строка без ссылки»
    разошлись бы на первой правке правила.
    """
    proposal = get_proposal(db, project)
    common = {
        "role_suggestions": role_suggestions(db, project),
        "plan_facts": plan_facts(db, project),
    }
    if proposal is None:
        return {
            "effort_unit": "days",
            "hours_per_day": 8,
            "tax_rate_pct": 0.0,
            "currency": "USD",
            "notes": "",
            "status": "draft",
            "sent_at": None,
            "agreed_at": None,
            "pushed_count": 0,
            "pushable_count": 0,
            "categories": [],
            **common,
        }

    categories = db.scalars(
        select(ProposalCategory)
        .where(ProposalCategory.proposal_id == proposal.id)
        .order_by(ProposalCategory.position, ProposalCategory.id)
    ).all()
    tasks = db.scalars(
        select(ProposalTask)
        .where(ProposalTask.proposal_id == proposal.id)
        .order_by(ProposalTask.position, ProposalTask.id)
    ).all()
    counts = _comment_counts(db, proposal)

    by_category: dict[uuid.UUID, list[dict]] = {}
    for task in tasks:
        by_category.setdefault(task.category_id, []).append(
            {
                "id": str(task.id),
                "category_id": str(task.category_id),
                "name": task.name,
                "description": task.description,
                "details": task.details,
                "role": task.role,
                # float на проводе: JSON не знает Decimal, а строка заставила
                # бы клиент разбирать числа. Двух знаков точности Numeric
                # хватает, чтобы float пересказал их без потерь.
                "effort": float(task.effort),
                "rate": float(task.rate),
                "notes": task.notes,
                "risks": task.risks,
                "assumptions": task.assumptions,
                "position": task.position,
                "comment_count": counts.get(task.id, 0),
                # Задача плана, в которую строка уже перенесена; null — ещё нет.
                "plan_task_id": str(task.plan_task_id) if task.plan_task_id else None,
            }
        )

    return {
        "effort_unit": proposal.effort_unit,
        "hours_per_day": proposal.hours_per_day,
        "tax_rate_pct": float(proposal.tax_rate_pct),
        "currency": proposal.currency,
        "notes": proposal.notes,
        "status": proposal.status,
        "sent_at": proposal.sent_at.isoformat() if proposal.sent_at else None,
        "agreed_at": proposal.agreed_at.isoformat() if proposal.agreed_at else None,
        "pushed_count": sum(1 for task in tasks if task.plan_task_id is not None),
        # Переносима строка с оценкой и без ссылки: нулевую оценку в план не
        # зовут — задача из неё выходит однодневной заглушкой, которой никто
        # не заказывал.
        "pushable_count": sum(
            1 for task in tasks if task.plan_task_id is None and task.effort > 0
        ),
        **common,
        "categories": [
            {
                "id": str(category.id),
                "name": category.name,
                "description": category.description,
                "position": category.position,
                "tasks": by_category.get(category.id, []),
            }
            for category in categories
        ],
    }


def _duration_days(proposal: Proposal, effort: Decimal) -> int:
    """Длительность задачи плана из трудоёмкости строки.

    Часы переводятся в дни по hours_per_day и округляются вверх: план мерит
    календарём, и полдня работы всё равно занимают день в ленте. Нулевая
    оценка тоже даёт день — задач короче дня у диаграммы нет (см. CHECK
    ck_tasks_duration_days).
    """
    if proposal.effort_unit == "hours":
        days = float(effort) / proposal.hours_per_day
    else:
        days = float(effort)
    return max(1, math.ceil(days))


# Та же палитра, что у клиента (CATEGORY_COLORS в CategoryForm.tsx): категория,
# созданная переносом, не должна выбиваться из ряда созданных руками.
_CATEGORY_COLORS = (
    "#3b82f6",
    "#a855f7",
    "#f97316",
    "#10b981",
    "#ef4444",
    "#eab308",
    "#06b6d4",
    "#ec4899",
    "#64748b",
    "#b45309",
)


def _plan_categories_by_name(db: DbSession, project: Project) -> dict[str, Category]:
    """Категории плана по имени без учёта регистра и пробелов.

    Раздел сметы находит категорию плана по имени, а не создаёт всегда новую:
    повторный перенос и смета поверх начатого плана не должны плодить «Дизайн»
    рядом с «дизайн». Одно правило на предпросмотр и на сам перенос — иначе
    окно обещало бы одно, а перенос делал другое.
    """
    return {
        category.name.strip().casefold(): category
        for category in db.scalars(select(Category).where(Category.project_id == project.id)).all()
    }


def _proposal_rows(db: DbSession, proposal: Proposal | None) -> list[ProposalTask]:
    if proposal is None:
        return []
    return list(
        db.scalars(
            select(ProposalTask)
            .where(ProposalTask.proposal_id == proposal.id)
            .order_by(ProposalTask.position, ProposalTask.id)
        ).all()
    )


def _proposal_categories(db: DbSession, proposal: Proposal) -> list[ProposalCategory]:
    return list(
        db.scalars(
            select(ProposalCategory)
            .where(ProposalCategory.proposal_id == proposal.id)
            .order_by(ProposalCategory.position, ProposalCategory.id)
        ).all()
    )


def _pushable(row: ProposalTask) -> bool:
    """Переносится по умолчанию: оценённая строка, которой в плане ещё нет.

    Нулевую оценку в план не зовут: задача из неё выходит однодневной
    заглушкой, которой никто не заказывал. То же правило считает
    `pushable_count` в состоянии — см. proposal_state.
    """
    return row.plan_task_id is None and row.effort > 0


def push_preview(db: DbSession, project: Project) -> dict:
    """Что случится при переносе: куда ляжет каждый раздел, во сколько дней
    выйдет каждая строка, что уже в плане, а что без оценки.

    Считается здесь же, где и сам перенос, теми же функциями: клиент мог бы
    вывести длительности и сопоставление категорий сам, но тогда правило
    «часы вверх до целого дня» и «категория по имени без регистра» жили бы в
    двух местах и разошлись бы на первой правке.
    """
    proposal = get_proposal(db, project)
    rows = _proposal_rows(db, proposal)
    if proposal is None or not rows:
        return {"categories": []}

    existing = _plan_categories_by_name(db, project)
    by_category: dict[uuid.UUID, list[ProposalTask]] = {}
    for row in rows:
        by_category.setdefault(row.category_id, []).append(row)

    categories = []
    for category in _proposal_categories(db, proposal):
        section_rows = by_category.get(category.id, [])
        if not section_rows:
            continue
        plan_category = existing.get(category.name.strip().casefold())
        categories.append(
            {
                "id": str(category.id),
                "name": category.name,
                "plan_category": (
                    {"id": str(plan_category.id), "name": plan_category.name}
                    if plan_category is not None
                    else None
                ),
                "tasks": [
                    {
                        "id": str(row.id),
                        "name": row.name,
                        "duration_days": _duration_days(proposal, row.effort),
                        "in_plan": row.plan_task_id is not None,
                        "estimated": row.effort > 0,
                    }
                    for row in section_rows
                ],
            }
        )
    return {"categories": categories}


def _internal_note(row: ProposalTask, locale: str) -> str:
    """Заметки, риски и допущения строки — внутренней заметкой задачи.

    Перенос не должен терять того, что команда знала о работе, а внутренняя
    заметка — ровно то поле, которое клиент не видит (READ_INTERNAL_NOTE).
    Подписи — из словаря выгрузки на языке организации: текст этот пишет
    сервер, и по тому же доводу, что у документов (см. export/labels.py),
    словами его наполняет тот, кто пишет.
    """
    parts = []
    for key, text in (("notes", row.notes), ("risks", row.risks), ("assumptions", row.assumptions)):
        if text.strip():
            parts.append(f"{term('proposal_note', key, locale)}\n{text.strip()}")
    return "\n\n".join(parts)


def push_to_plan(
    db: DbSession,
    project: Project,
    actor_id: uuid.UUID | None,
    *,
    task_ids: Iterable[uuid.UUID] | None = None,
    locale: str,
) -> dict:
    """Переносит строки сметы в задачи диаграммы.

    Идёт через слой мутаций, а не пишет в таблицы напрямую: созданные задачи —
    состояние плана, и перенос обязан оставить след в журнале и сниматься
    одной отменой. Общий batch_id и делает пачку одной записью истории.

    Какие строки: названные в `task_ids`, а без списка — все переносимые по
    умолчанию (см. _pushable). Строка, уже перенесённая раньше, пропускается в
    любом случае: у неё есть ссылка на задачу, и второй перенос удваивал бы
    план. Ссылка ставится сразу после создания задачи — под тем же замком
    проекта, что держит apply_op, так что два одновременных переноса не
    создадут задачу дважды: второй увидит ссылку первого.

    Задачи встают на старт плана — раскладывать их по оси человек будет сам, и
    любая придуманная здесь последовательность выдавала бы себя за план,
    которого никто не составлял.
    """
    proposal = get_proposal(db, project)
    rows = _proposal_rows(db, proposal)
    if not rows:
        raise ProposalError("proposal_empty", "в предложении нет ни одной строки")

    wanted = set(task_ids or ())
    if wanted:
        known = {row.id for row in rows}
        if wanted - known:
            # Чужая или несуществующая строка неотличима от отсутствующей —
            # тем же принципом, что у require_task.
            raise ProposalError("proposal_task_not_found", "строка не найдена в этом предложении")
        chosen = [row for row in rows if row.id in wanted and row.plan_task_id is None]
    else:
        chosen = [row for row in rows if _pushable(row)]
    if not chosen:
        raise ProposalError(
            "proposal_nothing_to_push", "все выбранные строки уже в плане или без оценки"
        )

    by_category: dict[uuid.UUID, list[ProposalTask]] = {}
    for row in chosen:
        by_category.setdefault(row.category_id, []).append(row)

    existing = {key: category.id for key, category in _plan_categories_by_name(db, project).items()}
    taken = len(existing)

    start = project.start_date or RELATIVE_EPOCH
    batch_id = uuid.uuid4()
    created = 0

    for category in _proposal_categories(db, proposal):
        section_rows = by_category.get(category.id, [])
        if not section_rows:
            continue
        plan_category_id = existing.get(category.name.strip().casefold())
        if plan_category_id is None:
            revision = apply_op(
                db,
                project,
                CreateCategory(
                    name=category.name,
                    color=_CATEGORY_COLORS[taken % len(_CATEGORY_COLORS)],
                ),
                actor_id=actor_id,
                batch_id=batch_id,
            )
            plan_category_id = uuid.UUID(revision.op["category_id"])
            existing[category.name.strip().casefold()] = plan_category_id
            taken += 1
        for row in section_rows:
            revision = apply_op(
                db,
                project,
                CreateTask(
                    category_id=plan_category_id,
                    name=row.name,
                    start_date=start,
                    duration_days=_duration_days(proposal, row.effort),
                    description=row.description,
                    internal_note=_internal_note(row, locale),
                ),
                actor_id=actor_id,
                batch_id=batch_id,
            )
            row.plan_task_id = uuid.UUID(revision.op["task_id"])
            created += 1
    db.flush()

    return {"created_tasks": created, "batch_id": str(batch_id)}
