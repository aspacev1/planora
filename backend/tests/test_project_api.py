import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import get_db
from app.main import app


@pytest.fixture
def client(db):
    """A TestClient whose get_db is overridden with the `db` fixture's session.

    The override returns exactly the same session and does not commit — otherwise the
    `db` fixture's outer transaction would close ahead of time and the isolation
    between tests would disappear (see tests/conftest.py). The same pattern as in
    tests/test_auth.py.
    """

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


def test_creating_a_project_derives_a_slug_from_the_name(authed):
    response = authed.post("/api/projects", json={"name": "Şəhər Layihəsi"})
    assert response.status_code == 201
    assert response.json()["slug"] == "seher-layihesi"


def test_project_listing_shows_only_own_organization(authed, db):
    """A second organization with a project of its own must exist in the test.

    Without it the assertion would pass just the same even with the organization filter
    removed from the route — that is, it would check nothing.
    """
    from app.models import Organization, Project

    authed.post("/api/projects", json={"name": "Redesign"})

    other_org = Organization(name="Globex", slug="globex")
    db.add(other_org)
    db.flush()
    db.add(Project(org_id=other_org.id, name="Secret", slug="secret"))
    db.flush()

    response = authed.get("/api/projects")
    assert response.status_code == 200
    names = [item["name"] for item in response.json()]
    assert names == ["Redesign"]
    assert "Secret" not in names


def test_mutation_creates_a_task_and_returns_the_computed_end_date(authed):
    project_id = authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]
    category_id = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "create_category", "name": "Design", "color": "#3b82f6"}},
    ).json()["op"]["category_id"]

    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {
                "type": "create_task",
                "category_id": category_id,
                "name": "Logo",
                "start_date": "2026-03-06",
                "duration_days": 3,
            }
        },
    )

    state = authed.get(f"/api/projects/{project_id}").json()
    task = state["tasks"][0]
    assert task["start_date"] == "2026-03-06"
    # Friday plus three working days: Fri, Mon, Tue
    assert task["end_date"] == "2026-03-10"


def test_mutation_requires_authentication(client):
    response = client.post(
        "/api/projects/00000000-0000-0000-0000-000000000000/mutations",
        json={"op": {"type": "create_category", "name": "X", "color": "#000000"}},
    )
    assert response.status_code == 401


def test_mutation_on_a_foreign_project_returns_404(authed, db):
    from app.models import Organization, Project

    other_org = Organization(name="Other", slug="other")
    db.add(other_org)
    db.flush()
    foreign = Project(org_id=other_org.id, name="Secret", slug="secret")
    db.add(foreign)
    db.flush()

    response = authed.post(
        f"/api/projects/{foreign.id}/mutations",
        json={"op": {"type": "create_category", "name": "X", "color": "#000000"}},
    )
    assert response.status_code == 404


def test_get_project_on_a_foreign_project_returns_404(authed, db):
    # The same _load_project handler as in mutations, but here it is a separate route
    # (GET), and until now this branch had not been checked for it.
    from app.models import Organization, Project

    other_org = Organization(name="Other", slug="other")
    db.add(other_org)
    db.flush()
    foreign = Project(org_id=other_org.id, name="Secret", slug="secret")
    db.add(foreign)
    db.flush()

    response = authed.get(f"/api/projects/{foreign.id}")
    assert response.status_code == 404


def _demote_own_membership(authed, db, role: str) -> None:
    """Changes a registered user's role directly in the membership row, bypassing
    registration (there the role is always owner)."""
    from app.models import Membership

    user_id = authed.get("/api/auth/me").json()["id"]
    membership = db.scalar(select(Membership).where(Membership.user_id == user_id))
    membership.role = role
    db.flush()


def _grant_project_access(authed, db, project_id: str) -> None:
    """Invites a registered user into a project — the same way an invitation with the
    client role will once it exists."""
    from app.models import ProjectAccess

    user_id = authed.get("/api/auth/me").json()["id"]
    db.add(ProjectAccess(project_id=uuid.UUID(project_id), user_id=uuid.UUID(user_id)))
    db.flush()


