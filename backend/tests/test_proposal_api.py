"""The commercial proposal's routes: the budget, remarks, the carry-across into the plan."""

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import get_db
from app.main import app
from app.models import Membership


@pytest.fixture
def client(db):
    """The same pattern as in tests/test_comment_api.py: get_db returns the `db` fixture's
    session, and the outer transaction rolls everything back after the test."""

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
def project_id(authed):
    return authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]


def _category_id(authed, project_id: str, name: str = "Дизайн") -> str:
    response = authed.post(
        f"/api/projects/{project_id}/proposal/categories", json={"name": name}
    )
    assert response.status_code == 201
    return response.json()["id"]


def _task_id(
    authed, project_id: str, category_id: str, name: str = "Логотип", **fields: object
) -> str:
    response = authed.post(
        f"/api/projects/{project_id}/proposal/categories/{category_id}/tasks",
        json={"name": name, **fields},
    )
    assert response.status_code == 201
    return response.json()["id"]


def _demote(authed, db, role: str) -> None:
    """The same role as in tests/test_comment_api.py: the membership is edited in the
    database, because the application has no "demote yourself" route."""
    from app.models import Membership

    user_id = authed.get("/api/auth/me").json()["id"]
    membership = db.scalar(select(Membership).where(Membership.user_id == user_id))
    membership.role = role
    db.flush()


def _grant(authed, db, project_id: str) -> None:
    from app.models import ProjectAccess

    user_id = authed.get("/api/auth/me").json()["id"]
    db.add(ProjectAccess(project_id=uuid.UUID(project_id), user_id=uuid.UUID(user_id)))
    db.flush()


def test_untouched_project_answers_with_default_proposal(authed, project_id):
    """A project with no budget answers with default values rather than a 404: the client
    does not tell "never created" from "created empty", and that distinction is of no use to it."""
    state = authed.get(f"/api/projects/{project_id}/proposal").json()

    assert state == {
        "effort_unit": "days",
        "hours_per_day": 8,
        "tax_rate_pct": 0.0,
        "currency": "USD",
        "notes": "",
        "status": "draft",
        "sent_at": None,
        "agreed_at": None,
        "pushed_count": 0,
        "pushable_count": 0,
        "role_suggestions": [],
        # The plan's counters — for the "Assemble from the plan" card on an empty budget.
        "plan_facts": {"categories": 0, "tasks": 0},
        "categories": [],
    }


def test_viewer_reads_the_proposal_but_cannot_change_it(authed, db, project_id):
    _category_id(authed, project_id)
    _demote(authed, db, "viewer")

    assert authed.get(f"/api/projects/{project_id}/proposal").status_code == 200
    refused = [
        authed.patch(f"/api/projects/{project_id}/proposal", json={"tax_rate_pct": 5}),
        authed.post(f"/api/projects/{project_id}/proposal/categories", json={"name": "X"}),
        authed.post(f"/api/projects/{project_id}/proposal/push-to-plan"),
    ]
    assert [response.status_code for response in refused] == [403, 403, 403]


def test_client_does_not_see_the_proposal_even_with_a_project_grant(authed, db, project_id):
    """Rates, cost and the team's conversation are not for the client: they read the plan
    but not the budget. The same trimming the export already applies, where the "Budget"
    section is cut out of the client copy."""
    category_id = _category_id(authed, project_id)
    task_id = _task_id(authed, project_id, category_id)
    _demote(authed, db, "client")
    _grant(authed, db, project_id)

    assert authed.get(f"/api/projects/{project_id}").status_code == 200
    proposal = authed.get(f"/api/projects/{project_id}/proposal")
    assert proposal.status_code == 403
    assert proposal.json()["detail"] == "forbidden"
    thread = f"/api/projects/{project_id}/proposal/tasks/{task_id}/comments"
    assert authed.get(thread).status_code == 403
    assert authed.post(thread, json={"body": "Дорого"}).status_code == 403


def test_role_suggestions_gather_the_organizations_latest_rates(authed, project_id):
    """Role suggestions span the whole organization: a designer's rate is one for the
    studio and is not typed in again on the second project. The latest spelling wins, case
    and spaces do not multiply roles, and a role with no rate is still suggested."""
    category_id = _category_id(authed, project_id)
    for name, patch in (
        ("Логотип", {"role": "Дизайнер", "rate": 350}),
        ("Гайдлайн", {"role": " дизайнер ", "rate": 400}),
        ("Интервью", {"role": "Аналитик"}),
    ):
        task_id = _task_id(authed, project_id, category_id, name=name)
        authed.patch(f"/api/projects/{project_id}/proposal/tasks/{task_id}", json=patch)

    other_id = authed.post("/api/projects", json={"name": "Other"}).json()["id"]
    state = authed.get(f"/api/projects/{other_id}/proposal").json()

    assert state["role_suggestions"] == [
        {"role": "Аналитик", "rate": 0.0},
        {"role": "дизайнер", "rate": 400.0},
    ]


