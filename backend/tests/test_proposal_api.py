"""Маршруты коммерческого предложения: смета, реплики, перенос в план."""

import uuid

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
        # Счётчики плана — для карточки «Собрать из плана» на пустой смете.
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


def test_stage_marks_carry_dates_and_a_step_back_clears_them(authed, db, project_id):
    """Полоса этапов: отметка ставится при первом достижении этапа и живёт,
    пока этап не сняли; шаг назад снимает более поздние отметки."""
    stage = f"/api/projects/{project_id}/proposal/stage"

    sent = authed.post(stage, json={"stage": "sent"})
    assert sent.status_code == 200
    assert sent.json()["status"] == "sent"
    sent_at = sent.json()["sent_at"]
    assert sent_at is not None and sent.json()["agreed_at"] is None

    agreed = authed.post(stage, json={"stage": "agreed"}).json()
    assert agreed["status"] == "agreed"
    # Дата отправки — дата события, а не последнего нажатия.
    assert agreed["sent_at"] == sent_at and agreed["agreed_at"] is not None

    back = authed.post(stage, json={"stage": "sent"}).json()
    assert (back["status"], back["sent_at"], back["agreed_at"]) == ("sent", sent_at, None)

    draft = authed.post(stage, json={"stage": "draft"}).json()
    assert (draft["status"], draft["sent_at"], draft["agreed_at"]) == ("draft", None, None)

    # Согласовано сразу из черновика: отправка считается пройденной — той же
    # датой, ведь согласовать можно только то, что клиент видел.
    leap = authed.post(stage, json={"stage": "agreed"}).json()
    assert leap["sent_at"] is not None and leap["sent_at"] == leap["agreed_at"]

    assert authed.post(stage, json={"stage": "signed"}).status_code == 422
    _demote(authed, db, "viewer")
    assert authed.post(stage, json={"stage": "draft"}).status_code == 403


def test_switching_the_unit_converts_rows_and_keeps_the_totals(authed, project_id):
    """Смена единицы — смена того, чем меряют, а не переименование чисел: два
    дня по 400 в день становятся шестнадцатью часами по 50, итог тот же."""
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

    # Обратно — старой нормой часов в дне, даже если новая пришла тем же
    # запросом: оценки писались при восьми, и переводить их надо восемью.
    days = authed.patch(
        f"/api/projects/{project_id}/proposal", json={"effort_unit": "days", "hours_per_day": 6}
    ).json()
    rows = {row["name"]: row for row in days["categories"][0]["tasks"]}
    assert (rows["Логотип"]["effort"], rows["Логотип"]["rate"]) == (2.0, 400.0)
    assert days["hours_per_day"] == 6
    # Та же единица второй раз ничего не трогает.
    same = authed.patch(f"/api/projects/{project_id}/proposal", json={"effort_unit": "days"}).json()
    assert same["categories"][0]["tasks"][0]["effort"] == 2.0


def test_unit_switch_rounds_to_cents_and_refuses_what_does_not_fit(authed, project_id):
    category_id = _category_id(authed, project_id)
    task_id = _task_id(authed, project_id, category_id)
    authed.patch(f"/api/projects/{project_id}/proposal", json={"hours_per_day": 3})
    authed.patch(f"/api/projects/{project_id}/proposal/tasks/{task_id}", json={"effort": 1, "rate": 100})

    hours = authed.patch(f"/api/projects/{project_id}/proposal", json={"effort_unit": "hours"}).json()
    row = hours["categories"][0]["tasks"][0]
    # Треть сотни — 33,33: точность колонки, а не бесконечная дробь.
    assert (row["effort"], row["rate"]) == (3.0, 33.33)

    # Оценка у потолка колонки в часах не помещается: отказ целиком, смета
    # остаётся в прежней единице.
    authed.patch(f"/api/projects/{project_id}/proposal", json={"effort_unit": "days"})
    authed.patch(f"/api/projects/{project_id}/proposal/tasks/{task_id}", json={"effort": 999_999})
    refused = authed.patch(f"/api/projects/{project_id}/proposal", json={"effort_unit": "hours"})
    assert refused.status_code == 422
    assert refused.json()["detail"] == "proposal_value_out_of_range"
    assert authed.get(f"/api/projects/{project_id}/proposal").json()["effort_unit"] == "days"


def test_a_row_is_created_with_role_estimate_and_rate_at_once(authed, project_id):
    """Строка ввода спрашивает четыре поля разом — и всё это доезжает одним
    запросом, без правки в карточке. Одного имени по-прежнему достаточно."""
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
    assert state["plan_facts"] == {"tasks": 2, "categories": 1}


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
    assert response.json()["detail"] == "proposal_nothing_to_push"

    # Дописанная руками строка с оценкой — единственное, что перенос заведёт.
    state = authed.get(f"/api/projects/{project_id}/proposal").json()
    section_id = state["categories"][0]["id"]
    _task_id(authed, project_id, section_id, name="Вёрстка", effort=1)

    response = authed.post(f"/api/projects/{project_id}/proposal/push-to-plan")
    assert response.status_code == 201
    assert response.json()["created_tasks"] == 1

    plan = authed.get(f"/api/projects/{project_id}").json()
    assert sorted(task["name"] for task in plan["tasks"]) == ["Вёрстка", "Гайдлайн", "Логотип"]
    assert [category["name"] for category in plan["categories"]] == ["Дизайн"]
