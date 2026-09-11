"""An approved plan and the mandatory reason for a shift — section 5 of the specification.

Item 2 of section 13 requires accumulation to be checked separately: three shifts of
one day each from the baseline plan require a reason on the third. That is the whole
meaning of the rule "the deviation is counted from the baseline plan rather than from
the previous value", and without such a test, swapping the base for the previous value
would pass unnoticed — each individual one-day shift looks innocent.
"""

from datetime import date

import pytest

from app.models import Category, Organization, Project, Task
from app.mutations import (
    CreateCategory,
    CreateTask,
    MoveTask,
    ReasonRequired,
    SetDuration,
    apply_op,
    undo,
)
from app.plans import approve_plan, deviation_days, plan_versions


@pytest.fixture
def org(db):
    org = Organization(name="Acme", slug="acme")
    db.add(org)
    db.flush()
    return org


@pytest.fixture
def project(db, org):
    project = Project(org_id=org.id, name="Redesign", slug="redesign")
    db.add(project)
    db.flush()
    return project


@pytest.fixture
def category(db, project):
    revision = apply_op(db, project, CreateCategory(name="Design", color="#3b82f6"), actor_id=None)
    return db.get(Category, revision.op["category_id"])


def _task(db, project, category, *, start=date(2026, 3, 2), duration=5, name="Logo") -> Task:
    revision = apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id), name=name, start_date=start, duration_days=duration
        ),
        actor_id=None,
    )
    return db.get(Task, revision.op["task_id"])


# --- approval ------------------------------------------------------------------


def test_approval_snapshots_dates_into_the_baseline_of_every_task(db, project, category):
    task = _task(db, project, category)

    version = approve_plan(db, project, actor_id=None)

    assert version.version == 1
    assert project.plan_version == 1
    assert project.plan_approved_at is not None
    assert task.baseline_start == date(2026, 3, 2)
    assert task.baseline_duration == 5
    assert version.snapshot[str(task.id)] == {
        "name": "Logo",
        "start_date": "2026-03-02",
        "duration_days": 5,
    }


def test_a_task_created_after_approval_has_no_baseline(db, project, category):
    _task(db, project, category)
    approve_plan(db, project, actor_id=None)

    extra = _task(db, project, category, name="Сверх плана")

    # That is exactly what the "beyond the original plan" mark means: adding work is
    # normal and requires no explanations.
    assert extra.baseline_start is None
    assert extra.baseline_duration is None
    assert deviation_days(extra, start_date=date(2026, 12, 1)) is None


def test_reapproval_moves_the_baseline_and_keeps_the_old_version(db, project, category):
    task = _task(db, project, category)
    approve_plan(db, project, actor_id=None)

    apply_op(db, project, MoveTask(task_id=task.id, start_date=date(2026, 3, 30)), actor_id=None,
             reason="заказчик не прислал брендбук")
    second = approve_plan(db, project, actor_id=None)

    assert second.version == 2
    assert task.baseline_start == date(2026, 3, 30)

    # The old version stays: otherwise the chronicle of "what was promised in January"
    # vanishes at the very moment the promise stopped being kept.
    versions = plan_versions(db, project)
    assert [v.version for v in versions] == [2, 1]
    assert versions[-1].snapshot[str(task.id)]["start_date"] == "2026-03-02"


# --- the threshold -------------------------------------------------------------


def test_a_shift_within_the_threshold_needs_no_reason(db, project, category, org):
    task = _task(db, project, category)
    approve_plan(db, project, actor_id=None)

    apply_op(db, project, MoveTask(task_id=task.id, start_date=date(2026, 3, 4)), actor_id=None)

    assert task.start_date == date(2026, 3, 4)


def test_a_shift_beyond_the_threshold_without_a_reason_is_refused(db, project, category, org):
    task = _task(db, project, category)
    approve_plan(db, project, actor_id=None)

    with pytest.raises(ReasonRequired) as error:
        apply_op(db, project, MoveTask(task_id=task.id, start_date=date(2026, 3, 9)), actor_id=None)

    assert error.value.code == "reason_required"
    assert error.value.deviation_days == 7
    assert error.value.threshold_days == org.default_shift_threshold_days
    # There is no intermediate "moved but not explained" state: the change was not
    # applied at all.
    assert task.start_date == date(2026, 3, 2)


def test_the_same_shift_goes_through_once_the_reason_is_given(db, project, category):
    task = _task(db, project, category)
    approve_plan(db, project, actor_id=None)

    revision = apply_op(
        db,
        project,
        MoveTask(task_id=task.id, start_date=date(2026, 3, 9)),
        actor_id=None,
        reason="заказчик не прислал брендбук",
    )

    assert task.start_date == date(2026, 3, 9)
    # The reason is stored as entered and is not translated: it is a person's text.
    assert revision.reason == "заказчик не прислал брендбук"


