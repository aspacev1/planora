"""Маршруты коммерческого предложения: смета, реплики, перенос в план."""

import pytest
from fastapi.testclient import TestClient

from app.db import get_db
from app.main import app


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


def test_push_carries_risks_and_assumptions_into_the_internal_note(authed, project_id):
    """Риски и допущения строки не теряются при переносе: они складываются во
    внутреннюю заметку задачи под заголовками на языке организации. Описание
    при этом остаётся описанием — клиенту его показывать можно."""
    authed.patch("/api/org", json={"default_locale": "ru"})
    category_id = _category_id(authed, project_id, name="Дизайн")
    logo = _task_id(authed, project_id, category_id, name="Логотип")
    authed.patch(
        f"/api/projects/{project_id}/proposal/tasks/{logo}",
        json={
            "description": "Знак",
            "risks": "Правки затянутся",
            "assumptions": "Брендбук уже есть",
        },
    )
    # Одно поле пустое — заголовок пустого раздела не пишется.
    guide = _task_id(authed, project_id, category_id, name="Гайдлайн")
    authed.patch(
        f"/api/projects/{project_id}/proposal/tasks/{guide}",
        json={"assumptions": "  Шрифты куплены  "},
    )
    # Оба пустые — заметка пустая, а не пара голых заголовков.
    _task_id(authed, project_id, category_id, name="Иконки")

    response = authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")
    assert response.status_code == 201

    state = authed.get(f"/api/projects/{project_id}").json()
    by_name = {task["name"]: task for task in state["tasks"]}
    assert by_name["Логотип"]["description"] == "Знак"
    assert by_name["Логотип"]["internal_note"] == (
        "Риски:\nПравки затянутся\n\nДопущения:\nБрендбук уже есть"
    )
    assert by_name["Гайдлайн"]["internal_note"] == "Допущения:\nШрифты куплены"
    assert by_name["Иконки"]["internal_note"] == ""


def test_the_transferred_note_speaks_the_language_of_the_organization(authed, project_id):
    """Организация без выбранного языка пишет по-азербайджански — как правило
    скоркарда и письма: переводит тот, кто пишет, а пишет сервер."""
    category_id = _category_id(authed, project_id, name="Design")
    logo = _task_id(authed, project_id, category_id, name="Logo")
    authed.patch(
        f"/api/projects/{project_id}/proposal/tasks/{logo}",
        json={"risks": "Vendor is slow"},
    )
    authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")

    state = authed.get(f"/api/projects/{project_id}").json()
    assert state["tasks"][0]["internal_note"] == "Risklər:\nVendor is slow"


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
