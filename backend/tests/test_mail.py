"""Mail: assembling the text, choosing the transport and the behaviour of each of the three.

Not a single test here opens a socket or goes to the network: smtplib and urlopen are
replaced with stubs that record what they were given. What is checked is not "the
message arrived" (that is the mail server's job) but what our code decides — the
message's language, encrypting the channel before entering a password, the shape of the
request to the API, and the fact that a delivery failure does not rise upward as an
exception.
"""

import json
import logging
import smtplib
from urllib.error import HTTPError, URLError

import pytest

import app.mail as mail
from app.config import Settings
from app.mail.templates import available_locales, dictionary, render
from app.mail.transports import ApiTransport, Letter, LogTransport, MailError, SmtpTransport


def _settings(**env: str) -> Settings:
    return Settings(
        _env_file=None,
        app_secret="test-secret-not-for-production",
        director_email="director@example.com",
        database_url="postgresql+psycopg://u:p@host/db",
        **env,
    )


# ---- The message's text ------------------------------------------------------


def test_letter_comes_in_the_language_of_its_recipient():
    russian = render("verify_email", "ru", {"name": "Алекс", "link": "L", "hours": 24}, to="a@b.c")
    english = render("verify_email", "en", {"name": "Alex", "link": "L", "hours": 24}, to="a@b.c")

    assert "подтвердите" in russian.subject.lower()
    assert "confirm" in english.subject.lower()
    assert "Алекс" in russian.body and "L" in russian.body


def test_an_unknown_language_falls_back_instead_of_sending_an_empty_letter(caplog):
    with caplog.at_level(logging.WARNING):
        letter = render("verify_email", "fr", {"name": "Alex", "link": "L", "hours": 24}, to="a@b.c")

    assert letter.subject == dictionary("az")["verify_email"]["subject"]
    assert "fr" in caplog.text


def test_an_unknown_template_is_an_error_and_not_a_blank_page():
    with pytest.raises(MailError):
        render("welcome_aboard", "az", {}, to="a@b.c")


def test_every_language_has_every_template():
    """Dictionary completeness is checked here rather than by eye: a desync accumulates
    unnoticed and is discovered in an already sent message (§9)."""
    locales = available_locales()
    assert set(locales) >= {"az", "en", "ru"}

    reference = {
        (template, field)
        for template, fields in dictionary("az").items()
        for field in fields
    }
    for locale in locales:
        keys = {
            (template, field)
            for template, fields in dictionary(locale).items()
            for field in fields
        }
        assert keys == reference, f"словарь писем {locale} разошёлся с az"


def test_missing_substitution_data_does_not_reach_the_recipient():
    with pytest.raises(MailError):
        render("verify_email", "en", {"name": "Alex"}, to="a@b.c")


def test_user_content_cannot_smuggle_a_placeholder_into_the_letter():
    # Substitution goes through the template: a "{link}" inside a name stays text.
    letter = render(
        "verify_email", "en", {"name": "{link}", "link": "https://x/y", "hours": 24}, to="a@b.c"
    )
    assert "Hello, {link}!" in letter.body


# ---- Choosing the transport --------------------------------------------------


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        ({}, LogTransport),
        ({"mail_transport": "none"}, LogTransport),
        ({"mail_transport": "log"}, LogTransport),
        (
            {"mail_transport": "smtp", "smtp_url": "smtp://mail.example.com", "mail_from": "a@b.c"},
            SmtpTransport,
        ),
        (
            {
                "mail_transport": "api",
                "mail_api_url": "https://api.example.com/send",
                "mail_api_key": "k",
                "mail_from": "a@b.c",
            },
            ApiTransport,
        ),
    ],
)
def test_transport_follows_the_setting(env: dict, expected: type):
    assert isinstance(mail.build_transport(_settings(**env)), expected)


@pytest.mark.parametrize(
    "env",
    [
        {"mail_transport": "stmp"},  # a typo must not mean "mail is off"
        {"mail_transport": "smtp"},  # with no SMTP_URL and no MAIL_FROM
        {"mail_transport": "smtp", "smtp_url": "smtp://mail.example.com"},  # with no MAIL_FROM
        {"mail_transport": "api", "mail_api_url": "https://x/y", "mail_from": "a@b.c"},  # with no key
    ],
)
def test_a_half_configured_mail_setup_refuses_to_start(env: dict):
    with pytest.raises(ValueError):
        _settings(**env)


def test_disabled_mail_is_a_legitimate_setup():
    settings = _settings()
    assert settings.mail_enabled is False
    assert _settings(
        mail_transport="smtp", smtp_url="smtp://mail.example.com", mail_from="a@b.c"
    ).mail_enabled is True


