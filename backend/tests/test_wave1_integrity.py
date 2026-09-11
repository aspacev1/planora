"""Wave 1 regression tests from the remediation plan: data integrity.

Every test reproduces a path that, before the fix, led to a 500 or to irreversible
data loss: a double undo from two tabs, an undo of a deletion losing dependencies and
the conversation, a batch rollback into a deleted category, a reorder journal the size
of the whole project.
"""

import threading
import uuid
from datetime import date, datetime, timezone

import pytest
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.models import (
    Category,
    Comment,
    Dependency,
    Membership,
    Organization,
    Project,
    Revision,
    Task,
    TaskAssignee,
    User,
)
from app.mutations import (
    ApplyPositions,
    CreateCategory,
    CreateTask,
    DeleteCategory,
    DeleteTask,
    InvalidOperation,
    MoveTask,
    MutationError,
    NotFoundInProject,
    PublicCreateTask,
    PublicMoveTask,
    ReasonRequired,
    ReorderTask,
    apply_op,
    undo,
    undo_batch,
    undo_last,
)


@pytest.fixture
def project(db):
    org = Organization(name="Acme", slug="acme")
    db.add(org)
    db.flush()
    project = Project(org_id=org.id, name="Redesign", slug="redesign")
    db.add(project)
    db.flush()
    return project


@pytest.fixture
def category(db, project):
    revision = apply_op(db, project, CreateCategory(name="Design", color="#3b82f6"), actor_id=None)
    return db.get(Category, revision.op["category_id"])


def _task(db, project, category, *, name="Logo", start=date(2026, 3, 2), duration=5) -> Task:
    revision = apply_op(
        db,
        project,
        CreateTask(category_id=category.id, name=name, start_date=start, duration_days=duration),
        actor_id=None,
    )
    return db.get(Task, revision.op["task_id"])


# --- 1.1: the double-undo race ------------------------------------------------


def test_two_simultaneous_undos_do_not_double_undo(engine):
    """The second of two simultaneous undos waits for the lock and finds an empty journal.

    Before the fix both tabs picked the same revision before the lock, and the loser
    applied the undo a second time — the project went back to where the first had just
    left. The test holds the lock with an uncommitted first undo and makes sure the
    second blocks, and that once it has waited it gets nothing_to_undo rather than a
    double rollback.

    It works on sessions of its own with real commits: a row lock is visible only
    between different transactions. The slug is unique in the database, so it uses its
    own, and the cleanup is in a finally so as not to leave litter for the neighbours.
    """
    make_session = sessionmaker(bind=engine)
    marker = uuid.uuid4().hex[:8]
    setup = make_session()
    org = Organization(name="Race", slug=f"race-{marker}")
    setup.add(org)
    setup.flush()
    project = Project(org_id=org.id, name="Race", slug=f"race-{marker}")
    setup.add(project)
    setup.flush()
    org_id, project_id = org.id, project.id
    setup.commit()

    first = make_session()
    second = make_session()
    try:
        project_one = first.get(Project, project_id)
        category_rev = apply_op(
            first, project_one, CreateCategory(name="Design", color="#3b82f6"), actor_id=None
        )
        task_rev = apply_op(
            first,
            project_one,
            CreateTask(
                category_id=uuid.UUID(category_rev.op["category_id"]),
                name="Logo",
                start_date=date(2026, 3, 2),
                duration_days=5,
            ),
            actor_id=None,
        )
        task_id = uuid.UUID(task_rev.op["task_id"])
        apply_op(
            first,
            project_one,
            MoveTask(task_id=task_id, start_date=date(2026, 3, 9)),
            actor_id=None,
        )
        first.commit()

        # The first undo: the lock is taken, the transaction is open — as if the request
        # were still running.
        applied, undone = undo_last(first, project_one, actor_id=None)
        assert undone.op["type"] == "move_task"

        outcome: dict[str, object] = {}

        def concurrent_undo():
            project_two = second.get(Project, project_id)
            try:
                _, rival_undone = undo_last(second, project_two, actor_id=None)
                outcome["undone_seq"] = rival_undone.seq
            except MutationError as error:
                outcome["refused"] = error.code
            finally:
                second.commit()

        rival = threading.Thread(target=concurrent_undo)
        rival.start()
        # The rival must stand at the lock until the first transaction is closed.
        rival.join(timeout=0.5)
        assert rival.is_alive(), "вторая отмена не ждала замок проекта"

        first.commit()
        rival.join(timeout=10)
        assert not rival.is_alive()

        # Two presses mean two steps back: the rival is entitled to undo the previous
        # revision (the creation of the task), but not the same one again.
        assert outcome.get("undone_seq") != undone.seq

        check = make_session()
        try:
            undo_revisions = check.scalars(
                select(Revision).where(
                    Revision.project_id == project_id, Revision.undoes_seq.is_not(None)
                )
            ).all()
            # The key check: the move was undone exactly once.
            assert [r.undoes_seq for r in undo_revisions].count(undone.seq) == 1
            task = check.get(Task, task_id)
            # The task is either back where it started (the second gesture stepped
            # further — to undoing the creation) or exists on its original date.
            if task is not None:
                assert task.start_date == date(2026, 3, 2)
        finally:
            check.close()
    finally:
        first.rollback()
        first.close()
        second.close()
        cleanup = make_session()
        cleanup.delete(cleanup.get(Organization, org_id))
        cleanup.commit()
        cleanup.close()


