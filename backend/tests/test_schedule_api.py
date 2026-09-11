"""Separating the plan from the calendar: relative mode and anchoring to a start date.

The pure arithmetic of offsets (offset_of/date_at_offset) is checked over the wire
rather than separately: this wave's contract is "offsets, durations and dependencies
are preserved, only the axis changes", and it makes sense to assert that on the same
routes the interface uses.

Reference dates: RELATIVE_EPOCH = 2001-01-01 — a Monday, the project's "Day 1";
2026-08-24 — also a Monday, the start being assigned.
"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import get_db
from app.main import app
from app.models import Membership


@pytest.fixture
def client(db):
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


def _project(authed) -> str:
    return authed.post("/api/projects", json={"name": "Редизайн"}).json()["id"]


def _category(authed, project_id: str) -> str:
    revision = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "create_category", "name": "Работы", "color": "#dbeafe"}},
    ).json()
    return revision["op"]["category_id"]


def _task(authed, project_id: str, category_id: str, *, start: str, days: int) -> str:
    revision = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {
                "type": "create_task",
                "category_id": category_id,
                "name": "Задача",
                "start_date": start,
                "duration_days": days,
            }
        },
    ).json()
    return revision["op"]["task_id"]


def _state(authed, project_id: str) -> dict:
    response = authed.get(f"/api/projects/{project_id}")
    assert response.status_code == 200
    return response.json()


def _task_out(state: dict, task_id: str) -> dict:
    return next(task for task in state["tasks"] if task["id"] == task_id)


# --- relative mode ------------------------------------------------------------


def test_new_project_is_relative_and_has_no_start_date(authed):
    state = _state(authed, _project(authed))

    assert state["schedule_mode"] == "relative"
    assert state["start_date"] is None


def test_relative_task_carries_its_offset_in_working_days(authed):
    project_id = _project(authed)
    category_id = _category(authed, project_id)
    # Day 1 (the epoch's Monday) and day 15 — the Monday of the third week: with a
    # Mon-Fri week there are exactly ten working days between them.
    first = _task(authed, project_id, category_id, start="2001-01-01", days=10)
    third_week = _task(authed, project_id, category_id, start="2001-01-15", days=5)

    state = _state(authed, project_id)

    # Ten working days from a Monday — the end falls on the second week's Friday.
    assert _task_out(state, first)["end_date"] == "2001-01-12"


def test_relative_calendar_is_a_bare_weekly_mask(authed, db):
    project_id = _project(authed)
    # A holiday of a real year is configured but does not land on the relative axis:
    # a holiday is a property of a real date, which the plan does not have yet.
    authed.patch(f"/api/projects/{project_id}", json={"holidays_extra": ["2026-08-26"]})

    state = _state(authed, project_id)

    assert state["schedule_mode"] == "relative"
    assert state["calendar"]["holidays"] == []
    assert state["calendar"]["extra_workdays"] == []


# --- the preview ---------------------------------------------------------------


def test_preview_names_the_bounds_without_moving_anything(authed):
    project_id = _project(authed)
    category_id = _category(authed, project_id)
    task_id = _task(authed, project_id, category_id, start="2001-01-01", days=10)

    preview = authed.post(
        f"/api/projects/{project_id}/schedule/preview",
        json={"start_date": "2026-08-24"},
    )

    assert preview.status_code == 200
    assert preview.json() == {"start_date": "2026-08-24", "end_date": "2026-09-04"}
    # Nothing was applied: the project stayed relative and the task stayed at the epoch.
    state = _state(authed, project_id)
    assert state["schedule_mode"] == "relative"
    assert _task_out(state, task_id)["start_date"] == "2001-01-01"


# --- anchoring to a start date -------------------------------------------------


def test_assigning_a_start_date_lays_tasks_over_the_real_calendar(authed):
    project_id = _project(authed)
    # The Wednesday of the first week is a holiday: ten working days must step over
    # it, and the end shifts by a day.
    authed.patch(f"/api/projects/{project_id}", json={"holidays_extra": ["2026-08-26"]})
    category_id = _category(authed, project_id)
    first = _task(authed, project_id, category_id, start="2001-01-01", days=10)
    third_week = _task(authed, project_id, category_id, start="2001-01-15", days=5)

    response = authed.post(
        f"/api/projects/{project_id}/schedule", json={"start_date": "2026-08-24"}
    )

    assert response.status_code == 200
    state = response.json()
    assert state["schedule_mode"] == "calendar"
    assert state["start_date"] == "2026-08-24"
    # Offset 0 — at the start; ten working days across the holiday — through 7 September.
    assert _task_out(state, first)["start_date"] == "2026-08-24"
    assert _task_out(state, first)["end_date"] == "2026-09-07"
    # An offset of 10 working days: the holiday shifts it too — 8 September, not the 7th.
    assert _task_out(state, third_week)["start_date"] == "2026-09-08"
    # The calendar is real again: the holiday is back in the output.
    assert state["calendar"]["holidays"] == ["2026-08-26"]


def test_the_chosen_working_week_applies_to_the_conversion(authed):
    project_id = _project(authed)
    category_id = _category(authed, project_id)
    # An offset of 10 with Mon-Fri is the Monday of the relative axis's third week.
    task_id = _task(authed, project_id, category_id, start="2001-01-15", days=5)

    state = authed.post(
        f"/api/projects/{project_id}/schedule",
        json={"start_date": "2026-08-24", "working_days": 0b111111},
    ).json()

    # With a Mon-Sat week ten working days fit in sooner: the task's start is Friday
    # 4 September (the 11th working day) rather than Tuesday the 8th.
    assert _task_out(state, task_id)["start_date"] == "2026-09-04"
    assert state["overrides"]["working_days"] == 0b111111


def test_baselines_travel_with_the_axis(authed):
    project_id = _project(authed)
    category_id = _category(authed, project_id)
    task_id = _task(authed, project_id, category_id, start="2001-01-01", days=10)
    authed.post(f"/api/projects/{project_id}/plan/approvals")

    state = authed.post(
        f"/api/projects/{project_id}/schedule", json={"start_date": "2026-08-24"}
    ).json()

    # The promise moved along with the task: a plan agreed in relative days must not
    # become "shifted" from a single change of axis.
    task = _task_out(state, task_id)
    assert task["baseline_start"] == "2026-08-24"
    assert task["baseline_end"] == task["end_date"]


# --- changing the start again --------------------------------------------------


def test_moving_the_start_shifts_all_tasks_by_their_offsets(authed):
    project_id = _project(authed)
    category_id = _category(authed, project_id)
    task_id = _task(authed, project_id, category_id, start="2001-01-01", days=5)
    authed.post(f"/api/projects/{project_id}/schedule", json={"start_date": "2026-08-24"})

    state = authed.post(
        f"/api/projects/{project_id}/schedule", json={"start_date": "2026-08-31"}
    ).json()

    assert state["start_date"] == "2026-08-31"
    assert _task_out(state, task_id)["start_date"] == "2026-08-31"


def test_moving_the_start_may_keep_the_dates_in_place(authed):
    project_id = _project(authed)
    category_id = _category(authed, project_id)
    task_id = _task(authed, project_id, category_id, start="2001-01-01", days=5)
    authed.post(f"/api/projects/{project_id}/schedule", json={"start_date": "2026-08-24"})

    state = authed.post(
        f"/api/projects/{project_id}/schedule",
        json={"start_date": "2026-08-31", "shift_tasks": False},
    ).json()

    assert state["start_date"] == "2026-08-31"
    assert _task_out(state, task_id)["start_date"] == "2026-08-24"


# --- permissions and refusals --------------------------------------------------


def test_assigning_a_start_date_needs_project_admin(authed, db):
    project_id = _project(authed)
    user_id = authed.get("/api/auth/me").json()["id"]
    membership = db.scalar(select(Membership).where(Membership.user_id == user_id))
    membership.role = "viewer"
    db.flush()

    response = authed.post(
        f"/api/projects/{project_id}/schedule", json={"start_date": "2026-08-24"}
    )

    assert response.status_code == 403


def test_a_degenerate_calendar_is_a_refusal_not_a_crash(authed):
    project_id = _project(authed)
    category_id = _category(authed, project_id)
    # A task spanning the whole search width: on the relative axis (with no holidays)
    # it computes, while after anchoring to the calendar, where almost every day is
    # eaten by holidays, there are not enough working days within the search.
    _task(authed, project_id, category_id, start="2001-01-01", days=3650)
    holidays = [
        f"{year}-{month:02d}-{day:02d}"
        for year in range(2026, 2036)
        for month in range(1, 13)
        for day in range(1, 28)
    ]
    authed.patch(f"/api/projects/{project_id}", json={"holidays_extra": holidays})

    response = authed.post(
        f"/api/projects/{project_id}/schedule", json={"start_date": "2026-01-05"}
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "calendar_too_few_working_days"
