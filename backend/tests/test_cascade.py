"""Automatic shifting along dependencies, and the critical path.

Both are computed on the server, and for one reason: slack and layout are measured
in working days, and the working calendar is a property of the project.
"""

from datetime import date

import pytest
from sqlalchemy import func, select

from app.models import Category, Organization, Project, Revision, Task
from app.mutations import (
    AddDependency,
    CreateCategory,
    CreateTask,
    MoveCategory,
    MoveTask,
    RemoveDependency,
    ResizeTask,
    SetDuration,
    apply_op,
    undo,
)


@pytest.fixture
def project(db):
    org = Organization(name="Acme", slug="acme")
    db.add(org)
    db.flush()
    # Automatic shifting is on: it is off by default, and the tests below check
    # exactly it. That it stays silent while off is checked by a separate test.
    project = Project(org_id=org.id, name="Redesign", slug="redesign", auto_schedule=True)
    db.add(project)
    db.flush()
    return project


@pytest.fixture
def category(db, project):
    revision = apply_op(db, project, CreateCategory(name="Design", color="#3b82f6"), actor_id=None)
    return db.get(Category, revision.op["category_id"])


def _task(db, project, category, name, start, duration=1):
    return apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id),
            name=name,
            start_date=start,
            duration_days=duration,
        ),
        actor_id=None,
    ).op["task_id"]


def _link(db, project, first, second):
    return apply_op(
        db, project, AddDependency(from_task_id=first, to_task_id=second), actor_id=None
    )


def _starts(db, *task_ids):
    return [db.get(Task, task_id).start_date for task_id in task_ids]


# --- shifting forward ---------------------------------------------------------


def test_moving_a_predecessor_pushes_its_successor(db, project, category):
    # 4 March is a Wednesday; the week runs Monday to Friday.
    first = _task(db, project, category, "Макет", date(2026, 3, 4), duration=2)
    second = _task(db, project, category, "Вёрстка", date(2026, 3, 6), duration=2)
    _link(db, project, first, second)

    apply_op(db, project, MoveTask(task_id=first, start_date=date(2026, 3, 9)), actor_id=None)

    # The first runs 9-10 March, so the second must start on the 11th.
    assert _starts(db, first, second) == [date(2026, 3, 9), date(2026, 3, 11)]


def test_the_push_runs_through_the_whole_chain(db, project, category):
    first = _task(db, project, category, "Первая", date(2026, 3, 4))
    second = _task(db, project, category, "Вторая", date(2026, 3, 5))
    third = _task(db, project, category, "Третья", date(2026, 3, 6))
    _link(db, project, first, second)
    _link(db, project, second, third)

    apply_op(db, project, MoveTask(task_id=first, start_date=date(2026, 3, 10)), actor_id=None)

    assert _starts(db, first, second, third) == [
        date(2026, 3, 10),
        date(2026, 3, 11),
        date(2026, 3, 12),
    ]


def test_the_push_skips_non_working_days(db, project, category):
    # Friday 6 March plus a day is Monday the 9th, not Saturday.
    first = _task(db, project, category, "Макет", date(2026, 3, 6))
    second = _task(db, project, category, "Вёрстка", date(2026, 3, 6))
    _link(db, project, first, second)

    apply_op(db, project, MoveTask(task_id=first, start_date=date(2026, 3, 6)), actor_id=None)

    assert db.get(Task, second).start_date == date(2026, 3, 9)


def test_a_successor_with_slack_is_not_pulled_back(db, project, category):
    # Slack in a plan is most often put there on purpose: acceptance, a holiday, a delivery.
    first = _task(db, project, category, "Макет", date(2026, 3, 4))
    second = _task(db, project, category, "Вёрстка", date(2026, 3, 20))
    _link(db, project, first, second)

    apply_op(db, project, MoveTask(task_id=first, start_date=date(2026, 3, 5)), actor_id=None)

    assert db.get(Task, second).start_date == date(2026, 3, 20)


