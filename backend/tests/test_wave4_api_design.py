"""Регрессионные тесты волны 4: модель данных и дизайн API.

Идемпотентность, пагинация, обратимость плана, циклы связей, потолки входа,
раздельные «создать» и «перевыпустить» у публичной ссылки, /api/v1.
"""

from datetime import date

import pytest
from fastapi.testclient import TestClient

from app.calendar import Calendar, end_date
from app.db import get_db
from app.main import app


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


@pytest.fixture
def project_id(authed) -> str:
    return authed.post("/api/projects", json={"name": "Редизайн"}).json()["id"]


@pytest.fixture
def category_id(authed, project_id) -> str:
    return authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "create_category", "name": "Дизайн", "color": "#3b82f6"}},
    ).json()["op"]["category_id"]


def _create_task(authed, project_id, category_id, name="Логотип", start="2026-03-02"):
    return authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {
                "type": "create_task",
                "category_id": category_id,
                "name": name,
                "start_date": start,
                "duration_days": 5,
            }
        },
    ).json()["op"]["task_id"]


# --- 4.6: идемпотентность -----------------------------------------------------


def test_a_retried_mutation_applies_once(authed, project_id, category_id):
    task_id = _create_task(authed, project_id, category_id)
    move = {
        "op": {"type": "move_task", "task_id": task_id, "start_date": "2026-03-03"}
    }
    headers = {"Idempotency-Key": "move-once"}

    first = authed.post(
        f"/api/projects/{project_id}/mutations", json=move, headers=headers
    )
    second = authed.post(
        f"/api/projects/{project_id}/mutations", json=move, headers=headers
    )

    assert first.status_code == 201
    # Повтор получает тот же ответ — и не рождает вторую ревизию.
    assert second.json() == first.json()
    revisions = authed.get(f"/api/projects/{project_id}/revisions").json()
    assert [r["op"]["type"] for r in revisions].count("move_task") == 1


def test_a_retried_comment_does_not_duplicate(authed, project_id):
    body = {"body": "Одна реплика"}
    headers = {"Idempotency-Key": "say-once"}
    authed.post(f"/api/projects/{project_id}/comments", json=body, headers=headers)
    authed.post(f"/api/projects/{project_id}/comments", json=body, headers=headers)

    feed = authed.get(f"/api/projects/{project_id}/comments").json()
    assert len(feed) == 1


def test_share_create_and_rotate_are_separate_acts(authed, project_id):
    first = authed.post(f"/api/projects/{project_id}/share")
    assert first.status_code == 201
    url = first.json()["url"]

    # Повторное «создать» не убивает разосланный адрес.
    repeat = authed.post(f"/api/projects/{project_id}/share")
    assert repeat.status_code == 409
    assert repeat.json()["detail"] == "share_link_exists"
    assert authed.get(f"/api/projects/{project_id}/share").json()["url"] == url

    # Перевыпуск — отдельный, явно названный акт.
    rotated = authed.post(f"/api/projects/{project_id}/share/rotate")
    assert rotated.status_code == 201
    assert rotated.json()["url"] != url


# --- 4.7: пагинация -----------------------------------------------------------


def test_comments_paginate_backwards_with_a_cursor(authed, project_id):
    for number in range(5):
        authed.post(
            f"/api/projects/{project_id}/comments", json={"body": f"Реплика {number}"}
        )

    tail = authed.get(f"/api/projects/{project_id}/comments?limit=2").json()
    assert [c["body"] for c in tail] == ["Реплика 3", "Реплика 4"]

    older = authed.get(
        f"/api/projects/{project_id}/comments?limit=2&before={tail[0]['id']}"
    ).json()
    assert [c["body"] for c in older] == ["Реплика 1", "Реплика 2"]


def test_revisions_paginate_with_before_seq(authed, project_id, category_id):
    task_id = _create_task(authed, project_id, category_id)
    for day in (3, 4, 5):
        authed.post(
            f"/api/projects/{project_id}/mutations",
            json={
                "op": {
                    "type": "move_task",
                    "task_id": task_id,
                    "start_date": f"2026-03-0{day}",
                }
            },
        )

    page = authed.get(f"/api/projects/{project_id}/revisions?limit=2").json()
    seqs = [r["seq"] for r in page]
    assert seqs == [5, 4]

    older = authed.get(
        f"/api/projects/{project_id}/revisions?limit=2&before_seq={seqs[-1]}"
    ).json()
    assert [r["seq"] for r in older] == [3, 2]


# --- 4.5: обратимость утверждения плана ---------------------------------------


