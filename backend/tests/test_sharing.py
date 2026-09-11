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
    """The settings are assembled anew for every test.

    get_settings is cached through lru_cache: a test that substituted the publishing
    switch would otherwise leave its value to every test that follows.
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
    # The invariant "there is one link in force" is held by a partial unique index;
    # what is checked here is that issuing does not violate it.
    assert active_link(db, project) is second


def test_a_reissued_link_keeps_the_comment_setting(db, org, project):
    issue_link(db, project, org)
    set_comments_enabled(db, project, False)

    second = issue_link(db, project, org)

    # Disabled comments are a deliberate decision by the owner. Reissuing the
    # address is no reason to silently turn them back on.
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

    # A valid token of a neighbouring project does not open this one: otherwise one
    # link would be enough to read any project of the installation.
    assert resolve(db, org_slug="acme", project_slug="drugoy", token=link.token) is None
    assert resolve(db, org_slug="acme", project_slug="redesign-2026", token="") is None
    assert resolve(db, org_slug="acme", project_slug="redesign-2026", token=link.token) is not None


def test_the_organization_switch_closes_issued_links_too(db, org, project):
    link = issue_link(db, project, org)

    org.public_sharing_enabled = False
    db.flush()

    # Not only the issuing of new ones: an organization that turned publishing off
    # expects the addresses it distributed to have stopped opening.
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

    # Both slugs are what a person reads in the address; the token goes in the query,
    # because without it revoking a link would not change the address at all.
    assert url == f"https://planora.example.com/p/acme/redesign-2026?s={link.token}"


def test_revoking_an_unpublished_project_is_not_an_error(db, project):
    assert revoke_link(db, project) is None


def test_a_revoked_link_keeps_its_record(db, org, project):
    before = datetime.now(timezone.utc)
    link = issue_link(db, project, org)
    revoke_link(db, project)

    # The row is not deleted: the old address must answer "this link is no longer
    # valid" rather than "there is no such project".
    assert link.revoked_at >= before