def test_plan_facts_count_the_plan_not_the_proposal(authed, project_id):
    created = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "create_category", "name": "Дизайн", "color": "#3b82f6"}},
    ).json()
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {
                "type": "create_task",
                "category_id": created["op"]["category_id"],
                "name": "Логотип",
                "start_date": "2001-01-01",
                "duration_days": 2,
            }
        },
    )

    state = authed.get(f"/api/projects/{project_id}/proposal").json()
    assert state["plan_facts"] == {"categories": 1, "tasks": 1}
    # The budget is still empty meanwhile: the plan and the proposal are different lists.
    assert state["categories"] == []


def test_rows_start_without_a_plan_link(authed, project_id):
    category_id = _category_id(authed, project_id)
    _task_id(authed, project_id, category_id)

    state = authed.get(f"/api/projects/{project_id}/proposal").json()
    assert state["categories"][0]["tasks"][0]["plan_task_id"] is None
    assert state["pushed_count"] == 0
    # A row with no estimate does not count as carryable: a zero estimate would give a
    # one-day stub task nobody ordered.
    assert state["pushable_count"] == 0


def test_estimate_row_carries_role_effort_and_rate(authed, project_id):
    category_id = _category_id(authed, project_id)
    task_id = _task_id(authed, project_id, category_id)

    patched = authed.patch(
        f"/api/projects/{project_id}/proposal/tasks/{task_id}",
        json={
            "role": "Дизайнер",
            "effort": 2.5,
            "rate": 400,
            "description": "Знак и логотип",
            "details": "Три варианта, два раунда правок",
            "notes": "Шрифт покупает клиент",
            "risks": "Правки затянутся",
            "assumptions": "Брендбук уже есть",
        },
    )
    assert patched.status_code == 200

    state = authed.get(f"/api/projects/{project_id}/proposal").json()
    row = state["categories"][0]["tasks"][0]
    assert row["role"] == "Дизайнер"
    assert row["effort"] == 2.5
    assert row["rate"] == 400.0
    assert row["details"] == "Три варианта, два раунда правок"
    assert row["risks"] == "Правки затянутся"
    # The price is deliberately absent from the answer: it equals effort x rate, and a
    # stored copy would diverge from its factors.
    assert "price" not in row


def test_settings_patch_changes_only_named_fields(authed, project_id):
    response = authed.patch(
        f"/api/projects/{project_id}/proposal",
        json={"effort_unit": "hours", "tax_rate_pct": 18, "currency": "eur"},
    )
    assert response.status_code == 200

    state = authed.get(f"/api/projects/{project_id}/proposal").json()
    assert state["effort_unit"] == "hours"
    assert state["tax_rate_pct"] == 18.0
    # The currency code is normalized to upper case: it is a code, not text.
    assert state["currency"] == "EUR"
    # A field not named in the request is untouched.
    assert state["hours_per_day"] == 8


def test_stage_marks_carry_dates_and_a_step_back_clears_them(authed, db, project_id):
    """The stage bar: a mark is set when the stage is first reached and lives until the
    stage is cleared; a step back clears the later marks."""
    stage = f"/api/projects/{project_id}/proposal/stage"

    sent = authed.post(stage, json={"stage": "sent"})
    assert sent.status_code == 200
    assert sent.json()["status"] == "sent"
    sent_at = sent.json()["sent_at"]
    assert sent_at is not None and sent.json()["agreed_at"] is None

    agreed = authed.post(stage, json={"stage": "agreed"}).json()
    assert agreed["status"] == "agreed"
    # The send date is the date of the event, not of the last press.
    assert agreed["sent_at"] == sent_at and agreed["agreed_at"] is not None

    back = authed.post(stage, json={"stage": "sent"}).json()
    assert (back["status"], back["sent_at"], back["agreed_at"]) == ("sent", sent_at, None)

    draft = authed.post(stage, json={"stage": "draft"}).json()
    assert (draft["status"], draft["sent_at"], draft["agreed_at"]) == ("draft", None, None)

    # Agreed straight from draft: the send counts as passed — with the same date, since
    # only what the client has seen can be agreed.
    leap = authed.post(stage, json={"stage": "agreed"}).json()
    assert leap["sent_at"] is not None and leap["sent_at"] == leap["agreed_at"]

    assert authed.post(stage, json={"stage": "signed"}).status_code == 422
    _demote(authed, db, "viewer")
    assert authed.post(stage, json={"stage": "draft"}).status_code == 403


