from datetime import date

import pytest
from sqlalchemy import func, select

from app.models import (
    Category,
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
    AddDependency,
    AssignUser,
    CreateCategory,
    CreateTask,
    DeleteCategory,
    DeleteTask,
    InvalidOperation,
    MoveCategory,
    MoveTask,
    NotFoundInProject,
    PublicCreateCategory,
    PublicCreateTask,
    RemoveDependency,
    RenameCategory,
    ReorderCategory,
    ReorderTask,
    ResizeTask,
    SetCategoryColor,
    SetCriticality,
    SetDuration,
    SetMilestone,
    SetProgress,
    SetRisk,
    SetStatus,
    SetTaskFields,
    UnassignUser,
    apply_op,
    to_internal,
    undo,
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
    revision = apply_op(
        db,
        project,
        CreateCategory(name="Design", color="#3b82f6"),
        actor_id=None,
    )
    return db.get(Category, revision.op["category_id"])


@pytest.fixture
def other_project(db):
    org = Organization(name="Globex", slug="globex")
    db.add(org)
    db.flush()
    project = Project(org_id=org.id, name="Migration", slug="migration")
    db.add(project)
    db.flush()
    return project


@pytest.fixture
def other_category(db, other_project):
    revision = apply_op(
        db,
        other_project,
        CreateCategory(name="Ops", color="#22c55e"),
        actor_id=None,
    )
    return db.get(Category, revision.op["category_id"])


def test_create_task_writes_a_revision_after_the_category_one(db, project, category):
    revision = apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id),
            name="Logo",
            start_date=date(2026, 3, 4),
            duration_days=5,
        ),
        actor_id=None,
    )

    assert revision.seq == 2  # the first revision went to creating the category
    assert revision.op["type"] == "create_task"
    assert revision.inverse["type"] == "delete_task"

    task = db.get(Task, revision.op["task_id"])
    assert task.name == "Logo"
    assert task.duration_days == 5


def test_seq_increments_per_project(db, project, category):
    for index in range(3):
        apply_op(
            db,
            project,
            CreateTask(
                category_id=str(category.id),
                name=f"Task {index}",
                start_date=date(2026, 3, 4),
                duration_days=2,
            ),
            actor_id=None,
        )

    numbers = [r.seq for r in db.query(Revision).order_by(Revision.seq).all()]
    assert numbers == [1, 2, 3, 4]


def test_move_task_records_both_dates(db, project, category):
    created = apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id),
            name="Logo",
            start_date=date(2026, 3, 4),
            duration_days=5,
        ),
        actor_id=None,
    )
    task_id = created.op["task_id"]

    moved = apply_op(
        db,
        project,
        MoveTask(task_id=task_id, start_date=date(2026, 3, 11)),
        actor_id=None,
        reason="брендбук задержали",
    )

    assert moved.op == {
        "type": "move_task",
        "task_id": task_id,
        "from": "2026-03-04",
        "to": "2026-03-11",
    }
    assert moved.inverse["to"] == "2026-03-04"
    assert moved.reason == "брендбук задержали"


def test_undo_restores_the_previous_state(db, project, category):
    created = apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id),
            name="Logo",
            start_date=date(2026, 3, 4),
            duration_days=5,
        ),
        actor_id=None,
    )
    task_id = created.op["task_id"]

    moved = apply_op(
        db, project, MoveTask(task_id=task_id, start_date=date(2026, 3, 11)), actor_id=None
    )
    undo(db, project, moved, actor_id=None)

    assert db.get(Task, task_id).start_date == date(2026, 3, 4)


def test_undo_of_a_delete_brings_the_task_back_with_the_same_id(db, project, category):
    created = apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id),
            name="Logo",
            start_date=date(2026, 3, 4),
            duration_days=5,
        ),
        actor_id=None,
    )
    task_id = created.op["task_id"]

    deleted = apply_op(db, project, DeleteTask(task_id=task_id), actor_id=None)
    assert db.get(Task, task_id) is None

    undo(db, project, deleted, actor_id=None)
    restored = db.get(Task, task_id)
    assert restored is not None
    assert restored.name == "Logo"


def test_deleting_a_category_takes_its_tasks_with_it(db, project, category):
    for name in ("Logo", "Layout"):
        apply_op(
            db,
            project,
            CreateTask(
                category_id=str(category.id),
                name=name,
                start_date=date(2026, 3, 4),
                duration_days=5,
            ),
            actor_id=None,
        )

    deleted = apply_op(db, project, DeleteCategory(category_id=str(category.id)), actor_id=None)

    assert db.get(Category, category.id) is None
    assert db.scalar(select(func.count()).select_from(Task)) == 0
    # The number of tasks goes into the entry itself: "deleted a category" would say
    # nothing about the stage that went away with it.
    assert deleted.op == {
        "type": "delete_category",
        "category_id": str(category.id),
        "tasks": 2,
    }


def test_undo_of_a_category_delete_brings_back_the_whole_stage(db, project, category, insider):
    """An undo brings back not a heading but the whole stage — with dependencies and people.

    That is what the ban on deleting a non-empty category was lifted for: deleting a stage
    row by row for the sake of its heading means as many deletions as it has tasks, and as
    many presses of "Undo" to change one's mind.
    """
    first = apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id),
            name="Logo",
            start_date=date(2026, 3, 4),
            duration_days=5,
        ),
        actor_id=None,
    ).op["task_id"]
    second = apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id),
            name="Layout",
            start_date=date(2026, 3, 11),
            duration_days=3,
        ),
        actor_id=None,
    ).op["task_id"]
    apply_op(db, project, AddDependency(from_task_id=first, to_task_id=second), actor_id=None)
    apply_op(db, project, AssignUser(task_id=first, user_id=str(insider.id)), actor_id=None)

    deleted = apply_op(db, project, DeleteCategory(category_id=str(category.id)), actor_id=None)
    undo(db, project, deleted, actor_id=None)

    restored = db.get(Category, category.id)
    assert restored is not None
    assert restored.name == "Design"
    assert [task.name for task in db.scalars(select(Task).order_by(Task.position))] == [
        "Logo",
        "Layout",
    ]
    # The identifiers are the same: references to the task from the journal and from a
    # neighbouring tab must keep leading to the same place.
    assert db.get(Task, first).duration_days == 5
    # The dependency between two tasks of one category comes back too — and it would not,
    # were every task's environment restored right after its row: at that moment the
    # second task does not exist yet.
    assert db.scalar(select(func.count()).select_from(Dependency)) == 1
    assert db.scalar(select(func.count()).select_from(TaskAssignee)) == 1


