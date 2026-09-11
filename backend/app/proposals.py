"""A project's commercial proposal: the budget before the plan.

A proposal is a draft of a deal rather than a state of the plan: its edits have
no inverse operations, do not land in the revision journal and do not move the
chart. That is why it lives in a module of its own — the same way comments do —
rather than as branches in the operation registry, where an `inverse` is
mandatory.

The proposal touches the plan in two places, and they mirror each other.
Carrying budget rows across into chart tasks (push_to_plan) goes through the
mutation layer as a single batch: the created tasks are already plan state, and a
person is entitled to undo the carry-across with one button. Assembling the
budget from the plan (build_from_plan) is the reverse path: it writes only into
the budget's tables, does not touch the plan and therefore does not land in the
journal. The two paths are linked by ProposalTask.plan_task_id: a row remembers
its task, and a carry-across does not create it a second time.
"""

import math
import uuid
from collections.abc import Iterable
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from app.export.labels import term
from app.models import (
    Category,
    EffortUnit,
    Project,
    Proposal,
    ProposalCategory,
    ProposalComment,
    ProposalStatus,
    ProposalTask,
    Task,
    User,
)
from app.mutations import CreateCategory, CreateTask, apply_op
from app.schedule import RELATIVE_EPOCH


class ProposalError(Exception):
    """A proposal refusal — as a machine code, like mutations and comments."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def get_proposal(db: DbSession, project: Project) -> Proposal | None:
    return db.scalar(select(Proposal).where(Proposal.project_id == project.id))


def lock_project(db: DbSession, project: Project) -> None:
    """A lock on the project's row until the end of the transaction — the same one apply_op holds.

    The proposal belongs to the project, and needs no second lock of its own; but
    this one must be taken before any read a decision is made on: what is read
    before the lock is a snapshot from under someone else's uncommitted
    transaction.
    """
    db.execute(select(Project.id).where(Project.id == project.id).with_for_update())


def ensure_proposal(db: DbSession, project: Project) -> Proposal:
    """The proposal's row — on the first change, not when the project is created.

    A race between the first two edits is resolved by the lock on the project's
    row: both edits take it before asking about the proposal, and the second finds
    the row created by the first.
    """
    lock_project(db, project)
    proposal = get_proposal(db, project)
    if proposal is None:
        proposal = Proposal(project_id=project.id)
        db.add(proposal)
        db.flush()
    return proposal


def require_category(
    db: DbSession, proposal: Proposal, category_id: uuid.UUID
) -> ProposalCategory:
    # A section of someone else's proposal is indistinguishable from a nonexistent
    # one — by the same principle as tasks in the mutation routes.
    category = db.get(ProposalCategory, category_id)
    if category is None or category.proposal_id != proposal.id:
        raise ProposalError("proposal_category_not_found", "the section was not found in this proposal")
    return category


def require_task(db: DbSession, proposal: Proposal | None, task_id: uuid.UUID) -> ProposalTask:
    task = db.get(ProposalTask, task_id)
    if task is None or proposal is None or task.proposal_id != proposal.id:
        raise ProposalError("proposal_task_not_found", "the row was not found in this proposal")
    return task


def _next_position(db: DbSession, model, owner_column, owner_id: uuid.UUID) -> int:
    # max + 1 rather than COUNT(*): a deletion punches a hole in the numbering, and
    # COUNT after a deletion would hand out an already taken number again.
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
    db: DbSession,
    proposal: Proposal,
    category_id: uuid.UUID,
    name: str,
    *,
    role: str = "",
    effort: Decimal = Decimal("0"),
    rate: Decimal = Decimal("0"),
) -> ProposalTask:
    """A budget row — with its role, estimate and rate right away, if they were named.

    The input row in the table asks for all four fields at once: a budget is
    written row by row, and creating a row with just a name and then filling the
    money in on a card would mean open, edit, close — on every row in turn.
    """
    category = require_category(db, proposal, category_id)
    task = ProposalTask(
        proposal_id=proposal.id,
        category_id=category.id,
        name=name,
        role=role,
        effort=effort,
        rate=rate,
        position=_next_position(db, ProposalTask, ProposalTask.category_id, category.id),
    )
    db.add(task)
    db.flush()
    return task


def set_stage(proposal: Proposal, stage: str, *, now: datetime | None = None) -> None:
    """Marks a stage of the deal: draft, sent to the client, agreed.

    The timestamp is set when the stage is first reached and stays until the stage
    is cleared: "sent 27 Aug" under the stage bar is the date of the event, not of
    the last press. A step back clears the later marks so that the bar does not
    name the date of a stage that no longer exists. Agreed straight from draft
    counts the send as passed: only what the client has seen can be agreed — and
    "sent" gets the same date.

    These are notes to oneself, not a legal status: the stages can be walked in
    either direction, and there are no confirmations here.
    """
    at = now or datetime.now(timezone.utc)
    if stage == ProposalStatus.DRAFT:
        proposal.sent_at = None
        proposal.agreed_at = None
    elif stage == ProposalStatus.SENT:
        proposal.sent_at = proposal.sent_at or at
        proposal.agreed_at = None
    elif stage == ProposalStatus.AGREED:
        proposal.sent_at = proposal.sent_at or at
        proposal.agreed_at = proposal.agreed_at or at
    else:
        raise ProposalError("proposal_stage_invalid", f"unknown stage {stage!r}")
    proposal.status = stage


#: The width of the Numeric columns — the ceilings for the conversion. The same
#: numbers as in the route schemas: a wider value would go into the database as a
#: truncation error.
MAX_EFFORT = Decimal("999999.99")
MAX_RATE = Decimal("9999999999.99")
#: The same ceilings as integer parts — for the route schemas: one place for input
#: and for the conversion, so that the limits do not drift apart.
EFFORT_MAX = int(MAX_EFFORT)
RATE_MAX = int(MAX_RATE)
_CENT = Decimal("0.01")


def convert_unit(db: DbSession, proposal: Proposal, unit: str) -> None:
    """Converts the estimates and rates of every row into another unit without changing prices.

    Changing the unit changes what things are measured in rather than renaming the
    numbers: two days at 400 a day are sixteen hours at 50 an hour, and the total
    stays the same. It converts using the "hours per day" in force at the moment of
    the change: that number is what defined what a day was when the estimate was
    written.

    The effort is converted and rounded to the cent — the column's precision —
    while the rate is derived anew from the row's previous price rather than
    divided on its own: when dividing the effort does not come out evenly in two
    places (7 hours is 0.875 of a day, 0.88 in the column), the rate absorbs the
    rounding error and the proposal's total stays the same to the cent. A row with
    no effort has no price — its rate is simply converted by the same multiplier so
    that it is not lost when the estimate is filled in. A row whose effort would
    round to zero gets the minimal hundredth: otherwise its price would vanish
    together with the zero.

    It computes everything first and writes afterwards: a row that does not fit
    into the column must refuse entirely rather than leave the budget half in
    hours.
    """
    if unit == proposal.effort_unit:
        return
    factor = Decimal(proposal.hours_per_day)
    to_hours = unit == EffortUnit.HOURS
    converted = []
    for row in _proposal_rows(db, proposal):
        price = row.effort * row.rate
        effort = row.effort * factor if to_hours else row.effort / factor
        effort = effort.quantize(_CENT, rounding=ROUND_HALF_UP)
        if row.effort > 0:
            effort = max(effort, _CENT)
        if effort > 0:
            rate = price / effort
        else:
            rate = row.rate / factor if to_hours else row.rate * factor
        rate = rate.quantize(_CENT, rounding=ROUND_HALF_UP)
        if effort > MAX_EFFORT or rate > MAX_RATE:
            raise ProposalError(
                "proposal_value_out_of_range", "the recomputed value does not fit the column"
            )
        converted.append((row, effort, rate))
    for row, effort, rate in converted:
        row.effort = effort
        row.rate = rate
    proposal.effort_unit = unit

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
        raise ProposalError("comment_empty", "an empty comment")
    comment = ProposalComment(proposal_task_id=task.id, author_user_id=author.id, body=text)
    db.add(comment)
    db.flush()
    return comment


#: How many roles to suggest while a row is being entered. An organization with a
#: long history of budgets accumulates dozens of spellings, while the input row
#: holds a few — and typing will filter the extras out anyway.
ROLE_SUGGESTIONS_LIMIT = 20


def role_suggestions(db: DbSession, project: Project) -> list[dict]:
    """The roles the organization has already written in budgets, with each one's latest rate.

    Across the whole organization rather than per project: a designer's rate is one
    for the studio, and it must not be typed in again on the second project.
    Recency is by the row's created_at: the last rate written is the one in force.
    Case and spaces do not multiply roles — "Designer" and " designer " are one
    role, shown in its most recent spelling. A zero rate does not discard a role
    (the name is worth suggesting anyway), but a non-zero one, if there was one,
    wins.
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


