import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.config import get_settings
from app.db import get_db
from app.main import app


@pytest.fixture
def client(db):
    """The same pattern as in tests/test_project_api.py: get_db returns the `db`
    fixture's session and does not commit."""

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


@pytest.fixture(autouse=True)
def fresh_settings():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _demote(authed, db, role: str) -> None:
    from app.models import Membership

    user_id = authed.get("/api/auth/me").json()["id"]
    membership = db.scalar(select(Membership).where(Membership.user_id == user_id))
    membership.role = role
    db.flush()


def test_an_unpublished_project_says_so_without_pretending_it_is_forbidden(authed, project_id):
    body = authed.get(f"/api/projects/{project_id}/share").json()

    assert body["url"] is None
    # The interface must distinguish "not published yet" from "publishing is
    # forbidden by the installation": otherwise the button promises an action that
    # will end in a refusal.
    assert body["allowed"] is True
    assert body["comments_enabled"] is True


def test_publishing_returns_a_readable_address(authed, project_id, monkeypatch):
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://planora.example.com")
    get_settings.cache_clear()

    response = authed.post(f"/api/projects/{project_id}/share")

    assert response.status_code == 201
    assert response.json()["url"].startswith("https://planora.example.com/p/acme/redesign?s=")


def test_reissuing_changes_the_address_and_kills_the_old_one(authed, project_id):
    # Reissuing is a separate route (wave 4.6): a repeated POST /share no longer
    # kills the distributed address but answers 409.
    first = authed.post(f"/api/projects/{project_id}/share").json()["url"]
    second = authed.post(f"/api/projects/{project_id}/share/rotate").json()["url"]

    assert first != second
    assert authed.get(_public_path(first)).status_code == 404
    assert authed.get(_public_path(second)).status_code == 200


def test_revoking_closes_the_page(authed, project_id):
    url = authed.post(f"/api/projects/{project_id}/share").json()["url"]

    assert authed.delete(f"/api/projects/{project_id}/share").status_code == 204
    assert authed.get(_public_path(url)).status_code == 404
    assert authed.get(f"/api/projects/{project_id}/share").json()["url"] is None


def test_comments_are_switched_without_reissuing_the_link(authed, project_id):
    url = authed.post(f"/api/projects/{project_id}/share").json()["url"]

    patched = authed.patch(
        f"/api/projects/{project_id}/share", json={"comments_enabled": False}
    )

    assert patched.status_code == 200
    assert patched.json()["comments_enabled"] is False
    # The address is unchanged: turning comments off and reissuing the link are
    # different actions, and the first must not break an address already distributed.
    assert patched.json()["url"] == url
    assert authed.get(_public_path(url)).json()["comments_enabled"] is False


def test_switching_comments_on_a_project_without_a_link_is_a_404(authed, project_id):
    response = authed.patch(f"/api/projects/{project_id}/share", json={"comments_enabled": False})
    assert response.status_code == 404
    assert response.json()["detail"] == "share_link_not_found"


def test_a_reader_cannot_publish_the_project(authed, db, project_id):
    _demote(authed, db, "viewer")

    assert authed.get(f"/api/projects/{project_id}/share").status_code == 403
    assert authed.post(f"/api/projects/{project_id}/share").status_code == 403
    assert authed.delete(f"/api/projects/{project_id}/share").status_code == 403


def test_a_closed_installation_refuses_to_publish(authed, project_id, monkeypatch):
    monkeypatch.setenv("PUBLIC_SHARING_ENABLED", "false")
    get_settings.cache_clear()

    assert authed.get(f"/api/projects/{project_id}/share").json()["allowed"] is False
    response = authed.post(f"/api/projects/{project_id}/share")
    assert response.status_code == 403
    assert response.json()["detail"] == "sharing_disabled"


def test_the_share_route_hides_a_foreign_project(authed, db):
    from app.models import Organization, Project

    other_org = Organization(name="Globex", slug="globex")
    db.add(other_org)
    db.flush()
    foreign = Project(org_id=other_org.id, name="Secret", slug="secret")
    db.add(foreign)
    db.flush()

    assert authed.get(f"/api/projects/{foreign.id}/share").status_code == 404


def _public_path(url: str) -> str:
    """The public page's address in a form usable by TestClient.

    The link is assembled from PUBLIC_BASE_URL, that is, with a domain that does not
    exist in the test; the server, meanwhile, knows it as an API path.
    """
    path, _, query = url.partition("?")
    slugs = path.split("/p/", 1)[1]
    return f"/api/public/{slugs}?{query}"