def test_three_one_day_shifts_ask_for_a_reason_on_the_third(db, project, category):
    """Accumulation — item 2 of section 13.

    The threshold is 2 days. Each individual step is one day, that is, below the
    threshold when counted from the previous value; from the baseline plan the third
    step gives 3 days and must ask for a reason.
    """
    task = _task(db, project, category)
    approve_plan(db, project, actor_id=None)

    apply_op(db, project, MoveTask(task_id=task.id, start_date=date(2026, 3, 3)), actor_id=None)
    apply_op(db, project, MoveTask(task_id=task.id, start_date=date(2026, 3, 4)), actor_id=None)

    with pytest.raises(ReasonRequired) as error:
        apply_op(db, project, MoveTask(task_id=task.id, start_date=date(2026, 3, 5)), actor_id=None)

    assert error.value.deviation_days == 3
    assert task.start_date == date(2026, 3, 4)


def test_a_shift_back_towards_the_baseline_needs_no_reason(db, project, category):
    """The deviation is measured by absolute value, but from the baseline plan.

    A task that moved a week away with an explanation comes back into place freely:
    what has to be explained is the divergence from what was promised, not every
    movement.
    """
    task = _task(db, project, category)
    approve_plan(db, project, actor_id=None)
    apply_op(
        db,
        project,
        MoveTask(task_id=task.id, start_date=date(2026, 3, 16)),
        actor_id=None,
        reason="подрядчик сорвал срок",
    )

    apply_op(db, project, MoveTask(task_id=task.id, start_date=date(2026, 3, 2)), actor_id=None)

    assert task.start_date == date(2026, 3, 2)


def test_stretching_the_duration_past_the_threshold_also_asks(db, project, category):
    task = _task(db, project, category)
    approve_plan(db, project, actor_id=None)

    with pytest.raises(ReasonRequired) as error:
        apply_op(db, project, SetDuration(task_id=task.id, duration_days=9), actor_id=None)

    assert error.value.deviation_days == 4
    assert task.duration_days == 5


def test_before_approval_nothing_is_asked(db, project, category):
    """Before "Approve plan" is pressed, edits are free and nothing is asked."""
    task = _task(db, project, category)

    apply_op(db, project, MoveTask(task_id=task.id, start_date=date(2026, 6, 1)), actor_id=None)

    assert task.start_date == date(2026, 6, 1)


def test_the_project_threshold_overrides_the_organization_one(db, project, category, org):
    org.default_shift_threshold_days = 2
    project.shift_threshold_days = 10
    db.flush()
    task = _task(db, project, category)
    approve_plan(db, project, actor_id=None)

    apply_op(db, project, MoveTask(task_id=task.id, start_date=date(2026, 3, 10)), actor_id=None)

    assert task.start_date == date(2026, 3, 10)


def test_undo_of_a_shift_beyond_the_threshold_asks_as_well(db, project, category):
    """An undo is not a privileged action.

    If a return takes the task further from the baseline plan than the threshold, an
    explanation is needed exactly as it is by any other way of getting there; otherwise
    the rule is bypassed by a "shift with a reason — undo the undo" pair.
    """
    task = _task(db, project, category)
    approve_plan(db, project, actor_id=None)
    shift = apply_op(
        db,
        project,
        MoveTask(task_id=task.id, start_date=date(2026, 3, 16)),
        actor_id=None,
        reason="подрядчик сорвал срок",
    )
    back = undo(db, project, shift, actor_id=None)

    with pytest.raises(ReasonRequired):
        undo(db, project, back, actor_id=None)

    assert task.start_date == date(2026, 3, 2)


def test_a_duration_edit_is_not_charged_for_the_start_shift(db, project, category):
    """Wave 1.7: the dimensions are not mixed.

    A task whose start has moved with an explanation (7 days against a threshold of 2)
    edits its duration by a day — within the threshold. Before the fix the deviation was
    computed as the max over both dimensions, and an edit to the duration demanded a
    reason for someone else's shift of the start.
    """
    task = _task(db, project, category)
    approve_plan(db, project, actor_id=None)
    apply_op(
        db,
        project,
        MoveTask(task_id=task.id, start_date=date(2026, 3, 9)),
        actor_id=None,
        reason="подрядчик сорвал срок",
    )

    apply_op(db, project, SetDuration(task_id=task.id, duration_days=6), actor_id=None)

    assert task.duration_days == 6


def test_the_reported_deviation_belongs_to_the_edited_dimension(db, project, category):
    """The X-Shift-Deviation-Days header names the number from the dimension being edited.

    The start moved by 7, the duration is edited by 4: the refusal must name 4 — the
    interface shows that number to the person as "how far your edit takes it", and 7 in
    it would be a lie.
    """
    task = _task(db, project, category)
    approve_plan(db, project, actor_id=None)
    apply_op(
        db,
        project,
        MoveTask(task_id=task.id, start_date=date(2026, 3, 9)),
        actor_id=None,
        reason="подрядчик сорвал срок",
    )

    with pytest.raises(ReasonRequired) as error:
        apply_op(db, project, SetDuration(task_id=task.id, duration_days=9), actor_id=None)

    assert error.value.deviation_days == 4


def test_without_arguments_deviation_reports_the_larger_dimension(db, project, category):
    task = _task(db, project, category)
    approve_plan(db, project, actor_id=None)
    apply_op(
        db,
        project,
        MoveTask(task_id=task.id, start_date=date(2026, 3, 9)),
        actor_id=None,
        reason="подрядчик сорвал срок",
    )

    # The question "how far has the task drifted from what was promised" is still a max.
    assert deviation_days(task) == 7
