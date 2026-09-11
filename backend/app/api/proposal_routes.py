"""Routes of the commercial proposal.

Its own file rather than a tail of project_routes: the proposal has its own
domain layer (app/proposals) and its own kind of writing — edits without the
revision journal, as with comments. Two routes touch the plan: assembling the
budget from the plan only reads it, while carrying rows across into tasks
changes it — and that one alone goes through the mutation layer.

Not everyone who reads the project may read the proposal: a client and a
link-holding guest see the plan but not the budget with its rates and risks (see
Action.PROPOSAL_READ). That is why reading is checked here explicitly rather
than inherited from project_context.
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
    EFFORT_MAX,
    RATE_MAX,
    ProposalError,
    add_category,
    add_task,
    add_task_comment,
    build_from_plan,
    convert_unit,
    ensure_proposal,
    get_proposal,
    require_category,
    list_task_comments,
    proposal_state,
    push_preview,
    push_to_plan,
    require_task,
    set_stage,
)

router = APIRouter(prefix="/api/projects", tags=["proposal"])


class ProposalSettingsIn(BaseModel):
    """The budget's settings. Every field is optional: what was sent is what is edited."""

    effort_unit: Literal["days", "hours"] | None = None
    hours_per_day: int | None = Field(default=None, ge=1, le=24)
    tax_rate_pct: float | None = Field(default=None, ge=0, le=100)
    currency: str | None = Field(default=None, min_length=3, max_length=3)
    #: The proposal's assumptions and notes as a whole. An empty string erases
    #: them; None leaves them alone.
    notes: str | None = None


class ProposalCategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""


class ProposalCategoryPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None


class ProposalTaskIn(BaseModel):
    """A new row: the name is mandatory, while role, estimate and rate are
    optional if named right away. The numeric ceilings are the same as on an
    edit — the width of the Numeric columns."""

    name: str = Field(min_length=1, max_length=300)
    role: str = Field(default="", max_length=120)
    effort: float | None = Field(default=None, ge=0, le=999_999)
    rate: float | None = Field(default=None, ge=0, le=9_999_999_999)


class ProposalStageIn(BaseModel):
    stage: Literal["draft", "sent", "agreed"]


class ProposalTaskPatch(BaseModel):
    """Editing a row: the fields sent are changed, the rest are untouched.

    The numeric ceilings repeat the width of the Numeric columns: a wider value
    would go into the database as a truncation error — a 500 instead of an honest
    refusal.
    """

    name: str | None = Field(default=None, min_length=1, max_length=300)
    description: str | None = None
    details: str | None = None
    role: str | None = Field(default=None, max_length=120)
    effort: float | None = Field(default=None, ge=0, le=EFFORT_MAX)
    rate: float | None = Field(default=None, ge=0, le=RATE_MAX)
    notes: str | None = None
    risks: str | None = None
    assumptions: str | None = None


class ProposalCommentIn(BaseModel):
    body: str = Field(min_length=1)


class PushToPlanIn(BaseModel):
    """Which rows to carry across. An empty list means all that are carryable by
    default: estimated and not yet carried across (see proposals._pushable)."""

    task_ids: list[uuid.UUID] = []


def _refuse(error: ProposalError | MutationError) -> HTTPException:
    """A domain refusal becomes an HTTP refusal by the same logic as mutations: a
    foreign or nonexistent entity is a 404, everything else is a 422."""
    if isinstance(error, NotFoundInProject) or error.code in {
        "proposal_category_not_found",
        "proposal_task_not_found",
    }:
        return HTTPException(status_code=404, detail=error.code)
    return HTTPException(status_code=422, detail=error.code)


def _publish(
    background: BackgroundTasks, db: DbSession, project_id: uuid.UUID, event: dict
) -> None:
    # The same order as in mutations: commit first, then broadcast — on getting
    # the signal the client re-reads the data, and before the commit it would
    # re-read the old state.
    db.commit()
    background.add_task(hub.publish, project_id, event)


#: An event for neighbouring tabs: "the proposal changed, re-read it". The text
#: is not broadcast — the client will fetch it over HTTP, as with comments.
_CHANGED = {"type": "proposal"}


