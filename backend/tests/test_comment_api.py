import pytest
from fastapi.testclient import TestClient

from app.db import get_db
from app.main import app


@pytest.fixture
def client(db):
    """A TestClient whose get_db is overridden with the `db` fixture's session.

    The same pattern as in tests/test_project_api.py: the override returns exactly
    the same session and does not commit, otherwise the fixture's outer transaction
    would close ahead of time.
    """

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


def _task_id(authed, project_id: str) -> str:
    category = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "create_category", "name": "Дизайн", "color": "#3b82f6"}},
    ).json()["op"]["category_id"]
    return authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {
                "type": "create_task",
                "category_id": category,
                "name": "Логотип",
                "start_date": "2026-03-04",
                "duration_days": 5,
            }
        },
    ).json()["op"]["task_id"]


def test_posting_a_comment_returns_it_signed_by_its_author(authed, project_id):
    response = authed.post(f"/api/projects/{project_id}/comments", json={"body": "Согласовано"})

    assert response.status_code == 201
    body = response.json()
    assert body["body"] == "Согласовано"
    assert body["author"] == {"name": "Alex", "guest": False}
    assert body["task_id"] is None


def test_the_task_thread_is_narrower_than_the_project_thread(authed, project_id):
    """A task card shows the conversation about it. The project's feed shows the
    project's whole conversation, remarks on rows included: there is no reason to
    introduce a second place one has to look into so as not to miss what was said."""
    task_id = _task_id(authed, project_id)
    authed.post(f"/api/projects/{project_id}/comments", json={"body": "о проекте"})
    authed.post(
        f"/api/projects/{project_id}/comments", json={"body": "о задаче", "task_id": task_id}
    )

    of_task = authed.get(f"/api/projects/{project_id}/comments?task_id={task_id}").json()
    of_project = authed.get(f"/api/projects/{project_id}/comments").json()

    assert [c["body"] for c in of_task] == ["о задаче"]
    assert [c["body"] for c in of_project] == ["о проекте", "о задаче"]


def test_empty_comment_is_refused_with_a_machine_code(authed, project_id):
    response = authed.post(f"/api/projects/{project_id}/comments", json={"body": "   "})

    assert response.status_code == 422
    assert response.json()["detail"] == "comment_empty"


def test_comment_on_a_task_of_another_project_is_not_found(authed, project_id):
    other = authed.post("/api/projects", json={"name": "Other"}).json()["id"]
    stranger = _task_id(authed, other)

    response = authed.post(
        f"/api/projects/{project_id}/comments", json={"body": "сюда", "task_id": stranger}
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "task_not_found"


def test_comments_of_another_organization_are_not_reachable(authed, db):
    """Someone else's project is indistinguishable from a nonexistent one — by the
    same principle as in the project's other routes."""
    from app.models import Organization, Project

    other_org = Organization(name="Globex", slug="globex")
    db.add(other_org)
    db.flush()
    stranger = Project(org_id=other_org.id, name="Secret", slug="secret")
    db.add(stranger)
    db.flush()

    assert authed.get(f"/api/projects/{stranger.id}/comments").status_code == 404
    assert (
        authed.post(f"/api/projects/{stranger.id}/comments", json={"body": "?"}).status_code == 404
    )


def test_comments_require_a_session(authed, project_id):
    """There is no public-link guest yet: without a session the feed is closed."""
    anonymous = TestClient(app)

    assert anonymous.get(f"/api/projects/{project_id}/comments").status_code == 401
    assert (
        anonymous.post(f"/api/projects/{project_id}/comments", json={"body": "?"}).status_code
        == 401
    )


def test_a_viewer_may_comment_without_the_right_to_change_the_plan(authed, project_id, db):
    """The permission matrix already says a viewer comments without the right to
    write into the plan. The route must ask it rather than keep a list of roles of its own."""
    from sqlalchemy import select

    from app.models import Membership

    membership = db.scalar(select(Membership))
    membership.role = "viewer"
    db.flush()

    assert (
        authed.post(f"/api/projects/{project_id}/comments", json={"body": "вопрос"}).status_code
        == 201
    )
    # The same person cannot change the plan by that same matrix — otherwise the test
    # above would pass on a route that asks about permissions at all.
    assert (
        authed.post(
            f"/api/projects/{project_id}/mutations",
            json={"op": {"type": "create_category", "name": "Дизайн", "color": "#3b82f6"}},
        ).status_code
        == 403
    )
