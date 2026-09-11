from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import get_db
from app.main import app


@pytest.fixture
def client(db):
    """The same pattern as in tests/test_project_api.py: get_db returns the `db`
    fixture's session and does not commit, otherwise the outer transaction closes ahead
    of time and the isolation between tests disappears."""

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


@pytest.fixture
def clients(db):
    """A factory of clients over one database session — as in tests/test_invite_api.py.

    Managing membership requires two people: one edits a role, the other is edited.
    Each has a cookie of their own while the database session is shared, otherwise the
    second would not see the first one's organization.
    """

    def _override_get_db():
        yield db

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield lambda: TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def test_current_organization_is_named(authed):
    """The interface's header is signed with the organization's name, and there is
    nowhere else to take it from: the list of members says nothing about the organization itself."""
    response = authed.get("/api/org")
    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "Acme"
    assert body["slug"] == "acme"
    assert body["role"] == "owner"


def test_current_organization_requires_authentication(client):
    assert client.get("/api/org").status_code == 401


def test_a_client_still_knows_which_organization_they_are_in(authed, db):
    """Unlike the list of members, the organization's own name is not hidden from its
    member: they see it in the header on every screen, and the `client` role changes
    nothing here."""
    from app.models import Membership

    user_id = authed.get("/api/auth/me").json()["id"]
    membership = db.scalar(select(Membership).where(Membership.user_id == user_id))
    membership.role = "client"
    db.flush()

    response = authed.get("/api/org")
    assert response.status_code == 200
    assert response.json()["role"] == "client"


def test_members_lists_only_this_organization(authed, db):
    from app.auth import register

    register(db, name="Stranger", email="stranger@example.com", password="s3cret-pass")
    db.flush()

    response = authed.get("/api/org/members")
    assert response.status_code == 200
    emails = [m["email"] for m in response.json()]
    assert "stranger@example.com" not in emails


def test_members_requires_authentication(client):
    assert client.get("/api/org/members").status_code == 401


def test_members_returns_id_name_email_and_role(authed):
    response = authed.get("/api/org/members")
    assert response.status_code == 200
    [me] = response.json()
    assert me["name"] == "Alex"
    assert me["email"] == "alex@example.com"
    assert me["role"] == "owner"
    assert me["id"] == authed.get("/api/auth/me").json()["id"]


def test_a_client_does_not_see_the_organization_roster(authed, db):
    """Per the specification the client role does not see an organization's membership at all.

    Here it is a 403 rather than a 404: the route is not about a particular project, and
    there is nothing to hide about the existence of one's own organization from its own
    member.
    """
    from app.models import Membership

    user_id = authed.get("/api/auth/me").json()["id"]
    membership = db.scalar(select(Membership).where(Membership.user_id == user_id))
    membership.role = "client"
    db.flush()

    assert authed.get("/api/org/members").status_code == 403


# ---- managing membership: roles and removal from an organization -----------


def _register(client, name, email):
    return client.post(
        "/api/auth/register",
        json={"name": name, "email": email, "password": "s3cret-pass", "company_name": name},
    )


@pytest.fixture
def pair(clients, db):
    """The organization's owner and a second person in it. The second one's role is `viewer`.

    The second is created by ordinary registration (with an organization of their own,
    like everyone who comes off the street), while membership in someone else's is added
    as a row: the path through an invitation is checked in tests/test_invite_api.py, and
    repeating it here would mean checking invitations again rather than membership.
    """
    from app.models import Membership as MembershipModel

    owner = clients()
    _register(owner, "Alex", "alex@example.com")
    org_id = owner.get("/api/org").json()["id"]

    other = clients()
    _register(other, "Maria", "maria@example.com")
    other_id = other.get("/api/auth/me").json()["id"]

    db.add(MembershipModel(org_id=org_id, user_id=other_id, role="viewer"))
    db.flush()
    other.post("/api/org/switch", json={"org_id": org_id})
    return owner, other, other_id