def _scope_own_membership(authed, db) -> None:
    """Narrows a registered user's membership — the same way an invitation with selected
    projects will for a role other than client."""
    from app.models import Membership

    user_id = authed.get("/api/auth/me").json()["id"]
    membership = db.scalar(select(Membership).where(Membership.user_id == user_id))
    membership.project_scoped = True
    db.flush()


def test_client_without_a_grant_does_not_see_the_project(authed, db):
    # access._MATRIX: client is in _NEEDS_GRANT and without granted access to a project
    # does not even have PROJECT_READ — the reading routes must ask can() about that
    # rather than letting in any member of the organization.
    project_id = authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]

    _demote_own_membership(authed, db, "client")

    # someone else's project is indistinguishable from a nonexistent one — the same
    # principle applies to "the project exists but the role may not read it": 404, not 403.
    assert authed.get(f"/api/projects/{project_id}").status_code == 404
    # It is not in the list either, and that is not a refusal: the client was invited into
    # the organization, they simply have not been invited into any project yet.
    assert authed.get("/api/projects").json() == []


def test_client_sees_only_the_projects_he_was_invited_to(authed, db):
    invited = authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]
    other = authed.post("/api/projects", json={"name": "Внутренний"}).json()["id"]

    _demote_own_membership(authed, db, "client")
    _grant_project_access(authed, db, invited)

    listed = [project["id"] for project in authed.get("/api/projects").json()]
    assert listed == [invited]
    assert authed.get(f"/api/projects/{invited}").status_code == 200
    assert authed.get(f"/api/projects/{other}").status_code == 404


def test_client_with_a_grant_reads_the_project_without_the_internal_note(authed, db):
    # The role the note is hidden for: a client with granted access reads the whole project
    # — except one field. There is no can() substitution here anymore: the grant on the
    # project genuinely exists, and the gap of "reads it but does not see the note" is
    # reproduced exactly as it looks in production.
    project_id = authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]
    category_id = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "create_category", "name": "Design", "color": "#3b82f6"}},
    ).json()["op"]["category_id"]
    authed.post(
        f"/api/projects/{project_id}/mutations",
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

    _demote_own_membership(authed, db, "client")
    _grant_project_access(authed, db, project_id)

    state = authed.get(f"/api/projects/{project_id}").json()
    assert state["tasks"][0]["name"] == "Logo"
    assert "internal_note" not in state["tasks"][0]

    # And in the journal as well: the creation entry carries the note alongside the other
    # fields, and the task card's feed is a second door to the same field.
    revisions = authed.get(f"/api/projects/{project_id}/revisions").json()
    assert all("internal_note" not in revision["op"] for revision in revisions)


def test_a_scoped_editor_sees_only_the_granted_project(authed, db):
    """Narrowing (Membership.project_scoped) works for an editor the same way _NEEDS_GRANT
    works for a client — only without changing the role."""
    granted = authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]
    other = authed.post("/api/projects", json={"name": "Внутренний"}).json()["id"]

    _demote_own_membership(authed, db, "editor")
    _scope_own_membership(authed, db)
    _grant_project_access(authed, db, granted)

    listed = [project["id"] for project in authed.get("/api/projects").json()]
    assert listed == [granted]
    assert authed.get(f"/api/projects/{granted}").status_code == 200
    assert authed.get(f"/api/projects/{other}").status_code == 404


def test_a_scoped_editor_without_any_grant_sees_no_projects(authed, db):
    authed.post("/api/projects", json={"name": "Redesign"})

    _demote_own_membership(authed, db, "editor")
    _scope_own_membership(authed, db)

    assert authed.get("/api/projects").json() == []


