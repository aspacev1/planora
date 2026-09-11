"""Invitations over HTTP: issuing, the link, revoking, accepting and switching organizations.

What is checked here is what is not visible at the domain level: who may invite, which
refusal codes reach the client, that the plain link is returned exactly once, and that
whoever accepts an invitation ends up inside the inviting organization rather than in
their own.
"""

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.config import get_settings
from app.db import get_db
from app.main import app
from app.models import Invitation, Membership

PASSWORD = "s3cret-pass"


@pytest.fixture
def clients(db):
    """A factory of clients over one database session.

    Several clients are needed: one person issues an invitation while another accepts it,
    and each has a cookie of their own. The get_db override is shared — the fixture's
    session is one for the whole test, otherwise the second client would not see an
    invitation created by the first.
    """

    def _override_get_db():
        yield db

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield lambda: TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def _register(client, name, email, **extra):
    # company_name defaults to the same name as the person's: that is how the old rule
    # "the organization is named after its founder" behaved, and for most tests here what
    # matters is not that but the fact of registration itself. When registering through an
    # invitation (**extra carries invite_token) the value still rides out in the request,
    # but the route does not read it — the organization already exists.
    payload = {"name": name, "email": email, "password": PASSWORD, "company_name": name}
    payload.update(extra)
    return client.post("/api/auth/register", json=payload)


@pytest.fixture
def owner(clients):
    client = clients()
    _register(client, "Acme", "owner@example.com")
    return client


def _invite(owner, *, emails=("guest@example.com",), role="viewer", **extra):
    return owner.post(
        "/api/org/invitations",
        json={"emails": list(emails), "role": role, **extra},
    )


def _token(url: str) -> str:
    return url.rsplit("/", 1)[-1]


# ---- issuing --------------------------------------------------------------


def test_the_link_comes_back_once_and_points_at_the_public_base_url(owner):
    response = _invite(owner)
    assert response.status_code == 201
    [issued] = response.json()

    assert issued["email"] == "guest@example.com"
    assert issued["role"] == "viewer"
    assert issued["url"].startswith(f"{get_settings().public_base_url}/invite/")

    # There is nowhere to get the link a second time: the server remembers only the token's hash.
    listed = owner.get("/api/org/invitations").json()["invitations"]
    assert "url" not in listed[0]
    assert "token_hash" not in listed[0]


def test_several_addresses_at_once_produce_several_invitations(owner):
    response = _invite(owner, emails=("one@example.com", "two@example.com"))
    assert [issued["email"] for issued in response.json()] == [
        "one@example.com",
        "two@example.com",
    ]


def test_an_invitation_without_addresses_is_a_link_to_copy(owner):
    [issued] = _invite(owner, emails=()).json()
    assert issued["email"] is None
    assert issued["sent"] is False
    assert issued["url"]


def test_only_an_owner_may_invite(owner, clients, db):
    """The owner may invite: only they have ORG_ADMIN."""
    user_id = owner.get("/api/auth/me").json()["id"]
    membership = db.scalar(select(Membership).where(Membership.user_id == user_id))
    membership.role = "editor"
    db.flush()

    assert _invite(owner).status_code == 403
    assert owner.get("/api/org/invitations").status_code == 403


def test_inviting_without_a_session_is_401(clients):
    assert _invite(clients()).status_code == 401


def test_an_unknown_role_is_422_with_its_own_code(owner):
    response = _invite(owner, role="superuser")
    assert response.status_code == 422
    assert response.json()["detail"] == "unknown_role"


def test_the_owner_role_is_refused_by_the_server_and_not_only_hidden_in_the_form(owner):
    """The form's role list does not show it — but it is not the form that protects.

    A hidden row of a dropdown does not stop the request being sent by hand, and the rule
    lives on the server. The code is its own: the role exists, it is simply not handed out
    this way — it is assigned individually, PATCH /api/org/members.
    """
    response = _invite(owner, role="owner")

    assert response.status_code == 422
    assert response.json()["detail"] == "role_not_invitable"


def test_inviting_someone_who_is_already_inside_answers_409(owner, clients, db):
    """Not a 422: the request's shape is impeccable, there is simply nobody left to invite.

    Such an invitation would change nothing — `accept` does not touch an existing
    membership's role — but would look as if it had been sent.
    """
    from app.models import Membership as MembershipModel

    org_id = owner.get("/api/org").json()["id"]
    guest = clients()
    _register(guest, "Guest", "guest@example.com")
    guest_id = guest.get("/api/auth/me").json()["id"]
    db.add(MembershipModel(org_id=org_id, user_id=guest_id, role="viewer"))
    db.flush()

    response = _invite(owner, emails=("guest@example.com",))

    assert response.status_code == 409
    assert response.json()["detail"] == "already_member"


