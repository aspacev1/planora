"""Восстановление пароля: выдача ссылки, её погашение и защита формы.

Письма перехватываются фикстурой `mailbox` (tests/conftest.py) — ни один
тест не открывает сокет. Проверяется то, что решает наш код: одноразовость
ссылки, срок жизни, смерть всех сессий при смене пароля и молчание формы о
том, какие адреса зарегистрированы.
"""

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.auth import authenticate, open_session, register
from app.db import get_db
from app.main import app
from app.models import PasswordReset, Session
from app.password_reset import (
    RESEND_COOLDOWN,
    RESET_TTL,
    ResetError,
    issue_token,
    redeem_token,
    reset_link,
    send_reset,
)


@pytest.fixture
def user(db):
    created = register(db, name="Alex", email="alex@example.com", password="s3cret-pass")
    db.flush()
    return created


@pytest.fixture
def client(db):
    def _override_get_db():
        yield db

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def _token_of(text: str) -> str:
    """Токен из ссылки — так же, как его достаёт из письма человек."""
    return text.partition("token=")[2].split()[0]


# ---- Выдача и погашение -----------------------------------------------------


def test_the_open_token_is_not_what_lands_in_the_database(db, user):
    raw = issue_token(db, user)

    record = db.query(PasswordReset).filter_by(user_id=user.id).one()
    assert record.token_hash != raw
    assert raw not in record.token_hash


def test_redeeming_sets_the_new_password_and_burns_the_token(db, user):
    raw = issue_token(db, user)

    changed = redeem_token(db, raw, new_password="n3w-secret-pass")

    assert changed.id == user.id
    assert authenticate(db, email="alex@example.com", password="n3w-secret-pass") is not None
    assert authenticate(db, email="alex@example.com", password="s3cret-pass") is None
    assert db.query(PasswordReset).filter_by(user_id=user.id).count() == 0

    # Вторая попытка по той же ссылке ничего не даёт: токен погашен.
    with pytest.raises(ResetError) as exc_info:
        redeem_token(db, raw, new_password="another-pass-123")
    assert exc_info.value.code == "invalid_token"


def test_redeeming_closes_every_session_of_the_owner(db, user):
    # Две сессии — «угонщик» и брошенный ноутбук. Обе должны умереть: за
    # восстановлением приходят как раз тогда, когда пароль, похоже, утёк.
    open_session(db, user)
    open_session(db, user)

    redeem_token(db, issue_token(db, user), new_password="n3w-secret-pass")

    assert db.query(Session).filter_by(user_id=user.id).count() == 0


def test_an_unknown_token_is_rejected(db, user):
    with pytest.raises(ResetError) as exc_info:
        redeem_token(db, "made-up-token", new_password="n3w-secret-pass")
    assert exc_info.value.code == "invalid_token"


def test_an_expired_link_is_rejected_and_swept_away(db, user):
    raw = issue_token(db, user)
    record = db.query(PasswordReset).filter_by(user_id=user.id).one()
    record.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    db.flush()

    with pytest.raises(ResetError) as exc_info:
        redeem_token(db, raw, new_password="n3w-secret-pass")

    assert exc_info.value.code == "token_expired"
    # Пароль не тронут: просроченная ссылка ничего не меняет.
    assert authenticate(db, email="alex@example.com", password="s3cret-pass") is not None
    assert db.query(PasswordReset).filter_by(user_id=user.id).count() == 0


def test_a_new_link_invalidates_the_previous_one(db, user):
    first = issue_token(db, user)
    second = issue_token(db, user)

    with pytest.raises(ResetError):
        redeem_token(db, first, new_password="n3w-secret-pass")
    assert redeem_token(db, second, new_password="n3w-secret-pass").id == user.id


def test_the_link_is_built_from_the_public_base_url(db, user):
    raw = issue_token(db, user)
    link = reset_link(raw)

    assert link.startswith("http")
    assert "/reset-password?token=" in link
    assert _token_of(link)


# ---- Письмо -----------------------------------------------------------------


