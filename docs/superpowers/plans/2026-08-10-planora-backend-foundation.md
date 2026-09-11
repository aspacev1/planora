# Planora: the backend's foundation — implementation plan

> **Historical.** This is one of the original build plans this codebase
> was built from — every step below has since shipped. It reflects the plan
> as scoped in August 2026, not necessarily today's implementation; for
> current architecture and conventions, see the repo's `CLAUDE.md` and the
> `planora-conventions` skill. Kept as a build-history record, not an active
> task list.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Planora's backend up to a state where it deploys with one command, registers users with their organizations, stores projects, categories and tasks, changes them only through journalled mutations and counts working days correctly.

**Architecture:** FastAPI on top of SQLAlchemy 2.0 and Postgres. The business logic is laid out in modules that know nothing about HTTP: `calendar` — pure date functions, `access` — the permission matrix, `mutations` — the registry of operations with their inverses, `settings_resolution` — the organization → project settings inheritance. The `api` layer only receives requests and serializes responses. Changes to a project's data go exclusively through mutations; each writes an entry into the revision journal and can build its own inverse operation — from which a task's history, undo and rolling back an AI batch later come for free.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2.0, Alembic, Pydantic v2 + pydantic-settings, Postgres 16, argon2-cffi, pytest + httpx, uv, Docker Compose.

## Global Constraints

The spec's requirements, in force across every task in the plan:

- The hierarchy is strictly `Organization → Project → Category → Task`. There is no nesting of categories and no subtasks.
- A task's duration is in **working days**. There are no direct calendar-day operations in the code, only through the `calendar` module.
- The week's working days are a setting rather than a constant. Monday–Friday by default.
- Project settings overriding the organization's (`timezone`, `working_days`, `shift_threshold_days`) are stored **nullable**; `null` means "inherit" rather than "empty". Copying the organization's values into a project at creation time is forbidden.
- The change journal stores **an event with parameters** rather than a ready phrase: the text is assembled at display time in the reader's language.
- Case conversion for comparisons, search and logins is in the invariant locale only, never in the user's.
- Slugs are built from an explicit transliteration table (`ə→e, ğ→g, ı→i, İ→i, ö→o, ş→s, ü→u, ç→c` and Cyrillic). Automatic diacritic stripping is forbidden as the only mechanism — `ə` does not decompose into `e` — but is permissible as a fallback for languages outside the table, after the table has done its work.
- The locales: `az` (by default), `en`, `ru`.
- Registration is open: a new account gets its own organization and the `owner` role in it. No console commands for creating users.
- There are no external services: no queues, no Redis, no object storage.
- The deployment parameters come from environment variables. Mandatory and without a default value are only those that cannot be guessed correctly: `APP_SECRET` and `DATABASE_URL` — without them the application does not start. The rest have a safe default in the code, overridden by an environment variable; an install must come up right after deployment. Credentials and addresses in tracked files (`docker-compose.yml`) are set through `${VAR:-default}` rather than as literals.

---

### Task 1: The project's skeleton, configuration and deployment

**Files:**
- Create: `backend/pyproject.toml`
- Create: `backend/app/__init__.py`
- Create: `backend/app/config.py`
- Create: `backend/app/main.py`
- Create: `backend/tests/conftest.py`
- Create: `backend/tests/test_health.py`
- Create: `backend/Dockerfile`
- Create: `docker-compose.yml`
- Create: `.env.example`

**Interfaces:**
- Consumes: nothing, this is the first task.
- Produces: `app.config.Settings` — a pydantic-settings class with all the environment variables; `app.config.get_settings() -> Settings` (cached through `lru_cache`); `app.main.app` — the FastAPI instance.

- [ ] **Step 1: Create `backend/pyproject.toml`**

```toml
[project]
name = "planora"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.32",
    "sqlalchemy>=2.0.36",
    "alembic>=1.14",
    "psycopg[binary]>=3.2",
    "pydantic>=2.9",
    "pydantic-settings>=2.6",
    "argon2-cffi>=23.1",
]

[dependency-groups]
dev = ["pytest>=8.3", "pytest-asyncio>=0.24", "httpx>=0.27"]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]
```

- [ ] **Step 2: Write the failing health test**

Create `backend/tests/test_health.py`:

```python
from fastapi.testclient import TestClient

from app.main import app


def test_health_returns_ok():
    client = TestClient(app)
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
```

- [ ] **Step 3: Run the test and make sure it fails**

```bash
cd backend && uv run pytest tests/test_health.py -v
```

Expected: `ModuleNotFoundError: No module named 'app.main'`.

- [ ] **Step 4: Write the configuration module**

Create `backend/app/config.py`. All the values come from the environment, with defaults only where a value is safe and is not a secret:

```python
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str
    app_secret: str

    public_base_url: str = "http://localhost:8000"
    default_locale: str = "az"
    supported_locales: str = "az,en,ru"
    signup_mode: str = "open"

    mail_transport: str = "none"
    smtp_url: str = ""
    mail_from: str = ""
    invite_ttl_days: int = 7
    invite_rate_limit: int = 20

    public_sharing_enabled: bool = True
    guest_comment_rate_limit: int = 10

    ai_max_questions: int = 12
    ai_schema_retries: int = 2
    ai_request_timeout: int = 60

    max_tasks_per_project: int = 2000
    max_text_len: int = 4000
    log_level: str = "INFO"

    @property
    def locales(self) -> list[str]:
        return [item.strip() for item in self.supported_locales.split(",") if item.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
```

- [ ] **Step 5: Write the entry point**

Create `backend/app/__init__.py` as an empty file and `backend/app/main.py`:

```python
from fastapi import FastAPI

app = FastAPI(title="Planora")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
```

- [ ] **Step 6: Create a conftest with the tests' environment**

Create `backend/tests/conftest.py`:

```python
import os

os.environ.setdefault(
    "DATABASE_URL", "postgresql+psycopg://planora:planora@localhost:5432/planora_test"
)
os.environ.setdefault("APP_SECRET", "test-secret-not-for-production")
```

- [ ] **Step 7: Run the test and make sure it passes**

```bash
cd backend && uv run pytest tests/test_health.py -v
```

Expected: PASS.

- [ ] **Step 8: Write the Dockerfile, the docker-compose and the environment example**

Create `backend/Dockerfile`:

```dockerfile
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /usr/local/bin/uv

WORKDIR /app
COPY pyproject.toml ./
RUN uv sync --no-dev --no-install-project

COPY . .

ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

Create `docker-compose.yml` in the repository's root:

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: planora
      POSTGRES_PASSWORD: planora
      POSTGRES_DB: planora
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U planora"]
      interval: 5s
      retries: 10

  api:
    build: ./backend
    env_file: .env
    depends_on:
      db: {condition: service_healthy}
    ports: ["8000:8000"]
    command: uvicorn app.main:app --host 0.0.0.0 --port 8000

volumes:
  pgdata:
```

Create `.env.example`:

```
DATABASE_URL=postgresql+psycopg://planora:planora@db:5432/planora
APP_SECRET=change-me-to-a-long-random-string
PUBLIC_BASE_URL=https://planora.example.com
DEFAULT_LOCALE=az
SUPPORTED_LOCALES=az,en,ru
SIGNUP_MODE=open
MAIL_TRANSPORT=none
```

- [ ] **Step 9: Check that the database comes up**

```bash
docker compose up -d db && docker compose ps
```

Expected: the `db` container in a healthy state.

- [ ] **Step 10: Create the test database**

```bash
docker compose exec db psql -U planora -c "CREATE DATABASE planora_test"
```

Expected: `CREATE DATABASE`.

- [ ] **Step 11: Commit**

```bash
git add backend/ docker-compose.yml .env.example
git commit -m "feat: скелет бэкенда, конфигурация из окружения, docker compose"
```

---

### Task 2: The working-day calendar

**Files:**
- Create: `backend/app/calendar.py`
- Test: `backend/tests/test_calendar.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `app.calendar.WEEKDAYS_MON_FRI: int` — the default working-day mask.
  - `app.calendar.Calendar` — a frozen dataclass with the fields `working_days: int`, `holidays: frozenset[date]`, `extra_workdays: frozenset[date]`; the method `is_working(d: date) -> bool`.
  - `app.calendar.end_date(start: date, duration_days: int, cal: Calendar) -> date`.
  - `app.calendar.count_working_days(start: date, end: date, cal: Calendar) -> int`.

The mask's bits: bit 0 is Monday, bit 6 is Sunday, as in `date.weekday()`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_calendar.py`:

