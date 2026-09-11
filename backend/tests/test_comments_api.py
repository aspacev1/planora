"""Comments from a member with an account. Guest ones are in tests/test_public_api.py."""

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import get_db
from app.main import app


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
def project_id(authed):
    return authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]


def _demote(authed, db, role: str) -> None:
    from app.models import Membership

    user_id = authed.get("/api/auth/me").json()["id"]
    membership = db.scalar(select(Membership).where(Membership.user_id == user_id))
    membership.role = role
    db.flush()


def _grant(authed, db, project_id: str) -> None:
    from app.models import ProjectAccess

    user_id = authed.get("/api/auth/me").json()["id"]
    db.add(ProjectAccess(project_id=uuid.UUID(project_id), user_id=uuid.UUID(user_id)))
    db.flush()


def test_a_member_comments_under_his_own_name(authed, project_id):
    response = authed.post(
        f"/api/projects/{project_id}/comments", json={"body": "Сдвинул старт, брендбука нет"}
    )

    assert response.status_code == 201
    assert response.json()["author"] == {"name": "Alex", "guest": False}


def test_the_thread_is_read_oldest_first(authed, project_id):
    for text in ("первое", "второе", "третье"):
        authed.post(f"/api/projects/{project_id}/comments", json={"body": text})

    listed = authed.get(f"/api/projects/{project_id}/comments").json()

    # A conversation is read top to bottom — unlike the revision journal, where the
    # latest entry is what is wanted.
    assert [c["body"] for c in listed] == ["первое", "второе", "третье"]


def test_a_client_invited_to_the_project_may_comment(authed, db, project_id):
    _demote(authed, db, "client")
    _grant(authed, db, project_id)

    response = authed.post(f"/api/projects/{project_id}/comments", json={"body": "Принято"})

    assert response.status_code == 201
    # Commenting, yes; changing the plan, no: that is exactly the row of the matrix
    # the role exists for.
    forbidden = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "create_category", "name": "Свои задачи", "color": "#3b82f6"}},
    )
    assert forbidden.status_code == 403


def test_a_client_without_a_grant_does_not_reach_the_thread(authed, db, project_id):
    _demote(authed, db, "client")

    assert authed.get(f"/api/projects/{project_id}/comments").status_code == 404
    assert (
        authed.post(f"/api/projects/{project_id}/comments", json={"body": "Тук-тук"}).status_code
        == 404
    )


def test_an_empty_comment_is_refused(authed, project_id):
    response = authed.post(f"/api/projects/{project_id}/comments", json={"body": "   "})

    assert response.status_code == 422
    assert response.json()["detail"] == "comment_empty"


def test_a_comment_longer_than_the_limit_is_refused(authed, project_id, monkeypatch):
    from app.config import get_settings

    monkeypatch.setenv("MAX_TEXT_LEN", "10")
    get_settings.cache_clear()
    try:
        response = authed.post(
            f"/api/projects/{project_id}/comments", json={"body": "а" * 11}
        )
    finally:
        get_settings.cache_clear()

    assert response.status_code == 422
    assert response.json()["detail"] == "comment_too_long"


def test_comments_of_one_task_are_filtered(authed, project_id):
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
                "start_date": "2026-03-06",
                "duration_days": 3,
            }
        },
    ).json()["op"]["task_id"]

    authed.post(f"/api/projects/{project_id}/comments", json={"body": "к проекту"})
    authed.post(
        f"/api/projects/{project_id}/comments", json={"body": "к задаче", "task_id": task_id}
    )

    listed = authed.get(
        f"/api/projects/{project_id}/comments", params={"task_id": task_id}
    ).json()
    assert [c["body"] for c in listed] == ["к задаче"]


def _task(authed, project_id: str, name: str) -> str:
    category_id = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "create_category", "name": "Design", "color": "#3b82f6"}},
    ).json()["op"]["category_id"]
    return authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {
                "type": "create_task",
                "category_id": category_id,
                "name": name,
                "start_date": "2026-03-06",
                "duration_days": 3,
            }
        },
    ).json()["op"]["task_id"]


def test_the_counter_holds_one_number_per_task(authed, project_id):
    task_id = _task(authed, project_id, "Logo")

    for text in ("раз", "два"):
        authed.post(
            f"/api/projects/{project_id}/comments", json={"body": text, "task_id": task_id}
        )
    # A remark on the whole project belongs to no row and does not count.
    authed.post(f"/api/projects/{project_id}/comments", json={"body": "к проекту"})

    counts = authed.get(f"/api/projects/{project_id}/comments/counts").json()

    assert counts == {task_id: 2}


def test_a_task_without_comments_is_absent_from_the_counter(authed, project_id):
    _task(authed, project_id, "Logo")

    # Zero is the absence of a key: there is no reason to send a hundred zeros for
    # rows where nothing has been written.
    assert authed.get(f"/api/projects/{project_id}/comments/counts").json() == {}


def test_the_counter_of_a_member_includes_the_internal_thread(authed, project_id):
    task_id = _task(authed, project_id, "Logo")

    authed.post(
        f"/api/projects/{project_id}/comments",
        json={"body": "в сторону", "task_id": task_id, "internal": True},
    )

    # A member sees internal remarks in the feed itself — so the number next to a
    # task must match what they will find there.
    assert authed.get(f"/api/projects/{project_id}/comments/counts").json() == {task_id: 1}