def test_an_unscoped_editor_still_sees_the_whole_organization(authed, db):
    # The control case: narrowing is not a side effect of the editor role itself, it is
    # switched on only by an explicit project_scoped=True on the membership row.
    granted = authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]
    other = authed.post("/api/projects", json={"name": "Внутренний"}).json()["id"]

    _demote_own_membership(authed, db, "editor")

    listed = {project["id"] for project in authed.get("/api/projects").json()}
    assert listed == {granted, other}


def test_a_scoped_editor_cannot_create_a_new_project_to_escape_the_scope(authed, db):
    # A new project cannot carry pre-granted access — one can only create it and silently
    # be left without it oneself. A refusal here is the right answer: it does not let a
    # narrowed role bypass the list by "creating one more".
    _demote_own_membership(authed, db, "editor")
    _scope_own_membership(authed, db)

    response = authed.post("/api/projects", json={"name": "Побег"})

    assert response.status_code == 403


def test_role_without_read_internal_note_permission_does_not_see_it_in_mutation_response(
    authed, monkeypatch
):
    # create_task puts internal_note into its op, while its inverse operation is a bare
    # delete_task with no note; delete_task is the opposite — the operation itself has no
    # note, but its inverse operation (the undo snapshot) carries a full copy of the task
    # together with internal_note. We check both fields on a pair of requests that actually
    # fill them.
    #
    # can() is substituted inside access: the decision about the note's visibility lives
    # there, and the route merely calls access.visible_op.
    import app.access as access

    project_id = authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]
    category_id = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "create_category", "name": "Design", "color": "#3b82f6"}},
    ).json()["op"]["category_id"]

    real_can = access.can

    def fake_can(role, action, *, project_granted=False):
        from app.access import Action

        if action is Action.READ_INTERNAL_NOTE:
            return False
        return real_can(role, action, project_granted=project_granted)

    monkeypatch.setattr(access, "can", fake_can)

    create_response = authed.post(
        f"/api/projects/{project_id}/mutations",
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
    created = create_response.json()
    assert "internal_note" not in created["op"]
    task_id = created["op"]["task_id"]

    delete_response = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "delete_task", "task_id": task_id}},
    )
    deleted = delete_response.json()
    assert "internal_note" not in deleted["inverse"]


def _project_with_task(authed) -> tuple[str, str, str]:
    project_id = authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]
    category_id = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "create_category", "name": "Design", "color": "#3b82f6"}},
    ).json()["op"]["category_id"]
    task_id = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {
                "type": "create_task",
                "category_id": category_id,
                "name": "Logo",
                "start_date": "2026-03-06",
                "duration_days": 3,
            }
        },
    ).json()["op"]["task_id"]
    return project_id, category_id, task_id


def test_naming_a_task_of_another_project_is_reported_as_not_found(authed):
    # The route used to flatten both classes of refusal into a 422 with Russian prose:
    # reaching for a task of another organization looked like a validation error.
    own_project_id, _, _ = _project_with_task(authed)
    other_project_id, _, foreign_task_id = _project_with_task(authed)
    assert other_project_id != own_project_id

    response = authed.post(
        f"/api/projects/{own_project_id}/mutations",
        json={"op": {"type": "move_task", "task_id": foreign_task_id,
                     "start_date": "2026-03-11"}},
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "task_not_found"


def test_a_refused_operation_answers_with_a_stable_machine_code(authed):
    project_id, category_id, _ = _project_with_task(authed)

    # A domain refusal rather than a request-shape one: the wire accepts a shift of zero
    # days — it is rejected by the rule "a history entry must mean something".
    response = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "move_category", "category_id": category_id, "days": 0}},
    )
    assert response.status_code == 422
    # A code rather than translatable prose: message texts are composed by the client.
    assert response.json()["detail"] == "empty_shift"