def test_the_hourly_ceiling_answers_429(owner, monkeypatch):
    monkeypatch.setenv("INVITE_RATE_LIMIT", "1")
    get_settings.cache_clear()
    try:
        assert _invite(owner, emails=("one@example.com",)).status_code == 201
        response = _invite(owner, emails=("two@example.com",))
        assert response.status_code == 429
        assert response.json()["detail"] == "invite_rate_limited"
    finally:
        get_settings.cache_clear()


# ---- the message ----------------------------------------------------------


@pytest.fixture
def mail_on(monkeypatch):
    """An installation with mail configured. The `log` transport sends nothing outward but
    goes down exactly the same road as a real one."""
    monkeypatch.setenv("MAIL_TRANSPORT", "log")
    get_settings.cache_clear()
    try:
        yield
    finally:
        get_settings.cache_clear()


def test_without_a_mail_transport_nothing_is_sent_and_the_link_still_works(owner):
    [issued] = _invite(owner).json()
    assert issued["sent"] is False
    assert issued["mail_error"] is None
    assert owner.get("/api/org/invitations").json()["mail_enabled"] is False


def test_with_a_mail_transport_the_letter_goes_out(owner, mail_on, db):
    [issued] = _invite(owner).json()

    assert issued["sent"] is True
    assert owner.get("/api/org/invitations").json()["mail_enabled"] is True
    assert db.get(Invitation, uuid.UUID(issued["id"])).last_sent_at is not None


def test_asking_not_to_deliver_leaves_the_letter_unsent(owner, mail_on):
    [issued] = _invite(owner, deliver=False).json()
    assert issued["sent"] is False


def test_a_letter_that_did_not_go_out_does_not_undo_the_invitation(owner, mail_on, monkeypatch):
    """An invitation exists whether or not it was delivered by mail: all the interface has
    to say is "the message did not go out, copy the link"."""
    import app.api.invite_routes as routes

    def refuse(**kwargs) -> bool:
        # The transport does not raise a failure upward as an exception: it writes the
        # reason into the log and returns False (see app.mail.send).
        return False

    monkeypatch.setattr(routes, "send_mail", refuse)

    response = _invite(owner)

    assert response.status_code == 201
    [issued] = response.json()
    assert issued["sent"] is False
    assert issued["mail_error"] == "mail_failed"
    assert issued["url"]
    assert len(owner.get("/api/org/invitations").json()["invitations"]) == 1


def test_resending_by_mail_counts_against_the_same_hourly_ceiling(owner, mail_on, monkeypatch):
    monkeypatch.setenv("INVITE_RATE_LIMIT", "1")
    get_settings.cache_clear()
    [issued] = _invite(owner).json()

    response = owner.post(
        f"/api/org/invitations/{issued['id']}/reissue", json={"deliver": True}
    )

    assert response.status_code == 429
    # Issuing a link to copy, meanwhile, does not count: no message goes out with it.
    assert (
        owner.post(
            f"/api/org/invitations/{issued['id']}/reissue", json={"deliver": False}
        ).status_code
        == 200
    )


# ---- accepting ------------------------------------------------------------


def test_the_preview_answers_before_the_guest_has_an_account(owner, clients):
    [issued] = _invite(owner).json()

    response = clients().get(f"/api/invitations/{_token(issued['url'])}")

    assert response.status_code == 200
    body = response.json()
    assert body["org_name"] == "Acme"
    assert body["role"] == "viewer"
    assert body["email"] == "guest@example.com"
    assert body["inviter_name"] == "Acme"


def test_an_unknown_token_is_404(clients):
    assert clients().get("/api/invitations/nothing-like-a-token").status_code == 404


def test_accepting_puts_the_guest_inside_the_inviting_organization(owner, clients):
    [issued] = _invite(owner).json()
    guest = clients()
    _register(guest, "Guest", "guest@example.com")

    response = guest.post(f"/api/invitations/{_token(issued['url'])}/accept")

    assert response.status_code == 200
    assert response.json()["name"] == "Acme"
    assert response.json()["role"] == "viewer"
    # The session switched right away: the person pressed "accept" and ended up inside
    # rather than going to look for the organization in the switcher.
    assert guest.get("/api/org").json()["name"] == "Acme"