def test_the_letter_goes_out_in_the_language_of_its_recipient(db, user, mailbox):
    user.locale = "ru"
    db.flush()

    assert send_reset(db, user) is True

    (letter,) = mailbox
    assert letter.to == "alex@example.com"
    assert "парол" in letter.subject.lower()
    assert "Alex" in letter.body
    assert str(int(RESET_TTL.total_seconds() // 3600)) in letter.body

    # Ссылка из письма действительно работает — иначе проверять текст
    # письма бессмысленно.
    assert redeem_token(db, _token_of(letter.body), new_password="n3w-secret-pass")


def test_an_undelivered_letter_still_leaves_a_usable_token(db, user, monkeypatch):
    import app.mail as mail_module

    class Broken:
        def deliver(self, letter):
            raise mail_module.MailError("почтовый сервер лежит")

    monkeypatch.setattr(mail_module, "build_transport", lambda settings: Broken())

    assert send_reset(db, user) is False
    # Токен выдан: повторная просьба выпустит новый и погасит этот, а откат
    # ничего бы не улучшил.
    assert db.query(PasswordReset).filter_by(user_id=user.id).count() == 1


# ---- Маршруты ---------------------------------------------------------------


def test_the_form_sends_a_letter_with_a_working_link(client, db, user, mailbox):
    response = client.post("/api/auth/password/forgot", json={"email": "alex@example.com"})

    assert response.status_code == 204
    (letter,) = mailbox
    assert letter.to == "alex@example.com"

    reset = client.post(
        "/api/auth/password/reset",
        json={"token": _token_of(letter.body), "new_password": "n3w-secret-pass"},
    )
    assert reset.status_code == 204

    login = client.post(
        "/api/auth/login", json={"email": "alex@example.com", "password": "n3w-secret-pass"}
    )
    assert login.status_code == 200


def test_an_unknown_address_gets_the_same_silent_answer(client, mailbox):
    # 204 без письма: форма не справочник «кто здесь зарегистрирован».
    response = client.post("/api/auth/password/forgot", json={"email": "nobody@example.com"})

    assert response.status_code == 204
    assert mailbox == []


def test_a_repeat_within_the_cooldown_is_silently_swallowed(client, db, user, mailbox):
    assert client.post(
        "/api/auth/password/forgot", json={"email": "alex@example.com"}
    ).status_code == 204
    # Тот же 204, но письма нет: ответ «слишком часто» выдал бы, что адрес
    # зарегистрирован, — незнакомому адресу пауза не отвечает.
    assert client.post(
        "/api/auth/password/forgot", json={"email": "alex@example.com"}
    ).status_code == 204

    assert len(mailbox) == 1

    # Отматываем выдачу назад — как если бы прошла минута.
    record = db.query(PasswordReset).one()
    record.created_at = datetime.now(timezone.utc) - RESEND_COOLDOWN - timedelta(seconds=1)
    db.flush()

    assert client.post(
        "/api/auth/password/forgot", json={"email": "alex@example.com"}
    ).status_code == 204
    assert len(mailbox) == 2


def test_the_form_survives_a_dead_mail_server(client, user, monkeypatch):
    import app.mail as mail_module

    class Broken:
        def deliver(self, letter):
            raise mail_module.MailError("почтовый сервер лежит")

    monkeypatch.setattr(mail_module, "build_transport", lambda settings: Broken())

    response = client.post("/api/auth/password/forgot", json={"email": "alex@example.com"})

    assert response.status_code == 204


def test_too_many_requests_from_one_ip_hit_the_limit(client, mailbox):
    from app.config import get_settings

    limit = get_settings().password_reset_rate_limit_per_ip
    for _ in range(limit):
        assert client.post(
            "/api/auth/password/forgot", json={"email": "nobody@example.com"}
        ).status_code == 204

    response = client.post("/api/auth/password/forgot", json={"email": "nobody@example.com"})

    assert response.status_code == 429
    assert response.json()["detail"] == "too_many_requests"


def test_a_made_up_token_is_a_400_with_a_machine_code(client):
    response = client.post(
        "/api/auth/password/reset", json={"token": "nope", "new_password": "n3w-secret-pass"}
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "invalid_token"


def test_a_short_password_is_rejected_by_validation(client, db, user, mailbox):
    client.post("/api/auth/password/forgot", json={"email": "alex@example.com"})

    response = client.post(
        "/api/auth/password/reset",
        json={"token": _token_of(mailbox[0].body), "new_password": "short"},
    )

    # 422 от pydantic, токен не погашен: человек поправит пароль и отправит
    # форму ещё раз по той же ссылке.
    assert response.status_code == 422
    assert db.query(PasswordReset).count() == 1


def test_deleting_a_user_takes_their_unused_links_along(db, user):
    issue_token(db, user)
    db.delete(user)
    db.flush()

    assert db.query(PasswordReset).count() == 0
