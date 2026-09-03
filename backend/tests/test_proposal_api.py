"""Маршруты коммерческого предложения: смета, реплики, перенос в план."""

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

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


def _demote(authed, db, role: str) -> None:
    """Та же роль, что в tests/test_comment_api.py: членство правится в базе,
    потому что маршрута «понизить самого себя» у приложения нет."""
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
    """Проект без сметы отвечает значениями по умолчанию, а не 404: клиент не
    различает «не заводили» и «завели пустым», и различие это ему ни к чему."""
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
    """Ставки, себестоимость и разговор команды — не для клиента: план он
    читает, смету нет. Тот же урез, что уже действует у выгрузки, где раздел
    «Смета» вырезается из клиентского экземпляра."""
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
    """Подсказки ролей — по всей организации: ставка дизайнера одна на студию,
    и во втором проекте её не набирают заново. Последнее написание выигрывает,
    регистр и пробелы не плодят ролей, роль без ставки всё равно подсказана."""
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
    # Смета при этом по-прежнему пуста: план и предложение — разные списки.
    assert state["categories"] == []


def test_rows_start_without_a_plan_link(authed, project_id):
    category_id = _category_id(authed, project_id)
    _task_id(authed, project_id, category_id)

    state = authed.get(f"/api/projects/{project_id}/proposal").json()
    assert state["categories"][0]["tasks"][0]["plan_task_id"] is None
    assert state["pushed_count"] == 0
    # Строка без оценки не считается переносимой: нулевая оценка дала бы
    # однодневную задачу-заглушку, которой никто не заказывал.
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


def _estimated_task(authed, project_id: str, category_id: str, name: str, effort: float) -> str:
    task_id = _task_id(authed, project_id, category_id, name=name)
    authed.patch(f"/api/projects/{project_id}/proposal/tasks/{task_id}", json={"effort": effort})
    return task_id


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
    _estimated_task(authed, project_id, category_id, "Гайдлайн", effort=1)

    response = authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")
    assert response.status_code == 201
    assert response.json()["created_tasks"] == 2

    state = authed.get(f"/api/projects/{project_id}").json()
    assert [category["name"] for category in state["categories"]] == ["Дизайн"]
    by_name = {task["name"]: task for task in state["tasks"]}
    # 20 часов при восьмичасовом дне — три календарных дня, вверх: полдня
    # работы всё равно занимают день в ленте.
    assert by_name["Логотип"]["duration_days"] == 3
    assert by_name["Логотип"]["description"] == "Знак"
    # Час работы — тоже день: задач короче дня у диаграммы нет.
    assert by_name["Гайдлайн"]["duration_days"] == 1
    # Пачка отменяется одной кнопкой: у всех ревизий общий batch_id, и он же
    # назван в ответе — ради кнопки «Вернуть» в тосте.
    revisions = authed.get(f"/api/projects/{project_id}/revisions").json()
    batches = {entry["batch_id"] for entry in revisions}
    assert batches == {response.json()["batch_id"]}


def test_second_push_reuses_the_plan_category_by_name(authed, project_id):
    category_id = _category_id(authed, project_id, name="Дизайн")
    _estimated_task(authed, project_id, category_id, "Логотип", effort=2)
    authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")

    _estimated_task(authed, project_id, category_id, "Гайдлайн", effort=3)
    authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")

    state = authed.get(f"/api/projects/{project_id}").json()
    # «Дизайн» один: повторный перенос не плодит одноимённых категорий.
    assert [category["name"] for category in state["categories"]] == ["Дизайн"]


def test_second_push_skips_rows_already_in_plan(authed, project_id):
    """Перенесённая строка помнит свою задачу и второй раз в план не идёт:
    прежде два нажатия подряд удваивали план."""
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
    # Всё в плане — переносить нечего, и это отказ, а не тихий ноль.
    third = authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")
    assert third.status_code == 422
    assert third.json()["detail"] == "proposal_nothing_to_push"
    assert logo == rows["Логотип"]["id"]


def test_push_takes_only_the_named_rows(authed, project_id):
    """Окно переноса даёт снять галочку: переносятся названные строки, и
    только они. Чужая строка в списке — 404, как везде."""
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
    """Нулевая оценка в план по умолчанию не идёт — задача из неё вышла бы
    однодневной заглушкой. Названная явно, она переносится: решает человек."""
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
    """«Вернуть» в тосте снимает пачку целиком: задачи исчезают, ссылки строк
    обнуляются базой (SET NULL), и строки снова переносимы."""
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
    """Заметки, риски и допущения строки не теряются при переносе: они уходят
    во внутреннюю заметку задачи — поле, которого клиент не видит."""
    category_id = _category_id(authed, project_id, name="Дизайн")
    logo = _estimated_task(authed, project_id, category_id, "Логотип", effort=2)
    authed.patch(
        f"/api/projects/{project_id}/proposal/tasks/{logo}",
        json={"risks": "Правки затянутся", "assumptions": "Брендбук есть"},
    )

    authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")

    task = authed.get(f"/api/projects/{project_id}").json()["tasks"][0]
    # Организация Acme создана регистрацией с языком по умолчанию установки
    # (в тестах — азербайджанским), подписи берутся из словаря выгрузки.
    assert task["internal_note"] == "Risklər\nПравки затянутся\n\nFərziyyələr\nБрендбук есть"


def test_push_preview_tells_what_will_happen(authed, project_id):
    """Окно переноса показывает, куда ляжет раздел и во сколько дней выйдет
    строка, и отмечает то, что переносить не будет."""
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
                # Категория плана найдена по имени без учёта регистра.
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
    # Раздел без строк в окне не показывается: переносить из него нечего.


def plan_category_id_of(authed, project_id: str, name: str) -> str:
    return next(
        category["id"]
        for category in authed.get(f"/api/projects/{project_id}").json()["categories"]
        if category["name"] == name
    )


def test_empty_proposal_refuses_to_push(authed, project_id):
    response = authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")
    assert response.status_code == 422
    assert response.json()["detail"] == "proposal_empty"
    assert authed.get(f"/api/projects/{project_id}/proposal/push-plan").json() == {
        "categories": []
    }