def _comment_counts(db: DbSession, proposal: Proposal) -> dict[uuid.UUID, int]:
    """How many remarks each row has — with one query per proposal."""
    rows = db.execute(
        select(ProposalComment.proposal_task_id, func.count())
        .join(ProposalTask, ProposalTask.id == ProposalComment.proposal_task_id)
        .where(ProposalTask.proposal_id == proposal.id)
        .group_by(ProposalComment.proposal_task_id)
    ).all()
    return {task_id: count for task_id, count in rows}


def proposal_state(db: DbSession, project: Project) -> dict:
    """The whole proposal: settings, sections, rows.

    This applies to a project with no proposal row too: the default values are
    returned, and the client cannot tell "never created" from "created and never
    touched" — that distinction tells it nothing.

    The totals (hours, sum, tax) are deliberately not computed here: they are a
    simple product and sum of the numbers already shown, and a server restating
    them would create a second place where the same arithmetic lives.

    The carry-across counters are an exception to that rule, and a justified one:
    "how many rows are already in the plan" and "how many can be carried across"
    could be derived from the links by the client itself, but the stage bar and the
    main button ask for them first, before the table, and two places with one rule
    of "an estimated row with no link" would diverge on the first edit of the rule.
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
                # A float on the wire: JSON does not know Decimal, and a string
                # would force the client to parse numbers. Numeric's two places of
                # precision are enough for a float to restate them without loss.
                "effort": float(task.effort),
                "rate": float(task.rate),
                "notes": task.notes,
                "risks": task.risks,
                "assumptions": task.assumptions,
                "position": task.position,
                "comment_count": counts.get(task.id, 0),
                # A reference to the plan's task — so that the screen knows which
                # rows are already in the plan and does not invite carrying across
                # what has been carried.
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
        # A row is carryable if it has an estimate and no link: a zero estimate is
        # not invited into the plan — a task out of it comes out as a one-day stub
        # nobody ordered.
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


def plan_facts(db: DbSession, project: Project) -> dict:
    """What the plan holds — for the "Assemble from the plan" card on an empty budget.

    Inside the budget's state rather than as a separate route: the card is drawn at
    the same moment as the budget itself, and a second request would show it
    without numbers for the first half-second. Two COUNTs on a read are cheaper
    than that hitch.

    The categories counted are those that have tasks: the assembly skips empty
    ones, and the number on the card must match the number of sections it will
    create.
    """
    tasks, categories = db.execute(
        select(func.count(), func.count(func.distinct(Task.category_id))).where(
            Task.project_id == project.id
        )
    ).one()
    return {"tasks": tasks or 0, "categories": categories or 0}


def _effort(proposal: Proposal, duration_days: int) -> Decimal:
    """A row's effort from the duration of a plan task.

    The inverse of _duration_days: days as they are, hours through hours_per_day.
    No rounding: that is needed only towards the plan, where less than a day does
    not exist.
    """
    if proposal.effort_unit == "hours":
        return Decimal(duration_days * proposal.hours_per_day)
    return Decimal(duration_days)


def build_from_plan(db: DbSession, project: Project, proposal: Proposal) -> dict:
    """Assembles the budget from the plan: a category becomes a section, a task a row.

    The reverse path to push_to_plan, and a mirror of it: sections follow the order
    of the categories (position), rows follow the order of tasks inside a category,
    and the estimate is taken from the duration by the same arithmetic the
    carry-across uses to compute duration from an estimate. The role and the rate
    are left empty: they do not exist in the plan, and any number here would pass
    itself off as an estimate nobody made.

    Every row refers to its task right away (plan_task_id): otherwise a budget
    assembled from the plan would double every one of its tasks on the very first
    carry-across.

    Into an empty budget only. Rows typed by hand are not merged with the plan:
    which of the two lists is the truth is decided by a person, not by the
    assembly. Categories with no tasks are skipped — a section with no work would
    stand in the budget as a row with no amount. A plan with no tasks has nothing
    to assemble from.
    """
    lines = db.scalar(
        select(func.count())
        .select_from(ProposalTask)
        .where(ProposalTask.proposal_id == proposal.id)
    )
    if lines:
        raise ProposalError("proposal_not_empty", "the proposal already has rows")

    tasks = db.scalars(
        select(Task).where(Task.project_id == project.id).order_by(Task.position, Task.id)
    ).all()
    if not tasks:
        raise ProposalError("plan_empty", "the plan has no tasks at all")

    by_category: dict[uuid.UUID, list[Task]] = {}
    for task in tasks:
        by_category.setdefault(task.category_id, []).append(task)
    categories = db.scalars(
        select(Category)
        .where(Category.project_id == project.id)
        .order_by(Category.position, Category.id)
    ).all()

    # Sections stand after the ones already created (empty ones) rather than on top
    # of them: the assembly does not rewrite someone else's numbering.
    position = _next_position(db, ProposalCategory, ProposalCategory.proposal_id, proposal.id)
    created_categories = 0
    created_tasks = 0
    for category in categories:
        rows = by_category.get(category.id, [])
        if not rows:
            continue
        section = ProposalCategory(proposal_id=proposal.id, name=category.name, position=position)
        db.add(section)
        db.flush()
        position += 1
        created_categories += 1
        for index, task in enumerate(rows):
            db.add(
                ProposalTask(
                    proposal_id=proposal.id,
                    category_id=section.id,
                    name=task.name,
                    description=task.description,
                    effort=_effort(proposal, task.duration_days),
                    position=index,
                    plan_task_id=task.id,
                )
            )
            created_tasks += 1
    db.flush()
    return {"created_categories": created_categories, "created_tasks": created_tasks}


def _duration_days(proposal: Proposal, effort: Decimal) -> int:
    """The duration of a plan task from a row's effort.

    Hours are converted into days by hours_per_day and rounded up: a plan measures
    by the calendar, and half a day of work still occupies a day on the chart. A
    zero estimate also yields a day — the chart has no tasks shorter than a day
    (see the CHECK ck_tasks_duration_days).
    """
    if proposal.effort_unit == "hours":
        days = float(effort) / proposal.hours_per_day
    else:
        days = float(effort)
    return max(1, math.ceil(days))


# The same palette as on the client (CATEGORY_COLORS in CategoryForm.tsx): a
# category created by a carry-across must not stand out from the ones created by hand.
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
    """The plan's categories by name, ignoring case and spaces.

    A budget section finds a plan category by name rather than always creating a
    new one: a repeated carry-across, and a budget laid over a plan already begun,
    must not multiply "Design" next to "design". One rule for the preview and for
    the carry-across itself — otherwise the dialog would promise one thing while
    the carry-across did another.
    """
    return {
        category.name.strip().casefold(): category
        for category in db.scalars(select(Category).where(Category.project_id == project.id)).all()
    }


def _proposal_rows(db: DbSession, proposal: Proposal | None) -> list[ProposalTask]:
    if proposal is None:
        return []
    # populate_existing: a row already loaded into this session is re-read from the
    # database rather than handed back from the session's cache. The carry-across
    # reads the rows right after the project lock precisely for the sake of fresh
    # references to tasks — the cache would return a snapshot taken before a rival
    # committed theirs.
    return list(
        db.scalars(
            select(ProposalTask)
            .where(ProposalTask.proposal_id == proposal.id)
            .order_by(ProposalTask.position, ProposalTask.id)
            .execution_options(populate_existing=True)
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
    """Carried across by default: an estimated row that is not in the plan yet.

    A zero estimate is not invited into the plan: a task out of it comes out as a
    one-day stub nobody ordered. The same rule computes `pushable_count` in the
    state — see proposal_state.
    """
    return row.plan_task_id is None and row.effort > 0


def push_preview(db: DbSession, project: Project) -> dict:
    """What will happen on a carry-across: where each section will land, how many
    days each row comes to, what is already in the plan and what has no estimate.

    It is computed in the same place as the carry-across itself, with the same
    functions: the client could derive the durations and the category matching
    itself, but then the rules "hours round up to a whole day" and "a category by
    case-insensitive name" would live in two places and diverge on the first edit.
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
    """A row's notes, risks and assumptions — as the task's internal note.

    A carry-across must not lose what the team knew about the work, and the
    internal note is exactly the field a client does not see (READ_INTERNAL_NOTE).
    The labels come from the export dictionary in the organization's language: this
    text is written by the server, and by the same argument as for documents (see
    export/labels.py), whoever writes it fills it with words.
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
    """Carries budget rows across into chart tasks.

    It goes through the mutation layer rather than writing into tables directly:
    the created tasks are plan state, and a carry-across must leave a trace in the
    journal and be removable with one undo. The shared batch_id is what makes the
    batch a single history entry.

    Which rows: those named in `task_ids`, and with no list, all that are carryable
    by default (see _pushable). A row already linked to a plan task — carried
    across earlier or assembled from the plan (build_from_plan) — is skipped in any
    case: it has a reference to a task, and a second carry-across would double the
    plan. The project lock is taken before the rows are read, not only inside
    apply_op: two simultaneous carry-acrosses queue up at the very entrance, and the
    second, once it has waited, reads the rows already carrying the first one's
    references — it has nothing to carry. Read the rows before the lock, and both
    sides would see empty references, both would pass the "already in the plan"
    check, and the plan would double
    (tests/test_proposal_push_race.py). The reference lives outside the journal:
    undoing a carry-across deletes the task, and the database extinguishes the
    reference itself (SET NULL), returning the row to the not-yet-carried ones.

    The tasks are placed at the plan's start — a person will lay them out along the
    axis themselves, and any sequence invented here would pass itself off as a plan
    nobody drew up.
    """
    lock_project(db, project)
    proposal = get_proposal(db, project)
    rows = _proposal_rows(db, proposal)
    if not rows:
        raise ProposalError("proposal_empty", "the proposal has no rows at all")

    wanted = set(task_ids or ())
    if wanted:
        known = {row.id for row in rows}
        if wanted - known:
            # A foreign or nonexistent row is indistinguishable from a missing one
            # — by the same principle as in require_task.
            raise ProposalError("proposal_task_not_found", "the row was not found in this proposal")
        chosen = [row for row in rows if row.id in wanted and row.plan_task_id is None]
    else:
        chosen = [row for row in rows if _pushable(row)]
    if not chosen:
        raise ProposalError(
            "proposal_nothing_to_push", "every selected row is already in the plan or has no estimate"
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
