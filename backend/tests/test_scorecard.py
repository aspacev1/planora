"""The scorecard: metrics, statuses, lazy committing, the rule and the events.

Live computations are tied to "today" in the project's timezone, so the dates in the
tests are built from a real today (Asia/Baku — the organization's default), while the
assertions hold on to countable quantities rather than particular days of the week.
"""

import uuid
from datetime import date, datetime, time, timedelta, timezone
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
    ProjectAccess,
    Revision,
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


# --- statuses ------------------------------------------------------------------


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
    """Sunday 21:00 UTC is already Monday in Baku (+4): the timestamp must land in the
    next week rather than in the one that has passed."""
    monday = date(2026, 8, 17)
    stamp = datetime(2026, 8, 16, 21, 0, tzinfo=timezone.utc)
    assert _in_week(stamp, monday, BAKU) is True
    assert _in_week(stamp, monday - timedelta(days=7), BAKU) is False


# --- the first GET and idempotency ---------------------------------------------


def test_first_get_seeds_configs_and_snapshots_idempotently(authed, db):
    project_id, _ = _project(authed, db)

    first = authed.get(f"/api/projects/{project_id}/scorecard")
    assert first.status_code == 200
    keys = [m["key"] for m in first.json()["metrics"]]
    assert keys == [
        "overdue_tasks", "finish_drift", "scope_growth", "date_shifts",
        "close_rate", "stale_in_progress", "data_quality", "team_pace",
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
    assert len(configs) == 8
    snapshots = db.scalars(
        select(ScorecardSnapshot).where(
            ScorecardSnapshot.project_id == uuid.UUID(project_id)
        )
    ).all()
    assert len(snapshots) == 8
    assert {s.week_start for s in snapshots} == {_current_week()}


# --- the metrics ---------------------------------------------------------------


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

    # The average overdue is rolled into the overdue row: the same fact, not a separate
    # metric. A one-day task's finish date is the first working day from the start; the
    # average is the mean over the working days from it to today.
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
    """Nothing due and nothing closed is not 1.0 but no_data: there is nothing to say
    about a dead week, rather than "everything is within norm"."""
    project_id, category_id = _project(authed, db)
    _task(authed, project_id, category_id, name="Far", start=_today() + timedelta(days=60))

    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    assert _metric(state, "close_rate")["value"] is None
    assert _metric(state, "close_rate")["status"] == "no_data"


def test_close_rate_with_work_but_nothing_due_is_ok(authed, db):
    """Nothing was due but something was closed — 1.0: a week with no promises but with
    work in it does not fail."""
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
    """A milestone is not performed and so is not "unassigned": only an ordinary task
    counts towards quality on an unfilled assignee."""
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
    # The default threshold is 2 days: a shift of 3 days counts, one of 1 day does not.
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
    # Two tasks, both unusable: one with no assignee, the other created by AI with
    # untouched dates. The value is zero per cent.
    assert quality["value"] == 0.0
    dq = state["data_quality"]
    assert dq["unassigned"] == 1
    assert dq["unreal_deadline"] == 1
    # The checklist adds up: unassigned + unreal - both == affected. The reasons differ
    # and there is no intersection.
    assert dq["both"] == 0
    assert dq["affected"] == 2
    assert dq["unassigned"] + dq["unreal_deadline"] - dq["both"] == dq["affected"]


def test_relative_project_reports_no_data_for_dated_metrics(authed, db):
    project_id, category_id = _project(authed, db, calendar_mode=False)
    _task(authed, project_id, category_id, name="Offset task", start=date(2001, 1, 1))

    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    # Metrics tied to real dates have no data for a relative plan.
    for key in ("overdue_tasks", "finish_drift", "close_rate"):
        assert _metric(state, key)["status"] == "no_data", key
    # scope_growth and quality are computed from the journal/state rather than from dates
    # — for a relative plan they are live.
    assert _metric(state, "scope_growth")["value"] == 1
    assert state["data_quality"]["unassigned"] == 1


# --- committing weeks -----------------------------------------------------------


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
        assert len(rows) == 8, missing
        by_key = {row.metric_key: row for row in rows}
        assert by_key["overdue_tasks"].details.get("backfilled") is True
        assert by_key["overdue_tasks"].computed_by is None
        # The journal metrics are reconstructed exactly — with no mark.
        assert "backfilled" not in by_key["date_shifts"].details
        assert "backfilled" not in by_key["close_rate"].details
        assert "backfilled" not in by_key["scope_growth"].details
        # finish_drift with no base to compare against is no_data and marked as backfilled.
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


# --- the rule and the events -----------------------------------------------------


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
    # Three deeply overdue tasks against a target of 0 keep overdue red.
    for n in range(3):
        _task(
            authed, project_id, category_id, name=f"Late {n}",
            start=_today() - timedelta(days=30),
        )
    _seed_risk_week(db, project_id, "overdue_tasks", _current_week() - timedelta(days=7))
    user_id = authed.get("/api/auth/me").json()["id"]
    # The config is created before the first GET of the scorecard: ensure_metrics will see
    # it ready (target 0, an owner) and will not re-seed it with a default.
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
    # An organization with the default locale az: "Araşdır: Gecikmiş tapşırıqlar".
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
    # Five overdue against the default target of 2 — a red week, but only one.
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
    # The previous week was calmer — there is something to compute the delta from.
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
    assert risk["payload"]["delta"] == 3.0  # 5 overdue against 2 a week ago
    assert risk["payload"]["top_assignee"] == {"name": "Alex", "count": 5}


# --- the new metrics: the finish projection and scope ---------------------------


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
    # The first week with no previous snapshot — the drift is unmeasurable, but the projection is recorded.
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
    assert scope["value"] == 3  # 5 created - 2 closed
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
    # The task was created and deleted this week — as an addition it did happen, and the
    # name is taken from the journal since it is no longer in the plan.
    assert [t["name"] for t in details["added"]] == ["Ephemeral"]


def test_scope_growth_ignores_undo_restore(authed, db):
    project_id, category_id = _project(authed, db)
    task_id = _task(authed, project_id, category_id, name="Solid", start=_today())
    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "delete_task", "task_id": task_id}},
    )
    # Undoing a deletion brings the task back with a create_task entry carrying undoes_seq
    # — that is a restore rather than new scope: there is still one addition.
    assert authed.post(f"/api/projects/{project_id}/undo").status_code == 201

    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    assert _metric(state, "scope_growth")["added_count"] == 1


