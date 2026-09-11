"""Settings derived from the hosting environment.

Both checks below are about deploying to a platform where the environment variables
come not from `.env` but from a dashboard and from the platform itself. An error in
either does not bring the application down but quietly weakens it: the wrong driver
means a failure only on the first request to the database, the wrong
PUBLIC_BASE_URL means a session cookie without Secure. So they are checked
separately rather than "we will see in production".
"""

import pytest

from app.config import Settings


def _settings(**env: str) -> Settings:
    # _env_file=None: otherwise a developer's .env lying next to it would override
    # what the test sets explicitly, and the check would depend on someone's machine.
    return Settings(
        _env_file=None,
        app_secret="test-secret-not-for-production",
        director_email="director@example.com",
        **env,
    )


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        (
            "postgresql://u:p@host/db",
            "postgresql+psycopg://u:p@host/db",
        ),
        # A Heroku legacy: SQLAlchemy does not parse that scheme at all.
        (
            "postgres://u:p@host/db",
            "postgresql+psycopg://u:p@host/db",
        ),
        # Already carrying a driver — nothing to touch.
        (
            "postgresql+psycopg://u:p@host/db",
            "postgresql+psycopg://u:p@host/db",
        ),
        # Another driver was chosen deliberately and must not be substituted.
        (
            "postgresql+asyncpg://u:p@host/db",
            "postgresql+asyncpg://u:p@host/db",
        ),
    ],
)
def test_database_url_gets_the_driver_it_needs(given: str, expected: str) -> None:
    assert _settings(database_url=given).database_url == expected


def test_the_query_string_of_a_managed_database_survives_the_rewrite() -> None:
    # Neon and Supabase have an sslmode and a pooler channel name in the URL. A
    # concatenation that lost the tail would give a connection without TLS instead of
    # an explicit error.
    settings = _settings(database_url="postgresql://u:p@ep-x-pooler.aws.neon.tech/db?sslmode=require")
    assert settings.database_url.endswith("/db?sslmode=require")
    assert settings.database_url.startswith("postgresql+psycopg://")


def test_public_base_url_comes_from_the_platform_when_nobody_set_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VERCEL_PROJECT_PRODUCTION_URL", "planora.vercel.app")

    settings = _settings(database_url="postgresql+psycopg://u:p@host/db")

    assert settings.public_base_url == "https://planora.vercel.app"


def test_a_deployment_without_a_project_domain_falls_back_to_its_own(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("VERCEL_PROJECT_PRODUCTION_URL", raising=False)
    monkeypatch.setenv("VERCEL_URL", "planora-abc123.vercel.app")

    settings = _settings(database_url="postgresql+psycopg://u:p@host/db")

    assert settings.public_base_url == "https://planora-abc123.vercel.app"


def test_an_explicit_public_base_url_wins_over_the_platform(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A custom domain attached to the project is not shown by the platform in its own
    # variables — guessing over a value that is set would take the address back to
    # vercel.app.
    monkeypatch.setenv("VERCEL_PROJECT_PRODUCTION_URL", "planora.vercel.app")

    settings = _settings(
        database_url="postgresql+psycopg://u:p@host/db",
        public_base_url="https://planora.example.com",
    )

    assert settings.public_base_url == "https://planora.example.com"


def test_outside_the_platform_the_base_url_stays_local(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("VERCEL_PROJECT_PRODUCTION_URL", raising=False)
    monkeypatch.delenv("VERCEL_URL", raising=False)

    settings = _settings(database_url="postgresql+psycopg://u:p@host/db")

    assert settings.public_base_url == "http://localhost:8000"


@pytest.mark.parametrize("mode", ["open", "invite_only", "closed"])
def test_every_signup_mode_from_the_specification_is_accepted(mode: str) -> None:
    settings = _settings(database_url="postgresql+psycopg://u:p@host/db", signup_mode=mode)
    assert settings.signup_mode == mode


@pytest.mark.parametrize(
    ("field", "value"),
    [("signup_mode", "opne"), ("mail_transport", "sendmail")],
)
def test_a_misspelled_switch_stops_the_start_instead_of_the_installation(
    field: str, value: str
) -> None:
    """A typo in SIGNUP_MODE silently turns the installation into a closed one (the
    comparison with `open` does not match), a typo in MAIL_TRANSPORT into one where
    the send button exists but messages do not go out. Both refusals are
    indistinguishable from the intended behaviour and are hunted for hours; a refusal
    to start is found in a second."""
    with pytest.raises(ValueError):
        _settings(database_url="postgresql+psycopg://u:p@host/db", **{field: value})