def test_switching_the_unit_converts_rows_and_keeps_the_totals(authed, project_id):
    """Changing the unit changes what things are measured in rather than renaming the
    numbers: two days at 400 a day become sixteen hours at 50, and the total is the same."""
    category_id = _category_id(authed, project_id)
    for name, effort, rate in (("Логотип", 2, 400), ("Гайдлайн", 3, 200)):
        task_id = _task_id(authed, project_id, category_id, name=name)
        authed.patch(
            f"/api/projects/{project_id}/proposal/tasks/{task_id}",
            json={"effort": effort, "rate": rate},
        )

    hours = authed.patch(f"/api/projects/{project_id}/proposal", json={"effort_unit": "hours"})
    assert hours.status_code == 200
    rows = {row["name"]: row for row in hours.json()["categories"][0]["tasks"]}
    assert (rows["Логотип"]["effort"], rows["Логотип"]["rate"]) == (16.0, 50.0)
    assert (rows["Гайдлайн"]["effort"], rows["Гайдлайн"]["rate"]) == (24.0, 25.0)

    # Back again using the old hours-per-day norm, even if a new one arrived in the same
    # request: the estimates were written under eight, and eight is what must convert them.
    days = authed.patch(
        f"/api/projects/{project_id}/proposal", json={"effort_unit": "days", "hours_per_day": 6}
    ).json()
    rows = {row["name"]: row for row in days["categories"][0]["tasks"]}
    assert (rows["Логотип"]["effort"], rows["Логотип"]["rate"]) == (2.0, 400.0)
    assert days["hours_per_day"] == 6
    # The same unit a second time touches nothing.
    same = authed.patch(f"/api/projects/{project_id}/proposal", json={"effort_unit": "days"}).json()
    assert same["categories"][0]["tasks"][0]["effort"] == 2.0


def test_unit_switch_rounds_to_cents_and_refuses_what_does_not_fit(authed, project_id):
    category_id = _category_id(authed, project_id)
    task_id = _task_id(authed, project_id, category_id)
    authed.patch(f"/api/projects/{project_id}/proposal", json={"hours_per_day": 3})
    authed.patch(f"/api/projects/{project_id}/proposal/tasks/{task_id}", json={"effort": 1, "rate": 100})

    hours = authed.patch(f"/api/projects/{project_id}/proposal", json={"effort_unit": "hours"}).json()
    row = hours["categories"][0]["tasks"][0]
    # A third of a hundred is 33.33: the column's precision rather than an endless fraction.
    assert (row["effort"], row["rate"]) == (3.0, 33.33)

    # An estimate at the column's ceiling does not fit in hours: a refusal entirely, and
    # the budget stays in its previous unit.
    authed.patch(f"/api/projects/{project_id}/proposal", json={"effort_unit": "days"})
    authed.patch(f"/api/projects/{project_id}/proposal/tasks/{task_id}", json={"effort": 999_999})
    refused = authed.patch(f"/api/projects/{project_id}/proposal", json={"effort_unit": "hours"})
    assert refused.status_code == 422
    assert refused.json()["detail"] == "proposal_value_out_of_range"
    assert authed.get(f"/api/projects/{project_id}/proposal").json()["effort_unit"] == "days"


def test_a_row_is_created_with_role_estimate_and_rate_at_once(authed, project_id):
    """The input row asks for four fields at once — and all of it arrives in a single
    request, with no editing on a card. A name alone is still enough."""
    category_id = _category_id(authed, project_id)
    created = authed.post(
        f"/api/projects/{project_id}/proposal/categories/{category_id}/tasks",
        json={"name": "Логотип", "role": " Дизайнер ", "effort": 2, "rate": 400},
    )
    assert created.status_code == 201
    bare = authed.post(
        f"/api/projects/{project_id}/proposal/categories/{category_id}/tasks",
        json={"name": "Без полей"},
    )
    assert bare.status_code == 201

    state = authed.get(f"/api/projects/{project_id}/proposal").json()
    full, empty = state["categories"][0]["tasks"]
    assert (full["role"], full["effort"], full["rate"]) == ("Дизайнер", 2.0, 400.0)
    assert (empty["role"], empty["effort"], empty["rate"]) == ("", 0.0, 0.0)
    assert state["pushable_count"] == 1
def _set_row(authed, project_id: str, task_id: str, effort: float, rate: float) -> None:
    response = authed.patch(
        f"/api/projects/{project_id}/proposal/tasks/{task_id}",
        json={"effort": effort, "rate": rate},
    )
    assert response.status_code == 200


def _efforts_and_rates(authed, project_id: str) -> list[tuple[float, float]]:
    state = authed.get(f"/api/projects/{project_id}/proposal").json()
    return [
        (task["effort"], task["rate"])
        for category in state["categories"]
        for task in category["tasks"]
    ]


def test_switching_unit_recalculates_rows_and_keeps_prices(authed, project_id):
    """Two days at 400 are sixteen hours at 50: a budget in other units costs the same
    rather than eight times more."""
    category_id = _category_id(authed, project_id)
    logo = _task_id(authed, project_id, category_id, name="Логотип")
    guide = _task_id(authed, project_id, category_id, name="Гайдлайн")
    _set_row(authed, project_id, logo, effort=2, rate=400)
    _set_row(authed, project_id, guide, effort=0.5, rate=1000)

    response = authed.patch(
        f"/api/projects/{project_id}/proposal", json={"effort_unit": "hours"}
    )
    assert response.status_code == 200
    assert response.json()["effort_unit"] == "hours"
    assert _efforts_and_rates(authed, project_id) == [(16.0, 50.0), (4.0, 125.0)]

    # And back again: the same days and the same rates — converting there and back does not drift.
    authed.patch(f"/api/projects/{project_id}/proposal", json={"effort_unit": "days"})
    assert _efforts_and_rates(authed, project_id) == [(2.0, 400.0), (0.5, 1000.0)]