def test_deleting_a_category_takes_its_tasks_and_is_undone_in_one_step(authed):
    """A category goes away together with its stage — and comes back with it.

    The route used to answer `category_not_empty` to this, and removing a stage meant
    deleting each of its tasks in turn: as many history entries and as many presses of
    "Undo" as it has rows.
    """
    project_id, category_id, task_id = _project_with_task(authed)

    deleted = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "delete_category", "category_id": category_id}},
    )
    assert deleted.status_code == 201
    assert deleted.json()["op"]["tasks"] == 1

    state = authed.get(f"/api/projects/{project_id}").json()
    assert state["categories"] == []
    assert state["tasks"] == []

    undone = authed.post(f"/api/projects/{project_id}/undo", json={})
    assert undone.status_code == 201

    state = authed.get(f"/api/projects/{project_id}").json()
    assert [category["id"] for category in state["categories"]] == [category_id]
    assert [task["id"] for task in state["tasks"]] == [task_id]


def test_an_over_long_name_is_refused_before_it_reaches_the_column(authed):
    # tasks.name is varchar(300): without a bound in the schema a longer string reached the
    # database and came back as a 500 on a truncation error.
    project_id, category_id, _ = _project_with_task(authed)

    response = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {
                "type": "create_task",
                "category_id": category_id,
                "name": "L" * 301,
                "start_date": "2026-03-06",
                "duration_days": 3,
            }
        },
    )
    assert response.status_code == 422


def test_an_unknown_criticality_is_refused(authed):
    project_id, category_id, _ = _project_with_task(authed)

    response = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {
                "type": "create_task",
                "category_id": category_id,
                "name": "Logo",
                "start_date": "2026-03-06",
                "duration_days": 3,
                "criticality": "апокалиптическая",
            }
        },
    )
    assert response.status_code == 422


def test_the_task_status_travels_with_the_project_state(authed):
    project_id, _, task_id = _project_with_task(authed)

    assert _state_task(authed, project_id)["status"] == "planned"

    response = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "set_status", "task_id": task_id, "status": "blocked"}},
    )
    assert response.status_code == 201

    assert _state_task(authed, project_id)["status"] == "blocked"


def _state_task(authed, project_id):
    return authed.get(f"/api/projects/{project_id}").json()["tasks"][0]


def test_an_unknown_status_is_refused_at_the_wire(authed):
    project_id, _, task_id = _project_with_task(authed)

    response = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "set_status", "task_id": task_id, "status": "paused"}},
    )
    assert response.status_code == 422


@pytest.mark.parametrize("progress", [-1, 101])
def test_progress_outside_the_percentage_range_is_refused(authed, progress):
    project_id, category_id, _ = _project_with_task(authed)

    response = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {
                "type": "create_task",
                "category_id": category_id,
                "name": "Logo",
                "start_date": "2026-03-06",
                "duration_days": 3,
                "progress_pct": progress,
            }
        },
    )
    assert response.status_code == 422


def test_a_client_supplied_task_id_never_reaches_the_database(authed, db):
    # task_id exists for the sake of undoing a deletion: it restores a row under its
    # previous identifier. It must not be accepted over the wire — the assignment of
    # identifiers stops being the server's business, and a collision with an existing id
    # turns into an IntegrityError and a 500.
    from app.models import Task

    project_id, category_id, _ = _project_with_task(authed)
    chosen = "11111111-1111-1111-1111-111111111111"

    response = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {
                "type": "create_task",
                "category_id": category_id,
                "name": "Logo",
                "start_date": "2026-03-06",
                "duration_days": 3,
                "task_id": chosen,
            }
        },
    )
    assert response.status_code == 422
    assert db.get(Task, chosen) is None


def test_a_client_supplied_position_never_reaches_the_database(authed, db):
    from app.models import Task

    project_id, category_id, _ = _project_with_task(authed)

    response = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {
                "type": "create_task",
                "category_id": category_id,
                "name": "Logo",
                "start_date": "2026-03-06",
                "duration_days": 3,
                "position": -5,
            }
        },
    )
    assert response.status_code == 422
    assert db.scalar(select(Task).where(Task.position == -5)) is None


