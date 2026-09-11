"""Automatic shifting along dependencies: a successor does not start before its
predecessor has finished.

The rule is off by default and is enabled per project (`auto_schedule`). The
reason is not caution: a dependency in this system is first of all a picture,
and until now it moved nothing at all (see DependencyNudge — a suggestion, not
an action). Enabling automatic shifting changes the meaning of every dependency
in the project at once, and that must happen by a person's decision rather than
on an upgrade.

It only moves forward. A task with slack left between it and its predecessor is
not pulled back — even if the dependencies would let it start earlier. Slack in
a plan is most often put there on purpose: acceptance, a holiday, a delivery
window. Automatic shifting that swept such gaps away would be rewriting a plan
nobody asked to have rewritten, and doing it silently.

It walks forward along dependencies from the changed tasks rather than over the
whole project: a walk over the whole project would "fix" violations a person
left deliberately and which have nothing to do with their current edit.
"""

import uuid
from collections import deque
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.calendar import Calendar, end_date, first_working_on_or_after
from app.models import Dependency, Project, Task


def push_successors(
    db: DbSession,
    project: Project,
    cal: Calendar,
    seeds: set[uuid.UUID],
) -> dict[uuid.UUID, date]:
    """Move the successors of the changed tasks. Returns their previous dates.

    The previous ones, not the new ones: what is returned goes into the inverse
    operation, and it is what puts the plan back on undo. The caller can see the
    new dates anyway — they are already on the tasks.

    A cycle is impossible (add_dependency rejects it), but the walk is still
    bounded by the number of tasks: the revision journal and restoring from a
    snapshot go around that check, and a walk looping here would hang the
    request.
    """
    if not seeds:
        return {}

    tasks = {
        task.id: task
        for task in db.scalars(select(Task).where(Task.project_id == project.id)).all()
    }
    links: dict[uuid.UUID, list[uuid.UUID]] = {task_id: [] for task_id in tasks}
    for source, target in db.execute(
        select(Dependency.from_task_id, Dependency.to_task_id).where(
            Dependency.project_id == project.id
        )
    ).all():
        if source in links and target in tasks:
            links[source].append(target)

    was: dict[uuid.UUID, date] = {}
    queue = deque(seed for seed in seeds if seed in tasks)
    # The walk's ceiling: every task may be queued again when yet another
    # predecessor moves it, but no more than once per dependency.
    steps = len(tasks) * (sum(len(after) for after in links.values()) + 1) + 1

    while queue:
        steps -= 1
        if steps < 0:
            break
        current = tasks[queue.popleft()]
        finished = end_date(current.start_date, current.duration_days, cal)
        # The next working day after the finish is the earliest the work waiting
        # on this task can start.
        earliest = first_working_on_or_after(finished + timedelta(days=1), cal)

        for after_id in links[current.id]:
            after = tasks[after_id]
            if after.start_date >= earliest:
                continue
            was.setdefault(after.id, after.start_date)
            after.start_date = earliest
            queue.append(after.id)

    db.flush()
    return was


def apply_dates(db: DbSession, project: Project, dates: dict[uuid.UUID, date]) -> dict[uuid.UUID, date]:
    """Set dates from a ready map. Returns the previous ones — for undoing an undo.

    The restore path: the map is dictated by the journal, and nothing is
    computed here from dependencies — the computation already ran in the forward
    operation. Recomputing it would mean landing on undo in a different state
    from the one we left: moving forward is reversible, "move to the earliest
    possible" is not.
    """
    if not dates:
        return {}

    was: dict[uuid.UUID, date] = {}
    for task in db.scalars(
        select(Task).where(Task.project_id == project.id, Task.id.in_(dates))
    ).all():
        was[task.id] = task.start_date
        task.start_date = dates[task.id]
    db.flush()
    return was