def test_rate_absorbs_rounding_so_the_total_survives(authed, project_id):
    """7 hours are 0.875 of a day, 0.88 in two places. The rate is derived from the previous
    price (350) rather than multiplied out on its own: 0.88 x 400 would have given 352."""
    authed.patch(f"/api/projects/{project_id}/proposal", json={"effort_unit": "hours"})
    category_id = _category_id(authed, project_id)
    task_id = _task_id(authed, project_id, category_id)
    _set_row(authed, project_id, task_id, effort=7, rate=50)

    authed.patch(f"/api/projects/{project_id}/proposal", json={"effort_unit": "days"})

    [(effort, rate)] = _efforts_and_rates(authed, project_id)
    assert (effort, rate) == (0.88, 397.73)
    assert effort * rate == pytest.approx(350, abs=0.01)


def test_row_without_effort_converts_its_rate_by_the_factor(authed, project_id):
    """A row with no estimate has no price and there is nothing to derive a rate from — it
    is simply converted by "hours per day" so as not to be lost when the estimate is filled in."""
    category_id = _category_id(authed, project_id)
    task_id = _task_id(authed, project_id, category_id)
    _set_row(authed, project_id, task_id, effort=0, rate=400)

    authed.patch(f"/api/projects/{project_id}/proposal", json={"effort_unit": "hours"})

    assert _efforts_and_rates(authed, project_id) == [(0.0, 50.0)]




def test_category_carries_description_and_takes_patches(authed, project_id):
    """A section's description stands on its row in the table — and is edited separately
    from the name: patch changes only the fields that were sent."""
    created = authed.post(
        f"/api/projects/{project_id}/proposal/categories",
        json={"name": "Discovery", "description": "Понять цели и требования"},
    )
    assert created.status_code == 201
    category_id = created.json()["id"]

    patched = authed.patch(
        f"/api/projects/{project_id}/proposal/categories/{category_id}",
        json={"description": "Цели, люди, требования"},
    )
    assert patched.status_code == 200

    state = authed.get(f"/api/projects/{project_id}/proposal").json()
    category = state["categories"][0]
    assert category["name"] == "Discovery"
    assert category["description"] == "Цели, люди, требования"


def test_proposal_notes_live_on_the_proposal_itself(authed, project_id):
    """Assumptions and notes are a property of the proposal as a whole, not of a row."""
    response = authed.patch(
        f"/api/projects/{project_id}/proposal",
        json={"notes": "Оценки по текущему объёму.\nСтавки без лицензий."},
    )
    assert response.status_code == 200

    state = authed.get(f"/api/projects/{project_id}/proposal").json()
    assert state["notes"] == "Оценки по текущему объёму.\nСтавки без лицензий."


def test_row_comments_are_signed_and_counted(authed, project_id):
    category_id = _category_id(authed, project_id)
    task_id = _task_id(authed, project_id, category_id)

    posted = authed.post(
        f"/api/projects/{project_id}/proposal/tasks/{task_id}/comments",
        json={"body": "  Ставку согласовали  "},
    )
    assert posted.status_code == 201
    assert posted.json()["body"] == "Ставку согласовали"
    assert posted.json()["author"] == {"name": "Alex", "guest": False}

    thread = authed.get(
        f"/api/projects/{project_id}/proposal/tasks/{task_id}/comments"
    ).json()
    assert [comment["body"] for comment in thread] == ["Ставку согласовали"]

    state = authed.get(f"/api/projects/{project_id}/proposal").json()
    assert state["categories"][0]["tasks"][0]["comment_count"] == 1


