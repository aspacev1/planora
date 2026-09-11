"""The language on a person's first appearance — from `Accept-Language`.

The rule of section 9: on first sign-in the language is taken from the header if it
asks for one of the three supported ones; otherwise it is Azerbaijani. After that
only what the person chose themselves.
"""

import pytest
from fastapi.testclient import TestClient

from app.db import get_db
from app.locales import preferred_locale
from app.main import app

SUPPORTED = ["az", "en", "ru"]


@pytest.fixture
def client(db):
    def _override_get_db():
        yield db

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.parametrize(
    "header,expected",
    [
        ("ru", "ru"),
        ("en-US,en;q=0.9", "en"),
        # The region is discarded: the product distinguishes languages, not dialects.
        ("ru-RU", "ru"),
        # The order is decided by the weights, not by the place in the string.
        ("de;q=0.9,ru;q=0.4,en;q=0.8", "en"),
        # On equal weights the one named earlier wins.
        ("en,ru", "en"),
        # Not a single supported one — the default language.
        ("de-DE,fr;q=0.8", "az"),
        ("*", "az"),
        ("", "az"),
        (None, "az"),
        # A malformed weight does not cancel the parsing of the whole header.
        ("ru;q=abc,en", "en"),
    ],
)
def test_preferred_locale(header, expected):
    assert preferred_locale(header, SUPPORTED, "az") == expected


def test_the_case_of_the_tag_does_not_depend_on_the_locale_of_the_process():
    """The Azerbaijani i-trap on language codes.

    Case conversion in the user's locale turns `I` into `ı`, and one and the same
    header would start being parsed differently depending on whose locale happened to
    be active. `casefold` does not depend on the process locale at all.
    """
    assert preferred_locale("RU", SUPPORTED, "az") == "ru"
    assert preferred_locale("EN-GB", SUPPORTED, "az") == "en"
    # A capital I in a language code must not turn into ı and lose "ru".
    assert preferred_locale("IT,ru", SUPPORTED, "az") == "ru"


def test_registration_takes_the_language_from_the_browser(client):
    response = client.post(
        "/api/auth/register",
        json={
            "name": "Alex",
            "email": "alex@example.com",
            "password": "s3cret-pass",
            "company_name": "Acme",
        },
        headers={"Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8"},
    )

    assert response.status_code == 201
    assert response.json()["locale"] == "ru"


def test_registration_falls_back_to_azerbaijani(client):
    response = client.post(
        "/api/auth/register",
        json={
            "name": "Alex",
            "email": "alex@example.com",
            "password": "s3cret-pass",
            "company_name": "Acme",
        },
        headers={"Accept-Language": "fr-FR,de;q=0.8"},
    )

    assert response.json()["locale"] == "az"


def test_the_header_is_never_asked_again(client):
    """The header is read once — on first appearance.

    Otherwise changing the language in the browser would silently overwrite a choice
    the person made by hand.
    """
    client.post(
        "/api/auth/register",
        json={
            "name": "Alex",
            "email": "alex@example.com",
            "password": "s3cret-pass",
            "company_name": "Acme",
        },
        headers={"Accept-Language": "ru"},
    )
    client.patch("/api/auth/me", json={"locale": "az"})

    profile = client.get("/api/auth/me", headers={"Accept-Language": "en"})

    assert profile.json()["locale"] == "az"
