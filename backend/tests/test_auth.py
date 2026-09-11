from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.api.auth_routes import _cookie_is_secure
from app.auth import (
    SESSION_COOKIE,
    SESSION_TTL,
    authenticate,
    close_session,
    current_user,
    open_session,
    register,
)
from app.config import get_settings
from app.db import get_db
from app.main import app
from app.models import Membership, Organization, Role, Session
from app.security import hash_password, hash_token, verify_password


def test_password_hash_is_not_the_password():
    hashed = hash_password("correct horse battery staple")
    assert hashed != "correct horse battery staple"
    assert verify_password("correct horse battery staple", hashed) is True
    assert verify_password("wrong", hashed) is False


def test_registration_creates_user_org_and_owner_membership(db):
    user = register(db, name="Alex", email="Alex@Example.com", password="s3cret-pass")
    db.flush()

    assert user.email == "alex@example.com"

    membership = db.query(Membership).filter_by(user_id=user.id).one()
    assert membership.role == Role.OWNER

    org = db.get(Organization, membership.org_id)
    assert org.name == "Alex"
    assert org.slug == "alex"


def test_the_organization_speaks_the_language_of_its_founder(db):
    """An organization's language is the language of whoever created it.

    Its messages go out in that language, and invitations above all. This used to
    keep the model's hard default (`az`), and a Russian-speaking owner sent the team
    invitations in Azerbaijani with no way to notice it from the interface.
    """
    user = register(db, name="Алексей", email="alex@example.com", password="s3cret-pass", locale="ru")
    db.flush()

    membership = db.query(Membership).filter_by(user_id=user.id).one()
    assert db.get(Organization, membership.org_id).default_locale == "ru"


def test_registration_rejects_a_duplicate_email_regardless_of_case(db):
    register(db, name="Alex", email="alex@example.com", password="s3cret-pass")
    db.flush()

    with pytest.raises(ValueError, match="занят"):
        register(db, name="Other", email="ALEX@example.com", password="other-pass")


def test_org_slug_gets_a_suffix_when_taken(db):
    register(db, name="Acme", email="one@example.com", password="s3cret-pass")
    db.flush()
    second = register(db, name="Acme", email="two@example.com", password="s3cret-pass")
    db.flush()

    membership = db.query(Membership).filter_by(user_id=second.id).one()
    org = db.get(Organization, membership.org_id)
    assert org.slug.startswith("acme-")


def test_org_slug_collision_at_insert_time_retries_instead_of_failing(db, monkeypatch):
    """Simulates a race: the SELECT check of the slug has gone stale (as if a
    concurrent request had passed it a fraction of a second before us), and the first
    insert attempt catches an IntegrityError on the unique index. register() must
    quietly retry with a new suffix rather than raise."""
    import app.slugs as slugs

    register(db, name="Acme", email="first@example.com", password="s3cret-pass")
    db.flush()

    original = slugs._candidate
    calls = {"n": 0}

    def flaky(name, *, forced, is_taken, fallback):
        calls["n"] += 1
        if calls["n"] == 1:
            return "acme"  # already taken by first@example.com — the insert will fail
        return original(name, forced=True, is_taken=is_taken, fallback=fallback)

    monkeypatch.setattr(slugs, "_candidate", flaky)

    second = register(db, name="Acme", email="second@example.com", password="s3cret-pass")
    db.flush()

    membership = db.query(Membership).filter_by(user_id=second.id).one()
    org = db.get(Organization, membership.org_id)
    assert org.slug != "acme"
    assert calls["n"] >= 2


def test_authenticate_accepts_the_right_password_and_rejects_the_wrong_one(db):
    register(db, name="Alex", email="alex@example.com", password="s3cret-pass")
    db.flush()

    assert authenticate(db, email="ALEX@example.com", password="s3cret-pass") is not None
    assert authenticate(db, email="alex@example.com", password="nope") is None
    assert authenticate(db, email="ghost@example.com", password="s3cret-pass") is None


# ---- The session's lifecycle -------------------------------------------------


def test_expired_session_does_not_authenticate(db):
    user = register(db, name="Alex", email="alex@example.com", password="s3cret-pass")
    db.flush()

    raw = "expired-raw-token"
    db.add(
        Session(
            user_id=user.id,
            token_hash=hash_token(raw),
            expires_at=datetime.now(timezone.utc) - timedelta(days=1),
        )
    )
    db.flush()

    with pytest.raises(HTTPException) as exc_info:
        current_user(planora_session=raw, db=db)
    assert exc_info.value.status_code == 401


