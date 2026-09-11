"""Undo over the wire: the last action and a whole batch."""

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import get_db
from app.main import app
from app.models import Category, Membership, Project, Revision, Task
from app.mutations import CreateCategory, CreateTask, apply_op, last_undoable, undo_batch


@pytest.fixture
def client(db):
    def _override_get_db():
        yield db

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def authed(client):
    client.post(
        "/api/auth/register",
        json={
            "name": "Alex",
            "email": "alex@example.com",
            "password": "s3cret-pass",
            "company_name": "Acme",
        },
    )
    return client


@pytest.fixture
def project_with_task(authed):
    project_id = authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]
    category_id = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "create_category", "name": "Design", "color": "#3b82f6"}},
    ).json()["op"]["category_id"]
    task_id = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {
                "type": "create_task",
                "category_id": category_id,
                "name": "Logo",
                "start_date": "2026-03-02",
                "duration_days": 5,
            }
        },
    ).json()["op"]["task_id"]
    return project_id, category_id, task_id


def _state(authed, project_id):
    return authed.get(f"/api/projects/{project_id}").json()


def test_undo_returns_the_task_to_where_it_was(authed, project_with_task):
    project_id, _, task_id = project_with_task
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "move_task", "task_id": task_id, "start_date": "2026-03-09"}},
    )

    response = authed.post(f"/api/projects/{project_id}/undo")

    assert response.status_code == 201
    assert _state(authed, project_id)["tasks"][0]["start_date"] == "2026-03-02"


def test_pressing_undo_twice_steps_two_changes_back(authed, project_with_task):
    """A second undo undoes the previous change rather than its own undo.

    Without tracking "this revision is the undo of that one", the journal is linear and
    the second entry from the top after an undo is the undo itself: a person pressing
    "Undo" twice would end up where they started.
    """
    project_id, _, task_id = project_with_task
    for day in ("2026-03-09", "2026-03-10"):
        authed.post(
            f"/api/projects/{project_id}/mutations",
            json={"op": {"type": "move_task", "task_id": task_id, "start_date": day}},
        )

    authed.post(f"/api/projects/{project_id}/undo")
    assert _state(authed, project_id)["tasks"][0]["start_date"] == "2026-03-09"

    authed.post(f"/api/projects/{project_id}/undo")
    assert _state(authed, project_id)["tasks"][0]["start_date"] == "2026-03-02"


def test_undo_brings_a_deleted_task_back_with_its_note(authed, project_with_task, db):
    project_id, category_id, _ = project_with_task
    created = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {
                "type": "create_task",
                "category_id": category_id,
                "name": "Черновик",
                "start_date": "2026-03-02",
                "duration_days": 1,
                "internal_note": "тайный план",
            }
        },
    ).json()["op"]["task_id"]
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "delete_task", "task_id": created}},
    )

    authed.post(f"/api/projects/{project_id}/undo")

    restored = db.get(Task, uuid.UUID(created))
    assert restored is not None
    # The note comes back together with the task: the undo snapshot stores it, and
    # visibility is decided on output rather than by corrupting the journal itself.
    assert restored.internal_note == "тайный план"


def test_the_project_state_names_what_undo_will_undo(authed, project_with_task):
    project_id, _, task_id = project_with_task

    undoable = _state(authed, project_id)["undoable"]
    assert undoable["op"]["type"] == "create_task"

    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "move_task", "task_id": task_id, "start_date": "2026-03-09"}},
    )
    assert _state(authed, project_id)["undoable"]["op"]["type"] == "move_task"

    authed.post(f"/api/projects/{project_id}/undo")
    # An undo does not offer to undo itself: next in line is the creation of the task.
    assert _state(authed, project_id)["undoable"]["op"]["type"] == "create_task"