def test_accepting_requires_a_session(owner, clients):
    [issued] = _invite(owner).json()
    assert clients().post(f"/api/invitations/{_token(issued['url'])}/accept").status_code == 401


def test_the_same_link_does_not_work_twice(owner, clients):
    [issued] = _invite(owner, emails=()).json()
    token = _token(issued["url"])

    first = clients()
    _register(first, "Guest", "guest@example.com")
    assert first.post(f"/api/invitations/{token}/accept").status_code == 200

    second = clients()
    _register(second, "Other", "other@example.com")
    response = second.post(f"/api/invitations/{token}/accept")
    assert response.status_code == 409
    assert response.json()["detail"] == "invite_accepted"


def test_a_revoked_link_dies_immediately(owner, clients):
    [issued] = _invite(owner).json()
    assert owner.delete(f"/api/org/invitations/{issued['id']}").status_code == 204

    response = clients().get(f"/api/invitations/{_token(issued['url'])}")
    assert response.status_code == 409
    assert response.json()["detail"] == "invite_revoked"


def test_an_invitation_addressed_to_someone_else_says_so_instead_of_letting_them_in(
    owner, clients
):
    [issued] = _invite(owner).json()
    stranger = clients()
    _register(stranger, "Stranger", "stranger@example.com")

    response = stranger.post(f"/api/invitations/{_token(issued['url'])}/accept")

    assert response.status_code == 403
    assert response.json()["detail"] == "invite_wrong_email"


def test_reissuing_replaces_the_link(owner, clients):
    [issued] = _invite(owner).json()
    reissued = owner.post(f"/api/org/invitations/{issued['id']}/reissue", json={}).json()

    assert reissued["url"] != issued["url"]
    assert clients().get(f"/api/invitations/{_token(issued['url'])}").status_code == 404
    assert clients().get(f"/api/invitations/{_token(reissued['url'])}").status_code == 200


def test_an_invitation_of_another_organization_is_not_reachable(owner, clients):
    [issued] = _invite(owner).json()
    stranger = clients()
    _register(stranger, "Globex", "globex@example.com")

    assert stranger.delete(f"/api/org/invitations/{issued['id']}").status_code == 404
    assert (
        stranger.post(f"/api/org/invitations/{issued['id']}/reissue", json={}).status_code == 404
    )


# ---- registration by link -------------------------------------------------


def test_registering_through_an_invitation_joins_that_organization_only(owner, clients, db):
    [issued] = _invite(owner).json()
    guest = clients()

    response = _register(guest, "Guest", "guest@example.com", invite_token=_token(issued["url"]))

    assert response.status_code == 201
    assert guest.get("/api/org").json()["name"] == "Acme"
    # Someone arriving by link does not get an organization of their own: it would be a
    # dummy with them alone inside, and in a closed installation it would additionally make
    # every invitee an owner.
    assert len(guest.get("/api/org/list").json()) == 1