def test_undo_of_an_empty_category_delete_restores_it_with_the_same_id(db, project, category):
    deleted = apply_op(db, project, DeleteCategory(category_id=str(category.id)), actor_id=None)
    assert db.get(Category, category.id) is None

    undo(db, project, deleted, actor_id=None)
    restored = db.get(Category, category.id)
    assert restored is not None
    assert restored.name == "Design"


def test_set_duration_rejects_zero(db, project, category):
    created = apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id),
            name="Logo",
            start_date=date(2026, 3, 4),
            duration_days=5,
        ),
        actor_id=None,
    )

    with pytest.raises(InvalidOperation) as error:
        apply_op(
            db, project, SetDuration(task_id=created.op["task_id"], duration_days=0), actor_id=None
        )
    assert error.value.code == "duration_too_short"


def test_set_duration_changes_the_duration_and_records_both_bounds(db, project, category):
    created = apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id),
            name="Logo",
            start_date=date(2026, 3, 4),
            duration_days=5,
        ),
        actor_id=None,
    )
    task_id = created.op["task_id"]

    changed = apply_op(
        db,
        project,
        SetDuration(task_id=task_id, duration_days=8),
        actor_id=None,
    )

    assert changed.op == {
        "type": "set_duration",
        "task_id": task_id,
        "from": 5,
        "to": 8,
    }
    assert changed.inverse == {
        "type": "set_duration",
        "task_id": task_id,
        "from": 8,
        "to": 5,
    }
    assert db.get(Task, task_id).duration_days == 8


def test_undo_of_set_duration_restores_the_previous_duration(db, project, category):
    created = apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id),
            name="Logo",
            start_date=date(2026, 3, 4),
            duration_days=5,
        ),
        actor_id=None,
    )
    task_id = created.op["task_id"]

    changed = apply_op(db, project, SetDuration(task_id=task_id, duration_days=8), actor_id=None)
    undo(db, project, changed, actor_id=None)

    assert db.get(Task, task_id).duration_days == 5


def test_undo_of_create_task_removes_it(db, project, category):
    created = apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id),
            name="Logo",
            start_date=date(2026, 3, 4),
            duration_days=5,
        ),
        actor_id=None,
    )
    task_id = created.op["task_id"]
    assert db.get(Task, task_id) is not None

    undo(db, project, created, actor_id=None)

    assert db.get(Task, task_id) is None


def test_undo_of_create_category_removes_it(db, project):
    created = apply_op(
        db,
        project,
        CreateCategory(name="Design", color="#3b82f6"),
        actor_id=None,
    )
    category_id = created.op["category_id"]
    assert db.get(Category, category_id) is not None

    undo(db, project, created, actor_id=None)

    assert db.get(Category, category_id) is None


def test_operation_naming_a_task_from_another_project_is_rejected(
    db, project, other_project, other_category
):
    foreign = apply_op(
        db,
        other_project,
        CreateTask(
            category_id=str(other_category.id),
            name="Foreign task",
            start_date=date(2026, 3, 4),
            duration_days=3,
        ),
        actor_id=None,
    )
    foreign_task_id = foreign.op["task_id"]

    with pytest.raises(NotFoundInProject) as error:
        apply_op(
            db,
            project,
            MoveTask(task_id=foreign_task_id, start_date=date(2026, 3, 11)),
            actor_id=None,
        )
    assert error.value.code == "task_not_found"


def test_create_task_rejects_a_category_from_another_project(db, project, other_category):
    with pytest.raises(NotFoundInProject) as error:
        apply_op(
            db,
            project,
            CreateTask(
                category_id=str(other_category.id),
                name="Logo",
                start_date=date(2026, 3, 4),
                duration_days=5,
            ),
            actor_id=None,
        )
    assert error.value.code == "category_not_found"


def test_create_after_a_delete_does_not_reuse_an_occupied_task_position(db, project, category):
    first = apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id), name="First", start_date=date(2026, 3, 4), duration_days=2
        ),
        actor_id=None,
    )
    second = apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id), name="Second", start_date=date(2026, 3, 4), duration_days=2
        ),
        actor_id=None,
    )
    apply_op(db, project, DeleteTask(task_id=first.op["task_id"]), actor_id=None)
    third = apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id), name="Third", start_date=date(2026, 3, 4), duration_days=2
        ),
        actor_id=None,
    )

    # COUNT(*) after a deletion counts the remaining rows rather than the greatest taken
    # number: after deleting the first of two tasks one row is left, and COUNT(*) gives 1 —
    # the same number the second task already holds.
    second_position = db.get(Task, second.op["task_id"]).position
    third_position = db.get(Task, third.op["task_id"]).position
    assert second_position != third_position


def test_create_after_a_delete_does_not_reuse_an_occupied_category_position(db, project):
    first = apply_op(db, project, CreateCategory(name="First", color="#111111"), actor_id=None)
    second = apply_op(db, project, CreateCategory(name="Second", color="#222222"), actor_id=None)
    apply_op(db, project, DeleteCategory(category_id=first.op["category_id"]), actor_id=None)
    third = apply_op(db, project, CreateCategory(name="Third", color="#333333"), actor_id=None)

    second_position = db.get(Category, second.op["category_id"]).position
    third_position = db.get(Category, third.op["category_id"]).position
    assert second_position != third_position


def test_undo_of_a_task_delete_restores_its_original_position(db, project, category):
    apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id), name="First", start_date=date(2026, 3, 4), duration_days=2
        ),
        actor_id=None,
    )
    second = apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id), name="Second", start_date=date(2026, 3, 4), duration_days=2
        ),
        actor_id=None,
    )
    second_task_id = second.op["task_id"]
    assert db.get(Task, second_task_id).position == 1

    deleted = apply_op(db, project, DeleteTask(task_id=second_task_id), actor_id=None)
    # Another task takes the freed place — a naive recount on undoing a deletion would
    # push the restored task to the end of the list.
    apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id), name="Third", start_date=date(2026, 3, 4), duration_days=2
        ),
        actor_id=None,
    )

    undo(db, project, deleted, actor_id=None)

    assert db.get(Task, second_task_id).position == 1


