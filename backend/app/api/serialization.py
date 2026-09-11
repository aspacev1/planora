"""The project's state and the comment feed as they go over the wire.

Extracted from the route because one and the same state gained two readers: a
member's working screen and a guest's public page. The difference between them
is not a different set of fields but two visibility flags, and holding it here is
cheaper than maintaining a second assembly of the same answer, which would one
day diverge from the first on exactly the field a guest must not see.
"""

from collections.abc import Sequence
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.calendar import end_date
from app.comments import author_names
from app.critical import critical_tasks
from app.models import (
    Category,
    Comment,
    Dependency,
    Organization,
    Project,
    ScheduleMode,
    Task,
    TaskAssignee,
)
from app.schedule import relative_calendar
from app.settings_resolution import project_calendar, resolve_shift_threshold, resolve_timezone


def project_state(
    db: DbSession,
    project: Project,
    org: Organization,
    *,
    show_notes: bool,
    show_people: bool = True,
    undoable: dict | None = None,
) -> dict:
    """The whole project: the calendar, categories, tasks, dependencies.

    `undoable` is what the "Undo" button will undo, already reduced to the form
    the caller is entitled to see. It is assembled outside: the "who sees what"
    decision lives in the permission matrix rather than here, and the snapshot of
    a deleted task carries an internal note that the button's label must not give
    away.

    `show_notes` is the internal note; neither `client` nor a guest sees it.
    `show_people` is the task assignees. A guest is not given them even as
    identifiers: an organization's membership is not something published
    alongside the plan, and per the specification not even a `client` with an
    account sees it.

    Raises `CalendarError` if no working days are left in the calendar: which code
    to call that is the route's decision.
    """
    # A relative plan lives on an axis with no real dates, and its calendar is a
    # single weekly mask: holidays and declared working days will land on the plan
    # when it is anchored to a start date (see app.schedule).
    relative = project.schedule_mode == ScheduleMode.RELATIVE
    calendar = relative_calendar(project, org) if relative else project_calendar(project, org)

    # Positions can coincide in one edge case (a row restored by an undo to a
    # position another row has taken since), so the id is a mandatory second sort
    # key rather than position alone.
    categories = db.scalars(
        select(Category)
        .where(Category.project_id == project.id)
        .order_by(Category.position, Category.id)
    ).all()
    tasks = db.scalars(
        select(Task).where(Task.project_id == project.id).order_by(Task.position, Task.id)
    ).all()

    # One query for the whole project rather than a query per task: with a hundred
    # tasks the latter would mean a hundred queries for one screen.
    assignees: dict[str, list[str]] = {str(t.id): [] for t in tasks}
    if show_people:
        for task_id, user_id in db.execute(
            select(TaskAssignee.task_id, TaskAssignee.user_id)
            .join(Task, Task.id == TaskAssignee.task_id)
            .where(Task.project_id == project.id)
            .order_by(TaskAssignee.user_id)
        ).all():
            assignees[str(task_id)].append(str(user_id))

    dependencies = db.execute(
        select(Dependency.from_task_id, Dependency.to_task_id)
        .where(Dependency.project_id == project.id)
        .order_by(Dependency.from_task_id, Dependency.to_task_id)
    ).all()

    ends = [end_date(t.start_date, t.duration_days, calendar) for t in tasks]
    # The critical path travels with the state rather than as a separate request:
    # it is drawn on the same bars, and a second trip to the server would mean a
    # chart that finishes drawing itself a frame after it appears. The server
    # computes it: slack is measured in working days, and the calendar is a
    # property of the project (see app/critical.py).
    critical = critical_tasks(
        {t.id: t.start_date for t in tasks},
        {t.id: finish for t, finish in zip(tasks, ends)},
        dependencies,
        calendar,
    )
    # The baseline plan's end is computed by the server against the same calendar
    # as the current one: the ghost under a bar must stand where a real bar with
    # those dates would stand, and the client does not repeat the calendar
    # arithmetic.
    baseline_ends = [
        end_date(t.baseline_start, t.baseline_duration, calendar)
        if t.baseline_start is not None and t.baseline_duration is not None
        else None
        for t in tasks
    ]

    return {
        "id": str(project.id),
        "name": project.name,
        "slug": project.slug,
        "deadline": project.deadline.isoformat() if project.deadline else None,
        # The plan: whether it is approved and under which version. From these two
        # values the interface tells a draft (edits are free) from an approved plan
        # and knows which button to show — "Approve" or "Re-approve".
        "plan_approved_at": (
            project.plan_approved_at.isoformat() if project.plan_approved_at else None
        ),
        "plan_version": project.plan_version,
        # The schedule mode and the assigned start. From them the interface picks
        # the scale — "Month 1 / Week 1" or real months — and knows which button to
        # show: "Assign a start date" or "Change".
        "schedule_mode": project.schedule_mode,
        "start_date": project.start_date.isoformat() if project.start_date else None,
        # Automatic shifting along dependencies: whether it is on for this project.
        # The interface needs more than the switch in the settings — with shifting
        # on it does not offer to move a task by hand (see DependencyNudge): an
        # offer to do what has already been done reads as a malfunction.
        "auto_schedule": project.auto_schedule,
        # What the "Undo" button will undo — together with the state rather than as
        # a separate request: the button must be inactive right away rather than
        # coming to life a frame after the render.
        "undoable": undoable,
        # The maximum over the tasks' finish dates; an empty project has no end.
        "project_end": max(ends).isoformat() if ends else None,
        # The calendar travels with the state: the interface fills non-working days
        # and draws weekends before the first click rather than guessing at them.
        "calendar": {
            "working_days": calendar.working_days,
            "holidays": sorted(d.isoformat() for d in calendar.holidays),
            "extra_workdays": sorted(d.isoformat() for d in calendar.extra_workdays),
        },
        # The resolved values rather than the project's raw nullable columns: which
        # of them were inherited from the organization and which were set directly
        # is not the interface's business.
        "settings": {
            "shift_threshold_days": resolve_shift_threshold(project, org),
            "timezone": resolve_timezone(project, org),
        },
        # The raw overrides — next to the resolved values, but separate from them.
        # The settings screen needs exactly this distinction: `null` there means
        # "inherit", and showing it as an inherited number would mean offering a
        # person to override what they never overrode.
        "overrides": {
            "timezone": project.timezone,
            "working_days": project.working_days,
            "shift_threshold_days": project.shift_threshold_days,
            "holidays_extra": list(project.holidays_extra or []),
            "workdays_extra": list(project.workdays_extra or []),
        },
        "categories": [
            {"id": str(c.id), "name": c.name, "color": c.color, "position": c.position}
            for c in categories
        ],
        "tasks": [
            {
                "id": str(t.id),
                "category_id": str(t.category_id),
                "name": t.name,
                "description": t.description,
                "start_date": t.start_date.isoformat(),
                "duration_days": t.duration_days,
                "end_date": task_end.isoformat(),
                # A milestone is drawn as a diamond on its day rather than as a
                # segment. A flag rather than an inference from "the duration equals
                # one day": one-day tasks are plentiful and do not become
                # milestones.
                "milestone": t.milestone,
                # A task with no slack: move it by a day and the whole project moves
                # by a day. A computed value rather than a stored one: it is derived
                # from dates and dependencies and would diverge from them on the
                # very first edit.
                "critical": t.id in critical,
                "criticality": t.criticality,
                # The risk flag is the contributor's word, no more secret than the
                # status: the dot on the bar is drawn for a guest too, as is the
                # blocked hatching.
                "risk": t.risk,
                "risk_note": t.risk_note,
                "progress_pct": t.progress_pct,
                # The status is no more secret than the progress: the public page
                # shows the same bars, and both outputs are assembled by this one
                # function.
                "status": t.status,
                "position": t.position,
                "assignee_ids": assignees[str(t.id)],
                # The baseline plan always travels with the task rather than via a
                # separate request: its ghost is drawn under every bar, and a second
                # trip to the server for it would mean a chart that finishes drawing
                # itself a frame after it appears.
                #
                # Empty baseline_* under an approved plan is itself the "beyond the
                # original plan" flag: there is no separate flag, because it would be
                # computable from these same two fields and would one day diverge
                # from them.
                "baseline_start": t.baseline_start.isoformat() if t.baseline_start else None,
                "baseline_duration": t.baseline_duration,
                "baseline_end": baseline_end.isoformat() if baseline_end else None,
                **({"internal_note": t.internal_note} if show_notes else {}),
            }
            for t, task_end, baseline_end in zip(tasks, ends, baseline_ends)
        ],
        "dependencies": [
            {"from_task_id": str(source), "to_task_id": str(target)}
            for source, target in dependencies
        ],
    }


def comments_out(db: DbSession, comments: Sequence[Comment]) -> list[dict]:
    """The feed of remarks.

    The author is returned identically for a member and for a guest — by name and
    by the `guest` flag. A member's identifier does not go outward: a signature
    under a remark does not need it, and the public page shows the same feed as
    the working screen.
    """
    names: dict[UUID, str] = author_names(db, comments)
    return [
        {
            "id": str(comment.id),
            "task_id": str(comment.task_id) if comment.task_id else None,
            "author": {
                "name": (
                    comment.guest_name
                    if comment.guest_name is not None
                    else names.get(comment.author_user_id, "")
                ),
                "guest": comment.guest_name is not None,
            },
            "body": comment.body,
            "created_at": comment.created_at.isoformat(),
            # The field does not lie to a guest: internal remarks do not reach
            # their feed at all (list_comments include_internal=False), so here it
            # is always false for them. A member needs the flag so that the feed
            # distinguishes "aside" from the general conversation.
            "internal": comment.internal,
        }
        for comment in comments
    ]