def test_row_of_another_project_is_unreachable(authed, project_id):
    """A row of someone else's budget is indistinguishable from a nonexistent one — by the
    same principle as tasks in the mutation routes."""
    other_id = authed.post("/api/projects", json={"name": "Other"}).json()["id"]
    category_id = _category_id(authed, other_id)
    stranger = _task_id(authed, other_id, category_id)

    response = authed.patch(
        f"/api/projects/{project_id}/proposal/tasks/{stranger}", json={"role": "нет"}
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "proposal_task_not_found"


def test_deleting_a_category_takes_its_rows_along(authed, project_id):
    category_id = _category_id(authed, project_id)
    _task_id(authed, project_id, category_id)

    response = authed.delete(
        f"/api/projects/{project_id}/proposal/categories/{category_id}"
    )
    assert response.status_code == 204
    assert authed.get(f"/api/projects/{project_id}/proposal").json()["categories"] == []


def _estimated_task(authed, project_id: str, category_id: str, name: str, effort: float) -> str:
    task_id = _task_id(authed, project_id, category_id, name=name)
    authed.patch(f"/api/projects/{project_id}/proposal/tasks/{task_id}", json={"effort": effort})
    return task_id


def test_push_to_plan_turns_rows_into_tasks_as_one_batch(authed, project_id):
    """The carry-across: a section becomes a category, a row a task, hours become days rounded up."""
    authed.patch(
        f"/api/projects/{project_id}/proposal",
        json={"effort_unit": "hours", "hours_per_day": 8},
    )
    category_id = _category_id(authed, project_id, name="Дизайн")
    logo = _task_id(authed, project_id, category_id, name="Логотип")
    authed.patch(
        f"/api/projects/{project_id}/proposal/tasks/{logo}",
        json={"effort": 20, "description": "Знак"},
    )
    _estimated_task(authed, project_id, category_id, "Гайдлайн", effort=1)

    response = authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")
    assert response.status_code == 201
    assert response.json()["created_tasks"] == 2

    state = authed.get(f"/api/projects/{project_id}").json()
    assert [category["name"] for category in state["categories"]] == ["Дизайн"]
    by_name = {task["name"]: task for task in state["tasks"]}
    # 20 hours with an eight-hour day are three calendar days, rounded up: half a day of
    # work still occupies a day on the chart.
    assert by_name["Логотип"]["duration_days"] == 3
    assert by_name["Логотип"]["description"] == "Знак"
    # An hour of work is a day too: the chart has no tasks shorter than a day.
    assert by_name["Гайдлайн"]["duration_days"] == 1
    # The batch is undone with one button: every revision shares a batch_id, and it is named
    # in the answer too — for the sake of the "Undo" button in the toast.
    revisions = authed.get(f"/api/projects/{project_id}/revisions").json()
    batches = {entry["batch_id"] for entry in revisions}
    assert batches == {response.json()["batch_id"]}


def test_push_carries_risks_and_assumptions_into_the_internal_note(authed, project_id):
    """A row's risks and assumptions are not lost in the carry-across: they are folded into
    the task's internal note under headings in the organization's language. The description
    meanwhile stays a description — it may be shown to the client."""
    authed.patch("/api/org", json={"default_locale": "ru"})
    category_id = _category_id(authed, project_id, name="Дизайн")
    logo = _estimated_task(authed, project_id, category_id, "Логотип", effort=2)
    authed.patch(
        f"/api/projects/{project_id}/proposal/tasks/{logo}",
        json={
            "description": "Знак",
            "risks": "Правки затянутся",
            "assumptions": "Брендбук уже есть",
        },
    )
    # One field is empty — the heading of an empty section is not written, and spaces at the
    # edges do not reach the note.
    guide = _estimated_task(authed, project_id, category_id, "Гайдлайн", effort=1)
    authed.patch(
        f"/api/projects/{project_id}/proposal/tasks/{guide}",
        json={"assumptions": "  Шрифты куплены  "},
    )
    # Every field is empty — the note is empty rather than a pair of bare headings.
    _estimated_task(authed, project_id, category_id, "Иконки", effort=1)

    response = authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")
    assert response.status_code == 201

    state = authed.get(f"/api/projects/{project_id}").json()
    by_name = {task["name"]: task for task in state["tasks"]}
    assert by_name["Логотип"]["description"] == "Знак"
    assert by_name["Логотип"]["internal_note"] == (
        "Риски\nПравки затянутся\n\nДопущения\nБрендбук уже есть"
    )
    assert by_name["Гайдлайн"]["internal_note"] == "Допущения\nШрифты куплены"
    assert by_name["Иконки"]["internal_note"] == ""

def test_second_push_reuses_the_plan_category_by_name(authed, project_id):
    category_id = _category_id(authed, project_id, name="Дизайн")
    _estimated_task(authed, project_id, category_id, "Логотип", effort=2)
    authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")

    _estimated_task(authed, project_id, category_id, "Гайдлайн", effort=3)
    authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")

    state = authed.get(f"/api/projects/{project_id}").json()
    # There is one "Design": a repeated carry-across does not multiply categories of the same name.
    assert [category["name"] for category in state["categories"]] == ["Дизайн"]


def test_second_push_skips_rows_already_in_plan(authed, project_id):
    """A carried-across row remembers its task and does not go into the plan a second time:
    before, two presses in a row doubled the plan."""
    category_id = _category_id(authed, project_id, name="Дизайн")
    logo = _estimated_task(authed, project_id, category_id, "Логотип", effort=2)
    first = authed.post(f"/api/projects/{project_id}/proposal/push-to-plan").json()
    assert first["created_tasks"] == 1

    _estimated_task(authed, project_id, category_id, "Гайдлайн", effort=3)
    second = authed.post(f"/api/projects/{project_id}/proposal/push-to-plan").json()
    assert second["created_tasks"] == 1

    plan = authed.get(f"/api/projects/{project_id}").json()
    assert sorted(task["name"] for task in plan["tasks"]) == ["Гайдлайн", "Логотип"]
    state = authed.get(f"/api/projects/{project_id}/proposal").json()
    rows = {row["name"]: row for row in state["categories"][0]["tasks"]}
    plan_ids = {task["name"]: task["id"] for task in plan["tasks"]}
    assert rows["Логотип"]["plan_task_id"] == plan_ids["Логотип"]
    assert rows["Гайдлайн"]["plan_task_id"] == plan_ids["Гайдлайн"]
    assert state["pushed_count"] == 2 and state["pushable_count"] == 0
    # Everything is in the plan — there is nothing to carry, and that is a refusal rather
    # than a silent zero.
    third = authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")
    assert third.status_code == 422
    assert third.json()["detail"] == "proposal_nothing_to_push"
    assert logo == rows["Логотип"]["id"]


def test_push_takes_only_the_named_rows(authed, project_id):
    """The carry-across dialog lets a checkbox be cleared: the named rows are carried, and
    only they. Someone else's row in the list is a 404, as everywhere."""
    category_id = _category_id(authed, project_id, name="Дизайн")
    logo = _estimated_task(authed, project_id, category_id, "Логотип", effort=2)
    _estimated_task(authed, project_id, category_id, "Гайдлайн", effort=3)

    response = authed.post(
        f"/api/projects/{project_id}/proposal/push-to-plan", json={"task_ids": [logo]}
    )
    assert response.status_code == 201
    assert response.json()["created_tasks"] == 1
    plan = authed.get(f"/api/projects/{project_id}").json()
    assert [task["name"] for task in plan["tasks"]] == ["Логотип"]

    other_id = authed.post("/api/projects", json={"name": "Other"}).json()["id"]
    stranger = _estimated_task(
        authed, other_id, _category_id(authed, other_id), "Чужая", effort=1
    )
    refused = authed.post(
        f"/api/projects/{project_id}/proposal/push-to-plan", json={"task_ids": [stranger]}
    )
    assert refused.status_code == 404
    assert refused.json()["detail"] == "proposal_task_not_found"


def test_rows_without_estimate_stay_behind_unless_named(authed, project_id):
    """A zero estimate does not go into the plan by default — a task out of it would come
    out as a one-day stub. Named explicitly, it is carried: the person decides."""
    category_id = _category_id(authed, project_id, name="Дизайн")
    _estimated_task(authed, project_id, category_id, "Логотип", effort=2)
    blank = _task_id(authed, project_id, category_id, name="Анимации")

    by_default = authed.post(f"/api/projects/{project_id}/proposal/push-to-plan").json()
    assert by_default["created_tasks"] == 1

    named = authed.post(
        f"/api/projects/{project_id}/proposal/push-to-plan", json={"task_ids": [blank]}
    )
    assert named.status_code == 201
    plan = authed.get(f"/api/projects/{project_id}").json()
    assert {task["name"]: task["duration_days"] for task in plan["tasks"]} == {
        "Логотип": 2,
        "Анимации": 1,
    }


def test_undoing_the_batch_frees_the_rows_for_another_push(authed, project_id):
    """"Undo" in the toast removes the whole batch: the tasks disappear, the rows'
    references are nulled by the database (SET NULL), and the rows are carryable again."""
    category_id = _category_id(authed, project_id, name="Дизайн")
    _estimated_task(authed, project_id, category_id, "Логотип", effort=2)
    pushed = authed.post(f"/api/projects/{project_id}/proposal/push-to-plan").json()

    undone = authed.post(f"/api/projects/{project_id}/batches/{pushed['batch_id']}/undo")
    assert undone.status_code == 201

    assert authed.get(f"/api/projects/{project_id}").json()["tasks"] == []
    state = authed.get(f"/api/projects/{project_id}/proposal").json()
    assert state["categories"][0]["tasks"][0]["plan_task_id"] is None
    assert state["pushable_count"] == 1
    again = authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")
    assert again.status_code == 201


def test_push_carries_team_notes_into_the_internal_note(authed, project_id):
    """A row's notes, risks and assumptions are not lost in the carry-across: they go into
    the task's internal note — a field the client does not see."""
    category_id = _category_id(authed, project_id, name="Дизайн")
    logo = _estimated_task(authed, project_id, category_id, "Логотип", effort=2)
    authed.patch(
        f"/api/projects/{project_id}/proposal/tasks/{logo}",
        json={"risks": "Правки затянутся", "assumptions": "Брендбук есть"},
    )

    authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")

    task = authed.get(f"/api/projects/{project_id}").json()["tasks"][0]
    # The Acme organization was created by a registration with the installation's default
    # language (Azerbaijani in the tests), and the labels come from the export dictionary.
    assert task["internal_note"] == "Risklər\nПравки затянутся\n\nFərziyyələr\nБрендбук есть"


def test_push_preview_tells_what_will_happen(authed, project_id):
    """The carry-across dialog shows where a section will land and how many days a row comes
    to, and marks what will not be carried."""
    authed.patch(
        f"/api/projects/{project_id}/proposal",
        json={"effort_unit": "hours", "hours_per_day": 8},
    )
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "create_category", "name": "дизайн", "color": "#3b82f6"}},
    )
    design = _category_id(authed, project_id, name="Дизайн")
    logo = _estimated_task(authed, project_id, design, "Логотип", effort=20)
    blank = _task_id(authed, project_id, design, name="Анимации")
    dev = _category_id(authed, project_id, name="Разработка")
    layout = _estimated_task(authed, project_id, dev, "Вёрстка", effort=8)
    _category_id(authed, project_id, name="Пустой раздел")
    authed.post(
        f"/api/projects/{project_id}/proposal/push-to-plan", json={"task_ids": [layout]}
    )

    preview = authed.get(f"/api/projects/{project_id}/proposal/push-plan").json()

    plan_category = authed.get(f"/api/projects/{project_id}").json()["categories"][0]
    assert preview == {
        "categories": [
            {
                "id": design,
                "name": "Дизайн",
                # The plan's category is found by name, ignoring case.
                "plan_category": {"id": plan_category["id"], "name": "дизайн"},
                "tasks": [
                    {
                        "id": logo,
                        "name": "Логотип",
                        "duration_days": 3,
                        "in_plan": False,
                        "estimated": True,
                    },
                    {
                        "id": blank,
                        "name": "Анимации",
                        "duration_days": 1,
                        "in_plan": False,
                        "estimated": False,
                    },
                ],
            },
            {
                "id": dev,
                "name": "Разработка",
                "plan_category": {"id": plan_category_id_of(authed, project_id, "Разработка"), "name": "Разработка"},
                "tasks": [
                    {
                        "id": layout,
                        "name": "Вёрстка",
                        "duration_days": 1,
                        "in_plan": True,
                        "estimated": True,
                    }
                ],
            },
        ]
    }
    # A section with no rows is not shown in the dialog: there is nothing to carry from it.


