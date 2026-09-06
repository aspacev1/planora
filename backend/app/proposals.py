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
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from app.models import (
    Category,
    Organization,
    Project,
    Proposal,
    ProposalCategory,
    ProposalComment,
    ProposalTask,
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
    """
    proposal = get_proposal(db, project)
    if proposal is None:
        return {
            "effort_unit": "days",
            "hours_per_day": 8,
            "tax_rate_pct": 0.0,
            "currency": "USD",
            "notes": "",
            "categories": [],
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
            }
        )

    return {
        "effort_unit": proposal.effort_unit,
        "hours_per_day": proposal.hours_per_day,
        "tax_rate_pct": float(proposal.tax_rate_pct),
        "currency": proposal.currency,
        "notes": proposal.notes,
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


# Заголовки разделов внутренней заметки, которую перенос собирает из рисков и
# допущений строки. Словарь здесь, а не в клиенте, по тому же доводу, что у
# _METRIC_LABELS в app/scorecard.py: текст ложится в базу, и переводит его тот,
# кто пишет, — на языке организации.
_NOTE_HEADINGS = {
    "risks": {"ru": "Риски", "en": "Risks", "az": "Risklər"},
    "assumptions": {"ru": "Допущения", "en": "Assumptions", "az": "Fərziyyələr"},
}


def _note_locale(org: Organization) -> str:
    """Язык заметки — язык организации; незнакомый откатывается к az, как в
    правиле скоркарда: словарь заголовков обязан знать этот язык."""
    return org.default_locale if org.default_locale in _NOTE_HEADINGS["risks"] else "az"


def internal_note_for(row: ProposalTask, locale: str) -> str:
    """Внутренняя заметка задачи из рисков и допущений строки.

    Именно во внутреннюю заметку, а не в описание: риски и допущения — разговор
    команды с самой собой («подрядчик ненадёжен», «клиент ещё не дал доступы»),
    и клиент, которому открыли план, читать их не должен. Заметку от него уже
    прячет READ_INTERNAL_NOTE — и в состоянии проекта, и в журнале, и в
    выгрузке, — так что переносу не нужно отдельного правила видимости.

    Оба текста складываются в одно поле под своими заголовками, а не в два
    новых поля задачи: у задачи одно место для внутреннего, и второе
    завело бы ещё одно поле с той же видимостью. Пустой раздел не пишется:
    заголовок без текста только мешал бы читать. Пустые оба — пустая заметка.
    """
    sections = []
    for field in ("risks", "assumptions"):
        text = getattr(row, field).strip()
        if text:
            sections.append(f"{_NOTE_HEADINGS[field][locale]}:\n{text}")
    return "\n\n".join(sections)


def push_to_plan(
    db: DbSession, project: Project, org: Organization, actor_id: uuid.UUID | None
) -> dict:
    """Переносит строки сметы в задачи диаграммы.

    Идёт через слой мутаций, а не пишет в таблицы напрямую: созданные задачи —
    состояние плана, и перенос обязан оставить след в журнале и сниматься
    одной отменой. Общий batch_id и делает пачку одной записью истории.

    Раздел сметы находит категорию плана по имени, без учёта регистра, а не
    создаёт всегда новую: повторный перенос и смета поверх начатого плана не
    должны плодить «Дизайн» рядом с «дизайн». Задачи встают на старт плана —
    раскладывать их по оси человек будет сам, и любая придуманная здесь
    последовательность выдавала бы себя за план, которого никто не составлял.

    Описание строки становится описанием задачи, риски и допущения — её
    внутренней заметкой (см. internal_note_for): перенос ничего из них не
    теряет, но и клиенту не показывает.
    """
    proposal = get_proposal(db, project)
    tasks = (
        []
        if proposal is None
        else db.scalars(
            select(ProposalTask)
            .where(ProposalTask.proposal_id == proposal.id)
            .order_by(ProposalTask.position, ProposalTask.id)
        ).all()
    )
    if not tasks:
        raise ProposalError("proposal_empty", "в предложении нет ни одной строки")

    categories = db.scalars(
        select(ProposalCategory)
        .where(ProposalCategory.proposal_id == proposal.id)
        .order_by(ProposalCategory.position, ProposalCategory.id)
    ).all()
    by_category: dict[uuid.UUID, list[ProposalTask]] = {}
    for task in tasks:
        by_category.setdefault(task.category_id, []).append(task)

    existing = {
        category.name.strip().casefold(): category.id
        for category in db.scalars(
            select(Category).where(Category.project_id == project.id)
        ).all()
    }
    taken = len(existing)

    start = project.start_date or RELATIVE_EPOCH
    locale = _note_locale(org)
    batch_id = uuid.uuid4()
    created = 0

    for category in categories:
        rows = by_category.get(category.id, [])
        if not rows:
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
        for row in rows:
            apply_op(
                db,
                project,
                CreateTask(
                    category_id=plan_category_id,
                    name=row.name,
                    start_date=start,
                    duration_days=_duration_days(proposal, row.effort),
                    description=row.description,
                    internal_note=internal_note_for(row, locale),
                ),
                actor_id=actor_id,
                batch_id=batch_id,
            )
            created += 1

    return {"created_tasks": created}