def test_undo_of_set_status_restores_status_and_progress_together(authed, project_with_task):
    """An undo clears both the status and the progress the coupling dragged along.

    set_status to 'done' carries the progress up to 100; an undo must bring both values
    back rather than leave the task "planned but 100% ready".
    """
    project_id, _, task_id = project_with_task
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "set_progress", "task_id": task_id, "progress_pct": 40}},
    )
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "set_status", "task_id": task_id, "status": "done"}},
    )
    task = _state(authed, project_id)["tasks"][0]
    assert (task["status"], task["progress_pct"]) == ("done", 100)

    authed.post(f"/api/projects/{project_id}/undo")

    task = _state(authed, project_id)["tasks"][0]
    assert (task["status"], task["progress_pct"]) == ("planned", 40)


def test_an_empty_project_has_nothing_to_undo(authed):
    project_id = authed.post("/api/projects", json={"name": "Пустой"}).json()["id"]

    assert _state(authed, project_id)["undoable"] is None
    assert authed.post(f"/api/projects/{project_id}/undo").status_code == 404


def test_undo_that_breaks_the_threshold_asks_for_a_reason(authed, project_with_task):
    """An undo is not a privileged action.

    The task moved with an explanation and then came back into place (a return to the
    baseline plan requires no explanations). Undoing that return takes it two weeks away
    again — and must ask for a reason exactly as an ordinary drag with the mouse would.
    """
    project_id, _, task_id = project_with_task
    authed.post(f"/api/projects/{project_id}/plan/approvals")
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {"type": "move_task", "task_id": task_id, "start_date": "2026-03-16"},
            "reason": "подрядчик сорвал срок",
        },
    )
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "move_task", "task_id": task_id, "start_date": "2026-03-02"}},
    )

    refused = authed.post(f"/api/projects/{project_id}/undo")
    assert refused.status_code == 409
    assert refused.json()["detail"] == "reason_required"
    assert refused.headers["X-Shift-Deviation-Days"] == "14"

    accepted = authed.post(
        f"/api/projects/{project_id}/undo", json={"reason": "всё-таки сдвигаем"}
    )
    assert accepted.status_code == 201
    assert _state(authed, project_id)["tasks"][0]["start_date"] == "2026-03-16"


def test_undo_of_a_named_revision_goes_through_while_it_is_still_on_top(authed, project_with_task):
    project_id, _, task_id = project_with_task
    moved = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "move_task", "task_id": task_id, "start_date": "2026-03-09"}},
    ).json()

    response = authed.post(
        f"/api/projects/{project_id}/undo", json={"expected_seq": moved["seq"]}
    )

    assert response.status_code == 201
    assert response.json()["undone_seq"] == moved["seq"]
    assert _state(authed, project_id)["tasks"][0]["start_date"] == "2026-03-02"


def test_undo_refuses_when_the_top_of_the_journal_moved_on(authed, project_with_task):
    """The button promised to bring back your own move but would bring back someone else's edit.

    Between showing "Undo" and pressing it, a colleague on the project applies a change
    of their own. A numberless undo would remove it — silently, and without asking
    either the person who pressed or the one whose edit was removed.
    """
    project_id, _, task_id = project_with_task
    mine = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "move_task", "task_id": task_id, "start_date": "2026-03-09"}},
    ).json()
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "set_progress", "task_id": task_id, "progress_pct": 40}},
    )

    refused = authed.post(f"/api/projects/{project_id}/undo", json={"expected_seq": mine["seq"]})

    assert refused.status_code == 409
    assert refused.json()["detail"] == "undo_conflict"
    # The refusal touched no edit at all: neither one's own nor anyone else's.
    task = _state(authed, project_id)["tasks"][0]
    assert (task["start_date"], task["progress_pct"]) == ("2026-03-09", 40)


def test_an_empty_project_refuses_a_named_undo_as_nothing_to_undo(authed):
    """An empty journal means "there is nothing to undo" rather than "the wrong thing is on top".

    The different codes are not pedantry: on the first the button disappears, on the
    second the interface re-reads the state and shows what is on top now.
    """
    project_id = authed.post("/api/projects", json={"name": "Пустой"}).json()["id"]

    refused = authed.post(f"/api/projects/{project_id}/undo", json={"expected_seq": 1})

    assert refused.status_code == 404
    assert refused.json()["detail"] == "nothing_to_undo"