def test_missing_cookie_is_rejected(db):
    with pytest.raises(HTTPException) as exc_info:
        current_user(planora_session=None, db=db)
    assert exc_info.value.status_code == 401


def test_logout_invalidates_the_server_side_session_not_just_the_cookie(db):
    user = register(db, name="Alex", email="alex@example.com", password="s3cret-pass")
    db.flush()
    raw = open_session(db, user)
    db.flush()

    assert current_user(planora_session=raw, db=db).id == user.id

    close_session(db, raw)
    db.flush()

    with pytest.raises(HTTPException) as exc_info:
        current_user(planora_session=raw, db=db)
    assert exc_info.value.status_code == 401


# ---- The routes through TestClient -------------------------------------------


@pytest.fixture
def client(db):
    """A TestClient whose get_db is overridden with the `db` fixture's session.

    The override returns exactly the same session and does not commit — otherwise the
    `db` fixture's outer transaction would close ahead of time and the isolation
    between tests would disappear (see tests/conftest.py).
    """

    def _override_get_db():
        yield db

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def test_register_route_returns_201_and_sets_an_httponly_cookie(client):
    response = client.post(
        "/api/auth/register",
        json={
            "name": "Alex",
            "email": "alex@example.com",
            "password": "s3cret-pass",
            "company_name": "Acme",
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["email"] == "alex@example.com"
    assert SESSION_COOKIE in response.cookies

    set_cookie_header = response.headers.get("set-cookie", "")
    assert "HttpOnly" in set_cookie_header


def test_register_route_names_the_new_organization_after_the_company_field(client, db):
    """The organization is named after the company from the form rather than after
    the person — otherwise the company_name field would be a shop window deciding nothing."""
    response = client.post(
        "/api/auth/register",
        json={
            "name": "Alex",
            "email": "alex@example.com",
            "password": "s3cret-pass",
            "company_name": "Acme Corp",
        },
    )
    assert response.status_code == 201

    membership = db.query(Membership).filter_by(user_id=response.json()["id"]).one()
    org = db.get(Organization, membership.org_id)
    assert org.name == "Acme Corp"


def test_register_route_requires_a_company_name_for_free_signup(client):
    """Without an invitation, registration creates a new organization — and must know
    what to call it. An empty and a missing string are the same refusal: the schema's
    validator reduces one to the other."""
    for payload in (
        {"name": "Alex", "email": "alex@example.com", "password": "s3cret-pass"},
        {
            "name": "Alex",
            "email": "alex@example.com",
            "password": "s3cret-pass",
            "company_name": "   ",
        },
    ):
        response = client.post("/api/auth/register", json=payload)
        assert response.status_code == 422
        assert response.json()["detail"] == "company_name_required"


def test_me_route_returns_the_authenticated_user(client):
    register_response = client.post(
        "/api/auth/register",
        json={
            "name": "Alex",
            "email": "alex@example.com",
            "password": "s3cret-pass",
            "company_name": "Acme",
        },
    )
    user_id = register_response.json()["id"]

    me_response = client.get("/api/auth/me")
    assert me_response.status_code == 200
    assert me_response.json()["id"] == user_id


def test_me_route_without_a_cookie_is_401(client):
    response = client.get("/api/auth/me")
    assert response.status_code == 401


def test_register_route_rejects_a_duplicate_address_with_409(client):
    client.post(
        "/api/auth/register",
        json={
            "name": "Alex",
            "email": "alex@example.com",
            "password": "s3cret-pass",
            "company_name": "Acme",
        },
    )
    response = client.post(
        "/api/auth/register",
        json={
            "name": "Other",
            "email": "ALEX@example.com",
            "password": "other-pass",
            "company_name": "Other Co",
        },
    )
    assert response.status_code == 409


def test_login_route_rejects_a_wrong_password_with_401(client):
    client.post(
        "/api/auth/register",
        json={
            "name": "Alex",
            "email": "alex@example.com",
            "password": "s3cret-pass",
            "company_name": "Acme",
        },
    )
    response = client.post(
        "/api/auth/login", json={"email": "alex@example.com", "password": "wrong"}
    )
    assert response.status_code == 401


def test_register_route_maps_an_unprotected_integrity_error_to_409(client, monkeypatch):
    """The route's safety net: even if register() one day lets an IntegrityError
    through (after a future edit unprotected by a SAVEPOINT, for instance), the route
    must not answer 500."""
    import app.api.auth_routes as routes_module
    from sqlalchemy.exc import IntegrityError

    def boom(*args, **kwargs):
        raise IntegrityError("insert", {}, Exception("unique violation"))

    monkeypatch.setattr(routes_module, "register", boom)

    response = client.post(
        "/api/auth/register",
        json={
            "name": "Alex",
            "email": "alex@example.com",
            "password": "s3cret-pass",
            "company_name": "Acme",
        },
    )
    assert response.status_code == 409


def test_logout_route_kills_the_session_so_the_same_cookie_stops_working(client):
    register_response = client.post(
        "/api/auth/register",
        json={
            "name": "Alex",
            "email": "alex@example.com",
            "password": "s3cret-pass",
            "company_name": "Acme",
        },
    )
    assert register_response.status_code == 201

    logout_response = client.post("/api/auth/logout")
    assert logout_response.status_code == 204

    me_response = client.get("/api/auth/me")
    assert me_response.status_code == 401


# ---- The cookie's Secure attribute follows the PUBLIC_BASE_URL scheme --------


class _FakeRequest:
    """Exactly what _cookie_is_secure reads: the scheme and the headers."""

    def __init__(self, scheme: str = "http", headers: dict[str, str] | None = None):
        from types import SimpleNamespace

        self.url = SimpleNamespace(scheme=scheme)
        self.headers = headers or {}


def test_cookie_is_secure_when_public_base_url_is_https(monkeypatch):
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://planora.example.com")
    get_settings.cache_clear()
    try:
        assert _cookie_is_secure(_FakeRequest()) is True
    finally:
        get_settings.cache_clear()


def test_cookie_is_not_secure_when_public_base_url_is_http(monkeypatch):
    monkeypatch.setenv("PUBLIC_BASE_URL", "http://localhost:8000")
    get_settings.cache_clear()
    try:
        assert _cookie_is_secure(_FakeRequest()) is False
    finally:
        get_settings.cache_clear()


def test_cookie_is_secure_behind_a_tls_terminating_proxy(monkeypatch):
    """Wave 2.7: the production signal is the request itself, not PUBLIC_BASE_URL alone.

    Behind a proxy with TLS the request arrives with X-Forwarded-Proto: https, and the
    cookie must be Secure even if nobody set PUBLIC_BASE_URL (a common case: the
    domain appeared before the variable).
    """
    monkeypatch.setenv("PUBLIC_BASE_URL", "http://localhost:8000")
    get_settings.cache_clear()
    try:
        assert _cookie_is_secure(_FakeRequest(headers={"x-forwarded-proto": "https"})) is True
        assert _cookie_is_secure(_FakeRequest(scheme="https")) is True
    finally:
        get_settings.cache_clear()


def test_cookie_secure_setting_overrides_the_guesswork(monkeypatch):
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://planora.example.com")
    monkeypatch.setenv("COOKIE_SECURE", "false")
    get_settings.cache_clear()
    try:
        assert _cookie_is_secure(_FakeRequest(scheme="https")) is False
    finally:
        get_settings.cache_clear()


def test_a_corrupted_hash_is_a_failed_login_not_a_crash():
    """A corrupted string in password_hash raises InvalidHashError rather than
    VerifyMismatchError, and used to reach the client as a 500 — even though the right
    answer is the same: sign-in failed."""
    assert verify_password("s3cret-pass", "не хеш вовсе") is False
    assert verify_password("s3cret-pass", "") is False
    # a truncated real hash
    assert verify_password("s3cret-pass", hash_password("s3cret-pass")[:20]) is False


def test_a_corrupted_hash_answers_401_instead_of_500(client, db):
    from sqlalchemy import select

    from app.models import User

    client.post(
        "/api/auth/register",
        json={
            "name": "Alex",
            "email": "alex@example.com",
            "password": "s3cret-pass",
            "company_name": "Acme",
        },
    )
    user = db.scalar(select(User).where(User.email == "alex@example.com"))
    user.password_hash = "испорчено"
    db.flush()

    response = client.post(
        "/api/auth/login", json={"email": "alex@example.com", "password": "s3cret-pass"}
    )
    assert response.status_code == 401
    assert response.json()["detail"] == "bad_credentials"


def test_the_session_cookie_lives_exactly_as_long_as_the_session(client):
    response = client.post(
        "/api/auth/register",
        json={
            "name": "Alex",
            "email": "alex@example.com",
            "password": "s3cret-pass",
            "company_name": "Acme",
        },
    )
    header = response.headers["set-cookie"]
    assert f"Max-Age={int(SESSION_TTL.total_seconds())}" in header