def test_project_slug_collision_at_insert_time_retries_instead_of_failing(authed, monkeypatch):
    """The same race test as for an organization's slug — now for a project too.

    The route used to do a check-and-insert with no IntegrityError handling: two
    simultaneous creations with the same name in one organization gave a 500. We simulate
    a stale check: the first candidate is an already taken slug, and the insert must fail
    and be retried with a new suffix.
    """
    import app.slugs as slugs

    authed.post("/api/projects", json={"name": "Redesign"})

    original = slugs._candidate
    calls = {"n": 0}

    def flaky(name, *, forced, is_taken, fallback):
        calls["n"] += 1
        if calls["n"] == 1:
            return "redesign"  # already taken — the insert will fail on the unique index
        return original(name, forced=True, is_taken=is_taken, fallback=fallback)

    monkeypatch.setattr(slugs, "_candidate", flaky)

    response = authed.post("/api/projects", json={"name": "Redesign"})
    assert response.status_code == 201
    assert response.json()["slug"] != "redesign"
    assert calls["n"] >= 2


def test_two_projects_with_the_same_name_get_distinct_slugs(authed):
    first = authed.post("/api/projects", json={"name": "Redesign"}).json()
    second = authed.post("/api/projects", json={"name": "Redesign"}).json()
    assert first["slug"] == "redesign"
    assert second["slug"].startswith("redesign-")


def test_project_state_carries_assignees_dependencies_and_calendar(authed, db):
    project_id = authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]
    category_id = authed.post(f"/api/projects/{project_id}/mutations", json={"op": {
        "type": "create_category", "name": "Design", "color": "#3b82f6"}}).json()["op"]["category_id"]
    first = authed.post(f"/api/projects/{project_id}/mutations", json={"op": {
        "type": "create_task", "category_id": category_id, "name": "A",
        "start_date": "2026-03-04", "duration_days": 2}}).json()["op"]["task_id"]
    second = authed.post(f"/api/projects/{project_id}/mutations", json={"op": {
        "type": "create_task", "category_id": category_id, "name": "B",
        "start_date": "2026-03-10", "duration_days": 2}}).json()["op"]["task_id"]
    authed.post(f"/api/projects/{project_id}/mutations", json={"op": {
        "type": "add_dependency", "from_task_id": first, "to_task_id": second}})

    me = authed.get("/api/auth/me").json()
    authed.post(f"/api/projects/{project_id}/mutations", json={"op": {
        "type": "assign_user", "task_id": first, "user_id": me["id"]}})

    state = authed.get(f"/api/projects/{project_id}").json()

    assert state["dependencies"] == [{"from_task_id": first, "to_task_id": second}]
    task = next(t for t in state["tasks"] if t["id"] == first)
    assert task["assignee_ids"] == [me["id"]]
    assert state["calendar"]["working_days"] == 31        # Mon-Fri
    assert state["calendar"]["holidays"] == []
    assert state["settings"]["shift_threshold_days"] == 2


def test_project_state_reports_the_deadline_and_project_end(authed):
    project_id = authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]
    state = authed.get(f"/api/projects/{project_id}").json()
    assert state["deadline"] is None
    assert state["project_end"] is None


def test_project_end_is_the_latest_task_end(authed):
    project_id, category_id, _ = _project_with_task(authed)  # 2026-03-06 + 3 → 2026-03-10
    authed.post(f"/api/projects/{project_id}/mutations", json={"op": {
        "type": "create_task", "category_id": category_id, "name": "Later",
        "start_date": "2026-03-16", "duration_days": 2}})

    state = authed.get(f"/api/projects/{project_id}").json()
    # Mon 16 + 2 working days = Tue 17 — later than 10 March on the first task
    assert state["project_end"] == "2026-03-17"


def test_a_task_with_no_assignees_reports_an_empty_list(authed):
    project_id, _, task_id = _project_with_task(authed)
    state = authed.get(f"/api/projects/{project_id}").json()
    assert next(t for t in state["tasks"] if t["id"] == task_id)["assignee_ids"] == []