def plan_category_id_of(authed, project_id: str, name: str) -> str:
    return next(
        category["id"]
        for category in authed.get(f"/api/projects/{project_id}").json()["categories"]
        if category["name"] == name
    )
def _rows_by_name(authed, project_id: str) -> dict[str, dict]:
    state = authed.get(f"/api/projects/{project_id}/proposal").json()
    return {row["name"]: row for category in state["categories"] for row in category["tasks"]}


def test_deleting_the_plan_task_returns_the_row_to_transferable(authed, project_id):
    """The reference is erased by the database (ON DELETE SET NULL) — there is no separate restore logic."""
    category_id = _category_id(authed, project_id)
    _estimated_task(authed, project_id, category_id, "Логотип", effort=2)
    authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")
    (logo,) = authed.get(f"/api/projects/{project_id}").json()["tasks"]

    response = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "delete_task", "task_id": logo["id"]}},
    )
    assert response.status_code == 201
    assert _rows_by_name(authed, project_id)["Логотип"]["plan_task_id"] is None

    # The row is carryable again — and is carried as if for the first time.
    response = authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")
    assert response.json()["created_tasks"] == 1
    (again,) = authed.get(f"/api/projects/{project_id}").json()["tasks"]
    assert _rows_by_name(authed, project_id)["Логотип"]["plan_task_id"] == again["id"]


