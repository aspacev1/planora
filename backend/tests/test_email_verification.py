"""Address confirmation: issuing a link, redeeming it and resending.

Messages are intercepted by the `mailbox` fixture (tests/conftest.py) — not a single
test opens a socket. What is checked is what our code decides: the link's
single-use nature, its lifetime, the message's language, and the fact that
unreachable mail does not cancel a registration.
"""

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.auth import open_session, register
from app.db import get_db
from app.email_verification import (
    RESEND_COOLDOWN,
    VERIFICATION_TTL,
    VerificationError,
    confirm_email,
    issue_token,
    send_verification,
    sent_recently,
    verification_link,
)
from app.main import app
from app.models import EmailVerification, User


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
    """The token from a link — the same way a person takes it out of an email."""
    return text.partition("token=")[2].split()[0]


# ---- Issuing and redeeming ---------------------------------------------------


def test_the_open_token_is_not_what_lands_in_the_database(db, user):
    raw = issue_token(db, user)

    record = db.query(EmailVerification).filter_by(user_id=user.id).one()
    assert record.token_hash != raw
    assert raw not in record.token_hash


def test_confirming_stamps_the_user_and_burns_the_token(db, user):
    raw = issue_token(db, user)
    assert user.email_verified_at is None

    confirmed = confirm_email(db, raw)

    assert confirmed.user.id == user.id
    assert confirmed.already_verified is False
    assert confirmed.user.email_verified_at is not None
    # The row stayed but is redeemed: there is nothing left to confirm with it.
    record = db.query(EmailVerification).filter_by(user_id=user.id).one()
    assert record.used_at is not None


def test_the_same_link_opened_again_says_the_address_is_already_confirmed(db, user):
    """A link from an email is followed twice — a second visit is not an error."""
    raw = issue_token(db, user)
    stamped = confirm_email(db, raw).user.email_verified_at

    again = confirm_email(db, raw)

    assert again.already_verified is True
    assert again.user.id == user.id
    # The confirmation mark is the same one: the second visit rewrites nothing.
    assert again.user.email_verified_at == stamped


def test_a_burnt_link_stays_good_for_the_answer_even_past_its_expiry(db, user):
    """A redeemed link's expiry date no longer affects anything."""
    raw = issue_token(db, user)
    confirm_email(db, raw)
    record = db.query(EmailVerification).filter_by(user_id=user.id).one()
    record.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    db.flush()

    assert confirm_email(db, raw).already_verified is True


def test_an_unknown_token_is_rejected(db, user):
    with pytest.raises(VerificationError) as exc_info:
        confirm_email(db, "made-up-token")
    assert exc_info.value.code == "invalid_token"


def test_an_expired_link_is_rejected_and_swept_away(db, user):
    raw = issue_token(db, user)
    record = db.query(EmailVerification).filter_by(user_id=user.id).one()
    record.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    db.flush()

    with pytest.raises(VerificationError) as exc_info:
        confirm_email(db, raw)

    assert exc_info.value.code == "token_expired"
    assert db.get(User, user.id).email_verified_at is None
    assert db.query(EmailVerification).filter_by(user_id=user.id).count() == 0


def test_a_new_link_invalidates_the_previous_one(db, user):
    first = issue_token(db, user)
    second = issue_token(db, user)

    with pytest.raises(VerificationError):
        confirm_email(db, first)
    assert confirm_email(db, second).user.email_verified_at is not None


def test_confirming_sweeps_links_that_expired_elsewhere(db, user):
    """A redeemed link has no second reason to visit the table — the cleanup is here."""
    stale = register(db, name="Ким", email="kim@example.com", password="s3cret-pass")
    db.flush()
    issue_token(db, stale)
    db.query(EmailVerification).filter_by(user_id=stale.id).one().expires_at = datetime.now(
        timezone.utc
    ) - timedelta(seconds=1)
    db.flush()

    confirm_email(db, issue_token(db, user))

    assert db.query(EmailVerification).filter_by(user_id=stale.id).count() == 0
    assert db.query(EmailVerification).filter_by(user_id=user.id).count() == 1


def test_the_link_is_built_from_the_public_base_url(db, user):
    raw = issue_token(db, user)
    link = verification_link(raw)

    assert link.startswith("http")
    assert "/verify-email?token=" in link
    assert _token_of(link)


# ---- The message -------------------------------------------------------------