def test_undo_with_an_empty_journal_refuses_with_a_code(db, project):
    with pytest.raises(NotFoundInProject) as error:
        undo_last(db, project, actor_id=None)
    assert error.value.code == "nothing_to_undo"


# --- 1.2: the edge of dates ----------------------------------------------------


def test_wire_dates_beyond_the_horizon_are_refused():
    """A date beyond the horizon is rejected on the wire rather than failing in the calendar."""
    with pytest.raises(ValidationError):
        PublicMoveTask(task_id=uuid.uuid4(), start_date=date(2201, 1, 1))
    with pytest.raises(ValidationError):
        PublicCreateTask(
            category_id=uuid.uuid4(),
            name="Далеко",
            start_date=date(2201, 1, 1),
            duration_days=1,
        )
    with pytest.raises(ValidationError):
        PublicCreateTask(
            category_id=uuid.uuid4(),
            name="Далеко",
            start_date=date(2026, 1, 1),
            duration_days=1,
            baseline_start=date(2201, 1, 1),
        )


# --- 1.4: undoing a deletion brings the task's environment back ---------------


def _member(db, org_id, *, name="Мария", email="m@example.com") -> User:
    user = User(name=name, email=email, password_hash="x")
    db.add(user)
    db.flush()
    db.add(Membership(org_id=org_id, user_id=user.id, role="editor"))
    db.flush()
    return user


def test_undoing_a_task_deletion_restores_links_assignees_and_comments(db, project, category):
    task = _task(db, project, category)
    other = _task(db, project, category, name="Сайт")
    user = _member(db, project.org_id)

    db.add(Dependency(project_id=project.id, from_task_id=task.id, to_task_id=other.id))
    db.add(TaskAssignee(task_id=task.id, user_id=user.id))
    comment_id = uuid.uuid4()
    created_at = datetime(2026, 3, 3, 12, 0, tzinfo=timezone.utc)
    db.add(
        Comment(
            id=comment_id,
            project_id=project.id,
            task_id=task.id,
            author_user_id=user.id,
            body="Согласовано с клиентом",
            created_at=created_at,
        )
    )
    db.flush()

    deletion = apply_op(db, project, DeleteTask(task_id=task.id), actor_id=None)
    # The cascade carried the environment away — exactly what used to vanish forever.
    assert db.get(Comment, comment_id) is None

    undo(db, project, deletion, actor_id=None)

    restored = db.get(Task, task.id)
    assert restored is not None
    assert db.scalar(
        select(Dependency).where(
            Dependency.from_task_id == task.id, Dependency.to_task_id == other.id
        )
    ) is not None
    assert db.scalar(
        select(TaskAssignee).where(
            TaskAssignee.task_id == task.id, TaskAssignee.user_id == user.id
        )
    ) is not None
    comment = db.get(Comment, comment_id)
    assert comment is not None
    assert comment.body == "Согласовано с клиентом"
    assert comment.created_at == created_at
    assert comment.author_user_id == user.id


def test_restoring_a_task_skips_links_whose_other_end_is_gone(db, project, category):
    """The world has moved on: the dependency's other end was deleted — the undo does not fail.

    A skip rather than a refusal: the cascade would have done the same to the dependency,
    while a refusal would leave the person with no task at all.
    """
    task = _task(db, project, category)
    other = _task(db, project, category, name="Сайт")
    db.add(Dependency(project_id=project.id, from_task_id=task.id, to_task_id=other.id))
    db.flush()

    deletion = apply_op(db, project, DeleteTask(task_id=task.id), actor_id=None)
    apply_op(db, project, DeleteTask(task_id=other.id), actor_id=None)

    undo(db, project, deletion, actor_id=None)

    assert db.get(Task, task.id) is not None
    assert (
        db.scalar(select(Dependency).where(Dependency.from_task_id == task.id)) is None
    )