def _make(db, project, category, name: str, position: int | None = None):
    return apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id),
            name=name,
            start_date=date(2026, 3, 4),
            duration_days=2,
            position=position,
        ),
        actor_id=None,
    )


def _order(db, category) -> list[str]:
    """The names of a category's rows in the order the chart reads them."""
    rows = db.scalars(
        select(Task).where(Task.category_id == category.id).order_by(Task.position, Task.id)
    ).all()
    return [row.name for row in rows]


def test_a_task_created_at_a_taken_slot_pushes_the_row_below(db, project, category):
    _make(db, project, category, "First")
    _make(db, project, category, "Second")

    # The "plus" on a row boundary: the task is created where it was pointed rather than at
    # the end of the list.
    _make(db, project, category, "Between", position=1)

    assert _order(db, category) == ["First", "Between", "Second"]


def test_a_task_created_at_a_free_slot_leaves_the_neighbours_alone(db, project, category):
    first = _make(db, project, category, "First")
    _make(db, project, category, "Second")

    # The tail of the list is nobody's: there is no one to move for its sake.
    _make(db, project, category, "Third", position=2)

    assert _order(db, category) == ["First", "Second", "Third"]
    assert db.get(Task, first.op["task_id"]).position == 0


def test_undo_of_a_delete_returns_the_task_even_when_its_slot_was_retaken(
    db, project, category
):
    """Undoing a deletion does not fail on a taken number but parts the list.

    A reorder renumbers the rows consecutively and closes the hole left by a deleted task.
    Before this, returning to the previous number would violate the uniqueness of
    (category_id, position) — that is, the undo would fail with a 500.
    """
    _make(db, project, category, "First")
    second = _make(db, project, category, "Second")
    third = _make(db, project, category, "Third")

    deleted = apply_op(db, project, DeleteTask(task_id=second.op["task_id"]), actor_id=None)
    apply_op(
        db,
        project,
        ReorderTask(
            task_id=third.op["task_id"], category_id=str(category.id), position=1
        ),
        actor_id=None,
    )
    assert db.get(Task, third.op["task_id"]).position == 1

    undo(db, project, deleted, actor_id=None)

    assert db.get(Task, second.op["task_id"]).position == 1
    assert _order(db, category) == ["First", "Second", "Third"]


def test_the_wire_carries_the_position_but_still_not_the_identifier(db, project, category):
    internal = to_internal(
        PublicCreateTask(
            category_id=str(category.id),
            name="Logo",
            start_date=date(2026, 3, 4),
            duration_days=5,
            position=2,
        )
    )

    # A row's place is chosen by a person, its identifier by the server.
    assert internal.position == 2
    assert internal.task_id is None


def test_public_operations_are_a_subset_of_the_internal_ones():
    """The public model differs from the internal one by exactly the restore fields.

    A pin against divergence: a new field added only to the internal model is normal, but a
    new restore field that has accidentally landed in the public one will surface here. The
    task's position is deliberately absent from this list: it is accepted over the wire —
    a row's place is chosen by a person (see the comment on the contract in mutations.py).
    """
    assert set(PublicCreateTask.model_fields) | {
        "task_id",
        "assignees",
        "dependencies",
        "comments",
    } == set(CreateTask.model_fields)
    assert set(PublicCreateCategory.model_fields) | {"category_id", "position", "tasks"} == set(
        CreateCategory.model_fields
    )


def test_to_internal_does_not_carry_restore_fields(db, project, category):
    internal = to_internal(
        PublicCreateTask(
            category_id=str(category.id),
            name="Logo",
            start_date=date(2026, 3, 4),
            duration_days=5,
        )
    )
    assert isinstance(internal, CreateTask)
    assert internal.task_id is None
    assert internal.position is None


def test_creating_past_the_project_task_limit_is_refused(db, project, category, monkeypatch):
    import app.mutations as mutations

    settings = mutations.get_settings()

    class _Capped:
        max_tasks_per_project = 1

        def __getattr__(self, item):
            return getattr(settings, item)

    monkeypatch.setattr(mutations, "get_settings", lambda: _Capped())

    apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id), name="First", start_date=date(2026, 3, 4), duration_days=2
        ),
        actor_id=None,
    )

    with pytest.raises(InvalidOperation) as error:
        apply_op(
            db,
            project,
            CreateTask(
                category_id=str(category.id),
                name="Second",
                start_date=date(2026, 3, 4),
                duration_days=2,
            ),
            actor_id=None,
        )
    assert error.value.code == "task_limit_reached"


def test_apply_op_takes_a_row_lock_on_the_project(engine):
    """Two sessions cannot apply operations to one project at the same time.

    The check is a real one rather than "was the method called": the second session asks
    for the project's row with NOWAIT — before the operation is applied it is free, and
    after apply_op inside the first session's unfinished transaction Postgres refuses
    immediately. Without the lock both sessions would compute max(seq)+1 from one snapshot,
    and the loser would catch a violation of the uniqueness of (project_id, seq).

    The observer asks for FOR NO KEY UPDATE specifically rather than FOR UPDATE: inserting
    a revision already takes FOR KEY SHARE on the project's row through the foreign key,
    and with FOR UPDATE the test would pass even without an explicit lock — that is, it
    would check nothing. FOR NO KEY UPDATE is compatible with FOR KEY SHARE and conflicts
    with exactly the lock apply_op takes.
    """
    from sqlalchemy import delete, select
    from sqlalchemy.exc import OperationalError
    from sqlalchemy.orm import sessionmaker

    from app.models import Organization, Project

    make_session = sessionmaker(bind=engine)

    setup = make_session()
    org = Organization(name="Lock", slug="lock-race-org")
    setup.add(org)
    setup.flush()
    locked = Project(org_id=org.id, name="Locked", slug="locked")
    setup.add(locked)
    setup.flush()
    org_id, project_id = org.id, locked.id
    setup.commit()
    setup.close()

    worker = make_session()
    observer = make_session()
    try:
        free = (
            select(Project.id)
            .where(Project.id == project_id)
            .with_for_update(nowait=True, key_share=True)
        )
        observer.execute(free)  # before the operation the row is free
        observer.rollback()

        apply_op(
            worker,
            worker.get(Project, project_id),
            CreateCategory(name="Design", color="#3b82f6"),
            actor_id=None,
        )

        with pytest.raises(OperationalError):
            observer.execute(free)
        observer.rollback()
    finally:
        worker.rollback()
        worker.close()
        observer.rollback()
        observer.close()
        cleanup = make_session()
        cleanup.execute(delete(Organization).where(Organization.id == org_id))
        cleanup.commit()
        cleanup.close()


