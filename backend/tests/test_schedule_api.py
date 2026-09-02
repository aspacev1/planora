"""Разделение плана и календаря: относительный режим и привязка к дате старта.

Чистая арифметика смещений (offset_of/date_at_offset) проверяется через
провод, а не отдельно: контракт этой волны — «смещения, длительности и связи
сохраняются, меняется только ось», и утверждать его имеет смысл на тех же
маршрутах, которыми пользуется интерфейс.

Опорные даты: RELATIVE_EPOCH = 2001-01-01 — понедельник, «День 1» проекта;
2026-08-24 — тоже понедельник, назначаемый старт.
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


# --- относительный режим -----------------------------------------------------


def test_new_project_is_relative_and_has_no_start_date(authed):
    state = _state(authed, _project(authed))

    assert state["schedule_mode"] == "relative"
    assert state["start_date"] is None


def test_relative_task_carries_its_offset_in_working_days(authed):
    project_id = _project(authed)
    category_id = _category(authed, project_id)
    # День 1 (понедельник эпохи) и день 15 — понедельник третьей недели: при
    # неделе пн–пт между ними ровно десять рабочих дней.
    first = _task(authed, project_id, category_id, start="2001-01-01", days=10)
    third_week = _task(authed, project_id, category_id, start="2001-01-15", days=5)

    state = _state(authed, project_id)

    # Десять рабочих дней с понедельника — конец в пятницу второй недели.
    assert _task_out(state, first)["end_date"] == "2001-01-12"


def test_relative_calendar_is_a_bare_weekly_mask(authed, db):
    project_id = _project(authed)
    # Праздник настоящего года настроен, но на относительную ось не попадает:
    # праздник — свойство настоящей даты, которой у плана ещё нет.
    authed.patch(f"/api/projects/{project_id}", json={"holidays_extra": ["2026-08-26"]})

    state = _state(authed, project_id)

    assert state["schedule_mode"] == "relative"
    assert state["calendar"]["holidays"] == []
    assert state["calendar"]["extra_workdays"] == []


# --- предпросмотр ------------------------------------------------------------


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
    # Ничего не применилось: проект остался относительным, задача — на эпохе.
    state = _state(authed, project_id)
    assert state["schedule_mode"] == "relative"
    assert _task_out(state, task_id)["start_date"] == "2001-01-01"


# --- привязка к дате старта --------------------------------------------------


def test_assigning_a_start_date_lays_tasks_over_the_real_calendar(authed):
    project_id = _project(authed)
    # Среда первой недели — праздник: десять рабочих дней обязаны его
    # перешагнуть, и конец сдвигается на день.
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
    # Смещение 0 — на старте; десять рабочих дней через праздник — до 7 сентября.
    assert _task_out(state, first)["start_date"] == "2026-08-24"
    assert _task_out(state, first)["end_date"] == "2026-09-07"
    # Смещение 10 рабочих дней: праздник сдвигает и его — 8 сентября, а не 7-е.
    assert _task_out(state, third_week)["start_date"] == "2026-09-08"
    # Календарь снова настоящий: праздник вернулся в выдачу.
    assert state["calendar"]["holidays"] == ["2026-08-26"]


def test_the_chosen_working_week_applies_to_the_conversion(authed):
    project_id = _project(authed)
    category_id = _category(authed, project_id)
    # Смещение 10 при пн–пт — понедельник третьей недели относительной оси.
    task_id = _task(authed, project_id, category_id, start="2001-01-15", days=5)

    state = authed.post(
        f"/api/projects/{project_id}/schedule",
        json={"start_date": "2026-08-24", "working_days": 0b111111},
    ).json()

    # При неделе пн–сб десять рабочих дней укладываются быстрее: старт задачи —
    # пятница 4 сентября (11-й рабочий день), а не вторник 8-го.
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

    # Обещание переехало вместе с задачей: план, согласованный в относительных
    # днях, не должен стать «сдвинутым» от одной смены оси.
    task = _task_out(state, task_id)
    assert task["baseline_start"] == "2026-08-24"
    assert task["baseline_end"] == task["end_date"]


# --- повторная смена старта --------------------------------------------------


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


# --- права и отказы ----------------------------------------------------------


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
    # Задача на всю ширину поиска: на относительной оси (без праздников) она
    # считается, а после привязки к календарю, где почти каждый день съеден
    # праздниками, рабочих дней в пределах поиска не хватает.
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