def test_removed_metric_config_and_alert_are_hidden(authed, db):
    project_id, _ = _project(authed, db)
    authed.get(f"/api/projects/{project_id}/scorecard")  # seeds the current configs
    # Orphaned rows of a removed metric (as before the migration): a config and an open
    # event. The application shows neither.
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


# --- API: permissions, limits, configuration ------------------------------------


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


# --- the status timestamps ------------------------------------------------------


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

    # The "progress 100 — done" coupling sets the timestamp the same way.
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


# --- the team's pace ------------------------------------------------------------


def _baku(day: date, hour: int) -> datetime:
    return datetime.combine(day, time(hour=hour), tzinfo=BAKU)


def _member(db, name: str, org_id) -> str:
    """A second person in the organization — with no sign-in, just a membership row: the
    owner makes them an assignee."""
    user = User(email=f"{name.lower()}@example.com", password_hash="x", name=name)
    db.add(user)
    db.flush()
    db.add(Membership(org_id=org_id, user_id=user.id, role="editor"))
    db.flush()
    return str(user.id)


def _mutate(authed, project_id: str, op: dict) -> dict:
    response = authed.post(f"/api/projects/{project_id}/mutations", json={"op": op})
    assert response.status_code == 201, response.text
    return response.json()


def _stamp_revision(db, seq: int, at: datetime) -> None:
    """Shift a journal entry's time: a test cannot wait for Monday."""
    revision = db.scalar(select(Revision).where(Revision.seq == seq))
    revision.created_at = at
    db.flush()


