"""Маршруты коммерческого предложения: смета, реплики, перенос в план."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import get_db
from app.main import app
from app.models import Membership


@pytest.fixture
def client(db):
    """Тот же паттерн, что в tests/test_comment_api.py: get_db отдаёт сессию
    фикстуры `db`, и внешняя транзакция откатывает всё после теста."""

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


def _task_id(authed, project_id: str, category_id: str, name: str = "Логотип") -> str:
    response = authed.post(
        f"/api/projects/{project_id}/proposal/categories/{category_id}/tasks",
        json={"name": name},
    )
    assert response.status_code == 201
    return response.json()["id"]


def test_untouched_project_answers_with_default_proposal(authed, project_id):
    """Проект без сметы отвечает значениями по умолчанию, а не 404: клиент не
    различает «не заводили» и «завели пустым», и различие это ему ни к чему."""
    state = authed.get(f"/api/projects/{project_id}/proposal").json()

    assert state == {
        "effort_unit": "days",
        "hours_per_day": 8,
        "tax_rate_pct": 0.0,
        "currency": "USD",
        "notes": "",
        "categories": [],
        # Счётчики плана — для карточки «Собрать из плана» на пустой смете.
        "plan": {"tasks": 0, "categories": 0},
    }


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
    # Цены в ответе нет намеренно: она равна effort × rate, и хранимая копия
    # разъехалась бы с сомножителями.
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
    # Код валюты нормализуется к верхнему регистру: он код, а не текст.
    assert state["currency"] == "EUR"
    # Не названное в запросе поле не тронуто.
    assert state["hours_per_day"] == 8


def test_category_carries_description_and_takes_patches(authed, project_id):
    """Описание раздела стоит на его строке в таблице — и правится отдельно
    от имени: patch меняет только присланные поля."""
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
    """Допущения и примечания — свойство предложения целиком, не строки."""
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
    """Строка чужой сметы неотличима от несуществующей — тем же принципом,
    что и задачи в маршрутах мутаций."""
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


def test_push_to_plan_turns_rows_into_tasks_as_one_batch(authed, project_id):
    """Перенос: раздел — категорией, строка — задачей, часы — днями вверх."""
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
    _task_id(authed, project_id, category_id, name="Гайдлайн")

    response = authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")
    assert response.status_code == 201
    assert response.json() == {"created_tasks": 2}

    state = authed.get(f"/api/projects/{project_id}").json()
    assert [category["name"] for category in state["categories"]] == ["Дизайн"]
    by_name = {task["name"]: task for task in state["tasks"]}
    # 20 часов при восьмичасовом дне — три календарных дня, вверх: полдня
    # работы всё равно занимают день в ленте.
    assert by_name["Логотип"]["duration_days"] == 3
    assert by_name["Логотип"]["description"] == "Знак"
    # Нулевая оценка — день: задач короче дня у диаграммы нет.
    assert by_name["Гайдлайн"]["duration_days"] == 1
    # Пачка отменяется одной кнопкой: у всех ревизий общий batch_id.
    revisions = authed.get(f"/api/projects/{project_id}/revisions").json()
    batches = {entry["batch_id"] for entry in revisions}
    assert len(batches) == 1 and batches != {None}


def test_second_push_reuses_the_plan_category_by_name(authed, project_id):
    category_id = _category_id(authed, project_id, name="Дизайн")
    _task_id(authed, project_id, category_id, name="Логотип")
    authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")

    _task_id(authed, project_id, category_id, name="Гайдлайн")
    authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")

    state = authed.get(f"/api/projects/{project_id}").json()
    # «Дизайн» один: повторный перенос не плодит одноимённых категорий.
    assert [category["name"] for category in state["categories"]] == ["Дизайн"]


def test_empty_proposal_refuses_to_push(authed, project_id):
    response = authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")
    assert response.status_code == 422
    assert response.json()["detail"] == "proposal_empty"


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
    """Категории считаются только с задачами: сборка пустые пропускает, и
    число на карточке обязано сойтись с числом заведённых разделов."""
    design = _plan_category(authed, project_id, "Дизайн")
    _plan_category(authed, project_id, "Пустая")
    _plan_task(authed, project_id, design, "Логотип", 2)
    _plan_task(authed, project_id, design, "Гайдлайн", 3)

    state = authed.get(f"/api/projects/{project_id}/proposal").json()
    assert state["plan"] == {"tasks": 2, "categories": 1}


def test_build_from_plan_turns_categories_into_sections_and_tasks_into_linked_rows(
    authed, project_id
):
    """Сборка: категория — разделом в порядке плана, задача — строкой с
    оценкой из длительности и ссылкой на задачу; роль и ставка пустые."""
    # Раздел «Разработка» заведён первым, но в плане стоит вторым: порядок
    # сметы берётся из position, а не из порядка создания.
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
    # Категория без задач разделом не стала: строка без суммы в смете молчит.
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
    # Порядок строк внутри раздела — порядок задач в плане.
    assert [row["name"] for row in state["categories"][0]["tasks"]] == ["Логотип", "Гайдлайн"]
    # Сборка пишет только в смету: план и его журнал не тронуты.
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
    # Два дня по шесть часов — двенадцать часов.
    assert state["categories"][0]["tasks"][0]["effort"] == 12.0


def test_build_from_plan_refuses_a_proposal_that_already_has_rows(authed, project_id):
    design = _plan_category(authed, project_id, "Дизайн")
    _plan_task(authed, project_id, design, "Логотип", 2)
    category_id = _category_id(authed, project_id, name="Своё")
    _task_id(authed, project_id, category_id, name="Набрано руками")

    response = authed.post(f"/api/projects/{project_id}/proposal/build-from-plan")
    assert response.status_code == 422
    assert response.json()["detail"] == "proposal_not_empty"
    # Набранное руками на месте, и сборка ничего к нему не дописала.
    state = authed.get(f"/api/projects/{project_id}/proposal").json()
    assert [category["name"] for category in state["categories"]] == ["Своё"]


def test_build_from_plan_refuses_an_empty_plan(authed, project_id):
    _plan_category(authed, project_id, "Дизайн")

    response = authed.post(f"/api/projects/{project_id}/proposal/build-from-plan")
    assert response.status_code == 422
    assert response.json()["detail"] == "plan_empty"
    assert authed.get(f"/api/projects/{project_id}/proposal").json()["categories"] == []


def test_build_from_plan_needs_the_right_to_write(authed, db, project_id):
    """Право читать смету не даёт права её собирать — отказ на сервере, а не
    только спрятанная карточка."""
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
    """Строки, собранные из плана, помнят свои задачи — перенос заводит
    только то, чего в плане ещё нет."""
    design = _plan_category(authed, project_id, "Дизайн")
    _plan_task(authed, project_id, design, "Логотип", 2)
    _plan_task(authed, project_id, design, "Гайдлайн", 3)
    authed.post(f"/api/projects/{project_id}/proposal/build-from-plan")

    # Всё уже в плане — переносить нечего, и об этом говорится прямо.
    response = authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")
    assert response.status_code == 422
    assert response.json()["detail"] == "proposal_in_plan"

    # Дописанная руками строка — единственное, что перенос заведёт.
    state = authed.get(f"/api/projects/{project_id}/proposal").json()
    section_id = state["categories"][0]["id"]
    _task_id(authed, project_id, section_id, name="Вёрстка")

    response = authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")
    assert response.status_code == 201
    assert response.json() == {"created_tasks": 1}

    plan = authed.get(f"/api/projects/{project_id}").json()
    assert sorted(task["name"] for task in plan["tasks"]) == ["Вёрстка", "Гайдлайн", "Логотип"]
    assert [category["name"] for category in plan["categories"]] == ["Дизайн"]


def test_pushed_rows_remember_their_tasks_until_the_push_is_undone(authed, project_id):
    """Перенос связывает строку с созданной задачей: второй перенос той же
    сметы ничего не дублирует, а отмена переноса гасит ссылку и возвращает
    строку в число ещё не перенесённых."""
    category_id = _category_id(authed, project_id, name="Дизайн")
    _task_id(authed, project_id, category_id, name="Логотип")

    authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")
    state = authed.get(f"/api/projects/{project_id}/proposal").json()
    row = state["categories"][0]["tasks"][0]
    plan = authed.get(f"/api/projects/{project_id}").json()
    assert row["plan_task_id"] == plan["tasks"][0]["id"]

    repeated = authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")
    assert repeated.status_code == 422
    assert repeated.json()["detail"] == "proposal_in_plan"

    # Отмена переноса удаляет задачу — и база сама гасит ссылку.
    undo = authed.post(f"/api/projects/{project_id}/undo")
    assert undo.status_code in (200, 201), undo.text
    state = authed.get(f"/api/projects/{project_id}/proposal").json()
    assert state["categories"][0]["tasks"][0]["plan_task_id"] is None

    again = authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")
    assert again.status_code == 201
    assert again.json() == {"created_tasks": 1}
