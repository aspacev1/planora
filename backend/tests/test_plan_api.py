"""The plan approval routes and the "a reason is required" refusal over the wire."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import get_db
from app.main import app
from app.models import Membership


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


def _set_role(authed, db, role: str) -> None:
    user_id = authed.get("/api/auth/me").json()["id"]
    membership = db.scalar(select(Membership).where(Membership.user_id == user_id))
    membership.role = role
    db.flush()


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


def test_approval_shows_up_in_the_project_state(authed, project_with_task):
    project_id, _, task_id = project_with_task

    approved = authed.post(f"/api/projects/{project_id}/plan/approvals")
    assert approved.status_code == 201
    assert approved.json()["version"] == 1

    state = authed.get(f"/api/projects/{project_id}").json()
    assert state["plan_version"] == 1
    assert state["plan_approved_at"] is not None

    task = state["tasks"][0]
    assert task["baseline_start"] == "2026-03-02"
    assert task["baseline_duration"] == 5
    # The baseline plan's end is computed by the server against the project's
    # calendar: Monday + 5 working days is Friday.
    assert task["baseline_end"] == "2026-03-06"
    assert task["id"] == task_id


def test_a_task_added_after_approval_comes_without_a_baseline(authed, project_with_task):
    project_id, category_id, _ = project_with_task
    authed.post(f"/api/projects/{project_id}/plan/approvals")

    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {
                "type": "create_task",
                "category_id": category_id,
                "name": "Сверх плана",
                "start_date": "2026-04-01",
                "duration_days": 2,
            }
        },
    )

    state = authed.get(f"/api/projects/{project_id}").json()
    extra = next(task for task in state["tasks"] if task["name"] == "Сверх плана")
    # Empty baseline_* under an approved plan is itself the "beyond the original
    # plan" flag: the interface puts its mark by it.
    assert extra["baseline_start"] is None
    assert extra["baseline_end"] is None


def test_a_shift_past_the_threshold_is_refused_with_the_numbers_in_the_headers(
    authed, project_with_task
):
    project_id, _, task_id = project_with_task
    authed.post(f"/api/projects/{project_id}/plan/approvals")

    response = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "move_task", "task_id": task_id, "start_date": "2026-03-16"}},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "reason_required"
    assert response.headers["X-Shift-Deviation-Days"] == "14"
    assert response.headers["X-Shift-Threshold-Days"] == "2"

    state = authed.get(f"/api/projects/{project_id}").json()
    assert state["tasks"][0]["start_date"] == "2026-03-02"


def test_the_same_shift_with_a_reason_goes_through_and_the_reason_lands_in_history(
    authed, project_with_task
):
    project_id, _, task_id = project_with_task
    authed.post(f"/api/projects/{project_id}/plan/approvals")

    response = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {"type": "move_task", "task_id": task_id, "start_date": "2026-03-16"},
            "reason": "заказчик не прислал брендбук",
        },
    )
    assert response.status_code == 201

    history = authed.get(f"/api/projects/{project_id}/revisions?task_id={task_id}").json()
    assert history[0]["reason"] == "заказчик не прислал брендбук"


def test_an_empty_reason_does_not_count_as_an_explanation(authed, project_with_task):
    """An empty string is not a reason.

    The client keeps the "Save" button inactive while the field is empty, but relying
    on that will not do: the rule lives on the server, otherwise it is bypassed with
    curl.
    """
    project_id, _, task_id = project_with_task
    authed.post(f"/api/projects/{project_id}/plan/approvals")

    response = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {"type": "move_task", "task_id": task_id, "start_date": "2026-03-16"},
            "reason": "   ",
        },
    )

    assert response.status_code == 409


def test_an_editor_may_approve_but_not_reapprove(authed, db, project_with_task):
    project_id, _, _ = project_with_task
    _set_role(authed, db, "editor")

    assert authed.post(f"/api/projects/{project_id}/plan/approvals").status_code == 201
    # Re-approval erases the baseline plan that explained shifts are counted from:
    # the specification leaves this to the owner.
    assert authed.post(f"/api/projects/{project_id}/plan/approvals").status_code == 403


def test_a_viewer_may_not_approve(authed, db, project_with_task):
    project_id, _, _ = project_with_task
    _set_role(authed, db, "viewer")

    assert authed.post(f"/api/projects/{project_id}/plan/approvals").status_code == 403


def test_the_chronicle_keeps_every_version(authed, project_with_task):
    project_id, _, task_id = project_with_task
    authed.post(f"/api/projects/{project_id}/plan/approvals")
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {"type": "move_task", "task_id": task_id, "start_date": "2026-03-16"},
            "reason": "подрядчик сорвал срок",
        },
    )
    authed.post(f"/api/projects/{project_id}/plan/approvals")

    versions = authed.get(f"/api/projects/{project_id}/plan/approvals").json()

    assert [item["version"] for item in versions] == [2, 1]
    assert versions[0]["approved_by"]["name"] == "Alex"
    assert versions[1]["snapshot"][task_id]["start_date"] == "2026-03-02"
    assert versions[0]["snapshot"][task_id]["start_date"] == "2026-03-16"
