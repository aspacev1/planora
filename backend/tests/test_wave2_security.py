"""Регрессионные тесты волны 2 плана исправлений: безопасность и мультитенантность.

Каждый тест воспроизводит путь, который до исправления давал постороннему
прочитать или потратить чужое: SSRF через адрес LLM, перебор паролей без
предела, токены в журнале, внутренние реплики в публичной ленте, вечная
украденная сессия, пишущий запрос с чужого сайта.
"""

import logging
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.ai.netguard import ensure_public_https
from app.ai.provider import LlmError
from app.ai import usage
from app.config import Settings, get_settings
from app.db import get_db
from app.mail.transports import Letter, LogTransport
from app.main import app
from app.models import Membership, Organization, OrgLlmCredential, Session, User
from app.auth import SESSION_IDLE_TTL, open_session


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


# --- 2.1: SSRF ---------------------------------------------------------------


@pytest.fixture
def strict_urls(monkeypatch):
    monkeypatch.setattr(get_settings(), "ai_allow_private_urls", False)


def _resolves_to(monkeypatch, address: str) -> None:
    monkeypatch.setattr(
        "app.ai.netguard.socket.getaddrinfo",
        lambda *args, **kwargs: [(2, 1, 6, "", (address, 443))],
    )


def test_llm_url_must_be_https(strict_urls):
    with pytest.raises(LlmError) as error:
        ensure_public_https("http://api.example.com/v1")
    assert error.value.code == "llm_url_not_https"


def test_llm_url_must_not_resolve_into_private_space(strict_urls, monkeypatch):
    """Адрес задаёт пользователь, а ходит по нему сервер: 169.254.169.254 —
    это метаданные облака, 10.х — внутренняя сеть установки."""
    for address in ("10.0.0.5", "127.0.0.1", "169.254.169.254", "192.168.1.1"):
        _resolves_to(monkeypatch, address)
        with pytest.raises(LlmError) as error:
            ensure_public_https("https://model.example.com/v1")
        assert error.value.code == "llm_url_private", address


def test_a_public_llm_url_passes(strict_urls, monkeypatch):
    _resolves_to(monkeypatch, "8.8.8.8")
    ensure_public_https("https://model.example.com/v1")


def test_the_self_hosted_switch_disables_the_guard(monkeypatch):
    monkeypatch.setattr(get_settings(), "ai_allow_private_urls", True)
    ensure_public_https("http://localhost:8081/v1")  # не поднимает