def test_a_project_without_auto_schedule_moves_nothing_else(db, project, category):
    project.auto_schedule = False
    db.flush()
    first = _task(db, project, category, "Макет", date(2026, 3, 4))
    second = _task(db, project, category, "Вёрстка", date(2026, 3, 5))
    _link(db, project, first, second)

    apply_op(db, project, MoveTask(task_id=first, start_date=date(2026, 3, 16)), actor_id=None)

    assert db.get(Task, second).start_date == date(2026, 3, 5)


def test_stretching_a_task_pushes_what_waits_for_it(db, project, category):
    first = _task(db, project, category, "Макет", date(2026, 3, 4), duration=2)
    second = _task(db, project, category, "Вёрстка", date(2026, 3, 6))
    _link(db, project, first, second)

    apply_op(db, project, SetDuration(task_id=first, duration_days=4), actor_id=None)

    # 4 March plus four working days runs through 9 March, so the second starts on the 10th.
    assert db.get(Task, second).start_date == date(2026, 3, 10)


def test_the_left_edge_pushes_too(db, project, category):
    first = _task(db, project, category, "Макет", date(2026, 3, 4), duration=2)
    second = _task(db, project, category, "Вёрстка", date(2026, 3, 6))
    _link(db, project, first, second)

    apply_op(
        db,
        project,
        ResizeTask(task_id=first, start_date=date(2026, 3, 3), duration_days=6),
        actor_id=None,
    )

    assert db.get(Task, second).start_date == date(2026, 3, 11)


def test_a_new_link_pushes_the_successor_at_once(db, project, category):
    first = _task(db, project, category, "Макет", date(2026, 3, 10), duration=3)
    second = _task(db, project, category, "Вёрстка", date(2026, 3, 4))

    _link(db, project, first, second)

    # A dependency is what "this work waits on that one" means: the second moves out past the first.
    assert db.get(Task, second).start_date == date(2026, 3, 13)


def test_moving_a_category_pushes_what_waits_outside_it(db, project, category):
    inside = _task(db, project, category, "Макет", date(2026, 3, 4))
    other = apply_op(db, project, CreateCategory(name="Build", color="#22c55e"), actor_id=None)
    outside = apply_op(
        db,
        project,
        CreateTask(
            category_id=other.op["category_id"],
            name="Вёрстка",
            start_date=date(2026, 3, 5),
            duration_days=1,
        ),
        actor_id=None,
    ).op["task_id"]
    _link(db, project, inside, outside)

    apply_op(db, project, MoveCategory(category_id=str(category.id), days=7), actor_id=None)

    assert _starts(db, inside, outside) == [date(2026, 3, 11), date(2026, 3, 12)]


# --- undo ---------------------------------------------------------------------


def test_the_whole_chain_comes_back_in_one_undo(db, project, category):
    first = _task(db, project, category, "Первая", date(2026, 3, 4))
    second = _task(db, project, category, "Вторая", date(2026, 3, 5))
    third = _task(db, project, category, "Третья", date(2026, 3, 6))
    _link(db, project, first, second)
    _link(db, project, second, third)
    moved = apply_op(
        db, project, MoveTask(task_id=first, start_date=date(2026, 3, 10)), actor_id=None
    )

    undo(db, project, moved, actor_id=None)

    assert _starts(db, first, second, third) == [
        date(2026, 3, 4),
        date(2026, 3, 5),
        date(2026, 3, 6),
    ]


def test_the_push_is_one_revision_not_one_per_task(db, project, category):
    first = _task(db, project, category, "Первая", date(2026, 3, 4))
    second = _task(db, project, category, "Вторая", date(2026, 3, 5))
    _link(db, project, first, second)
    before = db.scalar(select(func.count()).select_from(Revision))

    apply_op(db, project, MoveTask(task_id=first, start_date=date(2026, 3, 10)), actor_id=None)

    assert db.scalar(select(func.count()).select_from(Revision)) == before + 1


