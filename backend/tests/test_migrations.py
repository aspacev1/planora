"""Миграции против реальности: upgrade head на чистой базе, сверка с моделями,
обратимость downgrade.

Без этого теста расхождение цепочки миграций с models.py живёт незамеченным:
тесты приложения строят схему через create_all и потому проходят, а свежая
установка, которая накатывает alembic upgrade head, получает другую базу.

Тест работает не с базой из DATABASE_URL и не с базой conftest (`*_test`),
а с собственной одноразовой `*_migrations_test`: ему нужна база, в которой
не было create_all, — иначе upgrade падал бы на «таблица уже существует»,
а сверка сравнивала бы create_all сам с собой.
"""

import io
import uuid

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from pathlib import Path
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url

from app.config import get_settings
from app.db import Base
from app import models  # noqa: F401  импорт ради регистрации таблиц

BACKEND_DIR = Path(__file__).resolve().parents[1]


def _alembic_config(db_url: str) -> Config:
    config = Config(str(BACKEND_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    # Журнал команд alembic уходит в буфер, а не в stderr прогона тестов.
    config.stdout = io.StringIO()
    # Адрес подхватывает migrations/env.py — см. комментарий там.
    config.attributes["db_url"] = db_url
    return config


@pytest.fixture(scope="module")
def migrations_db_url():
    """Одноразовая чистая база; создаётся перед тестами модуля, сносится после.

    CREATE/DROP DATABASE выполняются через служебное подключение к базе из
    DATABASE_URL — саму её тест не трогает. Разрушающие операции разрешены
    только по имени с суффиксом `_migrations_test`.
    """
    admin_url = make_url(get_settings().database_url)
    db_name = f"{admin_url.database}_migrations_test"
    if not db_name.endswith("_migrations_test") or db_name == admin_url.database:
        raise RuntimeError(f"отказ сносить базу с подозрительным именем {db_name!r}")

    admin_engine = create_engine(admin_url, isolation_level="AUTOCOMMIT")
    with admin_engine.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)'))
        conn.execute(text(f'CREATE DATABASE "{db_name}"'))

    yield admin_url.set(database=db_name).render_as_string(hide_password=False)

    with admin_engine.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)'))
    admin_engine.dispose()


def test_upgrade_head_matches_models(migrations_db_url):
    """`alembic upgrade head` на пустой базе даёт ровно ту схему, что в models.py."""
    command.upgrade(_alembic_config(migrations_db_url), "head")

    engine = create_engine(migrations_db_url)
    try:
        with engine.connect() as conn:
            diffs = compare_metadata(MigrationContext.configure(conn), Base.metadata)
    finally:
        engine.dispose()

    assert diffs == [], (
        "схема после `alembic upgrade head` разошлась с models.py — "
        "недостающая или лишняя миграция:\n" + "\n".join(repr(d) for d in diffs)
    )


def test_downgrade_walks_back_to_empty(migrations_db_url):
    """Каждый downgrade выполним; после `downgrade base` таблиц не остаётся."""
    config = _alembic_config(migrations_db_url)
    command.upgrade(config, "head")
    command.downgrade(config, "base")

    engine = create_engine(migrations_db_url)
    try:
        leftovers = set(inspect(engine).get_table_names()) - {"alembic_version"}
    finally:
        engine.dispose()

    assert leftovers == set(), (
        f"после `alembic downgrade base` в базе остались таблицы: {sorted(leftovers)}"
    )


#: Миграция этапа предложения и ссылки строки на задачу — и ревизия перед ней.
#: Тест ниже накатывает её на непустые таблицы, как это случится на живой базе.
PLAN_LINKS = "c4d8e2f1a9b7"
BEFORE_PLAN_LINKS = "a1b2c3d4e5f6"


def test_proposal_migration_survives_rows_that_predate_it(migrations_db_url):
    """Накат на живой базе: строки, заведённые до миграции, получают умолчания,
    а откат их не теряет.

    Два теста выше проходят и без server_default: у пустой таблицы нет строк,
    которым нечего подставить в NOT NULL. Ошибка вылезает только на базе с
    данными — здесь она и воспроизводится: предложение и строка сметы
    заводятся на ревизии до миграции, затем накат до головы, откат на шаг и
    накат снова.
    """
    config = _alembic_config(migrations_db_url)
    command.downgrade(config, "base")
    command.upgrade(config, BEFORE_PLAN_LINKS)

    ids = {name: uuid.uuid4() for name in ("org", "project", "proposal", "section", "row")}
    engine = create_engine(migrations_db_url)
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO organizations (id, name, slug, default_locale, "
                    "default_timezone, working_days, week_start, holiday_calendar, "
                    "default_shift_threshold_days, public_sharing_enabled, "
                    "default_comments_enabled) VALUES (:org, 'Acme', 'acme', 'ru', "
                    "'UTC', 31, 0, '[]', 2, true, true)"
                ),
                ids,
            )
            conn.execute(
                text(
                    "INSERT INTO projects (id, org_id, name, slug, plan_version, "
                    "holidays_extra, workdays_extra) VALUES (:project, :org, 'Redesign', "
                    "'redesign', 0, '[]', '[]')"
                ),
                ids,
            )
            conn.execute(
                text("INSERT INTO proposals (id, project_id) VALUES (:proposal, :project)"),
                ids,
            )
            conn.execute(
                text(
                    "INSERT INTO proposal_categories (id, proposal_id, name, position) "
                    "VALUES (:section, :proposal, 'Дизайн', 0)"
                ),
                ids,
            )
            conn.execute(
                text(
                    "INSERT INTO proposal_tasks (id, proposal_id, category_id, name, "
                    "description, details, role, notes, risks, assumptions, position) "
                    "VALUES (:row, :proposal, :section, 'Логотип', '', '', '', '', '', "
                    "'', 0)"
                ),
                ids,
            )

        command.upgrade(config, "head")
        with engine.connect() as conn:
            proposal = conn.execute(
                text("SELECT status, sent_at, agreed_at FROM proposals WHERE id = :proposal"),
                ids,
            ).one()
            assert tuple(proposal) == ("draft", None, None)
            row = conn.execute(
                text("SELECT plan_task_id, created_at FROM proposal_tasks WHERE id = :row"),
                ids,
            ).one()
            assert row.plan_task_id is None
            assert row.created_at is not None

        command.downgrade(config, BEFORE_PLAN_LINKS)
        with engine.connect() as conn:
            columns = {column["name"] for column in inspect(conn).get_columns("proposal_tasks")}
            assert not columns & {"plan_task_id", "created_at"}
            columns = {column["name"] for column in inspect(conn).get_columns("proposals")}
            assert not columns & {"status", "sent_at", "agreed_at"}
            rows = conn.scalar(text("SELECT count(*) FROM proposal_tasks"))
            assert rows == 1

        # Второй накат на ту же непустую базу — та же дорога, что у отката
        # релиза и повторного выката.
        command.upgrade(config, "head")
        with engine.connect() as conn:
            assert conn.scalar(text("SELECT status FROM proposals WHERE id = :proposal"), ids) == "draft"
    finally:
        engine.dispose()
