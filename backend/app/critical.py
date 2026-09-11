"""The critical path: the tasks that have no slack.

A critical task is one whose shift by a day shifts the finish of the whole
project. This is the one question a chart without such a computation does not
answer at all: every bar is visible, but which of them holds the deadline —
none of them.

It is computed here rather than on the client for the same reason the server
computes the finish date: slack is measured in working days, and the working
calendar is a property of the project, so a second computation of it in the
browser would diverge from the first on the very first holiday.

Total float is computed, not free float: free float answers "how far can this
task move without touching its neighbour", while the question is always about
the project's deadline. Zero total float is exactly what criticality is.

There is deliberately no forward pass here. The early dates are already known —
they are the task's `start_date` and `end_date` — and building a plan on top of
them for "how it would be if everything started as early as possible" would
mean showing as critical something that is not on the chart: the dates were
assigned by a person, not computed.
"""

import uuid
from collections.abc import Iterable, Mapping
from datetime import date

from app.calendar import Calendar, count_working_days


def _slack(finished: date, starts: date, cal: Calendar) -> int:
    """Working days of idle time between one task's finish and another's start.

    Zero means the second starts on the very next working day. There is no
    negative value: a task started before its blocker finished is a violated
    dependency, not negative slack. Its slack is zero, and it will land on the
    critical path first, which is right: that is exactly what needs fixing.
    """
    if starts <= finished:
        return 0
    return max(0, count_working_days(finished, starts, cal) - 2)


def critical_tasks(
    starts: Mapping[uuid.UUID, date],
    ends: Mapping[uuid.UUID, date],
    dependencies: Iterable[tuple[uuid.UUID, uuid.UUID]],
    cal: Calendar,
) -> set[uuid.UUID]:
    """The ids of tasks with no slack.

    An empty project has no critical path: there is nothing to hold.

    A cycle in the dependencies is impossible — `add_dependency` rejects it —
    but relying on that as the only defence is not an option: the revision
    journal and restoring from a snapshot go around that check. So the walk
    counts degrees and stops at whatever it managed to resolve: a task caught in
    a cycle simply gets no slack and does not become critical. Silent
    incompleteness here is better than an infinite loop in the answer to a GET
    of a project.
    """
    if not starts:
        return set()

    successors: dict[uuid.UUID, list[uuid.UUID]] = {task: [] for task in starts}
    # How many of a task's successors are still unresolved. The backward pass
    # takes a task only once the counter has reached zero: slack is computed
    # from the slack of whoever follows, and on half of them it would be wrong.
    pending: dict[uuid.UUID, int] = {task: 0 for task in starts}
    predecessors: dict[uuid.UUID, list[uuid.UUID]] = {task: [] for task in starts}

    for source, target in dependencies:
        # A dependency outlives a task by exactly one server answer: the state
        # could have been assembled at the very moment a colleague deleted the task.
        if source not in successors or target not in successors:
            continue
        successors[source].append(target)
        predecessors[target].append(source)
        pending[source] += 1

    project_end = max(ends[task] for task in starts)

    floats: dict[uuid.UUID, int] = {}
    queue = [task for task, left in pending.items() if left == 0]

    while queue:
        task = queue.pop()
        after = successors[task]
        floats[task] = (
            min(_slack(ends[task], starts[nxt], cal) + floats[nxt] for nxt in after)
            if after
            # The tail of a chain holds the project's deadline directly: its
            # slack is the distance from its finish to the project's finish.
            else max(0, count_working_days(ends[task], project_end, cal) - 1)
        )

        for before in predecessors[task]:
            pending[before] -= 1
            if pending[before] == 0:
                queue.append(before)

    return {task for task, slack in floats.items() if slack == 0}