def test_the_log_transport_still_counts_as_a_mail_installation():
    """`none` and `log` write a message to the same place but differ in whether the
    interface shows the send button: in development it is needed."""
    assert _settings(mail_transport="log").mail_enabled is True


# ---- The stub ----------------------------------------------------------------


def test_the_stub_writes_the_whole_letter_into_the_log(caplog):
    with caplog.at_level(logging.INFO):
        LogTransport(sender="Planora <no-reply@example.com>").deliver(
            Letter(to="alex@example.com", subject="Тема", body="https://example.com/verify?token=x")
        )

    # Without the message's text, an installation with no mail server loses its only
    # way of getting the link.
    assert "https://example.com/verify?token=x" in caplog.text
    assert "alex@example.com" in caplog.text


# ---- SMTP -------------------------------------------------------------------


class FakeSMTP:
    """A stub for smtplib.SMTP: it records what was done with it."""

    instances: list["FakeSMTP"] = []
    advertise_starttls = True

    def __init__(self, host, port, timeout=None):
        self.host, self.port, self.timeout = host, port, timeout
        self.starttls_called = False
        self.login_args = None
        self.messages = []
        FakeSMTP.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def ehlo(self):
        return 250, b"ok"

    def has_extn(self, name):
        return name == "starttls" and self.advertise_starttls

    def starttls(self):
        self.starttls_called = True

    def login(self, user, password):
        self.login_args = (user, password)

    def send_message(self, message):
        self.messages.append(message)


@pytest.fixture
def fake_smtp(monkeypatch):
    FakeSMTP.instances = []
    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)
    monkeypatch.setattr(smtplib, "SMTP_SSL", FakeSMTP)
    return FakeSMTP


def _letter() -> Letter:
    return Letter(to="alex@example.com", subject="Тема", body="Текст")


def test_smtp_url_carries_host_credentials_and_port(fake_smtp):
    SmtpTransport(
        "smtp://user%40example.com:pa%2Fss@mail.example.com:2525", sender="a@b.c"
    ).deliver(_letter())

    smtp = fake_smtp.instances[0]
    assert (smtp.host, smtp.port) == ("mail.example.com", 2525)
    # A password with a slash parses rather than tearing the URL in half.
    assert smtp.login_args == ("user@example.com", "pa/ss")
    assert smtp.starttls_called is True


@pytest.mark.parametrize(
    ("url", "expected_port"),
    [("smtp://mail.example.com", 587), ("smtps://mail.example.com", 465)],
)
def test_the_scheme_decides_the_default_port(fake_smtp, url: str, expected_port: int):
    SmtpTransport(url, sender="a@b.c").deliver(_letter())
    assert fake_smtp.instances[0].port == expected_port


def test_a_password_is_never_sent_over_a_plaintext_connection(fake_smtp, monkeypatch):
    monkeypatch.setattr(fake_smtp, "advertise_starttls", False)

    with pytest.raises(MailError, match="незашифрованному"):
        SmtpTransport("smtp://user:secret@mail.example.com", sender="a@b.c").deliver(_letter())

    assert fake_smtp.instances[-1].login_args is None
    assert fake_smtp.instances[-1].messages == []

    # The same server with no credentials stays usable: a local relay (mailhog, postfix
    # on the same machine) needs no password, and forbidding such a send would be a ban
    # on development without TLS.
    SmtpTransport("smtp://mail.example.com", sender="a@b.c").deliver(_letter())
    assert fake_smtp.instances[-1].messages


def test_a_letter_carries_date_and_a_message_id_from_the_sender_domain(fake_smtp):
    SmtpTransport("smtps://mail.example.com", sender="Planora <no-reply@planora.app>").deliver(
        _letter()
    )

    message = fake_smtp.instances[0].messages[0]
    assert message["Date"]
    # Not the container's hostname: the machine's internal name must not ride out.
    assert message["Message-ID"].endswith("@planora.app>")
    assert message["To"] == "alex@example.com"
    assert message["Subject"] == "Тема"


def test_a_broken_smtp_url_is_reported_as_a_mail_error():
    with pytest.raises(MailError, match="SMTP_URL"):
        SmtpTransport("mail.example.com:587", sender="a@b.c")


def test_a_refusing_smtp_server_becomes_a_mail_error(monkeypatch):
    def refuse(*args, **kwargs):
        raise smtplib.SMTPConnectError(421, "too many connections")

    monkeypatch.setattr(smtplib, "SMTP", refuse)

    with pytest.raises(MailError):
        SmtpTransport("smtp://mail.example.com", sender="a@b.c").deliver(_letter())