def _stamp_done(db, task_id: str, at: datetime) -> None:
    db.get(Task, uuid.UUID(task_id)).done_at = at
    db.flush()


def _person(team: dict, name: str) -> dict:
    return next(m for m in team["members"] if m["user"]["name"] == name)


def _org_id(db, project_id: str):
    return db.get(Project, uuid.UUID(project_id)).org_id


def test_team_pace_counts_done_extra_and_on_time_per_person(authed, db):
    """Alex: one of the week's two tasks is done on time, the second missed silently, plus
    one closed beyond the plan. Bob: his own task done late. The task with no assignee goes
    into the "unassigned" bucket rather than into a row."""
    project_id, category_id = _project(authed, db)
    week = _current_week()
    alex = authed.get("/api/auth/me").json()["id"]
    bob = _member(db, "Bob", _org_id(db, project_id))

    on_time = _task(authed, project_id, category_id, name="On time", start=week)
    silent = _task(authed, project_id, category_id, name="Silent", start=week)
    extra = _task(authed, project_id, category_id, name="Extra", start=week + timedelta(days=7))
    late = _task(authed, project_id, category_id, name="Late", start=week)
    _task(authed, project_id, category_id, name="Nobody", start=week)
    for task_id in (on_time, silent, extra):
        _mutate(authed, project_id, {"type": "assign_user", "task_id": task_id, "user_id": alex})
    _mutate(authed, project_id, {"type": "assign_user", "task_id": late, "user_id": bob})
    for task_id in (on_time, extra, late):
        _mutate(authed, project_id, {"type": "set_status", "task_id": task_id, "status": "done"})
    _stamp_done(db, on_time, _baku(week, 9))
    _stamp_done(db, extra, _baku(week, 12))
    _stamp_done(db, late, _baku(week + timedelta(days=1), 10))

    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    assert state["summary"]["planned"] == 4
    assert state["summary"]["done"] == 2
    assert _metric(state, "team_pace")["value"] == 0.5

    team = state["team"]
    assert team["assessment"] is True
    assert team["unassigned_planned"] == 1
    assert [m["user"]["name"] for m in team["members"]] == ["Alex", "Bob"]

    me = _person(team, "Alex")
    assert (me["planned"], me["done"], me["extra"], me["on_time"]) == (2, 1, 1, 1)
    assert me["signal"] == "red"
    assert me["reason"] == {"kind": "overdue_silent", "count": 1}
    states = {t["name"]: t["state"] for t in me["tasks"]}
    assert states == {"On time": "done", "Silent": "late", "Extra": "done"}
    silent_entry = next(t for t in me["tasks"] if t["name"] == "Silent")
    assert silent_entry["warned"] is False

    other = _person(team, "Bob")
    assert (other["planned"], other["done"], other["on_time"]) == (1, 1, 0)
    assert other["signal"] == "green"
    assert next(t for t in other["tasks"])["late_days"] == 1
    # The trend's current week is what was done plus what was done beyond the plan.
    assert me["trend"][-1]["closed"] == 2
    assert len(me["trend"]) == 8