def test_undo_refuses_a_revision_from_another_project(db, project, other_project, other_category):
    foreign = apply_op(
        db,
        other_project,
        CreateTask(
            category_id=str(other_category.id),
            name="Foreign task",
            start_date=date(2026, 3, 4),
            duration_days=3,
        ),
        actor_id=None,
    )

    with pytest.raises(NotFoundInProject) as error:
        undo(db, project, foreign, actor_id=None)
    assert error.value.code == "revision_not_found"

    # the task of another project stayed in place
    assert db.get(Task, foreign.op["task_id"]) is not None


def test_the_journal_is_queryable_by_payload_containment(db, project, category):
    """op and inverse are jsonb rather than json.

    All three features built on this journal search by the payload's content. The
    containment operator (@>) exists only on jsonb: on json this query will not run at all.
    """
    from sqlalchemy import select

    from app.models import Revision

    apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id), name="Logo", start_date=date(2026, 3, 4), duration_days=5
        ),
        actor_id=None,
    )

    found = db.scalars(
        select(Revision).where(Revision.op.contains({"type": "create_task", "name": "Logo"}))
    ).all()
    assert len(found) == 1


def test_set_task_fields_records_previous_and_new_values(db, project, category):
    created = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="Logo",
        start_date=date(2026, 3, 4), duration_days=5), actor_id=None)
    task_id = created.op["task_id"]

    revision = apply_op(db, project, SetTaskFields(
        task_id=task_id, name="Logo redesign",
        description="Mark and wordmark", internal_note="client is picky"), actor_id=None)

    assert revision.op["from"] == {
        "name": "Logo", "description": "", "internal_note": ""}
    assert revision.op["to"] == {
        "name": "Logo redesign", "description": "Mark and wordmark",
        "internal_note": "client is picky"}
    assert revision.inverse["to"] == revision.op["from"]

    task = db.get(Task, task_id)
    assert task.name == "Logo redesign"


def test_undo_of_set_task_fields_restores_every_field(db, project, category):
    created = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="Logo",
        start_date=date(2026, 3, 4), duration_days=5,
        description="old", internal_note="old note"), actor_id=None)
    task_id = created.op["task_id"]

    changed = apply_op(db, project, SetTaskFields(
        task_id=task_id, name="New", description="new", internal_note="new note"),
        actor_id=None)
    undo(db, project, changed, actor_id=None)

    task = db.get(Task, task_id)
    assert (task.name, task.description, task.internal_note) == ("Logo", "old", "old note")


def test_set_progress_rejects_a_value_outside_the_range(db, project, category):
    created = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="Logo",
        start_date=date(2026, 3, 4), duration_days=5), actor_id=None)

    with pytest.raises(InvalidOperation):
        apply_op(db, project, SetProgress(task_id=created.op["task_id"], progress_pct=101),
                 actor_id=None)


def test_rename_category_round_trips(db, project, category):
    revision = apply_op(db, project, RenameCategory(
        category_id=str(category.id), name="Дизайн и бренд"), actor_id=None)
    assert db.get(Category, category.id).name == "Дизайн и бренд"

    undo(db, project, revision, actor_id=None)
    assert db.get(Category, category.id).name == "Design"


def test_set_criticality_rejects_an_unknown_level(db, project, category):
    created = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="Logo",
        start_date=date(2026, 3, 4), duration_days=5), actor_id=None)

    with pytest.raises(InvalidOperation):
        apply_op(db, project, SetCriticality(
            task_id=created.op["task_id"], criticality="urgent"), actor_id=None)


def test_set_criticality_and_progress_and_colour_round_trip(db, project, category):
    """The remaining three operations of the same shape: both bounds in the journal, the undo brings the previous one back."""
    created = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="Logo",
        start_date=date(2026, 3, 4), duration_days=5), actor_id=None)
    task_id = created.op["task_id"]

    criticality = apply_op(db, project, SetCriticality(
        task_id=task_id, criticality="high"), actor_id=None)
    assert criticality.op == {
        "type": "set_criticality", "task_id": task_id, "from": "normal", "to": "high"}
    undo(db, project, criticality, actor_id=None)
    assert db.get(Task, task_id).criticality == "normal"

    progress = apply_op(db, project, SetProgress(task_id=task_id, progress_pct=40), actor_id=None)
    assert db.get(Task, task_id).progress_pct == 40
    undo(db, project, progress, actor_id=None)
    assert db.get(Task, task_id).progress_pct == 0

    colour = apply_op(db, project, SetCategoryColor(
        category_id=str(category.id), color="#22c55e"), actor_id=None)
    assert db.get(Category, category.id).color == "#22c55e"
    undo(db, project, colour, actor_id=None)
    assert db.get(Category, category.id).color == "#3b82f6"


# --- status -------------------------------------------------------------------


def test_create_task_defaults_to_planned_and_accepts_a_status(db, project, category):
    default = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="A",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None)
    assert default.op["status"] == "planned"
    assert db.get(Task, default.op["task_id"]).status == "planned"

    explicit = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="B",
        start_date=date(2026, 3, 4), duration_days=1, status="blocked"), actor_id=None)
    assert db.get(Task, explicit.op["task_id"]).status == "blocked"


def test_create_task_rejects_an_unknown_status(db, project, category):
    with pytest.raises(InvalidOperation) as error:
        apply_op(db, project, CreateTask(
            category_id=str(category.id), name="A",
            start_date=date(2026, 3, 4), duration_days=1, status="paused"), actor_id=None)
    assert error.value.code == "unknown_status"


def test_set_status_rejects_an_unknown_status(db, project, category):
    task_id = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="A",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]

    with pytest.raises(InvalidOperation) as error:
        apply_op(db, project, SetStatus(task_id=task_id, status="paused"), actor_id=None)
    assert error.value.code == "unknown_status"