# ---- The delivery service's API ----------------------------------------------


class FakeResponse:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_the_api_transport_sends_the_letter_as_json_with_the_key(monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured["url"] = request.full_url
        captured["headers"] = request.headers
        captured["body"] = json.loads(request.data)
        return FakeResponse()

    monkeypatch.setattr("app.mail.transports.urlopen", fake_urlopen)

    ApiTransport(
        url="https://api.example.com/emails", key="secret-key", sender="no-reply@planora.app"
    ).deliver(_letter())

    assert captured["url"] == "https://api.example.com/emails"
    assert captured["headers"]["Authorization"] == "Bearer secret-key"
    assert captured["body"] == {
        "from": "no-reply@planora.app",
        "to": ["alex@example.com"],
        "subject": "Тема",
        "text": "Текст",
    }


def test_an_api_rejection_becomes_a_mail_error_with_the_status(monkeypatch):
    def fake_urlopen(request, timeout=None):
        raise HTTPError(request.full_url, 422, "Unprocessable", {}, None)

    monkeypatch.setattr("app.mail.transports.urlopen", fake_urlopen)

    with pytest.raises(MailError, match="422"):
        ApiTransport(url="https://x/y", key="k", sender="a@b.c").deliver(_letter())


def test_an_unreachable_api_becomes_a_mail_error(monkeypatch):
    def fake_urlopen(request, timeout=None):
        raise URLError("name or service not known")

    monkeypatch.setattr("app.mail.transports.urlopen", fake_urlopen)

    with pytest.raises(MailError):
        ApiTransport(url="https://x/y", key="k", sender="a@b.c").deliver(_letter())


# ---- The shared interface ----------------------------------------------------


def test_send_reports_a_failure_instead_of_raising(monkeypatch, caplog):
    class Broken:
        def deliver(self, letter):
            raise MailError("почтовый сервер лежит")

    monkeypatch.setattr(mail, "build_transport", lambda settings: Broken())

    with caplog.at_level(logging.ERROR):
        delivered = mail.send(
            to="alex@example.com",
            template="verify_email",
            locale="ru",
            params={"name": "Алекс", "link": "L", "hours": 24},
        )

    # The action the message was sent for has already happened — an exception from here
    # would roll it back entirely.
    assert delivered is False
    assert "не ушло" in caplog.text


def test_send_hands_the_rendered_letter_to_the_transport(mailbox):
    assert (
        mail.send(
            to="alex@example.com",
            template="verify_email",
            locale="ru",
            params={"name": "Алекс", "link": "https://x/y", "hours": 24},
        )
        is True
    )

    (letter,) = mailbox
    assert letter.to == "alex@example.com"
    assert "https://x/y" in letter.body


# ---- The invitation message --------------------------------------------------

# Both what the message contains and what must not be in it are checked: it goes to an
# address nobody has confirmed yet, and everything that lands in its text lands with
# who knows whom.

_INVITE = {
    "org": "Acme",
    "inviter": "Мария",
    "link": "https://planora.example.com/invite/abc",
    "expires": "2026-08-18",
}


def _invitation(locale: str = "ru") -> Letter:
    return render(
        "invitation",
        locale,
        {**_INVITE, "role": mail.role_name("editor", locale)},
        to="guest@example.com",
    )


def test_the_invitation_says_who_invites_where_and_until_when():
    letter = _invitation()

    assert letter.to == "guest@example.com"
    assert "Acme" in letter.subject
    assert "Мария" in letter.body
    assert "редактор" in letter.body
    assert "https://planora.example.com/invite/abc" in letter.body
    assert "2026-08-18" in letter.body


def test_the_invitation_speaks_the_language_of_the_organization():
    assert "invites you" in _invitation("en").body
    assert "dəvət edir" in _invitation("az").body
    assert "editor" in _invitation("en").body
    assert "redaktor" in _invitation("az").body


def test_an_unknown_organization_language_falls_back_instead_of_failing():
    """An organization's language is a column in the database; an unknown value that has
    landed in it must not turn an invitation into an exception."""
    assert "https://planora.example.com/invite/abc" in _invitation("kl").body


def test_an_unknown_role_reaches_the_letter_as_it_is():
    """A role is translated through the dictionary, but an unknown one does not lose the
    message: it goes out under its machine name rather than breaking the invitation's delivery."""
    assert mail.role_name("auditor", "ru") == "auditor"