def test_the_calendar_reports_the_project_exceptions(authed, db):
    """The project's exceptions are visible to the interface before the first click.

    It fills non-working days on the scale and draws the weekends — without this block it
    would have to guess at them from the week mask.
    """
    import uuid as uuid_module

    from app.models import Project

    project_id, _, _ = _project_with_task(authed)
    project = db.get(Project, uuid_module.UUID(project_id))
    # Exceptions belong to calendar mode: a relative axis has no real dates, and the
    # calendar there is a single weekly mask.
    project.schedule_mode = "calendar"
    project.holidays_extra = ["2026-03-09"]
    project.workdays_extra = ["2026-03-07"]
    db.flush()

    calendar = authed.get(f"/api/projects/{project_id}").json()["calendar"]
    assert calendar["holidays"] == ["2026-03-09"]
    assert calendar["extra_workdays"] == ["2026-03-07"]


def test_reading_a_project_with_no_working_days_explains_itself(authed, db):
    """The setting comes from a person — which means a person can bring reading down.

    A degenerate mask used to raise a bare ValueError from end_date and answer with a 500:
    the project stopped being readable with no explanation.
    """
    import uuid

    from app.models import Project

    project_id = authed.post("/api/projects", json={"name": "Broken"}).json()["id"]
    category_id = authed.post(f"/api/projects/{project_id}/mutations", json={"op": {
        "type": "create_category", "name": "Design", "color": "#3b82f6"}}).json()["op"]["category_id"]
    authed.post(f"/api/projects/{project_id}/mutations", json={"op": {
        "type": "create_task", "category_id": category_id, "name": "A",
        "start_date": "2026-03-04", "duration_days": 2}})

    project = db.get(Project, uuid.UUID(project_id))
    project.working_days = 0
    db.flush()

    response = authed.get(f"/api/projects/{project_id}")
    assert response.status_code == 422
    assert response.json()["detail"] == "calendar_has_no_working_days"


def test_a_calendar_too_short_for_the_duration_is_also_explained(authed, db):
    """The calendar's second point of refusal answers the same way — with a code, not a 500."""
    import uuid

    from app.models import Project

    project_id = authed.post("/api/projects", json={"name": "Narrow"}).json()["id"]
    category_id = authed.post(f"/api/projects/{project_id}/mutations", json={"op": {
        "type": "create_category", "name": "Design", "color": "#3b82f6"}}).json()["op"]["category_id"]
    authed.post(f"/api/projects/{project_id}/mutations", json={"op": {
        "type": "create_task", "category_id": category_id, "name": "A",
        "start_date": "2026-03-06", "duration_days": 2}})

    project = db.get(Project, uuid.UUID(project_id))
    # Calendar mode: declared working days are a property of real dates, and a relative
    # axis does not see them.
    project.schedule_mode = "calendar"
    # The only working day in the whole calendar is the one the task starts on; by the
    # duration's second day there are no working days left.
    project.working_days = 0
    project.workdays_extra = ["2026-03-06"]
    db.flush()

    response = authed.get(f"/api/projects/{project_id}")
    assert response.status_code == 422
    assert response.json()["detail"] == "calendar_too_few_working_days"


def test_set_task_fields_does_not_leak_the_note_to_a_role_that_cannot_read_it(
    authed, monkeypatch
):
    """The note is hidden when it lies in a nested dict too.

    set_task_fields is the first operation to put internal_note not at the entry's root but
    inside from/to. The check "is there such a key at the top level" silently fails on it,
    and the note rides out in the answer.
    """
    import app.access as access

    project_id, _, task_id = _project_with_task(authed)

    real_can = access.can

    def fake_can(role, action, *, project_granted=False):
        from app.access import Action

        if action is Action.READ_INTERNAL_NOTE:
            return False
        return real_can(role, action, project_granted=project_granted)

    monkeypatch.setattr(access, "can", fake_can)

    response = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {
            "type": "set_task_fields", "task_id": task_id, "name": "Logo redesign",
            "description": "Mark and wordmark", "internal_note": "тайный план"}},
    ).json()

    assert "internal_note" not in response["op"]["to"]
    assert "internal_note" not in response["op"]["from"]
    assert "internal_note" not in response["inverse"]["to"]