def test_progress_at_100_marks_the_task_done(db, project, category):
    task_id = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="A",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]

    revision = apply_op(db, project, SetProgress(task_id=task_id, progress_pct=100),
                        actor_id=None)

    task = db.get(Task, task_id)
    assert (task.progress_pct, task.status) == (100, "done")
    # Both status bounds landed in the journal: an undo will bring the previous status back
    # verbatim rather than deriving it through the coupling anew.
    assert revision.op["status_from"] == "planned"
    assert revision.op["status_to"] == "done"
    assert revision.inverse["status_to"] == "planned"


def test_progress_below_100_returns_a_done_task_to_in_progress(db, project, category):
    task_id = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="A",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]
    apply_op(db, project, SetProgress(task_id=task_id, progress_pct=100), actor_id=None)

    apply_op(db, project, SetProgress(task_id=task_id, progress_pct=60), actor_id=None)

    task = db.get(Task, task_id)
    assert (task.progress_pct, task.status) == (60, "in_progress")


def test_progress_movement_leaves_a_blocked_task_blocked(db, project, category):
    """The coupling knows exactly two transitions; a movement of progress does not touch the other statuses."""
    task_id = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="A",
        start_date=date(2026, 3, 4), duration_days=1, status="blocked"),
        actor_id=None).op["task_id"]

    revision = apply_op(db, project, SetProgress(task_id=task_id, progress_pct=50),
                        actor_id=None)

    assert db.get(Task, task_id).status == "blocked"
    # The status did not change — there are no status bounds in the journal.
    assert "status_from" not in revision.op


def test_set_status_done_pulls_the_progress_to_100(db, project, category):
    task_id = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="A",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]

    revision = apply_op(db, project, SetStatus(task_id=task_id, status="done"), actor_id=None)

    task = db.get(Task, task_id)
    assert (task.status, task.progress_pct) == ("done", 100)
    assert revision.op == {
        "type": "set_status", "task_id": task_id, "from": "planned", "to": "done",
        "progress_from": 0, "progress_to": 100}


def test_leaving_done_keeps_the_progress_untouched(db, project, category):
    task_id = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="A",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]
    apply_op(db, project, SetStatus(task_id=task_id, status="done"), actor_id=None)

    revision = apply_op(db, project, SetStatus(task_id=task_id, status="in_progress"),
                        actor_id=None)

    task = db.get(Task, task_id)
    # The coupling has no reverse rule: there is no such thing as an invented "almost ready".
    assert (task.status, task.progress_pct) == ("in_progress", 100)
    assert "progress_from" not in revision.op


def test_undo_of_set_status_restores_both_status_and_progress(db, project, category):
    task_id = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="A",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]
    apply_op(db, project, SetProgress(task_id=task_id, progress_pct=40), actor_id=None)

    done = apply_op(db, project, SetStatus(task_id=task_id, status="done"), actor_id=None)
    undo(db, project, done, actor_id=None)

    task = db.get(Task, task_id)
    assert (task.status, task.progress_pct) == ("planned", 40)


def test_undo_of_set_progress_restores_a_blocked_status(db, project, category):
    """An undo brings the status back from the journal rather than deriving it through the coupling anew.

    The coupling knows only the planned/in_progress pair — about 'blocked' below 100% it
    would never have guessed.
    """
    task_id = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="A",
        start_date=date(2026, 3, 4), duration_days=1, status="blocked"),
        actor_id=None).op["task_id"]

    finished = apply_op(db, project, SetProgress(task_id=task_id, progress_pct=100),
                        actor_id=None)
    assert db.get(Task, task_id).status == "done"

    undo(db, project, finished, actor_id=None)

    task = db.get(Task, task_id)
    assert (task.status, task.progress_pct) == ("blocked", 0)


def test_set_status_is_not_accepted_over_the_wire_with_a_progress():
    """progress_pct on set_status is a restore field, like task_id on create_task.

    It is not accepted over the wire: progress from the wire is governed by set_progress,
    and here a client would slip a value in around the coupling.
    """
    from app.mutations import PublicSetStatus

    assert set(PublicSetStatus.model_fields) | {"progress_pct"} == set(SetStatus.model_fields)


def _positions(db, project) -> dict[str, int]:
    rows = db.scalars(select(Task).where(Task.project_id == project.id)).all()
    return {str(row.id): row.position for row in rows}


def test_reorder_shifts_neighbours_and_records_the_whole_map(db, project, category):
    ids = [apply_op(db, project, CreateTask(
        category_id=str(category.id), name=f"T{i}",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]
        for i in range(3)]

    revision = apply_op(db, project, ReorderTask(
        task_id=ids[2], category_id=str(category.id), position=0), actor_id=None)

    after = _positions(db, project)
    assert after[ids[2]] == 0
    assert after[ids[0]] == 1
    assert after[ids[1]] == 2
    # the journal holds a map rather than a single shift
    assert set(revision.op["from"]) == set(ids)
    assert revision.op["to"][ids[0]] == 1


def test_undo_of_a_reorder_restores_every_neighbour(db, project, category):
    ids = [apply_op(db, project, CreateTask(
        category_id=str(category.id), name=f"T{i}",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]
        for i in range(3)]
    before = _positions(db, project)

    revision = apply_op(db, project, ReorderTask(
        task_id=ids[2], category_id=str(category.id), position=0), actor_id=None)
    undo(db, project, revision, actor_id=None)

    assert _positions(db, project) == before


def test_reorder_into_another_category_moves_and_renumbers(db, project, category):
    other = db.get(Category, apply_op(db, project, CreateCategory(
        name="Development", color="#22c55e"), actor_id=None).op["category_id"])
    task_id = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="Logo",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]

    apply_op(db, project, ReorderTask(
        task_id=task_id, category_id=str(other.id), position=0), actor_id=None)

    task = db.get(Task, task_id)
    assert task.category_id == other.id
    assert task.position == 0


def test_reorder_rejects_a_category_from_another_project(db, project, category, other_category):
    task_id = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="Logo",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]

    with pytest.raises(NotFoundInProject):
        apply_op(db, project, ReorderTask(
            task_id=task_id, category_id=str(other_category.id), position=0),
            actor_id=None)


