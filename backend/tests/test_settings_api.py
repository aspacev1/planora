"""Level 2-4 settings over the wire.

Inheritance of `null` is already covered in tests/test_settings_resolution.py at the
level of the functions. What is checked here is what did not exist at all until now:
that these values can be changed from the outside — and that an edit to an
organization's default reaches the projects that did not override it.
"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import get_db
from app.main import app
from app.models import Membership, Organization, Project, User


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


# --- level 2: the organization -------------------------------------------------


def test_organization_settings_come_with_the_organization(authed):
    body = authed.get("/api/org").json()

    assert body["settings"]["working_days"] == 0b11111
    assert body["settings"]["default_timezone"] == "Asia/Baku"
    assert body["settings"]["holiday_calendar"] == []


def test_the_owner_edits_the_defaults(authed):
    response = authed.patch(
        "/api/org",
        json={
            "default_timezone": "Europe/Moscow",
            "default_shift_threshold_days": 5,
            "holiday_calendar": ["2026-03-21", "2026-03-20", "2026-03-20"],
        },
    )

    assert response.status_code == 200
    settings = response.json()["settings"]
    assert settings["default_timezone"] == "Europe/Moscow"
    assert settings["default_shift_threshold_days"] == 5
    # A calendar is a set of dates: sorted and with no repeats.
    assert settings["holiday_calendar"] == ["2026-03-20", "2026-03-21"]


def test_a_changed_default_reaches_projects_that_inherit_it(authed):
    """Inheritance is live rather than a copy made at creation.

    The project was created before the default was edited — and still sees the new
    value, because it stores `null` rather than a snapshot.
    """
    project_id = authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]

    authed.patch("/api/org", json={"default_shift_threshold_days": 9})

    state = authed.get(f"/api/projects/{project_id}").json()
    assert state["settings"]["shift_threshold_days"] == 9
    assert state["overrides"]["shift_threshold_days"] is None


def test_a_project_override_survives_the_organization_change(authed):
    project_id = authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]
    authed.patch(f"/api/projects/{project_id}", json={"shift_threshold_days": 1})

    authed.patch("/api/org", json={"default_shift_threshold_days": 9})

    state = authed.get(f"/api/projects/{project_id}").json()
    assert state["settings"]["shift_threshold_days"] == 1


def test_an_unknown_timezone_is_refused(authed):
    response = authed.patch("/api/org", json={"default_timezone": "Mars/Olympus"})

    assert response.status_code == 422


def test_an_empty_working_day_mask_is_refused(authed):
    # A calendar with no working days makes it impossible to compute any finish date
    # — the project would stop being readable altogether.
    assert authed.patch("/api/org", json={"working_days": 0}).status_code == 422


def test_an_unsupported_locale_is_refused(authed):
    assert authed.patch("/api/org", json={"default_locale": "fr"}).status_code == 422


def test_only_the_owner_edits_the_organization(authed, db):
    _set_role(authed, db, "editor")

    assert authed.patch("/api/org", json={"working_days": 0b111111}).status_code == 403


def test_a_typo_in_a_field_name_is_refused_not_ignored(authed):
    response = authed.patch("/api/org", json={"working_dayz": 31})

    assert response.status_code == 422


# --- slugs ---------------------------------------------------------------------


def test_a_free_organization_slug_is_reported_as_free(authed):
    body = authed.get("/api/org/slug-check", params={"slug": "Yeni Şirkət"}).json()

    assert body["normalized"] == "yeni-sirket"
    assert body["available"] is True
    assert body["suggestion"] == "yeni-sirket"


def test_a_taken_organization_slug_suggests_a_free_one(authed, db):
    db.add(Organization(name="Globex", slug="globex"))
    db.flush()

    body = authed.get("/api/org/slug-check", params={"slug": "globex"}).json()

    assert body["available"] is False
    # A sequential number rather than random hexadecimal digits: a suggestion is read
    # by eye and dictated aloud.
    assert body["suggestion"] == "globex-2"


def test_the_organizations_own_slug_is_not_taken_by_itself(authed):
    own = authed.get("/api/org").json()["slug"]

    body = authed.get("/api/org/slug-check", params={"slug": own}).json()

    assert body["available"] is True


def test_a_taken_organization_slug_is_refused_on_save(authed, db):
    db.add(Organization(name="Globex", slug="globex"))
    db.flush()

    response = authed.patch("/api/org", json={"slug": "globex"})

    assert response.status_code == 409
    assert response.json()["detail"] == "slug_taken"


def test_the_project_slug_is_editable(authed):
    project_id = authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]

    response = authed.patch(f"/api/projects/{project_id}", json={"slug": "redesign-2026"})

    assert response.status_code == 200
    assert response.json()["slug"] == "redesign-2026"


def test_a_taken_project_slug_suggests_a_free_one(authed):
    authed.post("/api/projects", json={"name": "Redesign"})
    other_id = authed.post("/api/projects", json={"name": "Другой"}).json()["id"]

    body = authed.get(
        f"/api/projects/{other_id}/slug-check", params={"slug": "redesign"}
    ).json()

    assert body["available"] is False
    assert body["suggestion"] == "redesign-2"


def test_the_same_slug_in_another_organization_is_free(authed, db):
    """A project's slug is unique within an organization rather than globally."""
    project_id = authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]
    other_org = Organization(name="Globex", slug="globex")
    db.add(other_org)
    db.flush()
    db.add(Project(org_id=other_org.id, name="Redesign", slug="redesign-2026"))
    db.flush()

    body = authed.get(
        f"/api/projects/{project_id}/slug-check", params={"slug": "redesign-2026"}
    ).json()

    assert body["available"] is True