def test_team_pace_warning_before_deadline_turns_red_into_yellow(authed, db):
    """A flag before the deadline and a block before the deadline are a warning; a flag
    after the deadline and a retracted flag are not."""
    project_id, category_id = _project(authed, db)
    week = _current_week()
    alex = authed.get("/api/auth/me").json()["id"]
    before, after = _baku(week, 12), _baku(week + timedelta(days=1), 1)

    flagged = _task(authed, project_id, category_id, name="Flagged", start=week)
    blocked = _task(authed, project_id, category_id, name="Blocked", start=week)
    too_late = _task(authed, project_id, category_id, name="Too late", start=week)
    withdrawn = _task(authed, project_id, category_id, name="Withdrawn", start=week)
    for task_id in (flagged, blocked, too_late, withdrawn):
        _mutate(authed, project_id, {"type": "assign_user", "task_id": task_id, "user_id": alex})

    seq = _mutate(authed, project_id, {
        "type": "set_risk", "task_id": flagged, "risk": "yellow", "note": "жду доступ",
    })["seq"]
    _stamp_revision(db, seq, before)
    seq = _mutate(authed, project_id, {"type": "set_status", "task_id": blocked, "status": "blocked"})["seq"]
    _stamp_revision(db, seq, before)
    seq = _mutate(authed, project_id, {"type": "set_risk", "task_id": too_late, "risk": "red"})["seq"]
    _stamp_revision(db, seq, after)
    seq = _mutate(authed, project_id, {"type": "set_risk", "task_id": withdrawn, "risk": "yellow"})["seq"]
    _stamp_revision(db, seq, before)
    assert authed.post(f"/api/projects/{project_id}/undo").status_code == 201

    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    me = _person(state["team"], "Alex")
    by_name = {t["name"]: t for t in me["tasks"]}
    assert by_name["Flagged"]["warned"] is True and by_name["Flagged"]["warned_kind"] == "risk"
    assert by_name["Blocked"]["warned"] is True and by_name["Blocked"]["warned_kind"] == "blocked"
    assert by_name["Too late"]["warned"] is False
    assert by_name["Withdrawn"]["warned"] is False
    assert by_name["Flagged"]["risk"] == "yellow"
    # Two stayed silent — red; those who warned do not count as "silent".
    assert me["signal"] == "red"
    assert me["reason"] == {"kind": "overdue_silent", "count": 2}

    for task_id in (too_late, withdrawn):
        _mutate(authed, project_id, {"type": "set_status", "task_id": task_id, "status": "done"})
    state = authed.post(f"/api/projects/{project_id}/scorecard/recalculate").json()
    me = _person(state["team"], "Alex")
    assert me["signal"] == "yellow"
    assert me["reason"] == {"kind": "overdue_warned", "count": 2}


def test_team_pace_blocked_task_yellow_with_days_and_summary(authed, db):
    project_id, category_id = _project(authed, db)
    week = _current_week()
    alex = authed.get("/api/auth/me").json()["id"]
    # The deadline is far ahead: the task is not missed but standing blocked.
    task_id = _task(authed, project_id, category_id, name="Waiting", start=week + timedelta(days=21))
    _mutate(authed, project_id, {"type": "assign_user", "task_id": task_id, "user_id": alex})
    seq = _mutate(authed, project_id, {"type": "set_status", "task_id": task_id, "status": "blocked"})["seq"]
    since = week - timedelta(days=7)
    _stamp_revision(db, seq, _baku(since, 10))
    expected_days = count_working_days(since, _today(), WORKWEEK) - 1

    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    me = _person(state["team"], "Alex")
    assert me["signal"] == "yellow"
    assert me["reason"] == {
        "kind": "blocked", "task_id": task_id, "task": "Waiting", "days": expected_days,
    }
    assert state["summary"]["blocked"] == {
        "value": 1,
        "status": "warn",
        "longest": {"id": task_id, "name": "Waiting", "days": expected_days},
    }


def test_team_pace_reopened_task_is_yellow_but_undone_reopen_is_not(authed, db):
    project_id, category_id = _project(authed, db)
    week = _current_week()
    alex = authed.get("/api/auth/me").json()["id"]
    task_id = _task(authed, project_id, category_id, name="Invoice", start=week + timedelta(days=14))
    _mutate(authed, project_id, {"type": "assign_user", "task_id": task_id, "user_id": alex})
    _mutate(authed, project_id, {"type": "set_status", "task_id": task_id, "status": "done"})
    _mutate(authed, project_id, {"type": "set_status", "task_id": task_id, "status": "in_progress"})

    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    me = _person(state["team"], "Alex")
    assert me["signal"] == "yellow"
    assert me["reason"] == {"kind": "reopened", "task_id": task_id, "task": "Invoice"}
    assert me["tasks"][0]["reopened"] is True

    assert authed.post(f"/api/projects/{project_id}/undo").status_code == 201
    state = authed.post(f"/api/projects/{project_id}/scorecard/recalculate").json()
    me = _person(state["team"], "Alex")
    assert me["signal"] == "green"
    assert me["reason"] == {"kind": "in_pace"}


