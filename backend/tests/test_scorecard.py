"""Скоркард: метрики, статусы, ленивая фиксация, правило и события.

Живые вычисления привязаны к «сегодня» в таймзоне проекта, поэтому даты в
тестах строятся от настоящего сегодня (Asia/Baku — дефолт организации), а
утверждения держатся за счётные величины, не за конкретные дни недели.
"""

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.calendar import Calendar, count_working_days
from app.db import get_db
from app.main import app
from app.models import (
    AiSession,
    Membership,
    Organization,
    Project,
    ScorecardAlert,
    ScorecardMetric,
    ScorecardSnapshot,
    Task,
    User,
)
from app.scorecard import metric_status, week_start_of, _in_week

BAKU = ZoneInfo("Asia/Baku")
WORKWEEK = Calendar()


def _today() -> date:
    return datetime.now(BAKU).date()


def _current_week() -> date:
    return week_start_of(_today())


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


def _set_role(authed, db, role: str) -> None:
    user_id = authed.get("/api/auth/me").json()["id"]
    membership = db.scalar(select(Membership).where(Membership.user_id == user_id))
    membership.role = role
    db.flush()


def _project(authed, db, *, calendar_mode: bool = True) -> tuple[str, str]:
    project_id = authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]
    category_id = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "create_category", "name": "Design", "color": "#3b82f6"}},
    ).json()["op"]["category_id"]
    if calendar_mode:
        project = db.get(Project, uuid.UUID(project_id))
        project.schedule_mode = "calendar"
        project.start_date = _today() - timedelta(days=60)
        db.flush()
    return project_id, category_id


def _task(authed, project_id, category_id, *, name="Task", start: date, duration=1, **extra):
    response = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {
                "type": "create_task",
                "category_id": category_id,
                "name": name,
                "start_date": start.isoformat(),
                "duration_days": duration,
                **extra,
            }
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["op"]["task_id"]


def _metric(state: dict, key: str) -> dict:
    return next(m for m in state["metrics"] if m["key"] == key)


def _snapshot(db, project_id, key, week_start):
    return db.scalar(
        select(ScorecardSnapshot).where(
            ScorecardSnapshot.project_id == uuid.UUID(project_id),
            ScorecardSnapshot.metric_key == key,
            ScorecardSnapshot.week_start == week_start,
        )
    )


def _overdue_workdays(end: date) -> int:
    return count_working_days(end + timedelta(days=1), _today(), WORKWEEK)


# --- статусы ------------------------------------------------------------------


def test_status_thresholds_for_lte_metrics():
    target = Decimal("2")
    assert metric_status(Decimal("2"), target, "lte") == "ok"
    assert metric_status(Decimal("3"), target, "lte") == "warn"
    assert metric_status(Decimal("4"), target, "lte") == "warn"
    assert metric_status(Decimal("5"), target, "lte") == "risk"


def test_status_thresholds_for_lte_with_zero_target():
    zero = Decimal("0")
    assert metric_status(Decimal("0"), zero, "lte") == "ok"
    assert metric_status(Decimal("1"), zero, "lte") == "warn"
    assert metric_status(Decimal("2"), zero, "lte") == "warn"
    assert metric_status(Decimal("3"), zero, "lte") == "risk"


def test_status_thresholds_for_gte_metrics():
    target = Decimal("1.0")
    assert metric_status(Decimal("1"), target, "gte") == "ok"
    assert metric_status(Decimal("0.8"), target, "gte") == "warn"
    assert metric_status(Decimal("0.75"), target, "gte") == "warn"
    assert metric_status(Decimal("0.74"), target, "gte") == "risk"
    assert metric_status(None, target, "gte") == "no_data"


def test_week_attribution_respects_project_timezone():
    """Воскресенье 21:00 UTC — это уже понедельник в Баку (+4): метка обязана
    попасть в следующую неделю, а не в прошедшую."""
    monday = date(2026, 8, 17)
    stamp = datetime(2026, 8, 16, 21, 0, tzinfo=timezone.utc)
    assert _in_week(stamp, monday, BAKU) is True
    assert _in_week(stamp, monday - timedelta(days=7), BAKU) is False


# --- первый GET и идемпотентность --------------------------------------------