# --- level 3: the project ------------------------------------------------------


def test_project_settings_round_trip(authed):
    project_id = authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]
    # Calendar mode: the calendar block shows holidays and declared working days only
    # where the plan has real dates — a relative axis's calendar consists of a single
    # weekly mask.
    authed.post(f"/api/projects/{project_id}/schedule", json={"start_date": "2026-05-01"})

    response = authed.patch(
        f"/api/projects/{project_id}",
        json={
            "deadline": "2026-06-01",
            "timezone": "Europe/Moscow",
            "working_days": 0b111111,
            "holidays_extra": ["2026-05-09"],
            "workdays_extra": ["2026-05-16"],
        },
    )

    assert response.status_code == 200
    state = response.json()
    assert state["deadline"] == "2026-06-01"
    assert state["settings"]["timezone"] == "Europe/Moscow"
    assert state["calendar"]["working_days"] == 0b111111
    assert state["calendar"]["holidays"] == ["2026-05-09"]
    assert state["calendar"]["extra_workdays"] == ["2026-05-16"]


def test_a_null_resets_an_override_back_to_inherited(authed):
    project_id = authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]
    authed.patch(f"/api/projects/{project_id}", json={"timezone": "Europe/Moscow"})

    authed.patch(f"/api/projects/{project_id}", json={"timezone": None})

    state = authed.get(f"/api/projects/{project_id}").json()
    assert state["overrides"]["timezone"] is None
    assert state["settings"]["timezone"] == "Asia/Baku"


def test_a_field_that_was_not_sent_is_not_touched(authed):
    """"Not sent" and "sent as null" are different things.

    Without that difference, clearing an override would be inexpressible: any request
    without the field would erase it.
    """
    project_id = authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]
    authed.patch(f"/api/projects/{project_id}", json={"timezone": "Europe/Moscow"})

    authed.patch(f"/api/projects/{project_id}", json={"deadline": "2026-06-01"})

    state = authed.get(f"/api/projects/{project_id}").json()
    assert state["overrides"]["timezone"] == "Europe/Moscow"


def test_a_viewer_may_not_edit_the_project(authed, db):
    project_id = authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]
    _set_role(authed, db, "viewer")

    assert authed.patch(f"/api/projects/{project_id}", json={"name": "Другое"}).status_code == 403


def test_a_foreign_project_is_not_found(authed, db):
    other = Organization(name="Globex", slug="globex")
    db.add(other)
    db.flush()
    foreign = Project(org_id=other.id, name="Secret", slug="secret")
    db.add(foreign)
    db.flush()

    assert authed.patch(f"/api/projects/{foreign.id}", json={"name": "Моё"}).status_code == 404


# --- level 4: the profile ------------------------------------------------------


def test_the_language_lives_in_the_profile(authed, db):
    response = authed.patch("/api/auth/me", json={"locale": "ru"})

    assert response.status_code == 200
    assert response.json()["locale"] == "ru"
    # And it really is the profile rather than the browser's memory: the next sign-in will see the same.
    assert authed.get("/api/auth/me").json()["locale"] == "ru"
    assert db.scalar(select(User.locale).where(User.email == "alex@example.com")) == "ru"


def test_an_unsupported_profile_locale_is_refused(authed):
    response = authed.patch("/api/auth/me", json={"locale": "fr"})

    assert response.status_code == 422
    assert response.json()["detail"] == "unsupported_locale"


def test_the_profile_needs_a_session(client):
    assert client.patch("/api/auth/me", json={"locale": "ru"}).status_code == 401


def test_a_new_account_has_no_timezone_of_its_own(authed):
    """An empty timezone is not an omission but "count days by the browser".

    A copy of the organization's timezone made when the account was created would look
    like a deliberate choice by the person and would outlive an edit to the
    organization's default.
    """
    assert authed.get("/api/auth/me").json()["timezone"] is None


def test_the_timezone_lives_in_the_profile(authed, db):
    response = authed.patch("/api/auth/me", json={"timezone": "Europe/Moscow"})

    assert response.status_code == 200
    assert response.json()["timezone"] == "Europe/Moscow"
    # And it really is the profile rather than the browser's memory: the same person
    # from another computer must see their own days rather than another browser's.
    assert authed.get("/api/auth/me").json()["timezone"] == "Europe/Moscow"
    assert db.scalar(select(User.timezone).where(User.email == "alex@example.com")) == "Europe/Moscow"


def test_a_null_timezone_returns_the_profile_to_the_browser(authed):
    authed.patch("/api/auth/me", json={"timezone": "Europe/Moscow"})

    response = authed.patch("/api/auth/me", json={"timezone": None})

    assert response.status_code == 200
    assert response.json()["timezone"] is None


def test_a_profile_field_that_was_not_sent_is_not_touched(authed):
    """"Not sent" and "sent as null" are different things here too.

    Otherwise changing the language would erase the chosen timezone: the settings
    screen sends every field on its own, once it is done with it.
    """
    authed.patch("/api/auth/me", json={"timezone": "Europe/Moscow"})

    authed.patch("/api/auth/me", json={"locale": "ru"})

    assert authed.get("/api/auth/me").json()["timezone"] == "Europe/Moscow"


def test_an_unknown_profile_timezone_is_refused(authed):
    response = authed.patch("/api/auth/me", json={"timezone": "Mars/Olympus"})

    assert response.status_code == 422