```python
from datetime import date

import pytest

from app.calendar import WEEKDAYS_MON_FRI, Calendar, count_working_days, end_date

DEFAULT = Calendar()


def test_default_calendar_is_monday_to_friday():
    assert DEFAULT.working_days == WEEKDAYS_MON_FRI
    assert DEFAULT.is_working(date(2026, 3, 6)) is True   # пятница
    assert DEFAULT.is_working(date(2026, 3, 7)) is False  # суббота
    assert DEFAULT.is_working(date(2026, 3, 8)) is False  # воскресенье


def test_single_day_task_ends_on_its_start():
    assert end_date(date(2026, 3, 4), 1, DEFAULT) == date(2026, 3, 4)


def test_task_started_on_friday_skips_the_weekend():
    # пт 6 марта + 3 рабочих дня = пт, пн, вт
    assert end_date(date(2026, 3, 6), 3, DEFAULT) == date(2026, 3, 10)


def test_start_on_a_non_working_day_shifts_to_the_next_working_day():
    # суббота 7 марта, длительность 1 → понедельник 9 марта
    assert end_date(date(2026, 3, 7), 1, DEFAULT) == date(2026, 3, 9)


def test_holiday_is_skipped():
    cal = Calendar(holidays=frozenset({date(2026, 3, 9)}))
    # пт 6 марта + 3 дня: пт, вт (пн выходной по празднику), ср
    assert end_date(date(2026, 3, 6), 3, cal) == date(2026, 3, 11)


def test_extra_workday_beats_the_weekend_and_the_holiday():
    cal = Calendar(
        holidays=frozenset({date(2026, 3, 9)}),
        extra_workdays=frozenset({date(2026, 3, 7), date(2026, 3, 9)}),
    )
    assert cal.is_working(date(2026, 3, 7)) is True
    assert cal.is_working(date(2026, 3, 9)) is True


def test_non_standard_working_week():
    # рабочая неделя воскресенье–четверг: разряды 6,0,1,2,3
    mask = (1 << 6) | (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3)
    cal = Calendar(working_days=mask)
    assert cal.is_working(date(2026, 3, 8)) is True   # воскресенье
    assert cal.is_working(date(2026, 3, 6)) is False  # пятница


def test_count_working_days_is_inclusive_on_both_ends():
    assert count_working_days(date(2026, 3, 2), date(2026, 3, 6), DEFAULT) == 5
    assert count_working_days(date(2026, 3, 2), date(2026, 3, 8), DEFAULT) == 5
    assert count_working_days(date(2026, 3, 4), date(2026, 3, 4), DEFAULT) == 1


def test_count_working_days_rejects_reversed_range():
    with pytest.raises(ValueError):
        count_working_days(date(2026, 3, 6), date(2026, 3, 2), DEFAULT)


def test_duration_must_be_at_least_one_day():
    with pytest.raises(ValueError):
        end_date(date(2026, 3, 4), 0, DEFAULT)
```

- [ ] **Step 2: Run the tests and make sure they fail**

```bash
cd backend && uv run pytest tests/test_calendar.py -v
```

Expected: `ModuleNotFoundError: No module named 'app.calendar'`.

- [ ] **Step 3: Implement the module**

Create `backend/app/calendar.py`:

```python
from dataclasses import dataclass, field
from datetime import date, timedelta

MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY, SATURDAY, SUNDAY = (1 << i for i in range(7))
WEEKDAYS_MON_FRI = MONDAY | TUESDAY | WEDNESDAY | THURSDAY | FRIDAY

_MAX_SEARCH_DAYS = 3650


@dataclass(frozen=True)
class Calendar:
    """Рабочий календарь проекта.

    Порядок применения: маска дней недели, затем праздники их убирают,
    затем extra_workdays возвращают обратно конкретные даты.
    """

    working_days: int = WEEKDAYS_MON_FRI
    holidays: frozenset[date] = field(default_factory=frozenset)
    extra_workdays: frozenset[date] = field(default_factory=frozenset)

    def is_working(self, d: date) -> bool:
        if d in self.extra_workdays:
            return True
        if d in self.holidays:
            return False
        return bool(self.working_days & (1 << d.weekday()))


def _first_working_on_or_after(start: date, cal: Calendar) -> date:
    d = start
    for _ in range(_MAX_SEARCH_DAYS):
        if cal.is_working(d):
            return d
        d += timedelta(days=1)
    raise ValueError("календарь не содержит ни одного рабочего дня")


def end_date(start: date, duration_days: int, cal: Calendar) -> date:
    """Дата окончания задачи. Стартовый рабочий день входит в длительность."""
    if duration_days < 1:
        raise ValueError("длительность должна быть не меньше одного дня")

    d = _first_working_on_or_after(start, cal)
    counted = 1
    for _ in range(_MAX_SEARCH_DAYS):
        if counted >= duration_days:
            return d
        d += timedelta(days=1)
        if cal.is_working(d):
            counted += 1
    raise ValueError("календарь не содержит столько рабочих дней")


def count_working_days(start: date, end: date, cal: Calendar) -> int:
    """Сколько рабочих дней в отрезке, включая обе границы."""
    if end < start:
        raise ValueError("конец отрезка раньше начала")

    total = 0
    d = start
    while d <= end:
        if cal.is_working(d):
            total += 1
        d += timedelta(days=1)
    return total
```

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
cd backend && uv run pytest tests/test_calendar.py -v
```

Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/calendar.py backend/tests/test_calendar.py
git commit -m "feat: календарь рабочих дней с настраиваемой неделей и праздниками"
```

---

### Task 3: Text normalization — emails and slugs

**Files:**
- Create: `backend/app/text.py`
- Test: `backend/tests/test_text.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `app.text.normalize_email(raw: str) -> str` — the form used for comparison and for storing the uniqueness key.
  - `app.text.slugify(raw: str, fallback: str = "project") -> str`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_text.py`:

```python
from app.text import normalize_email, slugify


def test_email_is_trimmed_and_lowercased():
    assert normalize_email("  User@Example.COM ") == "user@example.com"


def test_email_normalization_is_stable_for_dotted_capital_i():
    # Азербайджанская İ не должна давать разный результат при повторном прогоне
    once = normalize_email("İSTANBUL@example.com")
    assert normalize_email(once) == once


def test_dotless_and_dotted_i_do_not_collapse_into_the_same_email():
    # разные буквы — разные адреса, молчаливого слияния аккаунтов быть не должно
    assert normalize_email("Ismail@x.com") != normalize_email("İsmail@x.com")


def test_slug_transliterates_azerbaijani_letters():
    assert slugify("Şəhər Layihəsi") == "seher-layihesi"
    assert slugify("Çağrı Mərkəzi") == "cagri-merkezi"


def test_slug_handles_dotted_and_dotless_i():
    assert slugify("İstanbul") == "istanbul"
    assert slugify("Işıq") == "isiq"


def test_slug_transliterates_cyrillic():
    assert slugify("Редизайн сайта") == "redizayn-sayta"


def test_slug_collapses_separators_and_trims_dashes():
    assert slugify("  Acme   //  Redesign 2026!! ") == "acme-redesign-2026"


def test_slug_falls_back_when_nothing_survives():
    assert slugify("!!! ???", fallback="project") == "project"
```

- [ ] **Step 2: Run the tests and make sure they fail**

```bash
cd backend && uv run pytest tests/test_text.py -v
```

Expected: `ModuleNotFoundError: No module named 'app.text'`.

- [ ] **Step 3: Implement the module**

Create `backend/app/text.py`. The transliteration is applied **before** the case conversion — otherwise `I` and `İ` are already indistinguishable:

```python
import re
import unicodedata

# Азербайджанский. Обе формы каждой буквы заданы явно: полагаться на
# «убрать диакритику» нельзя, İ и I — разные буквы, а не украшения.
_AZ = {
    "ə": "e", "Ə": "e",
    "ğ": "g", "Ğ": "g",
    "ı": "i", "I": "i",
    "i": "i", "İ": "i",
    "ö": "o", "Ö": "o",
    "ş": "s", "Ş": "s",
    "ü": "u", "Ü": "u",
    "ç": "c", "Ç": "c",
}

_RU = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}
_RU.update({k.upper(): v for k, v in _RU.items() if k})

_TRANSLIT = {**_AZ, **_RU}


def normalize_email(raw: str) -> str:
    """Форма адреса для сравнения и уникальности.

    NFKC приводит совместимые формы к одной, casefold не зависит от локали
    процесса — в отличие от приведения регистра в локали пользователя,
    где I превращается в ı и ломает поиск.
    """
    return unicodedata.normalize("NFKC", raw.strip()).casefold()


def slugify(raw: str, fallback: str = "project") -> str:
    transliterated = "".join(_TRANSLIT.get(ch, ch) for ch in raw)
    lowered = transliterated.lower()
    stripped = unicodedata.normalize("NFKD", lowered)
    ascii_only = "".join(ch for ch in stripped if not unicodedata.combining(ch))
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_only).strip("-")
    return slug or fallback
```

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
cd backend && uv run pytest tests/test_text.py -v
```

Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/text.py backend/tests/test_text.py
git commit -m "feat: нормализация почты и слагов с транслитерацией az и ru"
```