def test_first_get_seeds_configs_and_snapshots_idempotently(authed, db):
    project_id, _ = _project(authed, db)

    first = authed.get(f"/api/projects/{project_id}/scorecard")
    assert first.status_code == 200
    keys = [m["key"] for m in first.json()["metrics"]]
    assert keys == [
        "overdue_tasks", "finish_drift", "scope_growth", "date_shifts",
        "close_rate", "stale_in_progress", "data_quality",
    ]
    assert "daily" not in first.json()
    assert first.json()["outlook"] == {"projected_finish": None, "milestone": None}

    second = authed.get(f"/api/projects/{project_id}/scorecard")
    assert second.status_code == 200
    configs = db.scalars(
        select(ScorecardMetric).where(
            ScorecardMetric.project_id == uuid.UUID(project_id)
        )
    ).all()
    assert len(configs) == 7
    snapshots = db.scalars(
        select(ScorecardSnapshot).where(
            ScorecardSnapshot.project_id == uuid.UUID(project_id)
        )
    ).all()
    assert len(snapshots) == 7
    assert {s.week_start for s in snapshots} == {_current_week()}


# --- метрики ------------------------------------------------------------------


def test_overdue_count_and_average_in_working_days(authed, db):
    project_id, category_id = _project(authed, db)
    first_end = _today() - timedelta(days=14)
    second_end = _today() - timedelta(days=7)
    _task(authed, project_id, category_id, name="Late A", start=first_end)
    _task(authed, project_id, category_id, name="Late B", start=second_end)
    _task(authed, project_id, category_id, name="Future", start=_today() + timedelta(days=30))
    _task(
        authed, project_id, category_id, name="Closed late",
        start=first_end, status="done",
    )

    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    overdue = _metric(state, "overdue_tasks")
    assert overdue["value"] == 2
    assert overdue["status"] == "ok"

    # Средняя просрочка вкатана в строку overdue: тот же факт, не отдельная
    # метрика. Дата окончания однодневной задачи — первый рабочий день от
    # старта; средняя — среднее по рабочим дням от него до сегодня.
    from app.calendar import end_date

    ends = [end_date(first_end, 1, WORKWEEK), end_date(second_end, 1, WORKWEEK)]
    expected = sum(_overdue_workdays(end) for end in ends) / 2
    assert overdue["avg_days"] == pytest.approx(expected, abs=0.01)


def test_close_rate_counts_done_against_due_this_week(authed, db):
    project_id, category_id = _project(authed, db)
    monday = _current_week()
    _task(authed, project_id, category_id, name="Due", start=monday)
    done_id = _task(authed, project_id, category_id, name="Done", start=monday)
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "set_status", "task_id": done_id, "status": "done"}},
    )

    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    close_rate = _metric(state, "close_rate")
    assert close_rate["value"] == 0.5
    assert close_rate["status"] == "risk"


def test_close_rate_dead_week_is_no_data(authed, db):
    """Ничего не в срок и ничего не закрыто — не 1.0, а no_data: о мёртвой
    неделе нечего сказать, а не «всё в норме»."""
    project_id, category_id = _project(authed, db)
    _task(authed, project_id, category_id, name="Far", start=_today() + timedelta(days=60))

    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    assert _metric(state, "close_rate")["value"] is None
    assert _metric(state, "close_rate")["status"] == "no_data"


def test_close_rate_with_work_but_nothing_due_is_ok(authed, db):
    """Ничего не было в срок, но что-то закрыто — 1.0: неделя без обещаний с
    работой не проваливается."""
    project_id, category_id = _project(authed, db)
    done_id = _task(
        authed, project_id, category_id, name="Done early",
        start=_today() + timedelta(days=60),
    )
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "set_status", "task_id": done_id, "status": "done"}},
    )

    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    assert _metric(state, "close_rate")["value"] == 1.0
    assert _metric(state, "close_rate")["status"] == "ok"


def test_stale_in_progress_counts_only_long_running_tasks(authed, db):
    project_id, category_id = _project(authed, db)
    stale_id = _task(authed, project_id, category_id, name="Stuck", start=_today())
    fresh_id = _task(authed, project_id, category_id, name="Fresh", start=_today())
    for task_id in (stale_id, fresh_id):
        authed.post(
            f"/api/projects/{project_id}/mutations",
            json={"op": {"type": "set_status", "task_id": task_id, "status": "in_progress"}},
        )
    stale = db.get(Task, uuid.UUID(stale_id))
    stale.in_progress_since = datetime.now(timezone.utc) - timedelta(days=30)
    db.flush()

    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    metric = _metric(state, "stale_in_progress")
    assert metric["value"] == 1
    tasks = state and authed.get(
        f"/api/projects/{project_id}/scorecard/metrics/stale_in_progress/tasks"
    ).json()["details"]["tasks"]
    assert [t["name"] for t in tasks] == ["Stuck"]
    assert tasks[0]["in_progress_days"] > 5