def test_deleting_a_row_in_plan_leaves_the_plan_task_alone(authed, project_id):
    """A budget is a draft of a deal, and the plan is not its shadow: the row goes, the task stays."""
    category_id = _category_id(authed, project_id)
    row_id = _estimated_task(authed, project_id, category_id, "Логотип", effort=2)
    authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")

    assert authed.delete(f"/api/projects/{project_id}/proposal/tasks/{row_id}").status_code == 204
    assert [task["name"] for task in authed.get(f"/api/projects/{project_id}").json()["tasks"]] == [
        "Логотип"
    ]




def test_empty_proposal_refuses_to_push(authed, project_id):
    response = authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")
    assert response.status_code == 422
    assert response.json()["detail"] == "proposal_empty"
    assert authed.get(f"/api/projects/{project_id}/proposal/push-plan").json() == {
        "categories": []
    }


def _plan_category(authed, project_id: str, name: str, color: str = "#3b82f6") -> str:
    response = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "create_category", "name": name, "color": color}},
    )
    assert response.status_code == 201, response.text
    return response.json()["op"]["category_id"]


def _plan_task(authed, project_id: str, category_id: str, name: str, days: int) -> str:
    response = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {
                "type": "create_task",
                "category_id": category_id,
                "name": name,
                "start_date": "2026-03-02",
                "duration_days": days,
                "description": f"Описание: {name}",
            }
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["op"]["task_id"]


def test_proposal_state_counts_the_plan_for_the_empty_screen(authed, project_id):
    """Only categories with tasks are counted: the assembly skips empty ones, and the number
    on the card must match the number of sections created."""
    design = _plan_category(authed, project_id, "Дизайн")
    _plan_category(authed, project_id, "Пустая")
    _plan_task(authed, project_id, design, "Логотип", 2)
    _plan_task(authed, project_id, design, "Гайдлайн", 3)

    state = authed.get(f"/api/projects/{project_id}/proposal").json()
    assert state["plan_facts"] == {"tasks": 2, "categories": 1}


