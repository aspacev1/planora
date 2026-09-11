"""SSRF: the Jira site address is set by a user while the server is what goes
there — the same risk as with the LLM address (see tests/test_wave2_security.py)."""

import pytest

from app.config import get_settings
from app.jira.errors import JiraError
from app.jira.netguard import ensure_public_https


@pytest.fixture
def strict_urls(monkeypatch):
    monkeypatch.setattr(get_settings(), "jira_allow_private_urls", False)


def _resolves_to(monkeypatch, address: str) -> None:
    monkeypatch.setattr(
        "app.jira.netguard.socket.getaddrinfo",
        lambda *args, **kwargs: [(2, 1, 6, "", (address, 443))],
    )


def test_jira_url_must_be_https(strict_urls):
    with pytest.raises(JiraError) as error:
        ensure_public_https("http://team.atlassian.net")
    assert error.value.code == "jira_url_not_https"


def test_jira_url_must_not_resolve_into_private_space(strict_urls, monkeypatch):
    for address in ("10.0.0.5", "127.0.0.1", "169.254.169.254", "192.168.1.1"):
        _resolves_to(monkeypatch, address)
        with pytest.raises(JiraError) as error:
            ensure_public_https("https://team.atlassian.net")
        assert error.value.code == "jira_url_private", address


def test_a_public_jira_url_passes(strict_urls, monkeypatch):
    _resolves_to(monkeypatch, "8.8.8.8")
    ensure_public_https("https://team.atlassian.net")


def test_the_self_hosted_switch_disables_the_guard(monkeypatch):
    monkeypatch.setattr(get_settings(), "jira_allow_private_urls", True)
    ensure_public_https("http://localhost:8081")  # does not raise