def test_data_quality_unassigned_ignores_milestones(authed, db):
    """Веху не исполняют — она не «без исполнителя»: в счёт качества по
    незаполненному исполнителю идёт только обычная задача."""
    project_id, category_id = _project(authed, db)
    _task(authed, project_id, category_id, name="Plain", start=_today())
    _task(
        authed, project_id, category_id, name="Milestone", start=_today(), milestone=True
    )

    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    assert state["data_quality"]["unassigned"] == 1


def test_date_shifts_count_journal_operations_over_threshold(authed, db):
    project_id, category_id = _project(authed, db)
    start = _today() + timedelta(days=10)
    task_id = _task(authed, project_id, category_id, name="Movable", start=start)
    # Порог по умолчанию — 2 дня: сдвиг на 3 дня считается, на 1 день — нет.
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {
                "type": "move_task",
                "task_id": task_id,
                "start_date": (start + timedelta(days=3)).isoformat(),
            }
        },
    )
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {
                "type": "move_task",
                "task_id": task_id,
                "start_date": (start + timedelta(days=4)).isoformat(),
            }
        },
    )

    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    assert _metric(state, "date_shifts")["value"] == 1


def test_data_quality_counts_unassigned_and_untouched_ai_tasks(authed, db):
    project_id, category_id = _project(authed, db)
    _task(authed, project_id, category_id, name="No assignee", start=_today())
    ai_task_id = _task(authed, project_id, category_id, name="From AI", start=_today())
    user_id = authed.get("/api/auth/me").json()["id"]
    org_id = db.scalar(select(Project.org_id).where(Project.id == uuid.UUID(project_id)))
    session = AiSession(org_id=org_id)
    db.add(session)
    db.flush()
    ai_task = db.get(Task, uuid.UUID(ai_task_id))
    ai_task.created_by_ai_session_id = session.id
    db.flush()
    for task_id in (ai_task_id,):
        authed.post(
            f"/api/projects/{project_id}/mutations",
            json={"op": {"type": "assign_user", "task_id": task_id, "user_id": user_id}},
        )

    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    quality = _metric(state, "data_quality")
    # Две задачи, обе непригодны: одна без исполнителя, вторая — созданная AI
    # с нетронутыми датами. Значение — ноль процентов.
    assert quality["value"] == 0.0
    dq = state["data_quality"]
    assert dq["unassigned"] == 1
    assert dq["unreal_deadline"] == 1
    # Чек-лист сходится: unassigned + unreal − both == affected. Причины
    # разные, пересечения нет.
    assert dq["both"] == 0
    assert dq["affected"] == 2
    assert dq["unassigned"] + dq["unreal_deadline"] - dq["both"] == dq["affected"]


def test_relative_project_reports_no_data_for_dated_metrics(authed, db):
    project_id, category_id = _project(authed, db, calendar_mode=False)
    _task(authed, project_id, category_id, name="Offset task", start=date(2001, 1, 1))

    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    # Метрики, завязанные на настоящие даты, у относительного плана без данных.
    for key in ("overdue_tasks", "finish_drift", "close_rate"):
        assert _metric(state, key)["status"] == "no_data", key
    # scope_growth и качество считаются по журналу/состоянию, а не по датам —
    # у относительного плана они живые.
    assert _metric(state, "scope_growth")["value"] == 1
    assert state["data_quality"]["unassigned"] == 1


# --- фиксация недель ----------------------------------------------------------