def _role_of(client, user_id):
    roster = {member["id"]: member["role"] for member in client.get("/api/org/members").json()}
    return roster.get(user_id)


def test_an_owner_changes_the_role_of_a_member(pair):
    owner, _, other_id = pair

    response = owner.patch(f"/api/org/members/{other_id}", json={"role": "editor"})

    assert response.status_code == 200
    assert response.json()["role"] == "editor"
    assert response.json()["email"] == "maria@example.com"
    assert _role_of(owner, other_id) == "editor"


def test_the_owner_role_is_handed_over_by_this_route_and_not_by_an_invitation(pair):
    """An owner is appointed exactly here — that very "separate action".

    This role is not handed out by an invitation (`role_not_invitable`): a link with no
    address goes to whoever presents it. Here the recipient is named individually.
    """
    owner, other, other_id = pair

    assert owner.patch(f"/api/org/members/{other_id}", json={"role": "owner"}).status_code == 200
    # The permission is checked by deed rather than by the route's answer: the new owner
    # edits the organization's settings, which a `viewer` did not.
    assert other.patch("/api/org", json={"name": "Globex"}).status_code == 200


def test_the_last_owner_is_not_demoted(authed, db):
    """An organization with no owner is locked forever: there is nobody to appoint a new one."""
    user_id = authed.get("/api/auth/me").json()["id"]

    response = authed.patch(f"/api/org/members/{user_id}", json={"role": "editor"})

    assert response.status_code == 409
    assert response.json()["detail"] == "last_owner"
    assert _role_of(authed, user_id) == "owner"


def test_an_owner_steps_down_once_there_is_a_second_one(pair):
    owner, _, other_id = pair
    owner_id = owner.get("/api/auth/me").json()["id"]
    owner.patch(f"/api/org/members/{other_id}", json={"role": "owner"})

    assert owner.patch(f"/api/org/members/{owner_id}", json={"role": "editor"}).status_code == 200


def test_naming_the_role_a_member_already_has_is_not_an_error(authed):
    """An owner "appointed" owner is not an attempt to be left without an owner.

    Otherwise the last-owner protection would fire on a request that changes nothing: the
    interface sends the selected value rather than the difference from the previous one.
    """
    user_id = authed.get("/api/auth/me").json()["id"]

    assert authed.patch(f"/api/org/members/{user_id}", json={"role": "owner"}).status_code == 200


def test_an_unknown_role_is_refused_with_its_own_code(pair):
    owner, _, other_id = pair

    response = owner.patch(f"/api/org/members/{other_id}", json={"role": "superuser"})

    assert response.status_code == 422
    assert response.json()["detail"] == "unknown_role"


def test_a_person_from_another_organization_is_simply_not_found(authed, db):
    """404, not 403: otherwise enumerating addresses names other people's users."""
    from app.auth import register

    stranger = register(db, name="Stranger", email="stranger@example.com", password="s3cret-pass")
    db.flush()

    response = authed.patch(f"/api/org/members/{stranger.id}", json={"role": "editor"})

    assert response.status_code == 404
    assert response.json()["detail"] == "member_not_found"


def test_only_an_owner_changes_roles(pair):
    _, other, other_id = pair

    assert other.patch(f"/api/org/members/{other_id}", json={"role": "editor"}).status_code == 403


def test_an_owner_removes_a_member(pair):
    owner, _, other_id = pair

    assert owner.delete(f"/api/org/members/{other_id}").status_code == 204
    assert _role_of(owner, other_id) is None


def test_a_member_does_not_remove_anyone_but_themselves(pair, clients, db):
    from app.models import Membership as MembershipModel

    owner, other, _ = pair
    owner_id = owner.get("/api/auth/me").json()["id"]
    org_id = owner.get("/api/org").json()["id"]

    third = clients()
    _register(third, "Nadir", "nadir@example.com")
    third_id = third.get("/api/auth/me").json()["id"]
    db.add(MembershipModel(org_id=org_id, user_id=third_id, role="viewer"))
    db.flush()

    assert other.delete(f"/api/org/members/{owner_id}").status_code == 403
    assert other.delete(f"/api/org/members/{third_id}").status_code == 403