def test_team_pace_trend_reads_past_snapshots(authed, db):
    project_id, category_id = _project(authed, db)
    week = _current_week()
    alex = authed.get("/api/auth/me").json()["id"]
    task_id = _task(authed, project_id, category_id, name="Now", start=week)
    _mutate(authed, project_id, {"type": "assign_user", "task_id": task_id, "user_id": alex})
    _mutate(authed, project_id, {"type": "set_status", "task_id": task_id, "status": "done"})
    db.add(
        ScorecardSnapshot(
            project_id=uuid.UUID(project_id),
            metric_key="team_pace",
            week_start=week - timedelta(days=7),
            value=Decimal("1"),
            target_value=Decimal("0.8"),
            direction="gte",
            status="ok",
            details={"by_person": [{"user_id": alex, "name": "Alex", "done": 2, "extra": 1}]},
        )
    )
    db.flush()

    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    trend = _person(state["team"], "Alex")["trend"]
    assert trend[-2] == {"week_start": (week - timedelta(days=7)).isoformat(), "closed": 3}
    assert trend[-1] == {"week_start": week.isoformat(), "closed": 1}
    assert trend[0]["closed"] is None


def test_team_pace_never_raises_alerts_or_rule_tasks(authed, db):
    project_id, category_id = _project(authed, db)
    week = _current_week()
    _task(authed, project_id, category_id, name="Missed", start=week)
    _seed_risk_week(db, project_id, "team_pace", week - timedelta(days=7))

    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    assert _metric(state, "team_pace")["status"] == "risk"
    assert not [a for a in state["alerts"] if a["metric_key"] == "team_pace"]
    assert db.scalar(
        select(Task).where(Task.project_id == uuid.UUID(project_id), Task.name.like("%Темп%"))
    ) is None


def test_team_pace_visibility_follows_roles(authed, db):
    project_id, category_id = _project(authed, db)
    week = _current_week()
    alex = authed.get("/api/auth/me").json()["id"]
    task_id = _task(authed, project_id, category_id, name="Silent", start=week)
    _mutate(authed, project_id, {"type": "assign_user", "task_id": task_id, "user_id": alex})

    owner_view = authed.get(f"/api/projects/{project_id}/scorecard").json()["team"]
    assert owner_view["assessment"] is True
    assert _person(owner_view, "Alex")["signal"] == "red"

    for role in ("editor", "viewer"):
        _set_role(authed, db, role)
        view = authed.get(f"/api/projects/{project_id}/scorecard").json()["team"]
        assert view["assessment"] is False, role
        member = _person(view, "Alex")
        assert "signal" not in member and "reason" not in member, role
        assert member["planned"] == 1

    _set_role(authed, db, "client")
    db.add(ProjectAccess(project_id=uuid.UUID(project_id), user_id=uuid.UUID(alex)))
    db.flush()
    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    assert state["team"] is None
    assert state["summary"]["planned"] == 1


def test_team_pace_is_no_data_without_dates(authed, db):
    project_id, category_id = _project(authed, db, calendar_mode=False)
    _task(authed, project_id, category_id, name="Relative", start=date(2000, 1, 3))
    state = authed.get(f"/api/projects/{project_id}/scorecard").json()
    assert _metric(state, "team_pace")["value"] is None
    assert state["team"]["members"] == []
    assert state["summary"]["planned"] == 0