def test_lazy_fixation_backfills_missing_weeks(authed, db):
    project_id, category_id = _project(authed, db)
    _task(authed, project_id, category_id, name="Late", start=_today() - timedelta(days=30))
    week = _current_week()
    db.add(
        ScorecardSnapshot(
            project_id=uuid.UUID(project_id),
            metric_key="overdue_tasks",
            week_start=week - timedelta(days=21),
            value=Decimal("1"),
            target_value=Decimal("2"),
            direction="lte",
            status="ok",
            details={},
        )
    )
    db.flush()

    assert authed.get(f"/api/projects/{project_id}/scorecard").status_code == 200

    for missing in (week - timedelta(days=14), week - timedelta(days=7)):
        rows = db.scalars(
            select(ScorecardSnapshot).where(
                ScorecardSnapshot.project_id == uuid.UUID(project_id),
                ScorecardSnapshot.week_start == missing,
            )
        ).all()
        assert len(rows) == 7, missing
        by_key = {row.metric_key: row for row in rows}
        assert by_key["overdue_tasks"].details.get("backfilled") is True
        assert by_key["overdue_tasks"].computed_by is None
        # Журнальные метрики восстановлены точно — без пометки.
        assert "backfilled" not in by_key["date_shifts"].details
        assert "backfilled" not in by_key["close_rate"].details
        assert "backfilled" not in by_key["scope_growth"].details
        # finish_drift без базы для сравнения — no_data и помечен как дозапись.
        assert by_key["finish_drift"].value is None
        assert by_key["finish_drift"].details.get("backfilled") is True


def test_past_snapshots_are_immutable(authed, db):
    project_id, _ = _project(authed, db)
    week = _current_week() - timedelta(days=7)
    db.add(
        ScorecardSnapshot(
            project_id=uuid.UUID(project_id),
            metric_key="overdue_tasks",
            week_start=week,
            value=Decimal("42"),
            target_value=Decimal("2"),
            direction="lte",
            status="risk",
            details={"tasks": []},
        )
    )
    db.flush()

    response = authed.post(f"/api/projects/{project_id}/scorecard/recalculate")
    assert response.status_code == 200

    row = _snapshot(db, project_id, "overdue_tasks", week)
    assert row.value == Decimal("42")
    assert row.status == "risk"


# --- правило и события --------------------------------------------------------


def _seed_risk_week(db, project_id: str, key: str, week: date) -> None:
    db.add(
        ScorecardSnapshot(
            project_id=uuid.UUID(project_id),
            metric_key=key,
            week_start=week,
            value=Decimal("5"),
            target_value=Decimal("0"),
            direction="lte",
            status="risk",
            details={},
        )
    )
    db.flush()


def test_rule_creates_task_once_per_risk_series(authed, db):
    project_id, category_id = _project(authed, db)
    # Три глубоко просроченные задачи при цели 0 держат overdue красной.
    for n in range(3):
        _task(
            authed, project_id, category_id, name=f"Late {n}",
            start=_today() - timedelta(days=30),
        )
    _seed_risk_week(db, project_id, "overdue_tasks", _current_week() - timedelta(days=7))
    user_id = authed.get("/api/auth/me").json()["id"]
    # Конфиг заводится до первого GET скоркарда: ensure_metrics увидит его
    # готовым (цель 0, владелец) и не пересеет дефолтом.
    config = ScorecardMetric(
        project_id=uuid.UUID(project_id),
        metric_key="overdue_tasks",
        owner_user_id=uuid.UUID(user_id),
        target_value=Decimal("0"),
        direction="lte",
        enabled=True,
        position=0,
    )
    db.add(config)
    db.flush()

    assert authed.get(f"/api/projects/{project_id}/scorecard").status_code == 200

    created = db.scalars(
        select(Task).where(
            Task.project_id == uuid.UUID(project_id),
            Task.name.like("Araşdır: Gecikmiş%"),
        )
    ).all()
    # Организация с дефолтной локалью az: «Araşdır: Gecikmiş tapşırıqlar».
    assert len(created) == 1
    state = authed.post(f"/api/projects/{project_id}/scorecard/recalculate").json()
    created = db.scalars(
        select(Task).where(
            Task.project_id == uuid.UUID(project_id),
            Task.name.like("Araşdır: Gecikmiş%"),
        )
    ).all()
    assert len(created) == 1, "повтор внутри серии обязан подавляться"
    rule_alerts = [
        a
        for a in state["alerts"]
        if a["kind"] == "rule_triggered" and a["metric_key"] == "overdue_tasks"
    ]
    assert len(rule_alerts) == 1
    assert rule_alerts[0]["payload"]["task_id"] == str(created[0].id)