def test_anyone_may_leave_on_their_own(pair):
    """Leaving by one's own hand requires no permissions in the organization.

    It is checked on the `client` role: it does not even see the organization's
    membership, and if "leave" required a permission, whoever was once invited would stay
    inside forever.
    """
    owner, other, other_id = pair
    owner.patch(f"/api/org/members/{other_id}", json={"role": "client"})

    assert other.delete(f"/api/org/members/{other_id}").status_code == 204
    assert _role_of(owner, other_id) is None


def test_the_last_owner_does_not_leave_either(authed):
    """The same protection as for a demotion: the last owner cannot leave."""
    user_id = authed.get("/api/auth/me").json()["id"]

    response = authed.delete(f"/api/org/members/{user_id}")

    assert response.status_code == 409
    assert response.json()["detail"] == "last_owner"


def test_leaving_takes_named_project_access_with_it(pair, db):
    """Individually granted access goes away together with the membership.

    Otherwise someone invited back would silently see everything they saw before — access
    nobody granted anew.
    """
    from app.models import ProjectAccess
    from app.projects import create_project

    owner, other, other_id = pair
    org_id = owner.get("/api/org").json()["id"]
    project = create_project(db, org_id=org_id, name="Redesign")
    db.flush()
    db.add(ProjectAccess(project_id=project.id, user_id=other_id))
    db.flush()

    assert other.delete(f"/api/org/members/{other_id}").status_code == 204
    assert db.scalars(
        select(ProjectAccess).where(ProjectAccess.user_id == other_id)
    ).all() == []


def test_leaving_does_not_erase_the_person_from_the_plan(pair, db):
    """Task assignments remain: the plan is not rewritten by a staffing decision.

    An assignment can be cleared from someone who has left later too — by a separate
    action, which for that very reason does not check membership (see UnassignUser in
    app.mutations).
    """
    from app.models import Category, Task, TaskAssignee
    from app.projects import create_project

    owner, other, other_id = pair
    org_id = owner.get("/api/org").json()["id"]
    project = create_project(db, org_id=org_id, name="Redesign")
    db.flush()
    category = Category(project_id=project.id, name="Design", color="#3b82f6", position=0)
    db.add(category)
    db.flush()
    task = Task(
        project_id=project.id,
        category_id=category.id,
        name="Смета",
        start_date=date(2026, 8, 17),
        duration_days=1,
        position=0,
    )
    db.add(task)
    db.flush()
    db.add(TaskAssignee(task_id=task.id, user_id=other_id))
    db.flush()

    other.delete(f"/api/org/members/{other_id}")

    assert db.scalars(select(TaskAssignee).where(TaskAssignee.user_id == other_id)).all() != []


def test_the_organization_left_behind_stops_being_the_active_one(pair, db):
    """A departed person's session stops pointing at somewhere that is no longer theirs.

    This would not turn into a refusal even without the reset — the active membership
    takes the first available one — but a pointer at an organization the person no longer
    belongs to is better removed right away.
    """
    from app.models import Session as SessionModel

    _, other, other_id = pair
    assert db.scalars(
        select(SessionModel.active_org_id).where(SessionModel.user_id == other_id)
    ).all() != [None]

    other.delete(f"/api/org/members/{other_id}")

    assert set(
        db.scalars(select(SessionModel.active_org_id).where(SessionModel.user_id == other_id)).all()
    ) == {None}
    # Their own organization has not gone anywhere — the person returns to it.
    assert other.get("/api/org").json()["name"] == "Maria"


def test_managing_members_requires_authentication(client):
    someone = "00000000-0000-0000-0000-000000000001"
    assert client.patch(f"/api/org/members/{someone}", json={"role": "editor"}).status_code == 401
    assert client.delete(f"/api/org/members/{someone}").status_code == 401