def test_a_viewer_may_not_undo(authed, db, project_with_task):
    project_id, _, _ = project_with_task
    user_id = authed.get("/api/auth/me").json()["id"]
    membership = db.scalar(select(Membership).where(Membership.user_id == user_id))
    membership.role = "viewer"
    db.flush()

    assert authed.post(f"/api/projects/{project_id}/undo").status_code == 403


def test_undo_of_a_foreign_project_is_not_found(authed, db):
    from app.models import Organization

    other = Organization(name="Globex", slug="globex")
    db.add(other)
    db.flush()
    foreign = Project(org_id=other.id, name="Secret", slug="secret")
    db.add(foreign)
    db.flush()

    assert authed.post(f"/api/projects/{foreign.id}/undo").status_code == 404


# --- the batch ----------------------------------------------------------------


@pytest.fixture
def batch(db, authed):
    """A batch of mutations with a shared batch_id — that is how AI applies them."""
    project_id = authed.post("/api/projects", json={"name": "AI"}).json()["id"]
    project = db.get(Project, uuid.UUID(project_id))
    batch_id = uuid.uuid4()

    created = apply_op(
        db,
        project,
        CreateCategory(name="Дизайн", color="#3b82f6"),
        actor_id=None,
        batch_id=batch_id,
    )
    category_id = created.op["category_id"]
    for name in ("Логотип", "Макет"):
        apply_op(
            db,
            project,
            CreateTask(
                category_id=category_id,
                name=name,
                start_date="2026-03-02",
                duration_days=2,
            ),
            actor_id=None,
            batch_id=batch_id,
        )
    return project_id, str(batch_id)


def test_a_whole_batch_rolls_back_with_one_call(authed, db, batch):
    project_id, batch_id = batch

    response = authed.post(f"/api/projects/{project_id}/batches/{batch_id}/undo")

    assert response.status_code == 201
    assert response.json()["undone"] == 3
    state = _state(authed, project_id)
    assert state["tasks"] == []
    # The category went away too: the rollback runs from the end, otherwise it would
    # run into a non-empty category and leave half the batch in the project.
    assert state["categories"] == []


def test_rolling_the_same_batch_back_twice_is_refused(authed, batch):
    project_id, batch_id = batch
    authed.post(f"/api/projects/{project_id}/batches/{batch_id}/undo")

    again = authed.post(f"/api/projects/{project_id}/batches/{batch_id}/undo")

    assert again.status_code == 404
    assert again.json()["detail"] == "batch_not_found"


def test_an_unknown_batch_is_not_found(authed, batch):
    project_id, _ = batch

    response = authed.post(f"/api/projects/{project_id}/batches/{uuid.uuid4()}/undo")

    assert response.status_code == 404


def test_the_undo_of_a_batch_is_recorded_as_one_action(db, authed, batch):
    """A batch rollback reads in the journal as one action rather than as a scattering of entries."""
    project_id, batch_id = batch
    project = db.get(Project, uuid.UUID(project_id))

    applied = undo_batch(db, project, uuid.UUID(batch_id), actor_id=None)

    undo_batch_ids = {revision.batch_id for revision in applied}
    assert len(undo_batch_ids) == 1
    assert undo_batch_ids != {uuid.UUID(batch_id)}
    # And not a single category was left in the project: the whole batch rolled back.
    assert db.scalar(select(Category).where(Category.project_id == project.id)) is None


def test_undoing_a_batch_member_by_hand_is_skipped_by_the_batch_undo(db, authed, batch):
    """A revision undone on its own is not undone a second time.

    Otherwise a batch rollback would apply its inverse operation once more — and the
    creation of a task, already undone, would try to delete a row that does not exist.
    """
    project_id, batch_id = batch
    project = db.get(Project, uuid.UUID(project_id))
    last = last_undoable(db, project)
    assert last is not None
    authed.post(f"/api/projects/{project_id}/undo")

    applied = undo_batch(db, project, uuid.UUID(batch_id), actor_id=None)

    assert last.seq not in {revision.undoes_seq for revision in applied}
    assert db.scalar(select(Revision).where(Revision.undoes_seq == last.seq)) is not None