def test_registering_with_a_foreign_invitation_address_is_refused(owner, clients):
    [issued] = _invite(owner).json()

    response = _register(
        clients(), "Stranger", "stranger@example.com", invite_token=_token(issued["url"])
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "invite_wrong_email"


def test_a_closed_installation_refuses_even_a_valid_invitation(owner, clients, monkeypatch):
    [issued] = _invite(owner).json()
    monkeypatch.setenv("SIGNUP_MODE", "closed")
    get_settings.cache_clear()
    try:
        response = _register(
            clients(), "Guest", "guest@example.com", invite_token=_token(issued["url"])
        )
        assert response.status_code == 403
        assert response.json()["detail"] == "signup_disabled"
    finally:
        get_settings.cache_clear()


def test_an_invite_only_installation_lets_the_invited_in_and_no_one_else(owner, clients):
    """Exactly the difference for whose sake SIGNUP_MODE holds three values rather than two."""
    [issued] = _invite(owner).json()

    import os

    os.environ["SIGNUP_MODE"] = "invite_only"
    get_settings.cache_clear()
    try:
        assert _register(clients(), "Nobody", "nobody@example.com").status_code == 403
        assert (
            _register(
                clients(), "Guest", "guest@example.com", invite_token=_token(issued["url"])
            ).status_code
            == 201
        )
    finally:
        os.environ["SIGNUP_MODE"] = "open"
        get_settings.cache_clear()


def test_registering_the_ordinary_way_leaves_the_invitation_alive(owner, clients, db):
    """A person holding an invitation went and registered themselves — nothing breaks: they
    get their own organization while the invitation waits for its link."""
    [issued] = _invite(owner).json()
    guest = clients()
    _register(guest, "Guest", "guest@example.com")

    assert guest.get("/api/org").json()["name"] == "Guest"
    invitation = db.scalar(select(Invitation))
    assert invitation.accepted_at is None

    # And it fires once they do open the link after all.
    assert guest.post(f"/api/invitations/{_token(issued['url'])}/accept").status_code == 200


# ---- the organization switcher --------------------------------------------


def test_the_switcher_lists_every_organization_the_person_belongs_to(owner, clients):
    [issued] = _invite(owner).json()
    guest = clients()
    _register(guest, "Guest", "guest@example.com")
    guest.post(f"/api/invitations/{_token(issued['url'])}/accept")

    listed = guest.get("/api/org/list").json()

    assert {org["name"] for org in listed} == {"Acme", "Guest"}
    assert {org["role"] for org in listed} == {"viewer", "owner"}


def test_switching_changes_which_organization_the_next_request_talks_about(owner, clients):
    [issued] = _invite(owner).json()
    guest = clients()
    _register(guest, "Guest", "guest@example.com")
    guest.post(f"/api/invitations/{_token(issued['url'])}/accept")

    own = next(org for org in guest.get("/api/org/list").json() if org["name"] == "Guest")
    assert guest.post("/api/org/switch", json={"org_id": own["id"]}).status_code == 200

    assert guest.get("/api/org").json()["name"] == "Guest"
    # The choice lives until the end of the session rather than until the end of the page.
    assert guest.get("/api/org").json()["name"] == "Guest"


def test_switching_into_an_organization_one_does_not_belong_to_is_404(owner, clients):
    org_id = owner.get("/api/org").json()["id"]
    stranger = clients()
    _register(stranger, "Stranger", "stranger@example.com")

    response = stranger.post("/api/org/switch", json={"org_id": org_id})

    assert response.status_code == 404
    assert response.json()["detail"] == "organization_not_found"


def test_projects_follow_the_chosen_organization(owner, clients):
    owner.post("/api/projects", json={"name": "Redesign"})
    [issued] = _invite(owner, role="editor").json()
    guest = clients()
    _register(guest, "Guest", "guest@example.com")
    guest.post(f"/api/invitations/{_token(issued['url'])}/accept")

    assert [p["name"] for p in guest.get("/api/projects").json()] == ["Redesign"]

    own = next(org for org in guest.get("/api/org/list").json() if org["name"] == "Guest")
    guest.post("/api/org/switch", json={"org_id": own["id"]})

    assert guest.get("/api/projects").json() == []


# ---- the client role and granted access -----------------------------------


def test_a_client_sees_the_project_they_were_invited_to_and_no_other(owner, clients):
    granted = owner.post("/api/projects", json={"name": "Redesign"}).json()
    hidden = owner.post("/api/projects", json={"name": "Launch"}).json()

    [issued] = _invite(owner, role="client", project_ids=[granted["id"]]).json()
    guest = clients()
    _register(guest, "Guest", "guest@example.com")
    guest.post(f"/api/invitations/{_token(issued['url'])}/accept")

    assert [p["id"] for p in guest.get("/api/projects").json()] == [granted["id"]]
    assert guest.get(f"/api/projects/{granted['id']}").status_code == 200
    # A project they were not invited to is indistinguishable from a nonexistent one for a client.
    assert guest.get(f"/api/projects/{hidden['id']}").status_code == 404


def test_a_client_does_not_see_the_internal_note_of_a_project_they_may_read(owner, clients):
    project = owner.post("/api/projects", json={"name": "Redesign"}).json()
    category_id = owner.post(
        f"/api/projects/{project['id']}/mutations",
        json={"op": {"type": "create_category", "name": "Design", "color": "#3b82f6"}},
    ).json()["op"]["category_id"]
    owner.post(
        f"/api/projects/{project['id']}/mutations",
        json={
            "op": {
                "type": "create_task",
                "category_id": category_id,
                "name": "Logo",
                "start_date": "2026-03-06",
                "duration_days": 3,
                "internal_note": "тайный план",
            }
        },
    )

    [issued] = _invite(owner, role="client", project_ids=[project["id"]]).json()
    guest = clients()
    _register(guest, "Guest", "guest@example.com")
    guest.post(f"/api/invitations/{_token(issued['url'])}/accept")

    state = guest.get(f"/api/projects/{project['id']}").json()
    assert state["tasks"][0]["name"] == "Logo"
    assert "internal_note" not in state["tasks"][0]

    # And it is not in the change journal either: the note rides into op at creation.
    revisions = guest.get(f"/api/projects/{project['id']}/revisions").json()
    assert all("internal_note" not in revision["op"] for revision in revisions)


def test_a_client_does_not_see_risks_and_assumptions_transferred_from_the_proposal(
    owner, clients
):
    """A budget carry-across puts risks and assumptions into a task's internal note — and
    the READ_INTERNAL_NOTE rule hides it from a client everywhere the note occurs: in the
    project's state and in the journal, where create_task carries it."""
    project = owner.post("/api/projects", json={"name": "Redesign"}).json()
    category = owner.post(
        f"/api/projects/{project['id']}/proposal/categories", json={"name": "Design"}
    ).json()
    row = owner.post(
        f"/api/projects/{project['id']}/proposal/categories/{category['id']}/tasks",
        json={"name": "Logo"},
    ).json()
    owner.patch(
        f"/api/projects/{project['id']}/proposal/tasks/{row['id']}",
        json={"effort": 2, "risks": "подрядчик ненадёжен", "assumptions": "доступы дадут к среде"},
    )
    assert owner.post(f"/api/projects/{project['id']}/proposal/push-to-plan").status_code == 201

    [issued] = _invite(owner, role="client", project_ids=[project["id"]]).json()
    guest = clients()
    _register(guest, "Guest", "guest@example.com")
    guest.post(f"/api/invitations/{_token(issued['url'])}/accept")

    state = guest.get(f"/api/projects/{project['id']}").json()
    assert state["tasks"][0]["name"] == "Logo"
    assert "internal_note" not in state["tasks"][0]
    revisions = guest.get(f"/api/projects/{project['id']}/revisions").json()
    assert all("internal_note" not in revision["op"] for revision in revisions)
    assert "подрядчик" not in guest.get(f"/api/projects/{project['id']}").text

    # The owner sees the note in full: the carry-across lost nothing.
    mine = owner.get(f"/api/projects/{project['id']}").json()
    assert "подрядчик ненадёжен" in mine["tasks"][0]["internal_note"]
    assert "доступы дадут к среде" in mine["tasks"][0]["internal_note"]


def test_a_granted_project_is_still_read_only_for_a_client(owner, clients):
    project = owner.post("/api/projects", json={"name": "Redesign"}).json()
    [issued] = _invite(owner, role="client", project_ids=[project["id"]]).json()
    guest = clients()
    _register(guest, "Guest", "guest@example.com")
    guest.post(f"/api/invitations/{_token(issued['url'])}/accept")

    response = guest.post(
        f"/api/projects/{project['id']}/mutations",
        json={"op": {"type": "create_category", "name": "Своя", "color": "#3b82f6"}},
    )

    assert response.status_code == 403


def test_a_client_still_does_not_get_the_organization_roster(owner, clients):
    project = owner.post("/api/projects", json={"name": "Redesign"}).json()
    [issued] = _invite(owner, role="client", project_ids=[project["id"]]).json()
    guest = clients()
    _register(guest, "Guest", "guest@example.com")
    guest.post(f"/api/invitations/{_token(issued['url'])}/accept")

    assert guest.get("/api/org/members").status_code == 403


def test_the_invitation_letter_speaks_the_language_of_the_founder(clients, mail_on, mailbox):
    """An invitation message is in the language of whoever created the organization.

    The message's language comes from `organizations.default_locale`, and that was not set
    at registration at all and stayed at the model's hard default: a Russian-speaking owner
    sent the team invitations in Azerbaijani and had no way of noticing it from the
    interface. It is the end-to-end road that is checked — registration, issuing, the
    message — because both of its halves were sound separately even before, and they
    diverged exactly at the joint.
    """
    owner = clients()
    owner.post(
        "/api/auth/register",
        json={
            "name": "Алексей",
            "email": "founder@example.com",
            "password": PASSWORD,
            "company_name": "Алексей и Ко",
        },
        headers={"Accept-Language": "ru-RU,ru;q=0.9"},
    )
    # The address confirmation message is beside the point: it went out in the person's
    # language even before — only the organization's language diverged.
    mailbox.clear()

    response = _invite(owner, emails=("guest@example.com",))
    assert response.status_code == 201
    assert response.json()[0]["sent"] is True

    (letter,) = mailbox
    assert "приглашает вас в организацию" in letter.body
    assert "dəvət edir" not in letter.body