def test_revision_log_reads_newest_first_and_names_the_author(authed):
    project_id, _, task_id = _project_with_task(authed)
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "move_task", "task_id": task_id, "start_date": "2026-03-11"},
              "reason": "заказчик передвинул показ"},
    )

    response = authed.get(f"/api/projects/{project_id}/revisions")
    assert response.status_code == 200

    entries = response.json()
    # Newest first: the feed is read from the last event rather than paged towards it.
    assert [entry["op"]["type"] for entry in entries] == [
        "move_task", "create_task", "create_category",
    ]
    assert entries[0]["reason"] == "заказчик передвинул показ"
    assert entries[0]["actor"]["name"] == "Alex"
    assert entries[0]["op"]["from"] == "2026-03-06"
    assert entries[0]["op"]["to"] == "2026-03-11"


def test_revision_log_filtered_by_task_leaves_out_everything_else(authed):
    project_id, category_id, task_id = _project_with_task(authed)
    other_task_id = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "create_task", "category_id": category_id, "name": "Guide",
                     "start_date": "2026-03-06", "duration_days": 2}},
    ).json()["op"]["task_id"]
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "move_task", "task_id": other_task_id,
                     "start_date": "2026-03-11"}},
    )

    entries = authed.get(
        f"/api/projects/{project_id}/revisions", params={"task_id": task_id}
    ).json()

    # Neither the creation of a category nor another task: a card shows the history of its
    # own task rather than of the whole project.
    assert [entry["op"]["type"] for entry in entries] == ["create_task"]
    assert entries[0]["op"]["task_id"] == task_id


def test_revision_log_names_the_entities_it_mentions(authed):
    project_id, category_id, task_id = _project_with_task(authed)
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "move_task", "task_id": task_id, "start_date": "2026-03-11"}},
    )

    entries = authed.get(f"/api/projects/{project_id}/revisions").json()

    # A whole project's feed must name whose start this is: the name comes from the
    # identifier in the operation rather than from a separate request by the client.
    move = next(e for e in entries if e["op"]["type"] == "move_task")
    assert move["names"] == {task_id: "Logo"}
    creation = next(e for e in entries if e["op"]["type"] == "create_task")
    assert creation["names"][task_id] == "Logo"
    assert creation["names"][category_id] == "Design"


def test_revision_log_keeps_naming_a_deleted_task(authed):
    project_id, _, task_id = _project_with_task(authed)
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "delete_task", "task_id": task_id}},
    )

    entries = authed.get(f"/api/projects/{project_id}/revisions").json()

    # The task's row is gone, but the journal is the only place where the name outlived the
    # deletion: it is taken from the restore snapshot.
    deletion = next(e for e in entries if e["op"]["type"] == "delete_task")
    assert deletion["names"][task_id] == "Logo"


def test_revision_log_filters_by_actor_and_type(authed):
    project_id, _, task_id = _project_with_task(authed)
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "move_task", "task_id": task_id, "start_date": "2026-03-11"}},
    )

    by_type = authed.get(
        f"/api/projects/{project_id}/revisions", params={"types": ["move_task"]}
    ).json()
    assert [entry["op"]["type"] for entry in by_type] == ["move_task"]

    me = authed.get("/api/auth/me").json()["id"]
    by_actor = authed.get(
        f"/api/projects/{project_id}/revisions", params={"actor_id": me}
    ).json()
    assert len(by_actor) == 3

    nobody = authed.get(
        f"/api/projects/{project_id}/revisions",
        params={"actor_id": "00000000-0000-0000-0000-000000000000"},
    ).json()
    assert nobody == []


