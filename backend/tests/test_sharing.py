from datetime import datetime, timezone

import pytest

from app.config import get_settings
from app.models import Organization, Project
from app.sharing import (
    SharingDisabled,
    active_link,
    issue_link,
    public_url,
    resolve,
    revoke_link,
    set_comments_enabled,
    sharing_allowed,
)


@pytest.fixture
def org(db):
    org = Organization(name="Acme", slug="acme")
    db.add(org)
    db.flush()
    return org


@pytest.fixture
def project(db, org):
    project = Project(org_id=org.id, name="Redesign 2026", slug="redesign-2026")
    db.add(project)
    db.flush()
    return project


@pytest.fixture(autouse=True)
def default_settings():
    """Настройки собираются заново на каждый тест.

    get_settings кэширован через lru_cache: тест, подменивший рубильник
    публикации, иначе оставил бы своё значение всем следующим.
    """
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_issuing_a_link_publishes_the_project(db, org, project):
    link = issue_link(db, project, org)

    assert link.token
    assert link.revoked_at is None
    assert active_link(db, project) is link


def test_reissuing_kills_the_previous_link(db, org, project):
    first = issue_link(db, project, org)
    second = issue_link(db, project, org)

    assert second.token != first.token
    assert first.revoked_at is not None
    # Инвариант «действующая ссылка одна» держит частичный уникальный индекс;
    # здесь проверяется, что выпуск его не нарушает.
    assert active_link(db, project) is second


def test_a_reissued_link_keeps_the_comment_setting(db, org, project):
    issue_link(db, project, org)
    set_comments_enabled(db, project, False)

    second = issue_link(db, project, org)

    # Выключенные комментарии — сознательное решение владельца. Перевыпуск
    # адреса не повод молча включить их обратно.
    assert second.comments_enabled is False


def test_a_new_link_inherits_the_organization_default(db, org, project):
    org.default_comments_enabled = False
    db.flush()

    assert issue_link(db, project, org).comments_enabled is False


def test_a_revoked_link_no_longer_resolves(db, org, project):
    link = issue_link(db, project, org)
    revoke_link(db, project)

    assert active_link(db, project) is None
    assert resolve(db, org_slug="acme", project_slug="redesign-2026", token=link.token) is None


def test_resolving_needs_the_slugs_and_the_token_to_agree(db, org, project):
    link = issue_link(db, project, org)
    other = Project(org_id=org.id, name="Другой", slug="drugoy")
    db.add(other)
    db.flush()
    issue_link(db, other, org)

    # Действующий токен соседнего проекта не открывает этот: иначе одной
    # ссылки хватало бы, чтобы читать любой проект установки.
    assert resolve(db, org_slug="acme", project_slug="drugoy", token=link.token) is None
    assert resolve(db, org_slug="acme", project_slug="redesign-2026", token="") is None
    assert resolve(db, org_slug="acme", project_slug="redesign-2026", token=link.token) is not None


def test_the_organization_switch_closes_issued_links_too(db, org, project):
    link = issue_link(db, project, org)

    org.public_sharing_enabled = False
    db.flush()

    # Не только выпуск новых: организация, выключившая публикацию, ожидает,
    # что розданные адреса перестали открываться.
    assert resolve(db, org_slug="acme", project_slug="redesign-2026", token=link.token) is None
    with pytest.raises(SharingDisabled):
        issue_link(db, project, org)


def test_the_installation_switch_overrides_the_organization(db, org, project, monkeypatch):
    monkeypatch.setenv("PUBLIC_SHARING_ENABLED", "false")
    get_settings.cache_clear()

    assert org.public_sharing_enabled is True
    assert sharing_allowed(org) is False
    with pytest.raises(SharingDisabled):
        issue_link(db, project, org)


def test_the_public_address_is_built_from_the_configured_domain(db, org, project, monkeypatch):
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://planora.example.com/")
    get_settings.cache_clear()

    link = issue_link(db, project, org)
    url = public_url(org, project, link)

    # Слаги обоих — то, что человек читает в адресе; токен идёт запросом,
    # потому что без него отзыв ссылки не менял бы адрес вовсе.
    assert url == f"https://planora.example.com/p/acme/redesign-2026?s={link.token}"


def test_revoking_an_unpublished_project_is_not_an_error(db, project):
    assert revoke_link(db, project) is None


def test_a_revoked_link_keeps_its_record(db, org, project):
    before = datetime.now(timezone.utc)
    link = issue_link(db, project, org)
    revoke_link(db, project)

    # Запись не удаляется: старый адрес обязан отвечать «ссылка больше не
    # действует», а не «такого проекта нет».
    assert link.revoked_at >= before
