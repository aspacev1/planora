"""The director's panel: /api/admin/users.

Access is decided not by a role within an organization but by the director role —
which is pinned by the DIRECTOR_EMAIL environment variable (see
app.config.Settings) rather than by a code constant. tests/conftest.py gives it a
default value — "director@example.com" — the same way it does APP_SECRET; tests that
need a different address substitute the variable with monkeypatch and reset the
settings cache, as with the other switches (see
test_comments_api.py::test_a_comment_longer_than_the_limit_is_refused).
"""

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.auth import register
from app.config import get_settings
from app.db import get_db
from app.main import app
from app.models import Membership

#: The same address tests/conftest.py writes into DIRECTOR_EMAIL by default —
#: declaring it as a constant next to the line in every test would be the same
#: duplication as keeping APP_SECRET in two places, but since an environment
#: variable does not hand its value back as an importable symbol, the string has to
#: be repeated here.
DIRECTOR_EMAIL = "director@example.com"


@pytest.fixture
def clients(db):
    """A factory of clients over one database session — as in test_org_api.py.

    Every call is a new cookie, that is, a new signed-in person; the database session
    is shared, otherwise the director would not see the registrations made by the
    second client.
    """

    def _override_get_db():
        yield db

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield lambda: TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def client(clients):
    return clients()


def _register(client, name, email):
    return client.post(
        "/api/auth/register",
        json={"name": name, "email": email, "password": "s3cret-pass", "company_name": name},
    )


@pytest.fixture
def director(client):
    """A client signed in under the address from DIRECTOR_EMAIL."""
    _register(client, "Director", DIRECTOR_EMAIL)
    return client


def test_admin_route_requires_authentication(client):
    assert client.get("/api/admin/users").status_code == 401


def test_a_plain_user_is_refused_with_403_not_404(client):
    """403, not 404: the section names no entity whose existence would be worth
    staying silent about — the menu item is hidden from a non-director by the
    interface, not by the server."""
    _register(client, "Alex", "alex@example.com")

    response = client.get("/api/admin/users")

    assert response.status_code == 403
    assert response.json()["detail"] == "forbidden"


def test_nobody_else_gets_in_even_when_the_director_is_registered(director, clients):
    """DIRECTOR_EMAIL is not a list but a single address, and a second registered
    person does not get into the panel, whoever they are."""
    stranger = clients()
    _register(stranger, "Maria", "maria@example.com")

    assert stranger.get("/api/admin/users").status_code == 403
    # The director, meanwhile, sees the panel as usual.
    assert director.get("/api/admin/users").status_code == 200


def test_admin_lists_every_registration(director, db):
    register(db, name="Maria", email="maria@example.com", password="s3cret-pass")
    db.flush()

    response = director.get("/api/admin/users")
    assert response.status_code == 200
    emails = {row["email"] for row in response.json()}
    assert emails == {DIRECTOR_EMAIL, "maria@example.com"}


def test_admin_row_carries_registration_and_activity(director):
    rows = director.get("/api/admin/users").json()
    [row] = [row for row in rows if row["email"] == DIRECTOR_EMAIL]

    assert row["name"] == "Director"
    # Registration is already activity in itself — see open_session in app.auth.
    assert row["created_at"] is not None
    assert row["last_active_at"] is not None
    assert row["organizations"] == ["Director"]


def test_the_most_recent_registration_comes_first(director, db):
    # created_at uses server_default=func.now(): inside one transaction of the test
    # (see tests/conftest.py::db) that gives one and the same timestamp to two
    # consecutive registrations — which does not happen in production, where every
    # registration has its own transaction. The timestamp is shifted by hand so as to
    # check the route's sorting rather than a coincidence of the test's clocks.
    maria = register(db, name="Maria", email="maria@example.com", password="s3cret-pass")
    db.flush()
    maria.created_at = maria.created_at + timedelta(hours=1)
    db.flush()

    rows = director.get("/api/admin/users").json()
    assert rows[0]["email"] == "maria@example.com"


def test_a_user_outside_any_organization_still_lists_with_an_empty_roster(director, db):
    person = register(db, name="Solo", email="solo@example.com", password="s3cret-pass")
    db.flush()
    # The only membership is their own organization, created by the registration.
    membership = db.scalar(select(Membership).where(Membership.user_id == person.id))
    db.delete(membership)
    db.flush()

    rows = director.get("/api/admin/users").json()
    [row] = [row for row in rows if row["email"] == "solo@example.com"]
    assert row["organizations"] == []


def test_director_email_comparison_is_case_and_form_insensitive(client, monkeypatch):
    """The director role is compared by the same normalization as account uniqueness:
    the address in DIRECTOR_EMAIL need not match letter for letter and case for case
    what was entered at registration."""
    monkeypatch.setenv("DIRECTOR_EMAIL", "Owner@Example.com")
    get_settings.cache_clear()
    try:
        _register(client, "Owner", "owner@example.com")
        response = client.get("/api/admin/users")
    finally:
        get_settings.cache_clear()

    assert response.status_code == 200


def test_changing_the_variable_moves_the_role_without_touching_code(client, clients, monkeypatch):
    """Changing the director is an edit to DIRECTOR_EMAIL, not an edit to the code."""
    monkeypatch.setenv("DIRECTOR_EMAIL", "new-director@example.com")
    get_settings.cache_clear()
    try:
        _register(client, "Old Director", DIRECTOR_EMAIL)
        newcomer = clients()
        _register(newcomer, "New Director", "new-director@example.com")

        old_response = client.get("/api/admin/users")
        new_response = newcomer.get("/api/admin/users")
    finally:
        get_settings.cache_clear()

    assert old_response.status_code == 403
    assert new_response.status_code == 200


def test_me_reflects_director_status(director, clients):
    assert director.get("/api/auth/me").json()["is_director"] is True

    stranger = clients()
    _register(stranger, "Alex", "alex@example.com")
    assert stranger.get("/api/auth/me").json()["is_director"] is False