def test_revision_log_marks_undo_records(authed):
    project_id, _, task_id = _project_with_task(authed)
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "move_task", "task_id": task_id, "start_date": "2026-03-11"}},
    )
    undone_seq = authed.post(f"/api/projects/{project_id}/undo").json()["undone_seq"]

    entries = authed.get(f"/api/projects/{project_id}/revisions").json()

    # An undo entry carries the number of the revision it undid: by that pair the feed marks
    # things "undone" without asking the server a second time.
    undo_entry = entries[0]
    assert undo_entry["undoes_seq"] == undone_seq
    ordinary = entries[1]
    assert ordinary["seq"] == undone_seq
    assert ordinary["undoes_seq"] is None
    assert all(entry["batch_id"] is None for entry in entries)


def test_revision_log_does_not_leak_the_note_to_a_role_that_cannot_read_it(
    authed, monkeypatch
):
    import app.access as access

    project_id, category_id, _ = _project_with_task(authed)
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "create_task", "category_id": category_id, "name": "Guide",
                     "start_date": "2026-03-06", "duration_days": 2,
                     "internal_note": "тайный план"}},
    )

    real_can = access.can

    def fake_can(role, action, *, project_granted=False):
        from app.access import Action

        if action is Action.READ_INTERNAL_NOTE:
            return False
        return real_can(role, action, project_granted=project_granted)

    monkeypatch.setattr(access, "can", fake_can)

    entries = authed.get(f"/api/projects/{project_id}/revisions").json()
    assert all("internal_note" not in entry["op"] for entry in entries)


def test_revision_log_of_a_foreign_project_is_not_found(authed, db):
    from app.models import Organization, Project

    other_org = Organization(name="Other", slug="other")
    db.add(other_org)
    db.flush()
    foreign = Project(org_id=other_org.id, name="Theirs", slug="theirs")
    db.add(foreign)
    db.flush()

    response = authed.get(f"/api/projects/{foreign.id}/revisions")
    assert response.status_code == 404
    assert response.json()["detail"] == "project_not_found"


def test_owner_deletes_a_project_with_everything_inside(authed):
    project_id = authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]
    category_id = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "create_category", "name": "Design", "color": "#3b82f6"}},
    ).json()["op"]["category_id"]
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {
                "type": "create_task",
                "category_id": category_id,
                "name": "Logo",
                "start_date": "2026-03-02",
                "duration_days": 3,
            }
        },
    )

    assert authed.delete(f"/api/projects/{project_id}").status_code == 204

    # The project vanished both from the list and from its address: a deleted one is
    # indistinguishable from a nonexistent one.
    assert authed.get(f"/api/projects/{project_id}").status_code == 404
    assert authed.get("/api/projects").json() == []


def test_editor_cannot_delete_a_project(authed, db):
    # The permission is deliberately beyond PROJECT_ADMIN: an editor edits the settings,
    # while deletion is an irreversible owner-level action (see Action.PROJECT_DELETE).
    project_id = authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]

    _demote_own_membership(authed, db, "editor")

    response = authed.delete(f"/api/projects/{project_id}")
    assert response.status_code == 403
    assert response.json()["detail"] == "forbidden"
    # The project stayed readable: the refusal deleted nothing.
    assert authed.get(f"/api/projects/{project_id}").status_code == 200


def test_deleting_a_foreign_project_returns_404(authed, db):
    from app.models import Organization, Project

    other_org = Organization(name="Other", slug="other")
    db.add(other_org)
    db.flush()
    foreign = Project(org_id=other_org.id, name="Secret", slug="secret")
    db.add(foreign)
    db.flush()

    # The same 404 as on a read: someone else's project is indistinguishable from a
    # nonexistent one, and a deletion must not give away its existence.
    assert authed.delete(f"/api/projects/{foreign.id}").status_code == 404