@router.get("/{project_id}/proposal")
def get_project_proposal(
    context: ProjectContext = Depends(project_context), db: DbSession = Depends(get_db)
):
    """The whole proposal: settings, sections, rows with remark counters.

    The totals (sum, tax, grand total) are computed by the client: they are a
    product and a sum of numbers already sent, and a server restating them would
    be a second place with the same arithmetic.
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
        # Rows are recomputed before the new hours norm, if it arrived in the
        # same request: the estimates were written under the old one, and they
        # have to be converted with it.
        try:
            convert_unit(db, proposal, changes["effort_unit"])
        except ProposalError as error:
            raise _refuse(error)
    if "hours_per_day" in changes:
        proposal.hours_per_day = changes["hours_per_day"]
    if "tax_rate_pct" in changes:
        # A Decimal from a string rather than from a float: Decimal(0.1) is
        # 0.1000000000000000055..., and the tax would stop coming out round.
        proposal.tax_rate_pct = Decimal(str(changes["tax_rate_pct"]))
    if "currency" in changes:
        proposal.currency = changes["currency"].upper()
    if "notes" in changes:
        proposal.notes = changes["notes"]
    db.flush()
    _publish(background, db, context.project.id, _CHANGED)
    return proposal_state(db, context.project)


@router.post("/{project_id}/proposal/stage")
def set_proposal_stage(
    payload: ProposalStageIn,
    background: BackgroundTasks,
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    """Mark a stage of the deal — in either direction (see proposals.set_stage)."""
    context.require(Action.PROJECT_WRITE)
    proposal = ensure_proposal(db, context.project)
    try:
        set_stage(proposal, payload.stage)
    except ProposalError as error:
        raise _refuse(error)
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
    """Deletes a section together with its rows: a budget is a draft, and the
    plan's rule "carry the tasks out first" would be a ritual with no benefit here."""
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
        task = add_task(
            db,
            ensure_proposal(db, context.project),
            category_id,
            name,
            role=payload.role.strip(),
            # A Decimal from a string rather than from a float — for the same reason as the tax.
            effort=Decimal(str(payload.effort)) if payload.effort is not None else Decimal("0"),
            rate=Decimal(str(payload.rate)) if payload.rate is not None else Decimal("0"),
        )
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
    # Both checks: a remark on a row is written by someone entitled both to
    # comment and to see the budget. COMMENT alone is not enough — a client has it too.
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
    # The same shape as the project's feed (comments_out): the client draws both
    # with one component, and a second shape would mean a second feed.
    return {
        "id": str(comment.id),
        "task_id": str(comment.proposal_task_id),
        "author": {"name": names.get(comment.author_user_id, ""), "guest": False},
        "body": comment.body,
        "created_at": comment.created_at.isoformat(),
    }


@router.get("/{project_id}/proposal/push-plan")
def preview_push_to_plan(
    context: ProjectContext = Depends(project_context), db: DbSession = Depends(get_db)
):
    """What will happen on a carry-across — before it happens.

    The carry-across dialog shows where each section will land and how many days
    each row comes out to, and marks what will not be carried: what has already
    been carried and rows with no estimate. The server computes this with the same
    functions as the carry-across itself — see proposals.push_preview.
    """
    context.require(Action.PROPOSAL_READ)
    return push_preview(db, context.project)


@router.post("/{project_id}/proposal/build-from-plan", status_code=201)
def build_proposal_from_plan(
    background: BackgroundTasks,
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    """Assembles an empty budget from the plan: a category becomes a section, a task a row.

    Under the same project lock as the other edits (ensure_proposal): otherwise
    two simultaneous assemblies would both find the budget empty and assemble it
    twice. The refusals are 422 codes: `proposal_not_empty` if rows already
    exist, and `plan_empty` if there is nothing to assemble from.
    """
    context.require(Action.PROJECT_WRITE)
    try:
        result = build_from_plan(db, context.project, ensure_proposal(db, context.project))
    except ProposalError as error:
        raise _refuse(error)
    _publish(background, db, context.project.id, _CHANGED)
    return result


@router.post("/{project_id}/proposal/push-to-plan", status_code=201)
def push_proposal_to_plan(
    background: BackgroundTasks,
    payload: PushToPlanIn | None = None,
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    """Carries the budget into the plan: a section becomes a category, a row a task.

    A batch of revisions with a shared batch_id: in the history the carry-across
    reads as one entry and is removed by one undo — the batch_id goes into the
    answer for the sake of the "Undo" button in the toast. The tasks are placed
    at the plan's start — a person lays them out along the axis themselves. A
    row's notes, risks and assumptions go into the task's internal note in the
    organization's language: it is read by the team, not by the client.
    """
    context.require(Action.PROJECT_WRITE)
    try:
        result = push_to_plan(
            db,
            context.project,
            context.user.id,
            task_ids=payload.task_ids if payload else None,
            locale=context.org.default_locale,
        )
    except (ProposalError, MutationError) as error:
        raise _refuse(error)
    # The revisions are already in the journal — the fact that "the plan changed"
    # is enough for the neighbours: they re-read the state in full, as after an
    # ordinary mutation.
    _publish(background, db, context.project.id, {"type": "revision"})
    return result