def test_undo_of_a_reorder_across_categories_restores_the_category_too(db, project, category):
    """The map in the journal carries the category too, not only the number.

    Without categories_from an undo would bring the positions back but leave the task in
    the new category — that is, it would undo half of the reorder.
    """
    other = db.get(Category, apply_op(db, project, CreateCategory(
        name="Development", color="#22c55e"), actor_id=None).op["category_id"])
    task_id = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="Logo",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]

    revision = apply_op(db, project, ReorderTask(
        task_id=task_id, category_id=str(other.id), position=0), actor_id=None)
    undo(db, project, revision, actor_id=None)

    assert db.get(Task, task_id).category_id == category.id


def test_reorder_refuses_a_negative_position(db, project, category):
    task_id = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="Logo",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]

    with pytest.raises(InvalidOperation) as error:
        apply_op(db, project, ReorderTask(
            task_id=task_id, category_id=str(category.id), position=-1), actor_id=None)
    assert error.value.code == "negative_position"


def test_reorder_is_not_accepted_over_the_wire_as_apply_positions():
    """ApplyPositions exists only as an inverse operation.

    It is absent from the public registry: otherwise a client could send an arbitrary map
    of positions and lay the rows out around every check of the ordering.
    """
    from app.mutations import PublicOp

    accepted = {
        model.model_fields["type"].default
        for model in PublicOp.__args__[0].__args__
    }
    assert "reorder_task" in accepted
    assert "apply_positions" not in accepted
    assert "reorder_category" in accepted
    assert "apply_category_positions" not in accepted


def _category_positions(db, project) -> dict[str, int]:
    rows = db.scalars(select(Category).where(Category.project_id == project.id)).all()
    return {str(row.id): row.position for row in rows}


def _new_category(db, project, name: str) -> str:
    return apply_op(
        db, project, CreateCategory(name=name, color="#22c55e"), actor_id=None
    ).op["category_id"]


def test_reorder_category_shifts_neighbours_and_records_the_whole_map(db, project, category):
    """The stage takes the named place, the neighbours part, and the map goes into the journal.

    A map rather than a single shift, for the same reason as with a task: an undo needs
    everyone the reorder touched.
    """
    ids = [str(category.id)] + [_new_category(db, project, name) for name in ("B", "C")]

    revision = apply_op(
        db, project, ReorderCategory(category_id=ids[2], position=0), actor_id=None
    )

    after = _category_positions(db, project)
    assert after[ids[2]] == 0
    assert after[ids[0]] == 1
    assert after[ids[1]] == 2
    assert set(revision.op["from"]) == set(ids)
    assert revision.op["to"][ids[0]] == 1


def test_undo_of_a_category_reorder_restores_every_neighbour(db, project, category):
    ids = [str(category.id)] + [_new_category(db, project, name) for name in ("B", "C")]
    before = _category_positions(db, project)

    revision = apply_op(
        db, project, ReorderCategory(category_id=ids[2], position=0), actor_id=None
    )
    undo(db, project, revision, actor_id=None)

    assert _category_positions(db, project) == before


def test_reorder_category_past_the_end_puts_it_last(db, project, category):
    """A position past the end of the list is not a refusal: a throw to the very bottom sends the length."""
    ids = [str(category.id)] + [_new_category(db, project, "B")]

    apply_op(db, project, ReorderCategory(category_id=ids[0], position=99), actor_id=None)

    assert _category_positions(db, project) == {ids[1]: 0, ids[0]: 1}


def test_reorder_category_leaves_task_order_alone(db, project, category):
    """Tasks have their own numbering inside their own stage — reordering stages does not touch it."""
    other = _new_category(db, project, "B")
    task_id = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="Logo",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]

    apply_op(db, project, ReorderCategory(category_id=other, position=0), actor_id=None)

    task = db.get(Task, task_id)
    assert (task.category_id, task.position) == (category.id, 0)


def test_reorder_category_refuses_a_negative_position(db, project, category):
    with pytest.raises(InvalidOperation) as error:
        apply_op(
            db, project, ReorderCategory(category_id=str(category.id), position=-1),
            actor_id=None,
        )
    assert error.value.code == "negative_position"


def test_reorder_category_rejects_a_category_from_another_project(db, project, other_category):
    with pytest.raises(NotFoundInProject):
        apply_op(
            db, project, ReorderCategory(category_id=str(other_category.id), position=0),
            actor_id=None,
        )


def test_dependency_round_trips(db, project, category):
    a, b = [apply_op(db, project, CreateTask(
        category_id=str(category.id), name=n,
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]
        for n in ("A", "B")]

    added = apply_op(db, project, AddDependency(from_task_id=a, to_task_id=b), actor_id=None)
    assert db.scalar(select(func.count()).select_from(Dependency)) == 1

    undo(db, project, added, actor_id=None)
    assert db.scalar(select(func.count()).select_from(Dependency)) == 0


def test_a_task_cannot_depend_on_itself(db, project, category):
    a = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="A",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]

    with pytest.raises(InvalidOperation):
        apply_op(db, project, AddDependency(from_task_id=a, to_task_id=a), actor_id=None)