---

### Task 4: The data models and the first migration

**Files:**
- Create: `backend/app/db.py`
- Create: `backend/app/models.py`
- Create: `backend/alembic.ini`
- Create: `backend/migrations/env.py`
- Create: `backend/migrations/script.py.mako`
- Modify: `backend/tests/conftest.py`
- Test: `backend/tests/test_models.py`

**Interfaces:**
- Consumes: `app.config.get_settings`, `app.calendar.WEEKDAYS_MON_FRI`.
- Produces:
  - `app.db.Base` — the declarative base; `app.db.engine`; `app.db.SessionLocal`; `app.db.get_db()` — a FastAPI dependency.
  - `app.models`: `Organization`, `User`, `Membership`, `Session`, `Project`, `Category`, `Task`, `TaskAssignee`, `Dependency`, `Revision`, the `Role` enumeration.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_models.py`:

```python
from datetime import date

from app.calendar import WEEKDAYS_MON_FRI
from app.models import Category, Organization, Project, Task


def test_organization_defaults_come_from_the_spec(db):
    org = Organization(name="Acme", slug="acme")
    db.add(org)
    db.flush()

    assert org.default_locale == "az"
    assert org.working_days == WEEKDAYS_MON_FRI
    assert org.default_shift_threshold_days == 2
    assert org.holiday_calendar == []


def test_project_overrides_are_null_by_default(db):
    org = Organization(name="Acme", slug="acme")
    db.add(org)
    db.flush()

    project = Project(org_id=org.id, name="Redesign", slug="redesign")
    db.add(project)
    db.flush()

    # null означает «наследовать», а не «пусто» — копий значений организации быть не должно
    assert project.working_days is None
    assert project.shift_threshold_days is None
    assert project.timezone is None


def test_task_belongs_to_a_category_and_keeps_its_position(db):
    org = Organization(name="Acme", slug="acme")
    db.add(org)
    db.flush()
    project = Project(org_id=org.id, name="Redesign", slug="redesign")
    db.add(project)
    db.flush()
    category = Category(project_id=project.id, name="Design", color="#3b82f6", position=0)
    db.add(category)
    db.flush()

    task = Task(
        project_id=project.id,
        category_id=category.id,
        name="Logo",
        start_date=date(2026, 3, 4),
        duration_days=5,
        position=0,
    )
    db.add(task)
    db.flush()

    assert task.criticality == "normal"
    assert task.progress_pct == 0
    assert task.baseline_start is None
```

- [ ] **Step 2: Extend the conftest with a database fixture**

Replace the contents of `backend/tests/conftest.py`:

```python
import os

os.environ.setdefault(
    "DATABASE_URL", "postgresql+psycopg://planora:planora@localhost:5432/planora_test"
)
os.environ.setdefault("APP_SECRET", "test-secret-not-for-production")

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.config import get_settings
from app.db import Base


@pytest.fixture(scope="session")
def engine():
    engine = create_engine(get_settings().database_url)
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


@pytest.fixture
def db(engine):
    """Сессия в транзакции, которая откатывается после теста."""
    connection = engine.connect()
    transaction = connection.begin()
    session = sessionmaker(bind=connection)()
    yield session
    session.close()
    transaction.rollback()
    connection.close()
```

- [ ] **Step 3: Run the test and make sure it fails**

```bash
cd backend && uv run pytest tests/test_models.py -v
```

Expected: `ModuleNotFoundError: No module named 'app.db'`.

- [ ] **Step 4: Create the database access layer**

Create `backend/app/db.py`:

```python
from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings


class Base(DeclarativeBase):
    pass