def test_build_from_plan_turns_categories_into_sections_and_tasks_into_linked_rows(
    authed, project_id
):
    """The assembly: a category becomes a section in the plan's order, a task a row with an
    estimate from its duration and a reference to the task; the role and the rate are empty."""
    # The "Development" section was created first but stands second in the plan: the budget's
    # order comes from position rather than from the order of creation.
    develop = _plan_category(authed, project_id, "Разработка")
    design = _plan_category(authed, project_id, "Дизайн")
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "reorder_category", "category_id": design, "position": 0}},
    )
    _plan_category(authed, project_id, "Пустая")
    logo = _plan_task(authed, project_id, design, "Логотип", 2)
    guide = _plan_task(authed, project_id, design, "Гайдлайн", 3)
    layout = _plan_task(authed, project_id, develop, "Вёрстка", 5)
    journal = len(authed.get(f"/api/projects/{project_id}/revisions").json())

    response = authed.post(f"/api/projects/{project_id}/proposal/build-from-plan")
    assert response.status_code == 201, response.text
    assert response.json() == {"created_categories": 2, "created_tasks": 3}

    state = authed.get(f"/api/projects/{project_id}/proposal").json()
    # A category with no tasks did not become a section: a row with no amount says nothing in a budget.
    assert [category["name"] for category in state["categories"]] == ["Дизайн", "Разработка"]
    rows = {
        row["name"]: row for category in state["categories"] for row in category["tasks"]
    }
    assert rows["Логотип"]["effort"] == 2.0
    assert rows["Логотип"]["description"] == "Описание: Логотип"
    assert rows["Логотип"]["role"] == ""
    assert rows["Логотип"]["rate"] == 0.0
    assert rows["Логотип"]["plan_task_id"] == logo
    assert rows["Гайдлайн"]["plan_task_id"] == guide
    assert rows["Вёрстка"]["plan_task_id"] == layout
    # The order of rows within a section is the order of tasks in the plan.
    assert [row["name"] for row in state["categories"][0]["tasks"]] == ["Логотип", "Гайдлайн"]
    # The assembly writes only into the budget: the plan and its journal are untouched.
    assert len(authed.get(f"/api/projects/{project_id}/revisions").json()) == journal


def test_build_from_plan_counts_hours_through_hours_per_day(authed, project_id):
    authed.patch(
        f"/api/projects/{project_id}/proposal",
        json={"effort_unit": "hours", "hours_per_day": 6},
    )
    design = _plan_category(authed, project_id, "Дизайн")
    _plan_task(authed, project_id, design, "Логотип", 2)

    authed.post(f"/api/projects/{project_id}/proposal/build-from-plan")

    state = authed.get(f"/api/projects/{project_id}/proposal").json()
    # Two days of six hours are twelve hours.
    assert state["categories"][0]["tasks"][0]["effort"] == 12.0


def test_build_from_plan_refuses_a_proposal_that_already_has_rows(authed, project_id):
    design = _plan_category(authed, project_id, "Дизайн")
    _plan_task(authed, project_id, design, "Логотип", 2)
    category_id = _category_id(authed, project_id, name="Своё")
    _task_id(authed, project_id, category_id, name="Набрано руками")

    response = authed.post(f"/api/projects/{project_id}/proposal/build-from-plan")
    assert response.status_code == 422
    assert response.json()["detail"] == "proposal_not_empty"
    # What was typed by hand is in place, and the assembly appended nothing to it.
    state = authed.get(f"/api/projects/{project_id}/proposal").json()
    assert [category["name"] for category in state["categories"]] == ["Своё"]


def test_build_from_plan_refuses_an_empty_plan(authed, project_id):
    _plan_category(authed, project_id, "Дизайн")

    response = authed.post(f"/api/projects/{project_id}/proposal/build-from-plan")
    assert response.status_code == 422
    assert response.json()["detail"] == "plan_empty"
    assert authed.get(f"/api/projects/{project_id}/proposal").json()["categories"] == []


def test_build_from_plan_needs_the_right_to_write(authed, db, project_id):
    """The right to read a budget does not grant the right to assemble it — a refusal on the
    server rather than merely a hidden card."""
    design = _plan_category(authed, project_id, "Дизайн")
    _plan_task(authed, project_id, design, "Логотип", 2)
    user_id = authed.get("/api/auth/me").json()["id"]
    membership = db.scalar(select(Membership).where(Membership.user_id == user_id))
    membership.role = "viewer"
    db.flush()

    response = authed.post(f"/api/projects/{project_id}/proposal/build-from-plan")
    assert response.status_code == 403
    assert authed.get(f"/api/projects/{project_id}/proposal").json()["categories"] == []


def test_push_after_build_does_not_duplicate_the_plan(authed, project_id):
    """Rows assembled from the plan remember their tasks — a carry-across creates only what
    is not in the plan yet."""
    design = _plan_category(authed, project_id, "Дизайн")
    _plan_task(authed, project_id, design, "Логотип", 2)
    _plan_task(authed, project_id, design, "Гайдлайн", 3)
    authed.post(f"/api/projects/{project_id}/proposal/build-from-plan")

    # Everything is already in the plan — there is nothing to carry, and that is said plainly.
    response = authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")
    assert response.status_code == 422
    assert response.json()["detail"] == "proposal_nothing_to_push"

    # A row typed in by hand with an estimate is the only thing the carry-across will create.
    state = authed.get(f"/api/projects/{project_id}/proposal").json()
    section_id = state["categories"][0]["id"]
    _task_id(authed, project_id, section_id, name="Вёрстка", effort=1)

    response = authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")
    assert response.status_code == 201
    assert response.json()["created_tasks"] == 1

    plan = authed.get(f"/api/projects/{project_id}").json()
    assert sorted(task["name"] for task in plan["tasks"]) == ["Вёрстка", "Гайдлайн", "Логотип"]
    assert [category["name"] for category in plan["categories"]] == ["Дизайн"]