def test_the_same_dependency_cannot_be_added_twice(db, project, category):
    a, b = [apply_op(db, project, CreateTask(
        category_id=str(category.id), name=n,
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]
        for n in ("A", "B")]
    apply_op(db, project, AddDependency(from_task_id=a, to_task_id=b), actor_id=None)

    with pytest.raises(InvalidOperation):
        apply_op(db, project, AddDependency(from_task_id=a, to_task_id=b), actor_id=None)


def test_removing_a_dependency_that_does_not_exist_is_refused(db, project, category):
    a, b = [apply_op(db, project, CreateTask(
        category_id=str(category.id), name=n,
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]
        for n in ("A", "B")]

    with pytest.raises(NotFoundInProject):
        apply_op(db, project, RemoveDependency(from_task_id=a, to_task_id=b), actor_id=None)


def test_a_dependency_to_a_task_of_another_project_is_refused(
    db, project, category, other_project, other_category
):
    """Both sides of a dependency go through _require_task.

    Otherwise an arrow could be drawn into another project — and the very fact of that
    task's existence would become observable.
    """
    mine = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="A",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]
    foreign = apply_op(db, other_project, CreateTask(
        category_id=str(other_category.id), name="Foreign",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]

    with pytest.raises(NotFoundInProject):
        apply_op(db, project, AddDependency(from_task_id=mine, to_task_id=foreign), actor_id=None)


def test_undo_of_a_dependency_removal_brings_the_arrow_back(db, project, category):
    a, b = [apply_op(db, project, CreateTask(
        category_id=str(category.id), name=n,
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]
        for n in ("A", "B")]
    apply_op(db, project, AddDependency(from_task_id=a, to_task_id=b), actor_id=None)

    removed = apply_op(db, project, RemoveDependency(from_task_id=a, to_task_id=b), actor_id=None)
    assert db.scalar(select(func.count()).select_from(Dependency)) == 0

    undo(db, project, removed, actor_id=None)
    assert db.scalar(select(func.count()).select_from(Dependency)) == 1


@pytest.fixture
def insider(db, project):
    """A person from the same organization as the project is a candidate assignee."""
    user = User(name="Insider", email="insider@example.com", password_hash="x")
    db.add(user)
    db.flush()
    db.add(Membership(org_id=project.org_id, user_id=user.id, role="editor"))
    db.flush()
    return user


@pytest.fixture
def outsider(db, other_project):
    """A person from another organization: they cannot be assigned."""
    user = User(name="Outsider", email="outsider@example.com", password_hash="x")
    db.add(user)
    db.flush()
    db.add(Membership(org_id=other_project.org_id, user_id=user.id, role="editor"))
    db.flush()
    return user


def test_assigning_a_user_from_another_organization_is_refused(db, project, category, outsider):
    task_id = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="Logo",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]

    with pytest.raises(InvalidOperation):
        apply_op(db, project, AssignUser(task_id=task_id, user_id=str(outsider.id)),
                 actor_id=None)


def test_assignment_round_trips(db, project, category, insider):
    task_id = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="Logo",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]

    assigned = apply_op(db, project, AssignUser(task_id=task_id, user_id=str(insider.id)),
                        actor_id=None)
    assert assigned.inverse["type"] == "unassign_user"
    assert db.scalar(select(func.count()).select_from(TaskAssignee)) == 1

    undo(db, project, assigned, actor_id=None)
    assert db.scalar(select(func.count()).select_from(TaskAssignee)) == 0


def test_assigning_the_same_person_twice_is_refused(db, project, category, insider):
    task_id = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="Logo",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]
    apply_op(db, project, AssignUser(task_id=task_id, user_id=str(insider.id)), actor_id=None)

    with pytest.raises(InvalidOperation) as error:
        apply_op(db, project, AssignUser(task_id=task_id, user_id=str(insider.id)), actor_id=None)
    assert error.value.code == "already_assigned"


def test_unassigning_someone_who_is_not_assigned_is_refused(db, project, category, insider):
    task_id = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="Logo",
        start_date=date(2026, 3, 4), duration_days=1), actor_id=None).op["task_id"]

    with pytest.raises(NotFoundInProject) as error:
        apply_op(db, project, UnassignUser(task_id=task_id, user_id=str(insider.id)),
                 actor_id=None)
    assert error.value.code == "assignment_not_found"


# --- milestones ---------------------------------------------------------------


def _task(db, project, category, **fields):
    """A task with sensible defaults: the tests below care about one or two of its fields."""
    return apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id),
            name=fields.pop("name", "Logo"),
            start_date=fields.pop("start_date", date(2026, 3, 4)),
            duration_days=fields.pop("duration_days", 5),
            **fields,
        ),
        actor_id=None,
    ).op["task_id"]


def test_a_task_created_as_a_milestone_keeps_the_flag(db, project, category):
    task_id = _task(db, project, category, duration_days=1, milestone=True)

    assert db.get(Task, task_id).milestone is True


def test_a_milestone_longer_than_a_day_is_refused_at_creation(db, project, category):
    with pytest.raises(InvalidOperation) as error:
        _task(db, project, category, duration_days=5, milestone=True)
    assert error.value.code == "milestone_has_duration"


def test_becoming_a_milestone_collapses_the_duration_to_one_day(db, project, category):
    task_id = _task(db, project, category, duration_days=5)

    changed = apply_op(db, project, SetMilestone(task_id=task_id, milestone=True), actor_id=None)

    assert db.get(Task, task_id).duration_days == 1
    # Both duration bounds go into the journal: without them an undo would bring the flag
    # back but not the dates, and the task would stay one day long forever.
    assert changed.op["duration_from"] == 5
    assert changed.op["duration_to"] == 1


def test_undo_of_becoming_a_milestone_restores_the_duration(db, project, category):
    task_id = _task(db, project, category, duration_days=5)
    changed = apply_op(db, project, SetMilestone(task_id=task_id, milestone=True), actor_id=None)

    undo(db, project, changed, actor_id=None)

    task = db.get(Task, task_id)
    assert task.milestone is False
    assert task.duration_days == 5


def test_dropping_the_milestone_flag_leaves_the_duration_alone(db, project, category):
    task_id = _task(db, project, category, duration_days=1, milestone=True)

    changed = apply_op(db, project, SetMilestone(task_id=task_id, milestone=False), actor_id=None)

    # A segment one day long is the honest answer: a milestone had no real duration, and
    # there is nothing to invent one from on the way out.
    assert db.get(Task, task_id).duration_days == 1
    assert "duration_from" not in changed.op


def test_set_duration_is_refused_on_a_milestone(db, project, category):
    task_id = _task(db, project, category, duration_days=1, milestone=True)

    with pytest.raises(InvalidOperation) as error:
        apply_op(db, project, SetDuration(task_id=task_id, duration_days=4), actor_id=None)
    assert error.value.code == "task_is_milestone"


def test_a_milestone_still_moves(db, project, category):
    task_id = _task(db, project, category, duration_days=1, milestone=True)

    apply_op(db, project, MoveTask(task_id=task_id, start_date=date(2026, 3, 11)), actor_id=None)

    assert db.get(Task, task_id).start_date == date(2026, 3, 11)


def test_undo_of_a_deleted_milestone_brings_the_flag_back(db, project, category):
    task_id = _task(db, project, category, duration_days=1, milestone=True)
    deleted = apply_op(db, project, DeleteTask(task_id=task_id), actor_id=None)

    undo(db, project, deleted, actor_id=None)

    assert db.get(Task, task_id).milestone is True


def test_the_wire_accepts_the_milestone_flag(db, project, category):
    op = to_internal(
        PublicCreateTask(
            category_id=str(category.id),
            name="Kickoff",
            start_date=date(2026, 3, 4),
            duration_days=1,
            milestone=True,
        )
    )

    assert op.milestone is True


# --- a category shift ----------------------------------------------------------