def test_a_plan_version_can_be_restored(authed, project_id, category_id):
    task_id = _create_task(authed, project_id, category_id)
    assert authed.post(f"/api/projects/{project_id}/plan/approvals").status_code == 201

    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {"type": "move_task", "task_id": task_id, "start_date": "2026-03-16"},
            "reason": "подрядчик сорвал срок",
        },
    )
    assert authed.post(f"/api/projects/{project_id}/plan/approvals").status_code == 201

    # Возврат к версии 1: базовый план снова обещает 2 марта.
    restored = authed.post(f"/api/projects/{project_id}/plan/approvals/1/restore")
    assert restored.status_code == 201
    assert restored.json()["restored_from"] == 1

    state = authed.get(f"/api/projects/{project_id}").json()
    task = next(t for t in state["tasks"] if t["id"] == task_id)
    assert task["baseline_start"] == "2026-03-02"

    missing = authed.post(f"/api/projects/{project_id}/plan/approvals/99/restore")
    assert missing.status_code == 404


# --- 4.11: циклы и внутренние проверки ----------------------------------------


def test_a_dependency_cycle_is_refused(authed, project_id, category_id):
    a = _create_task(authed, project_id, category_id, name="A")
    b = _create_task(authed, project_id, category_id, name="B")
    c = _create_task(authed, project_id, category_id, name="C")

    for pair in ((a, b), (b, c)):
        assert (
            authed.post(
                f"/api/projects/{project_id}/mutations",
                json={
                    "op": {
                        "type": "add_dependency",
                        "from_task_id": pair[0],
                        "to_task_id": pair[1],
                    }
                },
            ).status_code
            == 201
        )

    ring = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "add_dependency", "from_task_id": c, "to_task_id": a}},
    )
    assert ring.status_code == 422
    assert ring.json()["detail"] == "dependency_cycle"


def test_max_text_len_is_read_at_call_time(authed, project_id, category_id, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "max_text_len", 10)
    refused = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {
                "type": "create_task",
                "category_id": category_id,
                "name": "Логотип",
                "start_date": "2026-03-02",
                "duration_days": 5,
                "description": "одиннадцать символов и больше",
            }
        },
    )
    assert refused.status_code == 422


# --- 4.3: позиции внутри категории --------------------------------------------


def test_positions_number_rows_inside_their_category(authed, project_id):
    first_cat = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "create_category", "name": "Дизайн", "color": "#3b82f6"}},
    ).json()["op"]["category_id"]
    second_cat = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "create_category", "name": "Разработка", "color": "#111111"}},
    ).json()["op"]["category_id"]

    _create_task(authed, project_id, first_cat, name="А")
    _create_task(authed, project_id, first_cat, name="Б")
    _create_task(authed, project_id, second_cat, name="В")

    state = authed.get(f"/api/projects/{project_id}").json()
    by_category: dict[str, list[int]] = {}
    for task in state["tasks"]:
        by_category.setdefault(task["category_id"], []).append(task["position"])
    # В каждой категории нумерация своя и с нуля — раньше «В» получала бы
    # позицию 2, сквозную по проекту.
    assert sorted(by_category[first_cat]) == [0, 1]
    assert by_category[second_cat] == [0]


# --- 4.8: потолок тела --------------------------------------------------------


def test_an_oversized_body_is_refused_before_parsing(client, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "max_body_bytes", 100)
    refused = client.post(
        "/api/auth/login",
        content=b"x" * 200,
        headers={"Content-Type": "application/json"},
    )
    assert refused.status_code == 413


# --- 4.9: арифметика календаря ------------------------------------------------


def test_the_arithmetic_end_date_matches_the_day_by_day_walk():
    """Новая арифметика обязана быть неотличима от прежнего шага по дням."""
    cal = Calendar(
        holidays=frozenset({date(2026, 3, 20), date(2026, 4, 6)}),
        extra_workdays=frozenset({date(2026, 3, 21)}),
    )

    def slow_end(start: date, duration: int) -> date:
        d = start
        while not cal.is_working(d):
            d = date.fromordinal(d.toordinal() + 1)
        counted = 1
        while counted < duration:
            d = date.fromordinal(d.toordinal() + 1)
            if cal.is_working(d):
                counted += 1
        return d

    for start in (date(2026, 3, 2), date(2026, 3, 7), date(2026, 3, 20)):
        for duration in (1, 2, 5, 13, 40, 260):
            assert end_date(start, duration, cal) == slow_end(start, duration), (
                start,
                duration,
            )


# --- 4.10: /api/v1 ------------------------------------------------------------


def test_the_v1_prefix_is_an_alias(client):
    assert client.get("/api/v1/health").status_code == 200
    assert client.get("/api/v1/config").json() == client.get("/api/config").json()


def test_openapi_and_docs_live_under_api(client):
    assert client.get("/api/openapi.json").status_code == 200
    assert client.get("/api/docs").status_code == 200