def test_rule_needs_two_consecutive_risk_weeks(authed, db):
    project_id, category_id = _project(authed, db)
    # Пять просроченных при цели по умолчанию 2 — красная неделя, но только одна.
    for n in range(5):
        _task(
            authed, project_id, category_id, name=f"Late {n}",
            start=_today() - timedelta(days=30),
        )

    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    assert _metric(state, "overdue_tasks")["status"] == "risk"
    assert not [a for a in state["alerts"] if a["kind"] == "rule_triggered"]
    created = db.scalars(
        select(Task).where(
            Task.project_id == uuid.UUID(project_id), Task.name.like("Araşdır:%")
        )
    ).all()
    assert created == []


def test_metric_risk_alert_carries_top_overdue_and_resolves(authed, db):
    project_id, category_id = _project(authed, db)
    task_ids = [
        _task(
            authed, project_id, category_id, name=f"Late {n}",
            start=_today() - timedelta(days=30 + n),
        )
        for n in range(5)
    ]

    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    risk = [
        a
        for a in state["alerts"]
        if a["kind"] == "metric_risk" and a["metric_key"] == "overdue_tasks"
    ]
    assert len(risk) == 1
    assert risk[0]["payload"]["total"] == 5
    assert len(risk[0]["payload"]["tasks"]) == 3

    for task_id in task_ids:
        authed.post(
            f"/api/projects/{project_id}/mutations",
            json={"op": {"type": "set_status", "task_id": task_id, "status": "done"}},
        )
    after = authed.post(f"/api/projects/{project_id}/scorecard/recalculate").json()
    assert not [
        a
        for a in after["alerts"]
        if a["kind"] == "metric_risk" and a["metric_key"] == "overdue_tasks"
    ]
    resolved = db.scalars(
        select(ScorecardAlert).where(
            ScorecardAlert.project_id == uuid.UUID(project_id),
            ScorecardAlert.metric_key == "overdue_tasks",
        )
    ).all()
    assert all(a.resolved_at is not None for a in resolved)


def test_metric_risk_alert_carries_delta_and_top_assignee(authed, db):
    project_id, category_id = _project(authed, db)
    user_id = authed.get("/api/auth/me").json()["id"]
    ids = [
        _task(
            authed, project_id, category_id, name=f"Late {n}",
            start=_today() - timedelta(days=30 + n),
        )
        for n in range(5)
    ]
    for task_id in ids:
        authed.post(
            f"/api/projects/{project_id}/mutations",
            json={"op": {"type": "assign_user", "task_id": task_id, "user_id": user_id}},
        )
    # Прошлая неделя была спокойнее — есть от чего считать дельту.
    db.add(
        ScorecardSnapshot(
            project_id=uuid.UUID(project_id),
            metric_key="overdue_tasks",
            week_start=_current_week() - timedelta(days=7),
            value=Decimal("2"),
            target_value=Decimal("2"),
            direction="lte",
            status="ok",
            details={},
        )
    )
    db.flush()

    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    risk = next(
        a
        for a in state["alerts"]
        if a["kind"] == "metric_risk" and a["metric_key"] == "overdue_tasks"
    )
    assert risk["payload"]["delta"] == 3.0  # 5 просроченных против 2 неделю назад
    assert risk["payload"]["top_assignee"] == {"name": "Alex", "count": 5}


# --- новые метрики: прогноз финиша и объём -----------------------------------


def test_finish_drift_measures_shift_from_last_week(authed, db):
    from app.calendar import end_date

    project_id, category_id = _project(authed, db)
    start = _today() + timedelta(days=20)
    _task(authed, project_id, category_id, name="Tail", start=start, duration=1)
    projected = end_date(start, 1, WORKWEEK)
    previous = projected - timedelta(days=7)
    db.add(
        ScorecardSnapshot(
            project_id=uuid.UUID(project_id),
            metric_key="finish_drift",
            week_start=_current_week() - timedelta(days=7),
            value=Decimal("0"),
            target_value=Decimal("0"),
            direction="lte",
            status="ok",
            details={"projected_finish": previous.isoformat()},
        )
    )
    db.flush()

    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    drift = _metric(state, "finish_drift")
    expected = count_working_days(previous + timedelta(days=1), projected, WORKWEEK)
    assert drift["value"] == expected
    snap = _snapshot(db, project_id, "finish_drift", _current_week())
    assert snap.details["projected_finish"] == projected.isoformat()
    assert snap.details["previous_finish"] == previous.isoformat()