def test_moving_a_category_shifts_every_task_in_it(db, project, category):
    first = _task(db, project, category, name="Logo", start_date=date(2026, 3, 4))
    second = _task(db, project, category, name="Palette", start_date=date(2026, 3, 9))

    moved = apply_op(db, project, MoveCategory(category_id=str(category.id), days=3), actor_id=None)

    assert db.get(Task, first).start_date == date(2026, 3, 7)
    assert db.get(Task, second).start_date == date(2026, 3, 12)
    assert moved.op["task_ids"] == [first, second]


def test_moving_a_category_is_one_revision_not_one_per_task(db, project, category):
    _task(db, project, category, name="Logo")
    _task(db, project, category, name="Palette")
    before = db.scalar(select(func.count()).select_from(Revision))

    apply_op(db, project, MoveCategory(category_id=str(category.id), days=3), actor_id=None)

    assert db.scalar(select(func.count()).select_from(Revision)) == before + 1


def test_undo_of_a_category_move_brings_every_task_back(db, project, category):
    first = _task(db, project, category, name="Logo", start_date=date(2026, 3, 4))
    second = _task(db, project, category, name="Palette", start_date=date(2026, 3, 9))
    moved = apply_op(db, project, MoveCategory(category_id=str(category.id), days=-6), actor_id=None)

    undo(db, project, moved, actor_id=None)

    assert db.get(Task, first).start_date == date(2026, 3, 4)
    assert db.get(Task, second).start_date == date(2026, 3, 9)


def test_moving_a_category_leaves_a_neighbour_alone(db, project, category):
    inside = _task(db, project, category, start_date=date(2026, 3, 4))
    neighbour = apply_op(
        db, project, CreateCategory(name="Build", color="#22c55e"), actor_id=None
    ).op["category_id"]
    outside = apply_op(
        db,
        project,
        CreateTask(
            category_id=neighbour,
            name="Deploy",
            start_date=date(2026, 3, 4),
            duration_days=2,
        ),
        actor_id=None,
    ).op["task_id"]

    apply_op(db, project, MoveCategory(category_id=str(category.id), days=5), actor_id=None)

    assert db.get(Task, inside).start_date == date(2026, 3, 9)
    assert db.get(Task, outside).start_date == date(2026, 3, 4)


def test_moving_a_category_by_zero_days_is_refused(db, project, category):
    _task(db, project, category)

    with pytest.raises(InvalidOperation) as error:
        apply_op(db, project, MoveCategory(category_id=str(category.id), days=0), actor_id=None)
    assert error.value.code == "empty_shift"


def test_moving_an_empty_category_is_refused(db, project, category):
    with pytest.raises(InvalidOperation) as error:
        apply_op(db, project, MoveCategory(category_id=str(category.id), days=4), actor_id=None)
    assert error.value.code == "category_empty"


def test_moving_a_category_of_another_project_is_refused(db, project, other_category):
    with pytest.raises(NotFoundInProject) as error:
        apply_op(
            db, project, MoveCategory(category_id=str(other_category.id), days=4), actor_id=None
        )
    assert error.value.code == "category_not_found"


# --- the bar's left edge -------------------------------------------------------


def test_resize_changes_start_and_duration_in_one_revision(db, project, category):
    task_id = _task(db, project, category, start_date=date(2026, 3, 4), duration_days=5)
    before = db.scalar(select(func.count()).select_from(Revision))

    changed = apply_op(
        db,
        project,
        ResizeTask(task_id=task_id, start_date=date(2026, 3, 2), duration_days=7),
        actor_id=None,
    )

    task = db.get(Task, task_id)
    assert (task.start_date, task.duration_days) == (date(2026, 3, 2), 7)
    assert db.scalar(select(func.count()).select_from(Revision)) == before + 1
    assert changed.op["from"] == {"start_date": "2026-03-04", "duration_days": 5}
    assert changed.op["to"] == {"start_date": "2026-03-02", "duration_days": 7}


def test_undo_of_a_resize_restores_both_fields(db, project, category):
    task_id = _task(db, project, category, start_date=date(2026, 3, 4), duration_days=5)
    changed = apply_op(
        db,
        project,
        ResizeTask(task_id=task_id, start_date=date(2026, 3, 2), duration_days=7),
        actor_id=None,
    )

    undo(db, project, changed, actor_id=None)

    task = db.get(Task, task_id)
    assert (task.start_date, task.duration_days) == (date(2026, 3, 4), 5)


def test_resize_is_refused_on_a_milestone(db, project, category):
    task_id = _task(db, project, category, duration_days=1, milestone=True)

    with pytest.raises(InvalidOperation) as error:
        apply_op(
            db,
            project,
            ResizeTask(task_id=task_id, start_date=date(2026, 3, 2), duration_days=3),
            actor_id=None,
        )
    assert error.value.code == "task_is_milestone"


def test_resize_rejects_zero_duration(db, project, category):
    task_id = _task(db, project, category)

    with pytest.raises(InvalidOperation) as error:
        apply_op(
            db,
            project,
            ResizeTask(task_id=task_id, start_date=date(2026, 3, 4), duration_days=0),
            actor_id=None,
        )
    assert error.value.code == "duration_too_short"


def test_set_risk_round_trip_and_unknown_flag(db, project, category):
    """The flag and the reason in one operation with both bounds; an undo brings both back.
    An unknown flag is a refusal rather than a 500 from the CHECK."""
    created = apply_op(db, project, CreateTask(
        category_id=str(category.id), name="Logo",
        start_date=date(2026, 3, 4), duration_days=5), actor_id=None)
    task_id = created.op["task_id"]

    revision = apply_op(db, project, SetRisk(
        task_id=task_id, risk="yellow", note="жду доступ"), actor_id=None)
    assert revision.op == {
        "type": "set_risk", "task_id": task_id,
        "from": {"risk": "green", "note": ""},
        "to": {"risk": "yellow", "note": "жду доступ"},
    }
    task = db.get(Task, task_id)
    assert (task.risk, task.risk_note) == ("yellow", "жду доступ")

    undo(db, project, revision, actor_id=None)
    task = db.get(Task, task_id)
    assert (task.risk, task.risk_note) == ("green", "")

    with pytest.raises(InvalidOperation):
        apply_op(db, project, SetRisk(task_id=task_id, risk="purple"), actor_id=None)