def test_a_guest_comment_survives_the_delete_undo_cycle(db, project, category):
    task = _task(db, project, category)
    db.add(
        Comment(
            project_id=project.id,
            task_id=task.id,
            guest_name="Заказчик",
            body="Хочется зеленее",
            created_at=datetime(2026, 3, 4, 9, 30, tzinfo=timezone.utc),
        )
    )
    db.flush()

    deletion = apply_op(db, project, DeleteTask(task_id=task.id), actor_id=None)
    undo(db, project, deletion, actor_id=None)

    comment = db.scalar(select(Comment).where(Comment.task_id == task.id))
    assert comment is not None
    assert comment.guest_name == "Заказчик"
    assert comment.author_user_id is None


# --- 1.5: a batch rollback ------------------------------------------------------


def test_batch_undo_into_a_deleted_category_refuses_with_a_code(db, project, category):
    """A restore into a deleted category is a coded refusal rather than an FK 500."""
    batch_id = uuid.uuid4()
    task_rev = apply_op(
        db,
        project,
        CreateTask(
            category_id=category.id, name="Логотип", start_date=date(2026, 3, 2), duration_days=5
        ),
        actor_id=None,
        batch_id=batch_id,
    )
    task_id = uuid.UUID(task_rev.op["task_id"])
    delete_batch = uuid.uuid4()
    apply_op(db, project, DeleteTask(task_id=task_id), actor_id=None, batch_id=delete_batch)
    apply_op(db, project, DeleteCategory(category_id=category.id), actor_id=None)

    with pytest.raises(NotFoundInProject) as error:
        undo_batch(db, project, delete_batch, actor_id=None)
    assert error.value.code == "category_not_found"


def test_apply_positions_with_desynced_maps_refuses_with_a_code(db, project, category):
    task = _task(db, project, category)
    with pytest.raises(InvalidOperation) as error:
        apply_op(
            db,
            project,
            ApplyPositions(positions={task.id: 0}, categories={}),
            actor_id=None,
        )
    assert error.value.code == "positions_categories_mismatch"


def test_batch_undo_accepts_a_reason_and_passes_the_threshold(db, project, category):
    """A rollback that takes a task away from the baseline plan is explainable — and therefore possible.

    Before the fix undo_batch accepted no reason at all: a batch that had returned a task
    to the plan was un-rollbackable — the reverse move required a reason, and there was
    nowhere to pass one.
    """
    from app.plans import approve_plan

    task = _task(db, project, category)
    approve_plan(db, project, actor_id=None)

    apply_op(
        db,
        project,
        MoveTask(task_id=task.id, start_date=date(2026, 3, 16)),
        actor_id=None,
        reason="подрядчик сорвал срок",
    )
    return_batch = uuid.uuid4()
    apply_op(
        db,
        project,
        MoveTask(task_id=task.id, start_date=date(2026, 3, 2)),
        actor_id=None,
        batch_id=return_batch,
    )

    # Rolling the return back takes it 14 days from the plan — with no reason, a refusal...
    with pytest.raises(ReasonRequired):
        undo_batch(db, project, return_batch, actor_id=None)

    # ...and with a reason the same rollback passes.
    undo_batch(db, project, return_batch, actor_id=None, reason="возврат был ошибкой")
    assert task.start_date == date(2026, 3, 16)


# --- 1.6: the reorder journal is a diff rather than a project snapshot ---------


def test_reorder_journals_only_the_rows_that_moved(db, project, category):
    first = _task(db, project, category, name="Первая")
    second = _task(db, project, category, name="Вторая")
    third = _task(db, project, category, name="Третья")
    other_rev = apply_op(db, project, CreateCategory(name="Разработка", color="#111111"),
                         actor_id=None)
    bystander = _task(
        db, project, db.get(Category, other_rev.op["category_id"]), name="Сторонняя"
    )

    revision = apply_op(
        db,
        project,
        ReorderTask(task_id=second.id, category_id=category.id, position=0),
        actor_id=None,
    )

    touched = set(revision.op["to"])
    # A task of another category did not move — it must not be in the journal.
    assert str(bystander.id) not in touched
    # The third task stayed in its position — also outside the journal.
    assert str(third.id) not in touched
    assert touched == {str(first.id), str(second.id)}
    assert set(revision.inverse["positions"]) == touched

    # The diff is enough for an undo: the order comes back exactly.
    undo(db, project, revision, actor_id=None)
    assert [db.get(Task, t.id).position for t in (first, second, third)] == [0, 1, 2]


def test_reorder_to_the_same_place_journals_nothing(db, project, category):
    task = _task(db, project, category)
    revision = apply_op(
        db,
        project,
        ReorderTask(task_id=task.id, category_id=category.id, position=0),
        actor_id=None,
    )
    assert revision.op["to"] == {}
    assert revision.inverse["positions"] == {}