def test_the_letter_goes_out_in_the_language_of_its_recipient(db, user, mailbox):
    user.locale = "ru"
    db.flush()

    assert send_verification(db, user) is True

    (letter,) = mailbox
    assert letter.to == "alex@example.com"
    assert "подтвердите" in letter.subject.lower()
    assert "Alex" in letter.body
    assert str(int(VERIFICATION_TTL.total_seconds() // 3600)) in letter.body

    # The link from the message really works — otherwise checking the message's text
    # would be pointless.
    assert confirm_email(db, _token_of(letter.body)).user.email_verified_at is not None


def test_an_undelivered_letter_still_leaves_a_usable_token(db, user, monkeypatch):
    import app.mail as mail_module

    class Broken:
        def deliver(self, letter):
            raise mail_module.MailError("the mail server is down")

    monkeypatch.setattr(mail_module, "build_transport", lambda settings: Broken())

    assert send_verification(db, user) is False
    # The token is issued: a person can ask for another message once the server is
    # fixed — and the old link will then give way to the new one.
    record = db.query(EmailVerification).filter_by(user_id=user.id).one()
    # An undelivered message starts no pause: there is nothing to wait for.
    assert record.sent_at is None
    assert sent_recently(db, user) is False


def test_a_letter_that_went_out_starts_the_pause(db, user, mailbox):
    assert send_verification(db, user) is True

    assert db.query(EmailVerification).filter_by(user_id=user.id).one().sent_at is not None
    assert sent_recently(db, user) is True


# ---- The routes --------------------------------------------------------------


def test_registration_sends_the_letter_and_leaves_the_address_unconfirmed(client, mailbox):
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
    assert response.json()["email_verified"] is False
    (letter,) = mailbox
    assert letter.to == "alex@example.com"


def test_registration_survives_a_dead_mail_server(client, monkeypatch):
    import app.mail as mail_module

    class Broken:
        def deliver(self, letter):
            raise mail_module.MailError("the mail server is down")

    monkeypatch.setattr(mail_module, "build_transport", lambda settings: Broken())

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


def test_the_link_from_the_letter_confirms_without_a_session(client, mailbox):
    client.post(
        "/api/auth/register",
        json={
            "name": "Alex",
            "email": "alex@example.com",
            "password": "s3cret-pass",
            "company_name": "Acme",
        },
    )
    token = _token_of(mailbox[0].body)
    # The message is opened in the browser the mail arrived in, not necessarily in
    # the one where a session is open.
    client.cookies.clear()

    response = client.post("/api/auth/verify-email", json={"token": token})

    assert response.status_code == 200
    assert response.json() == {"already_verified": False}


def test_opening_the_link_a_second_time_is_not_an_error(client, mailbox):
    """A link from an email is opened twice — the second time is not a refusal."""
    client.post(
        "/api/auth/register",
        json={
            "name": "Alex",
            "email": "alex@example.com",
            "password": "s3cret-pass",
            "company_name": "Acme",
        },
    )
    token = _token_of(mailbox[0].body)
    client.post("/api/auth/verify-email", json={"token": token})

    response = client.post("/api/auth/verify-email", json={"token": token})

    assert response.status_code == 200
    assert response.json() == {"already_verified": True}


def test_me_reports_the_address_as_confirmed_afterwards(client, mailbox):
    client.post(
        "/api/auth/register",
        json={
            "name": "Alex",
            "email": "alex@example.com",
            "password": "s3cret-pass",
            "company_name": "Acme",
        },
    )
    client.post("/api/auth/verify-email", json={"token": _token_of(mailbox[0].body)})

    assert client.get("/api/auth/me").json()["email_verified"] is True


def test_a_made_up_token_is_a_400_with_a_machine_code(client):
    response = client.post("/api/auth/verify-email", json={"token": "nope"})

    assert response.status_code == 400
    assert response.json()["detail"] == "invalid_token"


def test_resend_needs_a_session(client):
    assert client.post("/api/auth/verify-email/resend").status_code == 401


def test_resend_waits_out_the_cooldown(client, db, mailbox):
    client.post(
        "/api/auth/register",
        json={
            "name": "Alex",
            "email": "alex@example.com",
            "password": "s3cret-pass",
            "company_name": "Acme",
        },
    )

    assert client.post("/api/auth/verify-email/resend").status_code == 429

    # We wind the send time back — as if a minute had passed.
    record = db.query(EmailVerification).one()
    record.sent_at = datetime.now(timezone.utc) - RESEND_COOLDOWN - timedelta(seconds=1)
    db.flush()

    response = client.post("/api/auth/verify-email/resend")
    assert response.status_code == 200
    assert response.json() == {"sent": True}
    assert len(mailbox) == 2


def test_a_letter_that_never_went_out_does_not_lock_the_button(client, db, monkeypatch):
    """The pause is counted from the message: there is nothing to wait for over an unsent one."""
    import app.mail as mail_module

    class Broken:
        def deliver(self, letter):
            raise mail_module.MailError("the mail server is down")

    monkeypatch.setattr(mail_module, "build_transport", lambda settings: Broken())

    client.post(
        "/api/auth/register",
        json={
            "name": "Alex",
            "email": "alex@example.com",
            "password": "s3cret-pass",
            "company_name": "Acme",
        },
    )

    # The very first press: a refusal here would mean a minute of waiting for a
    # message nobody sent.
    assert client.post("/api/auth/verify-email/resend").json() == {"sent": False}


def test_resend_says_so_when_the_letter_did_not_go_out(client, db, monkeypatch, mailbox):
    import app.mail as mail_module

    client.post(
        "/api/auth/register",
        json={
            "name": "Alex",
            "email": "alex@example.com",
            "password": "s3cret-pass",
            "company_name": "Acme",
        },
    )
    db.query(EmailVerification).one().sent_at = (
        datetime.now(timezone.utc) - RESEND_COOLDOWN - timedelta(seconds=1)
    )
    db.flush()

    class Broken:
        def deliver(self, letter):
            raise mail_module.MailError("the mail server is down")

    monkeypatch.setattr(mail_module, "build_transport", lambda settings: Broken())

    # "Sent" instead of the truth would mean a person waiting for a message that
    # does not exist.
    assert client.post("/api/auth/verify-email/resend").json() == {"sent": False}


def test_resend_refuses_once_the_address_is_confirmed(client, mailbox):
    client.post(
        "/api/auth/register",
        json={
            "name": "Alex",
            "email": "alex@example.com",
            "password": "s3cret-pass",
            "company_name": "Acme",
        },
    )
    client.post("/api/auth/verify-email", json={"token": _token_of(mailbox[0].body)})

    response = client.post("/api/auth/verify-email/resend")

    assert response.status_code == 409
    assert response.json()["detail"] == "already_verified"


def test_deleting_a_user_takes_their_unused_links_along(db, user):
    issue_token(db, user)
    db.delete(user)
    db.flush()

    assert db.query(EmailVerification).count() == 0


def test_a_session_alone_does_not_confirm_anything(db, user):
    open_session(db, user)
    db.flush()

    assert db.get(User, user.id).email_verified_at is None