engine = create_engine(get_settings().database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
```

- [ ] **Step 5: Describe the models**

Create `backend/app/models.py`:

```python
import uuid
from datetime import date, datetime
from enum import StrEnum

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.calendar import WEEKDAYS_MON_FRI
from app.db import Base


class Role(StrEnum):
    OWNER = "owner"
    EDITOR = "editor"
    VIEWER = "viewer"
    CLIENT = "client"


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


class Organization(Base):
    __tablename__ = "organizations"

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String(200))
    slug: Mapped[str] = mapped_column(String(100), unique=True)

    default_locale: Mapped[str] = mapped_column(String(5), default="az")
    default_timezone: Mapped[str] = mapped_column(String(64), default="Asia/Baku")
    working_days: Mapped[int] = mapped_column(Integer, default=WEEKDAYS_MON_FRI)
    week_start: Mapped[int] = mapped_column(Integer, default=0)
    holiday_calendar: Mapped[list] = mapped_column(JSON, default=list)
    default_shift_threshold_days: Mapped[int] = mapped_column(Integer, default=2)
    public_sharing_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    default_comments_enabled: Mapped[bool] = mapped_column(Boolean, default=True)


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = _uuid_pk()
    email: Mapped[str] = mapped_column(String(320), unique=True)
    password_hash: Mapped[str] = mapped_column(String(200))
    name: Mapped[str] = mapped_column(String(200))
    locale: Mapped[str] = mapped_column(String(5), default="az")
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Membership(Base):
    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("org_id", "user_id"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    role: Mapped[str] = mapped_column(String(16))


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    token_hash: Mapped[str] = mapped_column(String(128), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Project(Base):
    __tablename__ = "projects"
    __table_args__ = (UniqueConstraint("org_id", "slug"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(200))
    slug: Mapped[str] = mapped_column(String(100))
    deadline: Mapped[date | None] = mapped_column(Date)
    plan_approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    plan_version: Mapped[int] = mapped_column(Integer, default=0)

    # nullable = «наследовать от организации»
    timezone: Mapped[str | None] = mapped_column(String(64))
    working_days: Mapped[int | None] = mapped_column(Integer)
    shift_threshold_days: Mapped[int | None] = mapped_column(Integer)

    holidays_extra: Mapped[list] = mapped_column(JSON, default=list)
    workdays_extra: Mapped[list] = mapped_column(JSON, default=list)


class Category(Base):
    __tablename__ = "categories"

    id: Mapped[uuid.UUID] = _uuid_pk()
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(200))
    color: Mapped[str] = mapped_column(String(9))
    position: Mapped[int] = mapped_column(Integer, default=0)


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[uuid.UUID] = _uuid_pk()
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    category_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("categories.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(300))
    description: Mapped[str] = mapped_column(Text, default="")
    internal_note: Mapped[str] = mapped_column(Text, default="")
    start_date: Mapped[date] = mapped_column(Date)
    duration_days: Mapped[int] = mapped_column(Integer)
    criticality: Mapped[str] = mapped_column(String(16), default="normal")
    progress_pct: Mapped[int] = mapped_column(Integer, default=0)
    position: Mapped[int] = mapped_column(Integer, default=0)
    baseline_start: Mapped[date | None] = mapped_column(Date)
    baseline_duration: Mapped[int | None] = mapped_column(Integer)


class TaskAssignee(Base):
    __tablename__ = "task_assignees"
    __table_args__ = (UniqueConstraint("task_id", "user_id"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    task_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))


class Dependency(Base):
    __tablename__ = "dependencies"
    __table_args__ = (UniqueConstraint("from_task_id", "to_task_id"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    from_task_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"))
    to_task_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"))


class Revision(Base):
    __tablename__ = "revisions"
    __table_args__ = (UniqueConstraint("project_id", "seq"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    seq: Mapped[int] = mapped_column(Integer)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    op: Mapped[dict] = mapped_column(JSON)
    inverse: Mapped[dict] = mapped_column(JSON)
    reason: Mapped[str | None] = mapped_column(Text)
    batch_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
```

- [ ] **Step 6: Run the test and make sure it passes**

```bash
cd backend && uv run pytest tests/test_models.py -v
```

Expected: 3 passed.

- [ ] **Step 7: Configure Alembic and create the migration**

```bash
cd backend && uv run alembic init migrations
```

In `backend/migrations/env.py` replace the target-metadata configuration block with:

```python
from app.config import get_settings
from app.db import Base
from app import models  # noqa: F401  импорт ради регистрации таблиц

config.set_main_option("sqlalchemy.url", get_settings().database_url)
target_metadata = Base.metadata
```

Then generate and apply the migration:

```bash
cd backend && uv run alembic revision --autogenerate -m "initial schema" && uv run alembic upgrade head
```

Expected: a file is created in `migrations/versions/`, and the `upgrade` command finishes without errors.

- [ ] **Step 8: Commit**

```bash
git add backend/app/db.py backend/app/models.py backend/alembic.ini backend/migrations/ backend/tests/
git commit -m "feat: модели данных и первая миграция"
```

---

### Task 5: Registration, sign-in and sessions

**Files:**
- Create: `backend/app/security.py`
- Create: `backend/app/auth.py`
- Create: `backend/app/api/__init__.py`
- Create: `backend/app/api/auth_routes.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_auth.py`

**Interfaces:**
- Consumes: `app.models`, `app.text.normalize_email`, `app.text.slugify`, `app.config.get_settings`.
- Produces:
  - `app.security.hash_password(raw: str) -> str`, `app.security.verify_password(raw: str, hashed: str) -> bool`.
  - `app.security.new_token() -> tuple[str, str]` — returns `(plain_token, hash)`.
  - `app.security.hash_token(raw: str) -> str`.
  - `app.auth.register(db, *, name, email, password) -> User` — creates the user, their organization and an `owner` membership.
  - `app.auth.authenticate(db, *, email, password) -> User | None`.
  - `app.auth.open_session(db, user) -> str` — returns the plain token for the cookie.
  - `app.auth.current_user(request, db) -> User` — a FastAPI dependency, raises a 401.
  - The routes: `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_auth.py`:

```python
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.auth import authenticate, close_session, current_user, open_session, register
from app.models import Membership, Organization, Role, Session
from app.security import hash_password, hash_token, verify_password


def test_password_hash_is_not_the_password():
    hashed = hash_password("correct horse battery staple")
    assert hashed != "correct horse battery staple"
    assert verify_password("correct horse battery staple", hashed) is True
    assert verify_password("wrong", hashed) is False


def test_registration_creates_user_org_and_owner_membership(db):
    user = register(db, name="Alex", email="Alex@Example.com", password="s3cret-pass")
    db.flush()

    assert user.email == "alex@example.com"

    membership = db.query(Membership).filter_by(user_id=user.id).one()
    assert membership.role == Role.OWNER

    org = db.get(Organization, membership.org_id)
    assert org.name == "Alex"
    assert org.slug == "alex"


def test_registration_rejects_a_duplicate_email_regardless_of_case(db):
    register(db, name="Alex", email="alex@example.com", password="s3cret-pass")
    db.flush()

    with pytest.raises(ValueError, match="занят"):
        register(db, name="Other", email="ALEX@example.com", password="other-pass")


def test_org_slug_gets_a_suffix_when_taken(db):
    register(db, name="Acme", email="one@example.com", password="s3cret-pass")
    db.flush()
    second = register(db, name="Acme", email="two@example.com", password="s3cret-pass")
    db.flush()

    membership = db.query(Membership).filter_by(user_id=second.id).one()
    org = db.get(Organization, membership.org_id)
    assert org.slug.startswith("acme-")


def test_expired_session_does_not_authenticate(db):
    """Истёкшая сессия — 401, а не молчаливый вход."""
    user = register(db, name="Alex", email="alex@example.com", password="s3cret-pass")
    db.flush()
    token = open_session(db, user)
    record = db.scalar(select(Session).where(Session.token_hash == hash_token(token)))
    record.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    db.flush()

    with pytest.raises(HTTPException) as error:
        current_user(planora_session=token, db=db)
    assert error.value.status_code == 401


def test_logout_kills_the_server_side_session_not_only_the_cookie(db):
    user = register(db, name="Alex", email="alex@example.com", password="s3cret-pass")
    db.flush()
    token = open_session(db, user)
    assert current_user(planora_session=token, db=db).id == user.id

    close_session(db, token)
    db.flush()

    with pytest.raises(HTTPException):
        current_user(planora_session=token, db=db)


def test_authenticate_accepts_the_right_password_and_rejects_the_wrong_one(db):
    register(db, name="Alex", email="alex@example.com", password="s3cret-pass")
    db.flush()

    assert authenticate(db, email="ALEX@example.com", password="s3cret-pass") is not None
    assert authenticate(db, email="alex@example.com", password="nope") is None
    assert authenticate(db, email="ghost@example.com", password="s3cret-pass") is None
```

- [ ] **Step 2: Run the tests and make sure they fail**

```bash
cd backend && uv run pytest tests/test_auth.py -v
```

Expected: `ModuleNotFoundError: No module named 'app.security'`.

- [ ] **Step 3: Implement the security primitives**

Create `backend/app/security.py`:

```python
import hashlib
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

_hasher = PasswordHasher()


def hash_password(raw: str) -> str:
    return _hasher.hash(raw)


def verify_password(raw: str, hashed: str) -> bool:
    try:
        return _hasher.verify(hashed, raw)
    except VerifyMismatchError:
        return False


def new_token() -> tuple[str, str]:
    """Открытый токен и его хеш. Открытый показывается один раз, хранится хеш."""
    raw = secrets.token_urlsafe(32)
    return raw, hash_token(raw)


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()
```

- [ ] **Step 4: Implement registration and sign-in**

Create `backend/app/auth.py`:

```python
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import Cookie, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.db import get_db
from app.models import Membership, Organization, Role, Session, User
from app.security import hash_password, hash_token, new_token, verify_password
from app.text import normalize_email, slugify

SESSION_COOKIE = "planora_session"
SESSION_TTL = timedelta(days=30)


def _unique_org_slug(db: DbSession, name: str) -> str:
    base = slugify(name, fallback="org")
    if db.scalar(select(Organization).where(Organization.slug == base)) is None:
        return base
    return f"{base}-{secrets.token_hex(3)}"


def register(db: DbSession, *, name: str, email: str, password: str) -> User:
    normalized = normalize_email(email)
    if db.scalar(select(User).where(User.email == normalized)) is not None:
        raise ValueError("адрес уже занят")

    settings = get_settings()
    user = User(
        email=normalized,
        password_hash=hash_password(password),
        name=name.strip(),
        locale=settings.default_locale,
    )
    db.add(user)
    db.flush()

    org = Organization(name=name.strip(), slug=_unique_org_slug(db, name))
    db.add(org)
    db.flush()

    db.add(Membership(org_id=org.id, user_id=user.id, role=Role.OWNER))
    db.flush()
    return user


# Хеш-пустышка считается один раз. Он нужен, чтобы проверка пароля для
# несуществующего адреса стоила столько же, сколько для существующего:
# иначе по времени ответа перебором собирается список зарегистрированных.
_DUMMY_HASH = hash_password("dummy-password-for-constant-time-compare")


def authenticate(db: DbSession, *, email: str, password: str) -> User | None:
    user = db.scalar(select(User).where(User.email == normalize_email(email)))
    if user is None:
        verify_password(password, _DUMMY_HASH)
        return None
    return user if verify_password(password, user.password_hash) else None


def open_session(db: DbSession, user: User) -> str:
    raw, hashed = new_token()
    db.add(
        Session(
            user_id=user.id,
            token_hash=hashed,
            expires_at=datetime.now(timezone.utc) + SESSION_TTL,
        )
    )
    db.flush()
    return raw


def close_session(db: DbSession, raw_token: str) -> None:
    record = db.scalar(select(Session).where(Session.token_hash == hash_token(raw_token)))
    if record is not None:
        db.delete(record)


def current_user(
    planora_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
    db: DbSession = Depends(get_db),
) -> User:
    if not planora_session:
        raise HTTPException(status_code=401, detail="not_authenticated")

    record = db.scalar(select(Session).where(Session.token_hash == hash_token(planora_session)))
    if record is None or record.expires_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=401, detail="session_expired")

    return db.get(User, record.user_id)
```

- [ ] **Step 5: Add the routes**

Create `backend/app/api/__init__.py` empty and `backend/app/api/auth_routes.py`:

```python
from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as DbSession

from app.auth import SESSION_COOKIE, authenticate, close_session, current_user, open_session, register
from app.config import get_settings
from app.db import get_db
from app.models import User

router = APIRouter(prefix="/api/auth", tags=["auth"])


class RegisterIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    email: EmailStr
    password: str = Field(min_length=8, max_length=200)


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: str
    name: str
    email: str
    locale: str


def _cookie_is_secure() -> bool:
    """Кука помечается Secure ровно тогда, когда установка работает по https.

    Выводим из уже существующей настройки, а не заводим отдельный рубильник:
    иначе появляется способ развернуть боевую установку и забыть его включить.
    """
    return get_settings().public_base_url.startswith("https://")


def _set_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        secure=_cookie_is_secure(),
        samesite="lax",
        max_age=int(SESSION_TTL.total_seconds()),
    )


def _to_out(user: User) -> UserOut:
    return UserOut(id=str(user.id), name=user.name, email=user.email, locale=user.locale)


@router.post("/register", response_model=UserOut, status_code=201)
def register_route(payload: RegisterIn, response: Response, db: DbSession = Depends(get_db)):
    if get_settings().signup_mode != "open":
        raise HTTPException(status_code=403, detail="signup_disabled")
    try:
        user = register(db, name=payload.name, email=payload.email, password=payload.password)
    except ValueError:
        raise HTTPException(status_code=409, detail="email_taken")
    except IntegrityError:
        # Гонка: между проверкой и вставкой адрес занял кто-то другой.
        # Ответ тот же, что и при обычном дубликате, — человеку всё равно,
        # проиграл он гонку или пришёл вторым.
        db.rollback()
        raise HTTPException(status_code=409, detail="email_taken")
    _set_cookie(response, open_session(db, user))
    return _to_out(user)


@router.post("/login", response_model=UserOut)
def login_route(payload: LoginIn, response: Response, db: DbSession = Depends(get_db)):
    user = authenticate(db, email=payload.email, password=payload.password)
    if user is None:
        raise HTTPException(status_code=401, detail="bad_credentials")
    _set_cookie(response, open_session(db, user))
    return _to_out(user)


@router.post("/logout", status_code=204)
def logout_route(
    response: Response,
    db: DbSession = Depends(get_db),
    planora_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
):
    if planora_session:
        close_session(db, planora_session)
    response.delete_cookie(SESSION_COOKIE)


@router.get("/me", response_model=UserOut)
def me_route(user: User = Depends(current_user)):
    return _to_out(user)
```

Replace `backend/app/main.py`:

```python
from fastapi import FastAPI

from app.api import auth_routes

app = FastAPI(title="Planora")
app.include_router(auth_routes.router)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
```

- [ ] **Step 6: Run the tests and make sure they pass**

```bash
cd backend && uv run pytest tests/test_auth.py tests/test_health.py -v
```

Expected: 6 passed.

- [ ] **Step 7: Commit**

```bash
git add backend/app/security.py backend/app/auth.py backend/app/api/ backend/app/main.py backend/tests/test_auth.py
git commit -m "feat: свободная регистрация с собственной организацией, вход и сессии"
```

---

### Task 6: The permission matrix

**Files:**
- Create: `backend/app/access.py`
- Test: `backend/tests/test_access.py`

**Interfaces:**
- Consumes: `app.models.Role`.
- Produces:
  - `app.access.Action` — an enumeration of actions.
  - `app.access.can(role: Role | None, action: Action, *, project_granted: bool = False) -> bool`. `role=None` means a guest by link.
  - `app.access.require(role, action, *, project_granted=False) -> None` — raises a `PermissionError`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_access.py`:

```python
import pytest

from app.access import Action, can, require
from app.models import Role


def test_owner_can_do_everything():
    for action in Action:
        assert can(Role.OWNER, action, project_granted=True) is True


def test_editor_writes_projects_but_does_not_administer_the_org():
    assert can(Role.EDITOR, Action.PROJECT_WRITE) is True
    assert can(Role.EDITOR, Action.PROJECT_READ) is True
    assert can(Role.EDITOR, Action.ORG_ADMIN) is False


def test_viewer_reads_and_comments_only():
    assert can(Role.VIEWER, Action.PROJECT_READ) is True
    assert can(Role.VIEWER, Action.COMMENT) is True
    assert can(Role.VIEWER, Action.PROJECT_WRITE) is False


def test_client_reads_only_granted_projects():
    assert can(Role.CLIENT, Action.PROJECT_READ, project_granted=True) is True
    assert can(Role.CLIENT, Action.PROJECT_READ, project_granted=False) is False


def test_client_and_guest_never_see_the_internal_note():
    assert can(Role.CLIENT, Action.READ_INTERNAL_NOTE, project_granted=True) is False
    assert can(None, Action.READ_INTERNAL_NOTE, project_granted=True) is False
    assert can(Role.VIEWER, Action.READ_INTERNAL_NOTE) is True


def test_guest_reads_the_shared_project_and_comments():
    assert can(None, Action.PROJECT_READ, project_granted=True) is True
    assert can(None, Action.COMMENT, project_granted=True) is True
    assert can(None, Action.PROJECT_WRITE, project_granted=True) is False


def test_require_raises_for_a_forbidden_action():
    with pytest.raises(PermissionError):
        require(Role.VIEWER, Action.PROJECT_WRITE)
```

- [ ] **Step 2: Run the tests and make sure they fail**

```bash
cd backend && uv run pytest tests/test_access.py -v
```

Expected: `ModuleNotFoundError: No module named 'app.access'`.

- [ ] **Step 3: Implement the matrix**

Create `backend/app/access.py`. This is the only place in the code where "is this allowed" is decided:

```python
from enum import StrEnum

from app.models import Role


class Action(StrEnum):
    PROJECT_READ = "project_read"
    PROJECT_WRITE = "project_write"
    PROJECT_ADMIN = "project_admin"
    ORG_ADMIN = "org_admin"
    COMMENT = "comment"
    READ_INTERNAL_NOTE = "read_internal_note"


_MATRIX: dict[Role | None, frozenset[Action]] = {
    Role.OWNER: frozenset(Action),
    Role.EDITOR: frozenset(
        {
            Action.PROJECT_READ,
            Action.PROJECT_WRITE,
            Action.PROJECT_ADMIN,
            Action.COMMENT,
            Action.READ_INTERNAL_NOTE,
        }
    ),
    Role.VIEWER: frozenset(
        {Action.PROJECT_READ, Action.COMMENT, Action.READ_INTERNAL_NOTE}
    ),
    Role.CLIENT: frozenset({Action.PROJECT_READ, Action.COMMENT}),
    None: frozenset({Action.PROJECT_READ, Action.COMMENT}),
}

# Роли, которые видят только те проекты, куда их позвали явно.
_NEEDS_GRANT: frozenset[Role | None] = frozenset({Role.CLIENT, None})


def can(role: Role | None, action: Action, *, project_granted: bool = False) -> bool:
    if role in _NEEDS_GRANT and not project_granted:
        return False
    return action in _MATRIX.get(role, frozenset())


def require(role: Role | None, action: Action, *, project_granted: bool = False) -> None:
    if not can(role, action, project_granted=project_granted):
        raise PermissionError(f"{role or 'guest'} не может выполнить {action}")
```

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
cd backend && uv run pytest tests/test_access.py -v
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/access.py backend/tests/test_access.py
git commit -m "feat: матрица прав как единственное место принятия решения о доступе"
```

---

### Task 7: Settings resolution and assembling a project's calendar

**Files:**
- Create: `backend/app/settings_resolution.py`
- Test: `backend/tests/test_settings_resolution.py`

**Interfaces:**
- Consumes: `app.models.Organization`, `app.models.Project`, `app.calendar.Calendar`.
- Produces:
  - `app.settings_resolution.resolve_working_days(project, org) -> int`
  - `app.settings_resolution.resolve_timezone(project, org) -> str`
  - `app.settings_resolution.resolve_shift_threshold(project, org) -> int`
  - `app.settings_resolution.project_calendar(project, org) -> Calendar`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_settings_resolution.py`:

```python
from datetime import date

from app.calendar import WEEKDAYS_MON_FRI
from app.models import Organization, Project
from app.settings_resolution import (
    project_calendar,
    resolve_shift_threshold,
    resolve_working_days,
)

SUN_TO_THU = (1 << 6) | (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3)


def _org(**kwargs) -> Organization:
    org = Organization(name="Acme", slug="acme", **kwargs)
    org.default_locale = kwargs.get("default_locale", "az")
    org.working_days = kwargs.get("working_days", WEEKDAYS_MON_FRI)
    org.default_shift_threshold_days = kwargs.get("default_shift_threshold_days", 2)
    org.holiday_calendar = kwargs.get("holiday_calendar", [])
    return org


def _project(**kwargs) -> Project:
    project = Project(name="Redesign", slug="redesign")
    project.working_days = kwargs.get("working_days")
    project.shift_threshold_days = kwargs.get("shift_threshold_days")
    project.holidays_extra = kwargs.get("holidays_extra", [])
    project.workdays_extra = kwargs.get("workdays_extra", [])
    return project


def test_null_on_the_project_means_inherit():
    org = _org(working_days=SUN_TO_THU, default_shift_threshold_days=5)
    project = _project()

    assert resolve_working_days(project, org) == SUN_TO_THU
    assert resolve_shift_threshold(project, org) == 5


def test_explicit_value_on_the_project_wins():
    org = _org(working_days=SUN_TO_THU, default_shift_threshold_days=5)
    project = _project(working_days=WEEKDAYS_MON_FRI, shift_threshold_days=1)

    assert resolve_working_days(project, org) == WEEKDAYS_MON_FRI
    assert resolve_shift_threshold(project, org) == 1


def test_changing_the_org_default_reaches_inheriting_projects_only():
    org = _org(default_shift_threshold_days=2)
    inheriting = _project()
    overriding = _project(shift_threshold_days=7)

    org.default_shift_threshold_days = 10

    assert resolve_shift_threshold(inheriting, org) == 10
    assert resolve_shift_threshold(overriding, org) == 7


def test_calendar_layers_org_holidays_then_project_extras():
    org = _org(holiday_calendar=["2026-03-20"])
    project = _project(holidays_extra=["2026-03-21"], workdays_extra=["2026-03-07"])

    cal = project_calendar(project, org)

    assert cal.is_working(date(2026, 3, 20)) is False  # праздник организации
    assert cal.is_working(date(2026, 3, 21)) is False  # доп. выходной проекта
    assert cal.is_working(date(2026, 3, 7)) is True    # рабочая суббота проекта
    assert cal.is_working(date(2026, 3, 19)) is True   # обычный четверг
```

- [ ] **Step 2: Run the tests and make sure they fail**

```bash
cd backend && uv run pytest tests/test_settings_resolution.py -v
```

Expected: `ModuleNotFoundError: No module named 'app.settings_resolution'`.

- [ ] **Step 3: Implement the module**

Create `backend/app/settings_resolution.py`:

```python
from datetime import date

from app.calendar import Calendar
from app.models import Organization, Project


def _dates(raw: list[str] | None) -> frozenset[date]:
    return frozenset(date.fromisoformat(item) for item in (raw or []))


def resolve_working_days(project: Project, org: Organization) -> int:
    return project.working_days if project.working_days is not None else org.working_days


def resolve_timezone(project: Project, org: Organization) -> str:
    return project.timezone if project.timezone is not None else org.default_timezone


def resolve_shift_threshold(project: Project, org: Organization) -> int:
    if project.shift_threshold_days is not None:
        return project.shift_threshold_days
    return org.default_shift_threshold_days


def project_calendar(project: Project, org: Organization) -> Calendar:
    """Календарь проекта: маска недели, минус праздники организации и проекта,
    плюс явно объявленные рабочие дни проекта."""
    holidays = _dates(org.holiday_calendar) | _dates(project.holidays_extra)
    return Calendar(
        working_days=resolve_working_days(project, org),
        holidays=holidays,
        extra_workdays=_dates(project.workdays_extra),
    )
```

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
cd backend && uv run pytest tests/test_settings_resolution.py -v
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/settings_resolution.py backend/tests/test_settings_resolution.py
git commit -m "feat: наследование настроек организация-проект и сборка календаря"
```

---

### Task 8: The mutation registry and the revision journal

**Files:**
- Create: `backend/app/mutations.py`
- Test: `backend/tests/test_mutations.py`

**Interfaces:**
- Consumes: `app.models`, `app.calendar`, `app.settings_resolution.project_calendar`.
- Produces:
  - `app.mutations.Op` — a discriminated union of operations: `CreateCategory`, `CreateTask`, `MoveTask`, `SetDuration`, `DeleteTask`.
  - `app.mutations.apply_op(db, project, op, *, actor_id, reason=None, batch_id=None) -> Revision`.
  - `app.mutations.undo(db, project, revision, *, actor_id) -> Revision`.

Every operation returns its own inverse when applied. This is exactly the mechanism a task's history, undo and rolling back an AI batch will grow out of later.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_mutations.py`:

```python
from datetime import date

import pytest

from app.models import Category, Organization, Project, Revision, Task
from app.mutations import (
    CreateCategory,
    CreateTask,
    DeleteCategory,
    DeleteTask,
    MoveTask,
    SetDuration,
    apply_op,
    undo,
)


@pytest.fixture
def project(db):
    org = Organization(name="Acme", slug="acme")
    db.add(org)
    db.flush()
    project = Project(org_id=org.id, name="Redesign", slug="redesign")
    db.add(project)
    db.flush()
    return project


@pytest.fixture
def category(db, project):
    revision = apply_op(
        db,
        project,
        CreateCategory(name="Design", color="#3b82f6"),
        actor_id=None,
    )
    return db.get(Category, revision.op["category_id"])


def test_create_task_writes_a_revision_after_the_category_one(db, project, category):
    revision = apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id),
            name="Logo",
            start_date=date(2026, 3, 4),
            duration_days=5,
        ),
        actor_id=None,
    )

    assert revision.seq == 2  # первая ревизия ушла на создание категории
    assert revision.op["type"] == "create_task"
    assert revision.inverse["type"] == "delete_task"

    task = db.get(Task, revision.op["task_id"])
    assert task.name == "Logo"
    assert task.duration_days == 5


def test_seq_increments_per_project(db, project, category):
    for index in range(3):
        apply_op(
            db,
            project,
            CreateTask(
                category_id=str(category.id),
                name=f"Task {index}",
                start_date=date(2026, 3, 4),
                duration_days=2,
            ),
            actor_id=None,
        )

    numbers = [r.seq for r in db.query(Revision).order_by(Revision.seq).all()]
    assert numbers == [1, 2, 3, 4]


def test_move_task_records_both_dates(db, project, category):
    created = apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id),
            name="Logo",
            start_date=date(2026, 3, 4),
            duration_days=5,
        ),
        actor_id=None,
    )
    task_id = created.op["task_id"]

    moved = apply_op(
        db,
        project,
        MoveTask(task_id=task_id, start_date=date(2026, 3, 11)),
        actor_id=None,
        reason="брендбук задержали",
    )

    assert moved.op == {
        "type": "move_task",
        "task_id": task_id,
        "from": "2026-03-04",
        "to": "2026-03-11",
    }
    assert moved.inverse["to"] == "2026-03-04"
    assert moved.reason == "брендбук задержали"


def test_undo_restores_the_previous_state(db, project, category):
    created = apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id),
            name="Logo",
            start_date=date(2026, 3, 4),
            duration_days=5,
        ),
        actor_id=None,
    )
    task_id = created.op["task_id"]

    moved = apply_op(
        db, project, MoveTask(task_id=task_id, start_date=date(2026, 3, 11)), actor_id=None
    )
    undo(db, project, moved, actor_id=None)

    assert db.get(Task, task_id).start_date == date(2026, 3, 4)


def test_undo_of_a_delete_brings_the_task_back_with_the_same_id(db, project, category):
    created = apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id),
            name="Logo",
            start_date=date(2026, 3, 4),
            duration_days=5,
        ),
        actor_id=None,
    )
    task_id = created.op["task_id"]

    deleted = apply_op(db, project, DeleteTask(task_id=task_id), actor_id=None)
    assert db.get(Task, task_id) is None

    undo(db, project, deleted, actor_id=None)
    restored = db.get(Task, task_id)
    assert restored is not None
    assert restored.name == "Logo"


def test_deleting_a_non_empty_category_is_refused(db, project, category):
    apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id),
            name="Logo",
            start_date=date(2026, 3, 4),
            duration_days=5,
        ),
        actor_id=None,
    )

    with pytest.raises(ValueError, match="не пуста"):
        apply_op(db, project, DeleteCategory(category_id=str(category.id)), actor_id=None)


def test_undo_of_a_category_delete_restores_it_with_the_same_id(db, project, category):
    deleted = apply_op(db, project, DeleteCategory(category_id=str(category.id)), actor_id=None)
    assert db.get(Category, category.id) is None

    undo(db, project, deleted, actor_id=None)
    restored = db.get(Category, category.id)
    assert restored is not None
    assert restored.name == "Design"


def test_set_duration_rejects_zero(db, project, category):
    created = apply_op(
        db,
        project,
        CreateTask(
            category_id=str(category.id),
            name="Logo",
            start_date=date(2026, 3, 4),
            duration_days=5,
        ),
        actor_id=None,
    )

    with pytest.raises(ValueError):
        apply_op(
            db, project, SetDuration(task_id=created.op["task_id"], duration_days=0), actor_id=None
        )
```

- [ ] **Step 2: Run the tests and make sure they fail**

```bash
cd backend && uv run pytest tests/test_mutations.py -v
```

Expected: `ModuleNotFoundError: No module named 'app.mutations'`.

- [ ] **Step 3: Implement the operation registry**

Create `backend/app/mutations.py`:

```python
import uuid
from datetime import date
from typing import Annotated, Literal

from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from app.models import Category, Project, Revision, Task


class CreateCategory(BaseModel):
    type: Literal["create_category"] = "create_category"
    name: str
    color: str
    category_id: uuid.UUID | None = None


class CreateTask(BaseModel):
    type: Literal["create_task"] = "create_task"
    category_id: uuid.UUID
    name: str
    start_date: date
    duration_days: int
    description: str = ""
    criticality: str = "normal"
    task_id: uuid.UUID | None = None


class MoveTask(BaseModel):
    type: Literal["move_task"] = "move_task"
    task_id: uuid.UUID
    start_date: date


class SetDuration(BaseModel):
    type: Literal["set_duration"] = "set_duration"
    task_id: uuid.UUID
    duration_days: int


class DeleteTask(BaseModel):
    type: Literal["delete_task"] = "delete_task"
    task_id: uuid.UUID


class DeleteCategory(BaseModel):
    type: Literal["delete_category"] = "delete_category"
    category_id: uuid.UUID


Op = Annotated[
    CreateCategory | CreateTask | MoveTask | SetDuration | DeleteTask | DeleteCategory,
    Field(discriminator="type"),
]


def _next_seq(db: DbSession, project: Project) -> int:
    current = db.scalar(
        select(func.coalesce(func.max(Revision.seq), 0)).where(Revision.project_id == project.id)
    )
    return current + 1


def _require_task(db: DbSession, project: Project, task_id: uuid.UUID) -> Task:
    task = db.get(Task, task_id)
    if task is None or task.project_id != project.id:
        raise ValueError("задача не найдена в этом проекте")
    return task


def _apply(db: DbSession, project: Project, op) -> tuple[dict, dict]:
    """Применяет операцию и возвращает пару (что записать в op, что записать в inverse)."""

    if isinstance(op, CreateCategory):
        category = Category(
            id=op.category_id or uuid.uuid4(),
            project_id=project.id,
            name=op.name,
            color=op.color,
            position=db.scalar(
                select(func.count()).select_from(Category).where(Category.project_id == project.id)
            ),
        )
        db.add(category)
        db.flush()
        return (
            {"type": "create_category", "category_id": str(category.id), "name": op.name,
             "color": op.color},
            {"type": "delete_category", "category_id": str(category.id)},
        )

    if isinstance(op, CreateTask):
        if op.duration_days < 1:
            raise ValueError("длительность должна быть не меньше одного дня")
        task = Task(
            id=op.task_id or uuid.uuid4(),
            project_id=project.id,
            category_id=op.category_id,
            name=op.name,
            description=op.description,
            start_date=op.start_date,
            duration_days=op.duration_days,
            criticality=op.criticality,
            position=db.scalar(
                select(func.count()).select_from(Task).where(Task.project_id == project.id)
            ),
        )
        db.add(task)
        db.flush()
        return (
            {
                "type": "create_task",
                "task_id": str(task.id),
                "category_id": str(task.category_id),
                "name": task.name,
                "start_date": task.start_date.isoformat(),
                "duration_days": task.duration_days,
                "description": task.description,
                "criticality": task.criticality,
            },
            {"type": "delete_task", "task_id": str(task.id)},
        )

    if isinstance(op, MoveTask):
        task = _require_task(db, project, op.task_id)
        previous = task.start_date
        task.start_date = op.start_date
        db.flush()
        return (
            {"type": "move_task", "task_id": str(task.id), "from": previous.isoformat(),
             "to": op.start_date.isoformat()},
            {"type": "move_task", "task_id": str(task.id), "from": op.start_date.isoformat(),
             "to": previous.isoformat()},
        )

    if isinstance(op, SetDuration):
        if op.duration_days < 1:
            raise ValueError("длительность должна быть не меньше одного дня")
        task = _require_task(db, project, op.task_id)
        previous = task.duration_days
        task.duration_days = op.duration_days
        db.flush()
        return (
            {"type": "set_duration", "task_id": str(task.id), "from": previous,
             "to": op.duration_days},
            {"type": "set_duration", "task_id": str(task.id), "from": op.duration_days,
             "to": previous},
        )

    if isinstance(op, DeleteCategory):
        category = db.get(Category, op.category_id)
        if category is None or category.project_id != project.id:
            raise ValueError("категория не найдена в этом проекте")
        remaining = db.scalar(
            select(func.count()).select_from(Task).where(Task.category_id == category.id)
        )
        # Удаление непустой категории унесло бы задачи каскадом, и обратная
        # операция их бы не вернула. Требуем сначала разобрать содержимое.
        if remaining:
            raise ValueError("категория не пуста")
        snapshot = {
            "type": "create_category",
            "category_id": str(category.id),
            "name": category.name,
            "color": category.color,
        }
        db.delete(category)
        db.flush()
        return ({"type": "delete_category", "category_id": str(op.category_id)}, snapshot)

    if isinstance(op, DeleteTask):
        task = _require_task(db, project, op.task_id)
        snapshot = {
            "type": "create_task",
            "task_id": str(task.id),
            "category_id": str(task.category_id),
            "name": task.name,
            "start_date": task.start_date.isoformat(),
            "duration_days": task.duration_days,
            "description": task.description,
            "criticality": task.criticality,
        }
        db.delete(task)
        db.flush()
        return ({"type": "delete_task", "task_id": str(op.task_id)}, snapshot)

    raise ValueError(f"неизвестная операция: {op!r}")


def apply_op(
    db: DbSession,
    project: Project,
    op,
    *,
    actor_id: uuid.UUID | None,
    reason: str | None = None,
    batch_id: uuid.UUID | None = None,
) -> Revision:
    forward, inverse = _apply(db, project, op)
    revision = Revision(
        project_id=project.id,
        seq=_next_seq(db, project),
        actor_user_id=actor_id,
        op=forward,
        inverse=inverse,
        reason=reason,
        batch_id=batch_id,
    )
    db.add(revision)
    db.flush()
    return revision


_MODELS = {
    "create_category": CreateCategory,
    "create_task": CreateTask,
    "move_task": MoveTask,
    "set_duration": SetDuration,
    "delete_task": DeleteTask,
    "delete_category": DeleteCategory,
}


def _op_from_dict(payload: dict):
    """Восстанавливает операцию из записи журнала.

    В журнале move_task и set_duration хранят обе границы (from и to), поэтому
    поле значения берётся из to — так одна и та же запись читается и как
    прямая операция, и как обратная.
    """
    kind = payload["type"]
    model = _MODELS[kind]
    data = dict(payload)
    if kind == "move_task":
        data["start_date"] = data.pop("to")
        data.pop("from", None)
    elif kind == "set_duration":
        data["duration_days"] = data.pop("to")
        data.pop("from", None)
    return model.model_validate(data)


def undo(db: DbSession, project: Project, revision: Revision, *, actor_id: uuid.UUID | None) -> Revision:
    return apply_op(db, project, _op_from_dict(revision.inverse), actor_id=actor_id)
```

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
cd backend && uv run pytest tests/test_mutations.py -v
```

Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/mutations.py backend/tests/test_mutations.py
git commit -m "feat: реестр мутаций с обратными операциями и журналом ревизий"
```

---

### Task 9: The HTTP layer for projects and mutations

**Files:**
- Create: `backend/app/api/project_routes.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_project_api.py`

**Interfaces:**
- Consumes: `app.auth.current_user`, `app.access`, `app.mutations.apply_op`, `app.settings_resolution.project_calendar`, `app.calendar.end_date`.
- Produces: the routes `POST /api/projects`, `GET /api/projects`, `GET /api/projects/{project_id}`, `POST /api/projects/{project_id}/mutations`.

The project's response contains every task's computed end date — it is not stored but computed from the project's calendar.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_project_api.py`:

```python
import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client(db):
    from app.db import get_db

    app.dependency_overrides[get_db] = lambda: db
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture
def authed(client):
    client.post(
        "/api/auth/register",
        json={"name": "Alex", "email": "alex@example.com", "password": "s3cret-pass"},
    )
    return client


def test_creating_a_project_derives_a_slug_from_the_name(authed):
    response = authed.post("/api/projects", json={"name": "Şəhər Layihəsi"})
    assert response.status_code == 201
    assert response.json()["slug"] == "seher-layihesi"


def test_project_listing_shows_only_own_organization(authed):
    authed.post("/api/projects", json={"name": "Redesign"})
    response = authed.get("/api/projects")
    assert response.status_code == 200
    assert [item["name"] for item in response.json()] == ["Redesign"]


def test_mutation_creates_a_task_and_returns_the_computed_end_date(authed):
    project_id = authed.post("/api/projects", json={"name": "Redesign"}).json()["id"]
    category_id = authed.post(
        f"/api/projects/{project_id}/mutations",
        json={"op": {"type": "create_category", "name": "Design", "color": "#3b82f6"}},
    ).json()["op"]["category_id"]

    authed.post(
        f"/api/projects/{project_id}/mutations",
        json={
            "op": {
                "type": "create_task",
                "category_id": category_id,
                "name": "Logo",
                "start_date": "2026-03-06",
                "duration_days": 3,
            }
        },
    )

    state = authed.get(f"/api/projects/{project_id}").json()
    task = state["tasks"][0]
    assert task["start_date"] == "2026-03-06"
    # пятница плюс три рабочих дня: пт, пн, вт
    assert task["end_date"] == "2026-03-10"


def test_mutation_requires_authentication(client):
    response = client.post(
        "/api/projects/00000000-0000-0000-0000-000000000000/mutations",
        json={"op": {"type": "create_category", "name": "X", "color": "#000000"}},
    )
    assert response.status_code == 401


def test_mutation_on_a_foreign_project_returns_404(authed, db):
    from app.models import Organization, Project

    other_org = Organization(name="Other", slug="other")
    db.add(other_org)
    db.flush()
    foreign = Project(org_id=other_org.id, name="Secret", slug="secret")
    db.add(foreign)
    db.flush()

    response = authed.post(
        f"/api/projects/{foreign.id}/mutations",
        json={"op": {"type": "create_category", "name": "X", "color": "#000000"}},
    )
    assert response.status_code == 404
```

- [ ] **Step 2: Run the tests and make sure they fail**

```bash
cd backend && uv run pytest tests/test_project_api.py -v
```

Expected: a 404 on `POST /api/projects` — the route does not exist yet.

- [ ] **Step 3: Implement the routes**

Create `backend/app/api/project_routes.py`:

```python
import secrets
import uuid

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.access import Action, can
from app.auth import current_user
from app.calendar import end_date
from app.db import get_db
from app.models import Category, Membership, Organization, Project, Role, Task, User
from app.mutations import Op, apply_op
from app.settings_resolution import project_calendar
from app.text import slugify

router = APIRouter(prefix="/api/projects", tags=["projects"])


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class ProjectOut(BaseModel):
    id: str
    name: str
    slug: str


def _membership(db: DbSession, user: User) -> Membership:
    membership = db.scalar(select(Membership).where(Membership.user_id == user.id))
    if membership is None:
        raise HTTPException(status_code=403, detail="no_organization")
    return membership


def _load_project(db: DbSession, user: User, project_id: uuid.UUID) -> tuple[Project, Membership]:
    membership = _membership(db, user)
    project = db.get(Project, project_id)
    # чужой проект неотличим от несуществующего: 404, а не 403
    if project is None or project.org_id != membership.org_id:
        raise HTTPException(status_code=404, detail="project_not_found")
    return project, membership


def _unique_slug(db: DbSession, org_id: uuid.UUID, name: str) -> str:
    base = slugify(name)
    taken = db.scalar(
        select(Project).where(Project.org_id == org_id, Project.slug == base)
    )
    return base if taken is None else f"{base}-{secrets.token_hex(3)}"


@router.post("", response_model=ProjectOut, status_code=201)
def create_project(
    payload: ProjectIn, user: User = Depends(current_user), db: DbSession = Depends(get_db)
):
    membership = _membership(db, user)
    if not can(Role(membership.role), Action.PROJECT_WRITE):
        raise HTTPException(status_code=403, detail="forbidden")

    project = Project(
        org_id=membership.org_id,
        name=payload.name,
        slug=_unique_slug(db, membership.org_id, payload.name),
    )
    db.add(project)
    db.flush()
    return ProjectOut(id=str(project.id), name=project.name, slug=project.slug)


@router.get("", response_model=list[ProjectOut])
def list_projects(user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    membership = _membership(db, user)
    projects = db.scalars(select(Project).where(Project.org_id == membership.org_id)).all()
    return [ProjectOut(id=str(p.id), name=p.name, slug=p.slug) for p in projects]


@router.get("/{project_id}")
def get_project(
    project_id: uuid.UUID, user: User = Depends(current_user), db: DbSession = Depends(get_db)
):
    project, membership = _load_project(db, user, project_id)
    org = db.get(Organization, project.org_id)
    calendar = project_calendar(project, org)
    show_notes = can(Role(membership.role), Action.READ_INTERNAL_NOTE)

    categories = db.scalars(
        select(Category).where(Category.project_id == project.id).order_by(Category.position)
    ).all()
    tasks = db.scalars(
        select(Task).where(Task.project_id == project.id).order_by(Task.position)
    ).all()

    return {
        "id": str(project.id),
        "name": project.name,
        "slug": project.slug,
        "categories": [
            {"id": str(c.id), "name": c.name, "color": c.color, "position": c.position}
            for c in categories
        ],
        "tasks": [
            {
                "id": str(t.id),
                "category_id": str(t.category_id),
                "name": t.name,
                "description": t.description,
                "start_date": t.start_date.isoformat(),
                "duration_days": t.duration_days,
                "end_date": end_date(t.start_date, t.duration_days, calendar).isoformat(),
                "criticality": t.criticality,
                "progress_pct": t.progress_pct,
                "position": t.position,
                **({"internal_note": t.internal_note} if show_notes else {}),
            }
            for t in tasks
        ],
    }


@router.post("/{project_id}/mutations", status_code=201)
def apply_mutation(
    project_id: uuid.UUID,
    op: Op = Body(..., embed=True),
    reason: str | None = Body(default=None),
    user: User = Depends(current_user),
    db: DbSession = Depends(get_db),
):
    project, membership = _load_project(db, user, project_id)
    if not can(Role(membership.role), Action.PROJECT_WRITE):
        raise HTTPException(status_code=403, detail="forbidden")

    try:
        revision = apply_op(db, project, op, actor_id=user.id, reason=reason)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error))

    return {"seq": revision.seq, "op": revision.op, "inverse": revision.inverse}
```

Add the route wiring to `backend/app/main.py`:

```python
from fastapi import FastAPI

from app.api import auth_routes, project_routes

app = FastAPI(title="Planora")
app.include_router(auth_routes.router)
app.include_router(project_routes.router)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
```

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
cd backend && uv run pytest tests/test_project_api.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Run the whole test suite**

```bash
cd backend && uv run pytest -v
```

Expected: every test green, not one skipped.

- [ ] **Step 6: Check the application live**

```bash
docker compose up -d && curl -s localhost:8000/api/health
```

Expected: `{"status":"ok"}`.

- [ ] **Step 7: Commit**

```bash
git add backend/app/api/project_routes.py backend/app/main.py backend/tests/test_project_api.py
git commit -m "feat: HTTP-слой проектов и применение мутаций"
```

---

## What this plan deliberately does not do

So that the next reader does not look for what is missing:

- **Plan approval, the baseline and the threshold with a reason** — plan 3. The `baseline_start`, `baseline_duration` and `plan_version` fields are already in the model, but there is no logic around them: `reason` is accepted and stored in the mutations but is optional for now.
- **WebSocket and live updates** — plan 4. The revisions are already written, there is nobody to broadcast them to.
- **Public links, guests, comments** — plan 4. The permission matrix already knows about a guest (`role=None`), the `ShareLink` and `Comment` entities do not exist yet.
- **Invitations, mail, address confirmation** — plan 5. `email_verified_at` exists and stays empty.
- **AI intake** — plan 6.
- **The full set of mutations.** Five are implemented: creating a category, creating a task, moving, changing the duration, deleting. The rest (renaming, changing the criticality, the progress, assigning owners, reordering, links) are added the same way in plan 2, when the interface comes for them.
- **Localizing the API's responses.** The journal already stores an event with parameters rather than a phrase — that is enough for the frontend to assemble the text in its own language. There are no server-side dictionaries and there will be no need for any until emails appear.