def test_saving_an_unsafe_llm_url_is_a_form_error(authed, monkeypatch):
    monkeypatch.setattr(get_settings(), "ai_allow_private_urls", False)
    response = authed.put(
        "/api/ai/credential",
        json={"base_url": "http://10.0.0.5/v1", "model": "m", "api_key": "k"},
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "llm_url_not_https"


# --- 2.2: AI в выбранной организации -----------------------------------------


def test_ai_credential_lives_in_the_switched_organization(authed, db):
    """До исправления AI брал «первое членство по id» и настраивал ключ первой
    организации, в какой бы человек ни работал."""
    user = db.scalar(select(User).where(User.email == "alex@example.com"))
    second = Organization(name="Вторая", slug="vtoraya")
    db.add(second)
    db.flush()
    db.add(Membership(org_id=second.id, user_id=user.id, role="owner"))
    db.flush()

    switched = authed.post("/api/org/switch", json={"org_id": str(second.id)})
    assert switched.status_code == 200

    saved = authed.put(
        "/api/ai/credential",
        json={"base_url": "https://model.example.com/v1", "model": "m", "api_key": "k"},
    )
    assert saved.status_code == 200

    row = db.scalar(select(OrgLlmCredential))
    assert row.org_id == second.id


# --- 2.3: пределы входа и регистрации ----------------------------------------


def test_failed_logins_to_one_account_hit_a_ceiling(authed, monkeypatch):
    monkeypatch.setattr(get_settings(), "login_rate_limit_per_account", 2)
    wrong = {"email": "alex@example.com", "password": "not-the-password"}
    assert authed.post("/api/auth/login", json=wrong).status_code == 401
    assert authed.post("/api/auth/login", json=wrong).status_code == 401
    refused = authed.post("/api/auth/login", json=wrong)
    assert refused.status_code == 429
    assert refused.json()["detail"] == "too_many_requests"


def test_successful_logins_do_not_lock_the_account(authed, monkeypatch):
    """Считаются только неудачи: человек с двух устройств — не перебор."""
    monkeypatch.setattr(get_settings(), "login_rate_limit_per_account", 2)
    good = {"email": "alex@example.com", "password": "s3cret-pass"}
    for _ in range(4):
        assert authed.post("/api/auth/login", json=good).status_code == 200


def test_the_ip_ceiling_counts_every_attempt(authed, monkeypatch):
    monkeypatch.setattr(get_settings(), "login_rate_limit_per_ip", 3)
    good = {"email": "alex@example.com", "password": "s3cret-pass"}
    for _ in range(3):
        assert authed.post("/api/auth/login", json=good).status_code == 200
    assert authed.post("/api/auth/login", json=good).status_code == 429


def test_signups_from_one_address_hit_a_ceiling(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "signup_rate_limit_per_ip", 1)
    first = client.post(
        "/api/auth/register",
        json={
            "name": "A",
            "email": "a@example.com",
            "password": "s3cret-pass",
            "company_name": "A Co",
        },
    )
    assert first.status_code == 201
    second = client.post(
        "/api/auth/register",
        json={
            "name": "B",
            "email": "b@example.com",
            "password": "s3cret-pass",
            "company_name": "B Co",
        },
    )
    assert second.status_code == 429


# --- 2.4: бюджет и частота AI -------------------------------------------------


@pytest.fixture
def org(db, authed) -> Organization:
    return db.scalar(select(Organization))


def test_token_usage_accumulates_per_day(db, org):
    usage.charge(db, org, 60)
    usage.charge(db, org, 40)
    assert usage.spent_today(db, org) == 100


def test_the_daily_budget_closes_the_gate(authed, db, org, monkeypatch):
    import app.api.ai_routes as routes
    from tests.test_ai_intake import QUESTION  # записанный ответ модели

    from app.ai.provider import RecordedProvider

    monkeypatch.setattr(get_settings(), "ai_daily_token_budget", 150)
    monkeypatch.setattr(
        routes, "provider_for", lambda db, org: RecordedProvider([QUESTION, QUESTION])
    )

    assert authed.post("/api/ai/sessions", json={"locale": "ru"}).status_code == 201
    # Первый вызов записал 100 токенов; на второй бюджета ещё хватает,
    # он доводит расход до 200 — и третий уже не проходит.
    assert authed.post("/api/ai/sessions", json={"locale": "ru"}).status_code == 201
    refused = authed.post("/api/ai/sessions", json={"locale": "ru"})
    assert refused.status_code == 429
    assert refused.json()["detail"] == "ai_budget_exhausted"


def test_the_ai_request_frequency_closes_the_gate(authed, monkeypatch):
    import app.api.ai_routes as routes
    from tests.test_ai_intake import QUESTION

    from app.ai.provider import RecordedProvider

    monkeypatch.setattr(get_settings(), "ai_requests_per_minute", 1)
    monkeypatch.setattr(
        routes, "provider_for", lambda db, org: RecordedProvider([QUESTION])
    )

    assert authed.post("/api/ai/sessions", json={"locale": "ru"}).status_code == 201
    refused = authed.post("/api/ai/sessions", json={"locale": "ru"})
    assert refused.status_code == 429
    assert refused.json()["detail"] == "ai_rate_limited"


# --- 2.5: внутренние реплики -------------------------------------------------


def _published_project(authed):
    project_id = authed.post("/api/projects", json={"name": "Редизайн"}).json()["id"]
    url = authed.post(f"/api/projects/{project_id}/share").json()["url"]
    org_slug, project_slug = url.split("/p/")[1].split("?")[0].split("/")
    token = url.split("?s=")[1]
    return project_id, f"/api/public/{org_slug}/{project_slug}/comments?s={token}"


def test_an_internal_comment_stays_out_of_the_public_feed(authed):
    project_id, public_feed = _published_project(authed)
    authed.post(
        f"/api/projects/{project_id}/comments",
        json={"body": "Клиенту не показываем: бюджет уже трещит", "internal": True},
    )
    authed.post(f"/api/projects/{project_id}/comments", json={"body": "Общая реплика"})

    team = authed.get(f"/api/projects/{project_id}/comments").json()
    assert [c["internal"] for c in team] == [True, False]

    guest = authed.get(public_feed).json()
    assert [c["body"] for c in guest] == ["Общая реплика"]


def test_a_guest_cannot_smuggle_the_internal_flag(authed):
    """Публичная модель признака не знает: гость, приславший его, получает
    обычную публичную реплику, а не внутреннюю."""
    _, public_feed = _published_project(authed)
    posted = authed.post(
        public_feed,
        json={"name": "Гость", "body": "Привет", "internal": True},
    )
    assert posted.status_code == 201
    feed = authed.get(public_feed).json()
    assert [c["body"] for c in feed] == ["Привет"]


# --- 2.6: APP_SECRET ---------------------------------------------------------


def test_the_placeholder_secret_refuses_to_start():
    with pytest.raises(Exception, match="APP_SECRET"):
        Settings(
            _env_file=None,
            app_secret="change-me-to-a-long-random-string",
            director_email="director@example.com",
            database_url="postgresql+psycopg://u:p@host/db",
        )


def test_a_short_secret_refuses_to_start():
    with pytest.raises(Exception, match="APP_SECRET"):
        Settings(
            _env_file=None,
            app_secret="short",
            director_email="director@example.com",
            database_url="postgresql+psycopg://u:p@host/db",
        )


# --- 2.7: DIRECTOR_EMAIL ------------------------------------------------------


def test_the_placeholder_director_email_refuses_to_start():
    with pytest.raises(Exception, match="DIRECTOR_EMAIL"):
        Settings(
            _env_file=None,
            app_secret="test-secret-not-for-production",
            director_email="change-me-to-your-email@example.com",
            database_url="postgresql+psycopg://u:p@host/db",
        )


def test_a_blank_director_email_refuses_to_start():
    with pytest.raises(Exception, match="DIRECTOR_EMAIL"):
        Settings(
            _env_file=None,
            app_secret="test-secret-not-for-production",
            director_email="   ",
            database_url="postgresql+psycopg://u:p@host/db",
        )


# --- 2.8: токены не в журнале ------------------------------------------------


def _letter() -> Letter:
    return Letter(
        to="a@b.c",
        subject="Подтверждение",
        body="Открой ссылку: https://plan.example.com/verify-email?token=AbCdEf0123456789AbCdEf01",
    )


def test_the_none_transport_masks_tokens(caplog):
    with caplog.at_level(logging.INFO, logger="app.mail.transports"):
        LogTransport(reveal_secrets=False).deliver(_letter())
    assert "AbCdEf0123456789AbCdEf01" not in caplog.text
    assert "AbCdEf…" in caplog.text  # письмо сопоставимо с записью в базе


def test_the_dev_log_transport_keeps_the_letter_readable(caplog):
    with caplog.at_level(logging.INFO, logger="app.mail.transports"):
        LogTransport(reveal_secrets=True).deliver(_letter())
    assert "AbCdEf0123456789AbCdEf01" in caplog.text


# Тесты Origin для WebSocket (волна 2.10) живут в test_live_api.py: сокету
# нужны фикстуры с подменой db_scope, а они там.


# --- 2.11: CSRF в глубину -----------------------------------------------------


def test_a_write_with_a_foreign_origin_is_refused(client):
    response = client.post(
        "/api/auth/login",
        json={"email": "a@b.c", "password": "irrelevant"},
        headers={"Origin": "https://evil.example"},
    )
    assert response.status_code == 403
    assert response.json()["detail"] == "csrf_origin_mismatch"


def test_a_write_from_our_own_origin_passes_the_middleware(client):
    response = client.post(
        "/api/auth/login",
        json={"email": "a@b.c", "password": "irrelevant"},
        headers={"Origin": "http://testserver"},
    )
    # Прошёл CSRF и упёрся в обычную проверку пароля — то, что и должно быть.
    assert response.status_code == 401


def test_reads_are_not_gated_by_origin(client):
    response = client.get("/api/health", headers={"Origin": "https://evil.example"})
    assert response.status_code == 200


# --- 2.12: сессии ------------------------------------------------------------


def test_an_idle_session_dies_before_its_expiry(authed, db):
    record = db.scalar(select(Session))
    record.last_used_at = datetime.now(timezone.utc) - SESSION_IDLE_TTL - timedelta(hours=1)
    db.flush()

    assert authed.get("/api/auth/me").status_code == 401
    # Мёртвая сессия убрана, а не оставлена лежать.
    assert db.scalar(select(Session)) is None


def test_changing_the_password_closes_the_other_sessions(authed, db):
    user = db.scalar(select(User))
    open_session(db, user)  # второе устройство
    assert len(db.scalars(select(Session)).all()) == 2

    changed = authed.post(
        "/api/auth/password",
        json={"current_password": "s3cret-pass", "new_password": "n3w-secret-pass"},
    )
    assert changed.status_code == 204
    # Текущая сессия жива, чужая закрыта.
    assert len(db.scalars(select(Session)).all()) == 1
    assert authed.get("/api/auth/me").status_code == 200

    # Новый пароль действует, старый — нет.
    assert (
        authed.post(
            "/api/auth/login",
            json={"email": "alex@example.com", "password": "s3cret-pass"},
        ).status_code
        == 401
    )


def test_the_wrong_current_password_changes_nothing(authed, db):
    refused = authed.post(
        "/api/auth/password",
        json={"current_password": "not-it", "new_password": "n3w-secret-pass"},
    )
    assert refused.status_code == 403
    assert (
        authed.post(
            "/api/auth/login",
            json={"email": "alex@example.com", "password": "s3cret-pass"},
        ).status_code
        == 200
    )


def test_close_others_keeps_only_this_device(authed, db):
    user = db.scalar(select(User))
    open_session(db, user)
    open_session(db, user)

    result = authed.post("/api/auth/sessions/close-others")
    assert result.status_code == 200
    assert result.json()["closed"] == 2
    assert authed.get("/api/auth/me").status_code == 200


def test_login_sweeps_the_users_expired_sessions(client, db):
    client.post(
        "/api/auth/register",
        json={
            "name": "Alex",
            "email": "alex@example.com",
            "password": "s3cret-pass",
            "company_name": "Acme",
        },
    )
    user = db.scalar(select(User))
    stale = Session(
        user_id=user.id,
        token_hash=uuid.uuid4().hex,
        expires_at=datetime.now(timezone.utc) - timedelta(days=1),
    )
    db.add(stale)
    db.flush()

    client.post(
        "/api/auth/login", json={"email": "alex@example.com", "password": "s3cret-pass"}
    )
    hashes = {row.token_hash for row in db.scalars(select(Session)).all()}
    assert stale.token_hash not in hashes