def test_finish_drift_without_baseline_is_no_data(authed, db):
    project_id, category_id = _project(authed, db)
    _task(authed, project_id, category_id, name="Tail", start=_today() + timedelta(days=20))

    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    drift = _metric(state, "finish_drift")
    # Первая неделя без прошлого снимка — дрейф неизмерим, но прогноз зафиксирован.
    assert drift["value"] is None
    assert drift["status"] == "no_data"
    snap = _snapshot(db, project_id, "finish_drift", _current_week())
    assert snap.details["projected_finish"] is not None


def test_scope_growth_nets_created_against_closed(authed, db):
    project_id, category_id = _project(authed, db)
    ids = [
        _task(authed, project_id, category_id, name=f"New {n}", start=_today())
        for n in range(5)
    ]
    for task_id in ids[:2]:
        authed.post(
            f"/api/projects/{project_id}/mutations",
            json={"op": {"type": "set_status", "task_id": task_id, "status": "done"}},
        )

    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    scope = _metric(state, "scope_growth")
    assert scope["value"] == 3  # 5 создано − 2 закрыто
    assert scope["added_count"] == 5
    assert scope["closed_count"] == 2


def test_scope_growth_keeps_deleted_task_name_from_journal(authed, db):
    project_id, category_id = _project(authed, db)
    task_id = _task(authed, project_id, category_id, name="Ephemeral", start=_today())
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "delete_task", "task_id": task_id}},
    )

    details = authed.get(
        f"/api/projects/{project_id}/scorecard/metrics/scope_growth/tasks"
    ).json()["details"]
    # Задача создана и удалена на этой неделе — как добавление она случилась,
    # имя берётся из журнала, раз в плане её больше нет.
    assert [t["name"] for t in details["added"]] == ["Ephemeral"]


def test_scope_growth_ignores_undo_restore(authed, db):
    project_id, category_id = _project(authed, db)
    task_id = _task(authed, project_id, category_id, name="Solid", start=_today())
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "delete_task", "task_id": task_id}},
    )
    # Отмена удаления возвращает задачу записью create_task с undoes_seq —
    # это восстановление, а не новый объём: добавлений по-прежнему одно.
    assert authed.post(f"/api/projects/{project_id}/undo").status_code == 201

    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    assert _metric(state, "scope_growth")["added_count"] == 1


def test_removed_metric_config_and_alert_are_hidden(authed, db):
    project_id, _ = _project(authed, db)
    authed.get(f"/api/projects/{project_id}/scorecard")  # сеет актуальные конфиги
    # Осиротевшие строки снятой метрики (как до миграции): конфиг и открытое
    # событие. Приложение не показывает ни то, ни другое.
    db.add(
        ScorecardMetric(
            project_id=uuid.UUID(project_id),
            metric_key="unassigned_tasks",
            target_value=Decimal("0"),
            direction="lte",
            enabled=True,
            position=99,
        )
    )
    db.add(
        ScorecardAlert(
            project_id=uuid.UUID(project_id),
            metric_key="unassigned_tasks",
            week_start=_current_week(),
            kind="metric_risk",
            payload={},
        )
    )
    db.flush()

    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    assert all(m["key"] != "unassigned_tasks" for m in state["metrics"])
    assert all(a["metric_key"] != "unassigned_tasks" for a in state["alerts"])


# --- API: права, пределы, настройка ------------------------------------------


def test_recalculate_is_rate_limited_per_project(authed, db):
    project_id, _ = _project(authed, db)
    assert authed.post(f"/api/projects/{project_id}/scorecard/recalculate").status_code == 200
    assert authed.post(f"/api/projects/{project_id}/scorecard/recalculate").status_code == 429


def test_viewer_may_read_but_not_write(authed, db):
    project_id, _ = _project(authed, db)
    _set_role(authed, db, "viewer")

    assert authed.get(f"/api/projects/{project_id}/scorecard").status_code == 200
    assert (
        authed.post(f"/api/projects/{project_id}/scorecard/recalculate").status_code
        == 403
    )
    assert (
        authed.patch(
            f"/api/projects/{project_id}/scorecard/metrics/overdue_tasks",
            json={"target_value": 10},
        ).status_code
        == 403
    )


def test_foreign_project_scorecard_is_hidden(authed, db):
    other_org = Organization(name="Globex", slug="globex")
    db.add(other_org)
    db.flush()
    foreign = Project(org_id=other_org.id, name="Secret", slug="secret")
    db.add(foreign)
    db.flush()

    assert authed.get(f"/api/projects/{foreign.id}/scorecard").status_code == 404