def test_the_journal_names_who_was_pushed(db, project, category):
    first = _task(db, project, category, "Первая", date(2026, 3, 4))
    second = _task(db, project, category, "Вторая", date(2026, 3, 5))
    _link(db, project, first, second)

    moved = apply_op(
        db, project, MoveTask(task_id=first, start_date=date(2026, 3, 10)), actor_id=None
    )

    assert moved.op["cascade"] == {second: "2026-03-11"}
    # The inverse entry carries the previous dates: it is by them that an undo brings the plan back.
    assert moved.inverse["cascade"] == {second: "2026-03-05"}


def test_undoing_a_new_link_returns_the_successor(db, project, category):
    first = _task(db, project, category, "Макет", date(2026, 3, 10), duration=3)
    second = _task(db, project, category, "Вёрстка", date(2026, 3, 4))
    linked = _link(db, project, first, second)

    undo(db, project, linked, actor_id=None)

    assert db.get(Task, second).start_date == date(2026, 3, 4)


def test_removing_a_link_by_hand_moves_nobody(db, project, category):
    # The automatic shift does not pull backwards: a removed dependency leaves the plan as it is.
    first = _task(db, project, category, "Макет", date(2026, 3, 10), duration=3)
    second = _task(db, project, category, "Вёрстка", date(2026, 3, 4))
    _link(db, project, first, second)
    pushed = db.get(Task, second).start_date

    apply_op(
        db, project, RemoveDependency(from_task_id=first, to_task_id=second), actor_id=None
    )

    assert db.get(Task, second).start_date == pushed


def test_an_untouched_project_records_no_cascade(db, project, category):
    # An empty field in the journal would mean a trace of something that did not happen.
    lonely = _task(db, project, category, "Одна", date(2026, 3, 4))

    moved = apply_op(
        db, project, MoveTask(task_id=lonely, start_date=date(2026, 3, 11)), actor_id=None
    )

    assert "cascade" not in moved.op


# --- the critical path ---------------------------------------------------------


def _critical(client_state) -> set[str]:
    return {t["name"] for t in client_state["tasks"] if t["critical"]}


def test_the_longest_chain_is_critical_and_the_slack_one_is_not(db, project, category):
    # A chain of two holds the project's end; a lone short task does not.
    first = _task(db, project, category, "Первая", date(2026, 3, 4), duration=3)
    second = _task(db, project, category, "Вторая", date(2026, 3, 9), duration=5)
    _link(db, project, first, second)
    _task(db, project, category, "Сбоку", date(2026, 3, 4), duration=1)

    from app.api.serialization import project_state

    org = db.get(Organization, project.org_id)
    state = project_state(db, project, org, show_notes=True)

    assert _critical(state) == {"Первая", "Вторая"}


def test_a_task_that_ends_with_the_project_holds_the_date(db, project, category):
    _task(db, project, category, "Долгая", date(2026, 3, 4), duration=10)
    _task(db, project, category, "Короткая", date(2026, 3, 4), duration=2)

    from app.api.serialization import project_state

    org = db.get(Organization, project.org_id)
    state = project_state(db, project, org, show_notes=True)

    assert _critical(state) == {"Долгая"}


def test_slack_inside_a_chain_takes_it_off_the_path(db, project, category):
    # Between the first and the second there is a week of idle time, so the first can
    # be moved and the project's deadline will not slide because of it.
    first = _task(db, project, category, "Первая", date(2026, 3, 4), duration=2)
    second = _task(db, project, category, "Вторая", date(2026, 3, 23), duration=5)
    _link(db, project, first, second)

    from app.api.serialization import project_state

    org = db.get(Organization, project.org_id)
    state = project_state(db, project, org, show_notes=True)

    assert _critical(state) == {"Вторая"}


def test_an_empty_project_has_no_critical_path(db, project):
    from app.api.serialization import project_state

    org = db.get(Organization, project.org_id)
    state = project_state(db, project, org, show_notes=True)

    assert state["tasks"] == []