def test_patch_updates_target_owner_and_enabled(authed, db):
    project_id, category_id = _project(authed, db)
    for n in range(3):
        _task(authed, project_id, category_id, name=f"Late {n}",
              start=_today() - timedelta(days=30))
    user_id = authed.get("/api/auth/me").json()["id"]

    state = authed.patch(
        f"/api/projects/{project_id}/scorecard/metrics/overdue_tasks",
        json={"target_value": 10, "owner_user_id": user_id},
    ).json()
    metric = _metric(state, "overdue_tasks")
    assert metric["target"] == 10
    assert metric["owner"] == {"id": user_id, "name": "Alex"}
    assert metric["status"] == "ok"

    disabled = authed.patch(
        f"/api/projects/{project_id}/scorecard/metrics/close_rate",
        json={"enabled": False},
    ).json()
    assert _metric(disabled, "close_rate")["status"] == "no_data"
    assert _metric(disabled, "close_rate")["enabled"] is False


def test_patch_refuses_owner_outside_the_organization(authed, db):
    project_id, _ = _project(authed, db)
    stranger = User(email="stranger@example.com", password_hash="x", name="Stranger")
    db.add(stranger)
    db.flush()

    response = authed.patch(
        f"/api/projects/{project_id}/scorecard/metrics/overdue_tasks",
        json={"owner_user_id": str(stranger.id)},
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "user_not_in_organization"


def test_patch_unknown_metric_is_404(authed, db):
    project_id, _ = _project(authed, db)
    response = authed.patch(
        f"/api/projects/{project_id}/scorecard/metrics/made_up",
        json={"target_value": 1},
    )
    assert response.status_code == 404


def test_metric_tasks_reads_past_weeks_from_the_snapshot(authed, db):
    project_id, category_id = _project(authed, db)
    _task(authed, project_id, category_id, name="Late", start=_today() - timedelta(days=30))
    week = _current_week() - timedelta(days=7)
    db.add(
        ScorecardSnapshot(
            project_id=uuid.UUID(project_id),
            metric_key="overdue_tasks",
            week_start=week,
            value=Decimal("1"),
            target_value=Decimal("2"),
            direction="lte",
            status="ok",
            details={"tasks": [{"id": "x", "name": "Frozen"}]},
        )
    )
    db.flush()

    current = authed.get(
        f"/api/projects/{project_id}/scorecard/metrics/overdue_tasks/tasks"
    ).json()
    assert [t["name"] for t in current["details"]["tasks"]] == ["Late"]

    past = authed.get(
        f"/api/projects/{project_id}/scorecard/metrics/overdue_tasks/tasks",
        params={"week": week.isoformat()},
    ).json()
    assert past["details"]["tasks"] == [{"id": "x", "name": "Frozen"}]

    future = authed.get(
        f"/api/projects/{project_id}/scorecard/metrics/overdue_tasks/tasks",
        params={"week": (week + timedelta(days=70)).isoformat()},
    )
    assert future.status_code == 422


# --- метки времени статуса ----------------------------------------------------


def test_done_at_is_stamped_and_cleared_by_status_mutations(authed, db):
    project_id, category_id = _project(authed, db)
    task_id = _task(authed, project_id, category_id, name="Flow", start=_today())
    task = db.get(Task, uuid.UUID(task_id))
    assert task.done_at is None

    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "set_status", "task_id": task_id, "status": "done"}},
    )
    assert task.done_at is not None

    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "set_status", "task_id": task_id, "status": "planned"}},
    )
    assert task.done_at is None

    # Связка «прогресс 100 — сделано» ставит метку тем же путём.
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "set_progress", "task_id": task_id, "progress_pct": 100}},
    )
    assert task.status == "done"
    assert task.done_at is not None


def test_in_progress_since_follows_status_transitions(authed, db):
    project_id, category_id = _project(authed, db)
    task_id = _task(authed, project_id, category_id, name="Flow", start=_today())
    task = db.get(Task, uuid.UUID(task_id))

    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "set_status", "task_id": task_id, "status": "in_progress"}},
    )
    assert task.in_progress_since is not None

    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "set_status", "task_id": task_id, "status": "blocked"}},
    )
    assert task.in_progress_since is None
