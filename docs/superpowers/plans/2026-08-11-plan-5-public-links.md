# Plan 5: public links and guests — implementation plan

> **Historical.** This is one of the original build plans this codebase
> was built from — every step below has since shipped. It reflects the plan
> as scoped in August 2026, not necessarily today's implementation; for
> current architecture and conventions, see the repo's `CLAUDE.md` and the
> `planora-conventions` skill. Kept as a build-history record, not an active
> task list.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a project to a person without an account at an address assembled from the organization and project slugs, and let them comment under their own name.

**Architecture:** The public page reads the project through a separate route with no session. The response body is assembled by the same builder as the working screen — with notes and assignees switched off: two copies of one layout would diverge on the very first new column, and an internal note would leak outward through exactly the copy that was forgotten. The guest's right to comment is asked of the same matrix as a member's: `can(None, Action.COMMENT, project_granted=True)`, where the role is `None` and the granted access is the live link itself.

**Tech Stack:** As in plans 0-4. No new dependencies.

## Decisions taken before the plan

**The address is `/p/{org-slug}/{project-slug}`, with no token.** That is the product owner's decision. The specification in §7 promises both a pretty address made of slugs and a link re-issue that kills the previous one — those two do not work together: if there is no secret in the address, the address after a re-issue is the same one. The accepted consequences:

- Revoking takes the project out of publication: the address stops opening instantly. Publishing again revives **the same** address — slugs cannot give you a "re-issue" after which the old link is dead and a new one works.
- A real re-issue is renaming the project slug. That is why editing the slug belongs to this plan and not to the settings plan: without it nothing whatsoever fulfils the promise of §7.
- A published project can be guessed by brute-forcing slugs. That is the price of the decision, and it is a conscious one: neither internal notes, nor the organization's roster, nor the change journal ever go outward.

**The `/p/` prefix is kept,** even though the owner's example did not have it (`planora.com/company/project`). The reason is technical: `/{something}/{something}` at the root also intercepts the application's own addresses — an organization with the slug `login` or `projects` would shadow the sign-in page and the project list — and after that no unknown two-segment address can honestly answer "not found".

**There is no token in `share_links`.** The specification lists one as part of the entity, but it is no longer in the address, and a secret that is never substituted anywhere protects nothing and misleads the next reader.

## Global Constraints

- Public routes require no session and do not read the cookie. Everything that decides access is the slugs in the address and the state of the link.
- An internal note never goes outward. The server makes that decision: no field in the response means no block in the interface.
- The guest's right is asked of `app.access`, not compared against a string. `None` acts as the guest's role.
- Server refusals are a machine code in `detail`, with no prose.
- Languages: `az` by default, `en`, `ru`; a key must appear in all three dictionaries.
- Dates and endings are computed by the server. The public page computes no more than the working one — that is, nothing.
- The guest comment limiter takes its ceiling from `GUEST_COMMENT_RATE_LIMIT`, not from a constant in the code.

## Files

| File | Responsibility |
|---|---|
| `backend/app/models.py` | The `share_links` table |
| `backend/app/sharing.py` | The publication domain: publish, revoke, toggle comments, find by slugs |
| `backend/app/project_state.py` | The single project-state builder — for the working screen and for the public page |
| `backend/app/rate_limit.py` | Sliding window by key; the guest's key is their address |
| `backend/app/api/project_routes.py` | Project settings, publication, slug |
| `backend/app/api/public_routes.py` | Reading the project and guest replies without a session |
| `frontend/src/api/sharing.ts`, `frontend/src/screens/ProjectSettings.tsx` | The project settings screen |
| `frontend/src/api/public.ts`, `frontend/src/screens/PublicProject.tsx` | The public page |

---

### Task 1: The public link table

**Files:**
- Modify: `backend/app/models.py`
- Create: `backend/migrations/versions/<hash>_share_links.py`
- Test: `backend/tests/test_models.py`

**Interfaces:**
- Produces: `ShareLink` with the fields `id`, `project_id` (unique), `comments_enabled`, `revoked_at`, `created_at`.

There is one link per project — hence `UniqueConstraint("project_id")`. A second row would mean two different addresses to one project, whereas the address is derived from the slugs and is therefore exactly one.

- [x] **Step 1: Write a failing test**

At the end of `backend/tests/test_models.py`:

```python
def test_project_has_at_most_one_share_link(db):
    """Адрес выводится из слагов и потому ровно один. Второй ряд означал бы
    два разных адреса к одному проекту — и вопрос, какой из них главный."""
    org = Organization(name="Acme", slug="acme")
    db.add(org)
    db.flush()
    project = Project(org_id=org.id, name="Redesign", slug="redesign")
    db.add(project)
    db.flush()

    link = ShareLink(project_id=project.id)
    db.add(link)
    db.flush()

    assert link.comments_enabled is True
    assert link.revoked_at is None

    with pytest.raises(IntegrityError):
        with db.begin_nested():
            db.add(ShareLink(project_id=project.id))
            db.flush()
```

Extend the import at the top with `ShareLink`.

- [x] **Step 2: Make sure the test fails**

```bash
cd backend && uv run pytest tests/test_models.py -q
```

Expected: `ImportError: cannot import name 'ShareLink'`.

- [x] **Step 3: Add the model**

In `backend/app/models.py`, after `Comment`:

```python
class ShareLink(Base):
    __tablename__ = "share_links"
    # Одна ссылка на проект: адрес выводится из слагов организации и проекта,
    # и второго адреса к тому же проекту просто не существует.
    __table_args__ = (UniqueConstraint("project_id"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    # Токена здесь нет, хотя спецификация его перечисляет: адрес собран из
    # слагов, подставлять секрет некуда. Колонка, которую никто не читает,
    # обещала бы защиту, которой нет.
    comments_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # Отзыв не удаляет ряд: когда ссылку открывали и когда закрыли — это
    # журнал, а не мусор. Публикация заново обнуляет отметку.
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
```

- [x] **Step 4: Make sure the test passes**

```bash
cd backend && uv run pytest tests/test_models.py -q
```

- [x] **Step 5: Migration**

```bash
cd backend && uv run alembic revision --autogenerate -m "share_links" && uv run alembic upgrade head && uv run pytest -q
```

Check that `upgrade()` contains only `create_table('share_links')`.

- [x] **Step 6: Commit**

```bash
git add backend/app/models.py backend/migrations backend/tests/test_models.py
git commit -m "feat: таблица публичной ссылки"
```

---

### Task 2: The publication domain

**Files:**
- Create: `backend/app/sharing.py`
- Test: `backend/tests/test_sharing.py`

**Interfaces:**
- Produces:
  - `publish(db, project, org) -> ShareLink`
  - `revoke(db, project) -> None`
  - `set_comments_enabled(db, project, enabled: bool) -> ShareLink`
  - `link_of(db, project) -> ShareLink | None` — the live link or `None`
  - `resolve(db, org_slug: str, project_slug: str) -> tuple[Project, Organization, ShareLink]`
  - `public_path(org, project) -> str`
  - `SharingRefused(code, message)`, `NotPublished(SharingRefused)`

`resolve` is the only place where it is decided whether the project is open to the outside. There are three conditions (the link exists, it is not revoked, the organization has not forbidden publication altogether), and spreading them across routes would mean checking two out of three in one place and three out of three in another.

- [x] **Step 1: Write failing tests**

Create `backend/tests/test_sharing.py`:

```python
import pytest

from app.models import Organization, Project, ShareLink
from app.sharing import (
    NotPublished,
    SharingRefused,
    link_of,
    public_path,
    publish,
    resolve,
    revoke,
    set_comments_enabled,
)


@pytest.fixture
def org(db):
    org = Organization(name="Acme", slug="acme")
    db.add(org)
    db.flush()
    return org


@pytest.fixture
def project(db, org):
    project = Project(org_id=org.id, name="Redesign", slug="redesign-2026")
    db.add(project)
    db.flush()
    return project


def test_publishing_opens_the_address_built_from_slugs(db, org, project):
    link = publish(db, project, org)

    assert link.revoked_at is None
    assert public_path(org, project) == "/p/acme/redesign-2026"
    assert resolve(db, "acme", "redesign-2026")[0].id == project.id


def test_comments_start_from_the_organization_default(db, org, project):
    """Умолчание организации — это умолчание, а не рекомендация: проект,
    который его не переопределял, обязан ему следовать."""
    org.default_comments_enabled = False
    db.flush()

    assert publish(db, project, org).comments_enabled is False


def test_revoking_closes_the_address_immediately(db, org, project):
    publish(db, project, org)
    revoke(db, project)

    with pytest.raises(NotPublished):
        resolve(db, "acme", "redesign-2026")
    assert link_of(db, project) is None


def test_publishing_again_revives_the_same_address(db, org, project):
    """Следствие решения об адресе из слагов, а не оплошность: секрета в
    адресе нет, и «новой» ссылке взяться неоткуда."""
    publish(db, project, org)
    revoke(db, project)
    revived = publish(db, project, org)

    assert revived.revoked_at is None
    assert resolve(db, "acme", "redesign-2026")[0].id == project.id
    # Ряд тот же самый: журнал публикаций не должен плодить дубликаты.
    assert db.query(ShareLink).count() == 1


def test_organization_may_forbid_public_sharing_entirely(db, org, project):
    org.public_sharing_enabled = False
    db.flush()

    with pytest.raises(SharingRefused) as refusal:
        publish(db, project, org)
    assert refusal.value.code == "public_sharing_disabled"


def test_a_link_of_an_organization_that_revoked_sharing_stops_resolving(db, org, project):
    """Выключатель организации гасит уже выданные ссылки, а не только новые:
    иначе запрет ничего не запрещает до тех пор, пока кто-то не отзовёт
    каждую ссылку руками."""
    publish(db, project, org)
    org.public_sharing_enabled = False
    db.flush()

    with pytest.raises(NotPublished):
        resolve(db, "acme", "redesign-2026")


def test_unknown_slugs_are_refused_the_same_way_as_a_revoked_link(db, org, project):
    """Одинаковый отказ — не лень: разные ответы рассказали бы перебором,
    какие организации и проекты существуют."""
    publish(db, project, org)

    with pytest.raises(NotPublished):
        resolve(db, "acme", "no-such-project")
    with pytest.raises(NotPublished):
        resolve(db, "globex", "redesign-2026")


def test_comments_switch_is_remembered(db, org, project):
    publish(db, project, org)

    assert set_comments_enabled(db, project, False).comments_enabled is False
    assert resolve(db, "acme", "redesign-2026")[2].comments_enabled is False


def test_switching_comments_on_an_unpublished_project_is_refused(db, org, project):
    with pytest.raises(SharingRefused) as refusal:
        set_comments_enabled(db, project, True)
    assert refusal.value.code == "not_published"
```

- [x] **Step 2: Make sure the tests fail**

```bash
cd backend && uv run pytest tests/test_sharing.py -q
```

Expected: `ModuleNotFoundError: No module named 'app.sharing'`.

- [x] **Step 3: Write the module**

Create `backend/app/sharing.py`:

```python
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.models import Organization, Project, ShareLink


class SharingRefused(Exception):
    """Отказ опубликовать или изменить публикацию.

    Той же формы, что MutationError и CommentRefused: машинный код наружу,
    человеческий текст — в журнал.
    """

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class NotPublished(SharingRefused):
    """По этому адресу ничего не открыто.

    Один класс на три разных случая — нет такой организации, нет такого
    проекта, ссылка отозвана — сознательно: разные ответы позволили бы
    перебором выяснить, какие организации и проекты существуют.
    """


def public_path(org: Organization, project: Project) -> str:
    """Адрес публичной страницы.

    Собирается здесь, а не в браузере: слаги нормализует сервер (см. text.py),
    и второй сборщик адреса в клиенте однажды разойдётся с этим — получится
    ссылка, которая не открывается.

    Префикс `/p/` не украшение: без него `/{организация}/{проект}` перехватил
    бы и собственные адреса приложения, и организация со слагом `login`
    заслонила бы вход.
    """
    return f"/p/{org.slug}/{project.slug}"


def link_of(db: DbSession, project: Project) -> ShareLink | None:
    """Действующая ссылка проекта. Отозванная — это отсутствие ссылки."""
    link = db.scalar(select(ShareLink).where(ShareLink.project_id == project.id))
    return link if link is not None and link.revoked_at is None else link and None


def publish(db: DbSession, project: Project, org: Organization) -> ShareLink:
    """Открыть проект наружу.

    Повторная публикация оживляет прежний ряд, а не создаёт новый: ряд — это
    журнал публикаций проекта, и второй ряд означал бы второй адрес, которого
    у слагов быть не может.
    """
    if not org.public_sharing_enabled:
        raise SharingRefused("public_sharing_disabled", "организация запретила публичные ссылки")

    link = db.scalar(select(ShareLink).where(ShareLink.project_id == project.id))
    if link is None:
        # Умолчание организации применяется один раз, при первой публикации:
        # дальше переключателем распоряжается владелец проекта, и повторная
        # публикация не должна отменять его решение.
        link = ShareLink(project_id=project.id, comments_enabled=org.default_comments_enabled)
        db.add(link)
    else:
        link.revoked_at = None
    db.flush()
    return link


def revoke(db: DbSession, project: Project) -> None:
    """Закрыть адрес. Мгновенно: следующий запрос по нему уже не откроется."""
    link = db.scalar(select(ShareLink).where(ShareLink.project_id == project.id))
    if link is not None and link.revoked_at is None:
        link.revoked_at = datetime.now(timezone.utc)
        db.flush()


def set_comments_enabled(db: DbSession, project: Project, enabled: bool) -> ShareLink:
    link = link_of(db, project)
    if link is None:
        raise SharingRefused("not_published", "проект не опубликован")
    link.comments_enabled = enabled
    db.flush()
    return link


def resolve(
    db: DbSession, org_slug: str, project_slug: str
) -> tuple[Project, Organization, ShareLink]:
    """Проект, открытый по этому адресу, — или отказ.

    Единственное место, где решается, открыт ли проект наружу. Условий три —
    организация не запретила публикацию, ссылка есть, ссылка не отозвана, — и
    разнести их по маршрутам значило бы однажды проверить два из трёх.
    """
    row = db.execute(
        select(Project, Organization, ShareLink)
        .join(Organization, Organization.id == Project.org_id)
        .join(ShareLink, ShareLink.project_id == Project.id)
        .where(
            Organization.slug == org_slug,
            Project.slug == project_slug,
            ShareLink.revoked_at.is_(None),
            Organization.public_sharing_enabled.is_(True),
        )
    ).first()
    if row is None:
        raise NotPublished("project_not_found", "по этому адресу ничего не открыто")
    return row[0], row[1], row[2]
```

- [x] **Step 4: Make sure the tests pass**

```bash
cd backend && uv run pytest tests/test_sharing.py -q
```

Expected: 9 passed.

- [x] **Step 5: Commit**

```bash
git add backend/app/sharing.py backend/tests/test_sharing.py
git commit -m "feat: домен публикации проекта"
```

---

### Task 3: One project-state builder

**Files:**
- Create: `backend/app/project_state.py`
- Modify: `backend/app/api/project_routes.py`
- Test: `backend/tests/test_project_state.py`

**Interfaces:**
- Produces: `build_state(db, project, org, *, show_notes: bool, show_assignees: bool) -> dict`.

A change with no change in behaviour: the body of `GET /api/projects/{id}` moves into a module as it is, and the route starts calling it. Done **before** the public route and as a separate commit, because otherwise the public page gets a second copy of the layout and the very first new column will appear in only one of them — and if that column turns out to be the note, it leaks outward.

`show_assignees` is switched off for a guest: assignees are the organization's roster, and a guest is not shown it (`GET /api/org/members` is not available to the `client` role at all).

- [x] **Step 1: Write a test for the builder**

Create `backend/tests/test_project_state.py`:

```python
from datetime import date

import pytest

from app.models import Category, Organization, Project, Task, User
from app.project_state import build_state
from app.security import hash_password


@pytest.fixture
def filled(db):
    org = Organization(name="Acme", slug="acme")
    db.add(org)
    db.flush()
    project = Project(org_id=org.id, name="Redesign", slug="redesign")
    db.add(project)
    db.flush()
    category = Category(project_id=project.id, name="Дизайн", color="#3b82f6", position=0)
    db.add(category)
    db.flush()
    task = Task(
        project_id=project.id,
        category_id=category.id,
        name="Логотип",
        internal_note="клиент платит с задержкой",
        start_date=date(2026, 3, 4),
        duration_days=5,
    )
    db.add(task)
    db.flush()
    return project, org


def test_state_carries_the_note_when_the_reader_may_see_it(db, filled):
    project, org = filled
    state = build_state(db, project, org, show_notes=True, show_assignees=True)

    assert state["tasks"][0]["internal_note"] == "клиент платит с задержкой"
    assert "assignee_ids" in state["tasks"][0]
    assert state["tasks"][0]["end_date"] == "2026-03-10"


def test_state_for_a_guest_carries_neither_notes_nor_assignees(db, filled):
    """Заметка не выходит наружу никогда, а исполнители — это состав
    организации, которого гость не видит и в остальных маршрутах."""
    project, org = filled
    state = build_state(db, project, org, show_notes=False, show_assignees=False)

    assert "internal_note" not in state["tasks"][0]
    assert "assignee_ids" not in state["tasks"][0]
    # Всё остальное на месте: гость видит ту же раскладку, а не огрызок.
    assert state["tasks"][0]["name"] == "Логотип"
    assert state["calendar"]["working_days"] > 0
```

- [x] **Step 2: Make sure the test fails**

```bash
cd backend && uv run pytest tests/test_project_state.py -q
```

Expected: `ModuleNotFoundError: No module named 'app.project_state'`.

- [x] **Step 3: Move the state assembly into a module**

Create `backend/app/project_state.py`: move into it, **with no changes in substance**, the body of `get_project` from `backend/app/api/project_routes.py`, starting at the line `calendar = project_calendar(project, org)` and up to and including `return {...}`, wrapped in a function:

```python
import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.calendar import CalendarError, end_date
from app.models import Category, Dependency, Organization, Project, Task, TaskAssignee
from app.settings_resolution import project_calendar, resolve_shift_threshold, resolve_timezone


def build_state(
    db: DbSession,
    project: Project,
    org: Organization,
    *,
    show_notes: bool,
    show_assignees: bool,
) -> dict:
    """Состояние проекта в том виде, в каком его показывают на экране.

    Один сборщик на рабочий экран и на публичную страницу. Вторая копия
    разошлась бы с первой на первой же новой колонке — а если этой колонкой
    окажется внутренняя заметка, она утечёт наружу именно через ту копию, про
    которую забыли.

    Что показывать, решает вызывающий: заметку — по праву READ_INTERNAL_NOTE,
    исполнителей — по тому, видит ли читатель состав организации вообще.
    """
```

The body is the former code with two differences: the assignee dictionary is built only when `show_assignees`, and it is substituted into the task by the same trick as the note:

```python
    assignees: dict[str, list[str]] = {}
    if show_assignees:
        assignees = {str(t.id): [] for t in tasks}
        for task_id, user_id in db.execute(...).all():
            assignees[str(task_id)].append(str(user_id))
```

and in the task assembly:

```python
                **({"assignee_ids": assignees[str(t.id)]} if show_assignees else {}),
                **({"internal_note": t.internal_note} if show_notes else {}),
```

- [x] **Step 4: Call the builder from the route**

`get_project` in `backend/app/api/project_routes.py` shrinks to:

```python
@router.get("/{project_id}")
def get_project(
    project_id: uuid.UUID, user: User = Depends(current_user), db: DbSession = Depends(get_db)
):
    project, membership = _load_project(db, user, project_id)
    _require_project_read(membership)
    org = db.get(Organization, project.org_id)
    return build_state(
        db,
        project,
        org,
        show_notes=can(parse_role(membership.role), Action.READ_INTERNAL_NOTE),
        show_assignees=True,
    )
```

Imports left unused after the move (`Category`, `Task`, `TaskAssignee`, `Dependency`, `end_date`, `CalendarError`, `project_calendar`, `resolve_*`) should be removed from `project_routes.py` — keep the ones the mutations still need; the equivalent of `npm run lint` for Python here is only a pair of eyes, so cross-check against the list at the end of the file.

- [x] **Step 5: Make sure nothing broke**

```bash
cd backend && uv run pytest -q
```

Expected: all the previous project tests pass without edits — that is exactly the check that the change did not alter behaviour.

- [x] **Step 6: Commit**

```bash
git add backend/app/project_state.py backend/app/api/project_routes.py backend/tests/test_project_state.py
git commit -m "refactor: состояние проекта собирается одним местом"
```

---

### Task 4: Project settings and publication

**Files:**
- Modify: `backend/app/api/project_routes.py`
- Test: `backend/tests/test_share_api.py`

**Interfaces:**
- Produces:
  - `GET /api/projects/{id}/settings` → `{slug, public_url, public_sharing_enabled, share: {published, comments_enabled}}`
  - `PUT /api/projects/{id}/share` with body `{published: bool, comments_enabled: bool}` → the same `share` object

One route instead of three (publish, revoke, toggle): the body describes the desired state in full, so calling it again breaks nothing, and the toggle and the publish button in the interface send the same thing.

The permission is `Action.PROJECT_ADMIN`: publishing a project to the outside is not the same as editing a task, and a `viewer`, who is forbidden to edit, certainly should not be opening the project to the world.

- [x] **Step 1: Write failing tests**

Create `backend/tests/test_share_api.py` with the `client`/`authed`/`project_id` fixtures (copy them from `tests/test_comment_api.py` — they are right there and of the same shape) and tests:

```python
def test_settings_show_the_address_before_it_is_published(authed, project_id):
    """Адрес известен заранее: он выведен из слагов, а не выдан публикацией.
    Владелец должен видеть, что именно он собирается открыть."""
    settings = authed.get(f"/api/projects/{project_id}/settings").json()

    assert settings["public_url"].endswith("/p/alex/redesign")
    assert settings["share"]["published"] is False


def test_publishing_and_revoking_flip_the_same_field(authed, project_id):
    published = authed.put(
        f"/api/projects/{project_id}/share",
        json={"published": True, "comments_enabled": True},
    )
    assert published.status_code == 200
    assert published.json()["published"] is True

    revoked = authed.put(
        f"/api/projects/{project_id}/share",
        json={"published": False, "comments_enabled": True},
    )
    assert revoked.json()["published"] is False
    assert authed.get(f"/api/projects/{project_id}/settings").json()["share"]["published"] is False


def test_comments_switch_survives_republishing(authed, project_id):
    """Переключателем распоряжается владелец проекта: повторная публикация не
    должна возвращать умолчание организации поверх его решения."""
    authed.put(
        f"/api/projects/{project_id}/share",
        json={"published": True, "comments_enabled": False},
    )
    authed.put(
        f"/api/projects/{project_id}/share",
        json={"published": False, "comments_enabled": False},
    )
    again = authed.put(
        f"/api/projects/{project_id}/share",
        json={"published": True, "comments_enabled": False},
    )

    assert again.json()["comments_enabled"] is False


def test_a_viewer_may_not_publish_a_project(authed, project_id, db):
    """Открыть проект миру — не то же, что поправить задачу: право отдельное."""
    from sqlalchemy import select

    from app.models import Membership

    db.scalar(select(Membership)).role = "viewer"
    db.flush()

    response = authed.put(
        f"/api/projects/{project_id}/share",
        json={"published": True, "comments_enabled": True},
    )
    assert response.status_code == 403


def test_organization_that_forbids_sharing_refuses_publication(authed, project_id, db):
    from sqlalchemy import select

    from app.models import Organization

    db.scalar(select(Organization)).public_sharing_enabled = False
    db.flush()

    response = authed.put(
        f"/api/projects/{project_id}/share",
        json={"published": True, "comments_enabled": True},
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "public_sharing_disabled"


def test_settings_of_another_organization_are_not_reachable(authed, db):
    from app.models import Organization, Project

    other = Organization(name="Globex", slug="globex")
    db.add(other)
    db.flush()
    stranger = Project(org_id=other.id, name="Secret", slug="secret")
    db.add(stranger)
    db.flush()

    assert authed.get(f"/api/projects/{stranger.id}/settings").status_code == 404
```

- [x] **Step 2: Make sure the tests fail**

```bash
cd backend && uv run pytest tests/test_share_api.py -q
```

- [x] **Step 3: Add the routes**

In `backend/app/api/project_routes.py`:

```python
class ShareIn(BaseModel):
    published: bool
    comments_enabled: bool


def _share_out(link: ShareLink | None) -> dict:
    return {
        "published": link is not None,
        # Выключенная публикация не забывает настройку комментариев: она
        # хранится в ряду и вернётся вместе со следующей публикацией.
        "comments_enabled": link.comments_enabled if link else True,
    }


@router.get("/{project_id}/settings")
def project_settings(
    project_id: uuid.UUID, user: User = Depends(current_user), db: DbSession = Depends(get_db)
):
    project, membership = _load_project(db, user, project_id)
    if not can(parse_role(membership.role), Action.PROJECT_ADMIN):
        raise HTTPException(status_code=403, detail="forbidden")
    org = db.get(Organization, project.org_id)

    return {
        "slug": project.slug,
        # Полный адрес собирает сервер: PUBLIC_BASE_URL знает он, а браузер
        # знает только тот адрес, по которому открыт сам, — за обратным
        # прокси это разные вещи.
        "public_url": get_settings().public_base_url.rstrip("/") + public_path(org, project),
        "public_sharing_enabled": org.public_sharing_enabled,
        "share": _share_out(link_of(db, project)),
    }


@router.put("/{project_id}/share")
def set_share(
    project_id: uuid.UUID,
    payload: ShareIn,
    user: User = Depends(current_user),
    db: DbSession = Depends(get_db),
):
    """Желаемое состояние публикации целиком, а не три отдельных действия.

    Повторный вызов с тем же телом ничего не меняет, поэтому кнопка публикации
    и переключатель комментариев шлют одно и то же, а гонка двух вкладок
    заканчивается последним состоянием, а не ошибкой.
    """
    project, membership = _load_project(db, user, project_id)
    if not can(parse_role(membership.role), Action.PROJECT_ADMIN):
        raise HTTPException(status_code=403, detail="forbidden")
    org = db.get(Organization, project.org_id)

    try:
        if payload.published:
            publish(db, project, org)
            set_comments_enabled(db, project, payload.comments_enabled)
        else:
            revoke(db, project)
    except SharingRefused as error:
        raise HTTPException(status_code=422, detail=error.code)

    return _share_out(link_of(db, project))
```

Imports: `from app.config import get_settings`, `from app.models import ShareLink`, `from app.sharing import SharingRefused, link_of, public_path, publish, revoke, set_comments_enabled`.

- [x] **Step 4: Make sure the tests pass, and run the backend suite**

```bash
cd backend && uv run pytest -q
```

- [x] **Step 5: Commit**

```bash
git add backend/app/api/project_routes.py backend/tests/test_share_api.py
git commit -m "feat: настройки проекта и публикация"
```

---

### Task 5: The project slug — checking and renaming

**Files:**
- Modify: `backend/app/projects.py`, `backend/app/api/project_routes.py`
- Test: `backend/tests/test_slug_api.py`

**Interfaces:**
- Produces:
  - `rename_slug(db, project, raw: str) -> Project` and `free_slug(db, org_id, raw: str) -> tuple[bool, str]` in `app/projects.py`
  - `GET /api/projects/{id}/slug-check?slug=…` → `{available: bool, suggestion: str}`
  - `PUT /api/projects/{id}/slug` with body `{slug}` → `{slug, public_url}`; a taken one is 422 `slug_taken`

Renaming is the only way to genuinely re-issue the link when the address is made of slugs: after it the old address is dead and the new one works. That is why it is here and not in the settings plan.

The slug is normalized by the server with the same `slugify` as at creation time: a person types «Редизайн 2026» and gets `redizayn-2026`. The transliteration must not be repeated in the browser — a divergence would produce a link that does not open.

- [x] **Step 1: Write failing tests**

Create `backend/tests/test_slug_api.py` (fixtures as in `test_share_api.py`):

```python
def test_slug_is_normalized_by_the_server_not_by_the_caller(authed, project_id):
    response = authed.put(f"/api/projects/{project_id}/slug", json={"slug": "Редизайн 2026"})

    assert response.status_code == 200
    assert response.json()["slug"] == "redizayn-2026"


def test_renaming_the_slug_kills_the_old_address(authed, project_id):
    """При адресе из слагов это единственный настоящий перевыпуск ссылки."""
    authed.put(
        f"/api/projects/{project_id}/share", json={"published": True, "comments_enabled": True}
    )
    before = authed.get(f"/api/projects/{project_id}/settings").json()["public_url"]

    authed.put(f"/api/projects/{project_id}/slug", json={"slug": "redesign-2027"})
    after = authed.get(f"/api/projects/{project_id}/settings").json()["public_url"]

    assert before != after
    assert after.endswith("/p/alex/redesign-2027")


def test_a_taken_slug_is_refused_and_a_free_one_is_suggested(authed, project_id):
    authed.post("/api/projects", json={"name": "Другой"})
    taken = authed.get("/api/projects").json()[1]["slug"]

    refusal = authed.put(f"/api/projects/{project_id}/slug", json={"slug": taken})
    assert refusal.status_code == 422
    assert refusal.json()["detail"] == "slug_taken"

    check = authed.get(f"/api/projects/{project_id}/slug-check?slug={taken}").json()
    assert check["available"] is False
    assert check["suggestion"].startswith(taken)
    assert check["suggestion"] != taken


def test_its_own_slug_is_not_taken_by_itself(authed, project_id):
    """Иначе форма настроек ругается на слаг, который уже стоит в поле."""
    current = authed.get(f"/api/projects/{project_id}/settings").json()["slug"]

    assert authed.get(f"/api/projects/{project_id}/slug-check?slug={current}").json()[
        "available"
    ] is True


def test_a_slug_that_normalizes_to_nothing_is_refused(authed, project_id):
    """«...» и одни пробелы дают пустой слаг, а пустой адрес не открывается."""
    response = authed.put(f"/api/projects/{project_id}/slug", json={"slug": "..."})

    assert response.status_code == 422
    assert response.json()["detail"] == "slug_empty"


def test_a_viewer_may_not_rename_the_slug(authed, project_id, db):
    from sqlalchemy import select

    from app.models import Membership

    db.scalar(select(Membership)).role = "viewer"
    db.flush()

    assert (
        authed.put(f"/api/projects/{project_id}/slug", json={"slug": "whatever"}).status_code == 403
    )
```

- [x] **Step 2: Make sure the tests fail**

```bash
cd backend && uv run pytest tests/test_slug_api.py -q
```

- [x] **Step 3: Extend the domain**

In `backend/app/projects.py`:

```python
import secrets

from app.text import slugify


class SlugRefused(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def free_slug(db: DbSession, org_id: uuid.UUID, raw: str, *, except_id=None) -> tuple[bool, str]:
    """Свободен ли слаг и что предложить, если занят.

    Свой собственный слаг проекта занятым не считается: иначе форма настроек
    ругалась бы на значение, которое в ней уже стоит.
    """
    slug = slugify(raw, fallback="")
    if not slug:
        raise SlugRefused("slug_empty", "слаг пуст после нормализации")

    taken = db.scalar(
        select(Project.id).where(
            Project.org_id == org_id, Project.slug == slug, Project.id != except_id
        )
    )
    if taken is None:
        return True, slug
    # Тот же приём, что и при создании: суффикс, а не отказ без вариантов.
    return False, f"{slug}-{secrets.token_hex(3)}"


def rename_slug(db: DbSession, project: Project, raw: str) -> Project:
    available, slug = free_slug(db, project.org_id, raw, except_id=project.id)
    if not available:
        raise SlugRefused("slug_taken", "слаг занят")
    project.slug = slug
    db.flush()
    return project
```

- [x] **Step 4: Add the routes**

In `backend/app/api/project_routes.py`:

```python
class SlugIn(BaseModel):
    slug: str = Field(min_length=1, max_length=100)


@router.get("/{project_id}/slug-check")
def check_slug(
    project_id: uuid.UUID,
    slug: str = Query(min_length=1, max_length=100),
    user: User = Depends(current_user),
    db: DbSession = Depends(get_db),
):
    project, membership = _load_project(db, user, project_id)
    if not can(parse_role(membership.role), Action.PROJECT_ADMIN):
        raise HTTPException(status_code=403, detail="forbidden")
    try:
        available, suggestion = free_slug(db, project.org_id, slug, except_id=project.id)
    except SlugRefused as error:
        raise HTTPException(status_code=422, detail=error.code)
    return {"available": available, "suggestion": suggestion}


@router.put("/{project_id}/slug")
def set_slug(
    project_id: uuid.UUID,
    payload: SlugIn,
    user: User = Depends(current_user),
    db: DbSession = Depends(get_db),
):
    project, membership = _load_project(db, user, project_id)
    if not can(parse_role(membership.role), Action.PROJECT_ADMIN):
        raise HTTPException(status_code=403, detail="forbidden")
    try:
        rename_slug(db, project, payload.slug)
    except SlugRefused as error:
        raise HTTPException(status_code=422, detail=error.code)

    org = db.get(Organization, project.org_id)
    return {
        "slug": project.slug,
        "public_url": get_settings().public_base_url.rstrip("/") + public_path(org, project),
    }
```

- [x] **Step 5: Run the backend suite and commit**

```bash
cd backend && uv run pytest -q
git add backend/app/projects.py backend/app/api/project_routes.py backend/tests/test_slug_api.py
git commit -m "feat: переименование слага проекта"
```

---

### Task 6: Public reading of a project

**Files:**
- Create: `backend/app/api/public_routes.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_public_api.py`

**Interfaces:**
- Consumes: `resolve` (Task 2), `build_state` (Task 3).
- Produces: `GET /api/public/{org_slug}/{project_slug}` → the project state plus `comments_enabled`.

Its own file rather than `project_routes.py`: every single route there begins with `_load_project(db, user, …)`, whereas here there is no user at all. Two families sharing one file sooner or later ends with a public route getting a `Depends(current_user)` by oversight and ceasing to be public.

- [x] **Step 1: Write failing tests**

Create `backend/tests/test_public_api.py`. The `client`/`authed`/`project_id` fixtures are as before; plus:

```python
@pytest.fixture
def published(authed, project_id):
    authed.put(
        f"/api/projects/{project_id}/share", json={"published": True, "comments_enabled": True}
    )
    return project_id


def _address(authed, project_id) -> str:
    slug = authed.get(f"/api/projects/{project_id}/settings").json()["slug"]
    return f"/api/public/alex/{slug}"


def test_a_guest_reads_a_published_project_without_a_session(client, authed, published):
    guest = TestClient(app)

    response = guest.get(_address(authed, published))

    assert response.status_code == 200
    assert response.json()["name"] == "Redesign"


def test_a_guest_sees_neither_internal_notes_nor_assignees(client, authed, published):
    category = authed.post(
        f"/api/projects/{published}/mutations",
        json={"op": {"type": "create_category", "name": "Дизайн", "color": "#3b82f6"}},
    ).json()["op"]["category_id"]
    authed.post(
        f"/api/projects/{published}/mutations",
        json={
            "op": {
                "type": "create_task",
                "category_id": category,
                "name": "Логотип",
                "start_date": "2026-03-04",
                "duration_days": 5,
                "internal_note": "клиент платит с задержкой",
            }
        },
    )
    guest = TestClient(app)

    task = guest.get(_address(authed, published)).json()["tasks"][0]

    assert "internal_note" not in task
    assert "assignee_ids" not in task
    assert task["end_date"] == "2026-03-10"


def test_an_unpublished_project_is_not_found(client, authed, project_id):
    guest = TestClient(app)

    assert guest.get(_address(authed, project_id)).status_code == 404


def test_a_revoked_address_dies_immediately(client, authed, published):
    guest = TestClient(app)
    assert guest.get(_address(authed, published)).status_code == 200

    authed.put(
        f"/api/projects/{published}/share", json={"published": False, "comments_enabled": True}
    )

    assert guest.get(_address(authed, published)).status_code == 404


def test_unknown_addresses_answer_exactly_like_a_revoked_one(client, authed, published):
    """Разные ответы рассказали бы перебором, какие организации существуют."""
    guest = TestClient(app)

    assert guest.get("/api/public/globex/redesign").status_code == 404
    assert guest.get("/api/public/alex/no-such-project").status_code == 404


def test_the_state_says_whether_comments_are_open(client, authed, published):
    guest = TestClient(app)
    assert guest.get(_address(authed, published)).json()["comments_enabled"] is True

    authed.put(
        f"/api/projects/{published}/share", json={"published": True, "comments_enabled": False}
    )
    assert guest.get(_address(authed, published)).json()["comments_enabled"] is False
```

- [x] **Step 2: Make sure the tests fail**

```bash
cd backend && uv run pytest tests/test_public_api.py -q
```

- [x] **Step 3: Write the route**

Create `backend/app/api/public_routes.py`:

```python
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session as DbSession

from app.db import get_db
from app.project_state import build_state
from app.sharing import NotPublished, resolve

# Ни один маршрут этого файла не зависит от current_user, и это его причина
# существовать отдельно от project_routes: там каждый маршрут начинается с
# загрузки проекта по сессии, и публичный маршрут по соседству однажды получил
# бы Depends(current_user) по недосмотру.
router = APIRouter(prefix="/api/public", tags=["public"])


@router.get("/{org_slug}/{project_slug}")
def public_project(org_slug: str, project_slug: str, db: DbSession = Depends(get_db)):
    """Проект глазами гостя: та же раскладка, без заметок и исполнителей."""
    try:
        project, org, link = resolve(db, org_slug, project_slug)
    except NotPublished as error:
        raise HTTPException(status_code=404, detail=error.code)

    state = build_state(db, project, org, show_notes=False, show_assignees=False)
    # Открыты ли комментарии — часть состояния страницы, а не отдельный
    # запрос: иначе форма реплики успевает мелькнуть до того, как выяснится,
    # что она запрещена.
    state["comments_enabled"] = link.comments_enabled
    return state
```

In `backend/app/main.py` — `app.include_router(public_routes.router)`.

- [x] **Step 4: Run the backend suite and commit**

```bash
cd backend && uv run pytest -q
git add backend/app/api/public_routes.py backend/app/main.py backend/tests/test_public_api.py
git commit -m "feat: публичное чтение проекта"
```

---

### Task 7: Guest replies and a per-address limiter

**Files:**
- Create: `backend/app/rate_limit.py`
- Modify: `backend/app/api/public_routes.py`
- Test: `backend/tests/test_rate_limit.py`, `backend/tests/test_public_comments_api.py`

**Interfaces:**
- Produces:
  - `RateLimiter(limit: int, window_seconds: float, now: Callable[[], float] = time.monotonic)` with an `allow(key: str) -> bool` method
  - `GET /api/public/{org}/{project}/comments` → the project thread in full
  - `POST /api/public/{org}/{project}/comments` with body `{body, guest_name}` → 201; 403 `comments_disabled`; 429 `too_many_comments`

The limiter keeps its window in process memory, not in the database. The reason is not laziness: the limiter's key is the guest's address, an address is personal data, and storing it in the database for the sake of a counter means setting up a store of personal data where a counter is enough. The price is known and written down: a restart resets the window, and with several processes each has its own. Today there is a single `api` container.

`now` is a parameter, not a call inside: otherwise the only way to check window expiry is to actually wait, and a test for a one-minute window takes a minute.

The guest's right is asked of the matrix: `can(None, Action.COMMENT, project_granted=True)`. The role `None` is the guest, and a live link is exactly the granted access for whose sake `project_granted` exists in `access.py`.

- [x] **Step 1: Write a test for the limiter**

Create `backend/tests/test_rate_limit.py`:

```python
from app.rate_limit import RateLimiter


def test_allows_up_to_the_limit_and_then_refuses():
    clock = [0.0]
    limiter = RateLimiter(limit=3, window_seconds=60, now=lambda: clock[0])

    assert [limiter.allow("ip") for _ in range(3)] == [True, True, True]
    assert limiter.allow("ip") is False


def test_the_window_slides_rather_than_resetting_on_a_schedule():
    """Окно скользит: три реплики в 12:00:59 не должны обнуляться в 12:01:00
    просто потому, что началась новая минута."""
    clock = [0.0]
    limiter = RateLimiter(limit=2, window_seconds=60, now=lambda: clock[0])

    limiter.allow("ip")
    clock[0] = 59.0
    limiter.allow("ip")
    assert limiter.allow("ip") is False

    clock[0] = 61.0  # первая вышла из окна, вторая ещё в нём
    assert limiter.allow("ip") is True
    assert limiter.allow("ip") is False


def test_keys_are_counted_apart():
    clock = [0.0]
    limiter = RateLimiter(limit=1, window_seconds=60, now=lambda: clock[0])

    assert limiter.allow("first") is True
    assert limiter.allow("second") is True
    assert limiter.allow("first") is False


def test_keys_that_fell_out_of_the_window_stop_taking_memory():
    """Иначе счётчик — это утечка: адресов много, окно короткое, а словарь
    растёт вечно."""
    clock = [0.0]
    limiter = RateLimiter(limit=1, window_seconds=60, now=lambda: clock[0])

    limiter.allow("ip")
    clock[0] = 120.0
    limiter.allow("other")

    assert "ip" not in limiter._hits
```

- [x] **Step 2: Write the limiter**

Create `backend/app/rate_limit.py`:

```python
import time
from collections import deque
from collections.abc import Callable


class RateLimiter:
    """Скользящее окно по ключу, в памяти процесса.

    В памяти, а не в базе: ключ гостевого ограничителя — его сетевой адрес,
    то есть персональные данные. Хранить их в базе ради счётчика значит
    завести хранилище персональных данных там, где достаточно счётчика.

    Плата принята сознательно: перезапуск обнуляет окна, а при нескольких
    процессах у каждого своё окно, и общий потолок умножается на их число.
    Сегодня контейнер `api` один; когда их станет больше, счётчик переедет в
    общее хранилище — но это будет замена одного класса, а не переделка
    маршрутов.

    `now` — параметр: иначе истечение окна проверяется только настоящим
    ожиданием, и тест минутного окна идёт минуту.
    """

    def __init__(
        self,
        limit: int,
        window_seconds: float,
        now: Callable[[], float] = time.monotonic,
    ):
        self._limit = limit
        self._window = window_seconds
        self._now = now
        self._hits: dict[str, deque[float]] = {}

    def allow(self, key: str) -> bool:
        moment = self._now()
        self._forget_old(moment)

        hits = self._hits.setdefault(key, deque())
        if len(hits) >= self._limit:
            return False
        hits.append(moment)
        return True

    def _forget_old(self, moment: float) -> None:
        """Иначе счётчик — это утечка: адресов много, окно короткое, а словарь
        растёт вечно. Чистится весь словарь, а не только запрошенный ключ:
        гость, пришедший однажды, второй раз ключ не трогает."""
        edge = moment - self._window
        for key in list(self._hits):
            hits = self._hits[key]
            while hits and hits[0] <= edge:
                hits.popleft()
            if not hits:
                del self._hits[key]
```

```bash
cd backend && uv run pytest tests/test_rate_limit.py -q
```

- [x] **Step 3: Write failing tests for guest replies**

Create `backend/tests/test_public_comments_api.py` (the `authed`/`published`/`_address` fixtures are as in Task 6):

```python
def test_a_guest_leaves_a_reply_signed_by_the_name_they_gave(client, authed, published):
    guest = TestClient(app)

    response = guest.post(
        f"{_address(authed, published)}/comments",
        json={"body": "А когда сдача?", "guest_name": "Нигяр"},
    )

    assert response.status_code == 201
    assert response.json()["guest_name"] == "Нигяр"
    assert response.json()["author"] is None


def test_guests_and_members_read_the_same_thread(client, authed, published):
    guest = TestClient(app)
    guest.post(
        f"{_address(authed, published)}/comments",
        json={"body": "вопрос гостя", "guest_name": "Нигяр"},
    )
    authed.post(f"/api/projects/{published}/comments", json={"body": "ответ участника"})

    seen_by_guest = [c["body"] for c in guest.get(f"{_address(authed, published)}/comments").json()]

    assert seen_by_guest == ["вопрос гостя", "ответ участника"]


def test_a_reply_without_a_name_is_refused(client, authed, published):
    guest = TestClient(app)

    response = guest.post(
        f"{_address(authed, published)}/comments", json={"body": "аноним", "guest_name": "  "}
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "guest_name_required"


def test_replies_are_refused_when_the_owner_switched_comments_off(client, authed, published):
    authed.put(
        f"/api/projects/{published}/share", json={"published": True, "comments_enabled": False}
    )
    guest = TestClient(app)

    response = guest.post(
        f"{_address(authed, published)}/comments", json={"body": "?", "guest_name": "Нигяр"}
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "comments_disabled"


def test_a_revoked_address_takes_the_thread_with_it(client, authed, published):
    guest = TestClient(app)
    authed.put(
        f"/api/projects/{published}/share", json={"published": False, "comments_enabled": True}
    )

    assert guest.get(f"{_address(authed, published)}/comments").status_code == 404


def test_too_many_replies_from_one_address_are_refused(client, authed, published, monkeypatch):
    """Потолок берётся из GUEST_COMMENT_RATE_LIMIT, а не из константы в коде."""
    from app.api import public_routes

    monkeypatch.setattr(public_routes, "_guest_limiter", RateLimiter(limit=2, window_seconds=3600))
    guest = TestClient(app)

    for _ in range(2):
        assert (
            guest.post(
                f"{_address(authed, published)}/comments",
                json={"body": "ещё", "guest_name": "Нигяр"},
            ).status_code
            == 201
        )

    refused = guest.post(
        f"{_address(authed, published)}/comments", json={"body": "и ещё", "guest_name": "Нигяр"}
    )
    assert refused.status_code == 429
    assert refused.json()["detail"] == "too_many_comments"
```

- [x] **Step 4: Extend the public routes**

In `backend/app/api/public_routes.py`:

```python
_settings = get_settings()

# Потолок — из настройки, окно — час: «10 реплик» без указания, за какой срок,
# ничего не ограничивает. Живёт в модуле, а не в запросе: счётчик, созданный
# заново на каждый запрос, всегда пуст.
_guest_limiter = RateLimiter(limit=_settings.guest_comment_rate_limit, window_seconds=3600)


class GuestCommentIn(BaseModel):
    body: str = Field(min_length=1, max_length=MAX_COMMENT_LEN)
    guest_name: str = Field(min_length=1, max_length=100)


def _open_project(db: DbSession, org_slug: str, project_slug: str):
    try:
        return resolve(db, org_slug, project_slug)
    except NotPublished as error:
        raise HTTPException(status_code=404, detail=error.code)


@router.get("/{org_slug}/{project_slug}/comments")
def public_comments(org_slug: str, project_slug: str, db: DbSession = Depends(get_db)):
    """Обсуждение проекта целиком: та же ветка, что видят участники.

    Ветка задачи наружу не отдаётся — карточки задачи на публичной странице
    нет, и отдавать ленту, которую негде показать, значит расширять поверхность
    без повода.
    """
    project, _org, _link = _open_project(db, org_slug, project_slug)
    comments = list_comments(db, project)
    actors = {...}  # тот же сбор имён, что и в project_routes.list_project_comments
    return [_comment_out(comment, actors) for comment in comments]


@router.post("/{org_slug}/{project_slug}/comments", status_code=201)
def add_public_comment(
    org_slug: str,
    project_slug: str,
    payload: GuestCommentIn,
    request: Request,
    db: DbSession = Depends(get_db),
):
    project, _org, link = _open_project(db, org_slug, project_slug)

    if not link.comments_enabled:
        raise HTTPException(status_code=403, detail="comments_disabled")
    # Роль гостя — None, а выданным доступом служит сама действующая ссылка:
    # ровно тот случай, ради которого в access.py заведён project_granted.
    if not can(None, Action.COMMENT, project_granted=True):
        raise HTTPException(status_code=403, detail="forbidden")

    # Адрес из соединения, а не из X-Forwarded-For: заголовок подделывается
    # одной строкой, и ограничитель, верящий ему, не ограничивает никого. За
    # обратным прокси это адрес прокси — то есть общий потолок на всех гостей;
    # чинится настройкой доверенных прокси, а не доверием к заголовку.
    caller = request.client.host if request.client else "unknown"
    if not _guest_limiter.allow(caller):
        raise HTTPException(status_code=429, detail="too_many_comments")

    name = payload.guest_name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="guest_name_required")

    try:
        comment = add_comment(db, project, body=payload.body, guest_name=name)
    except CommentRefused as error:
        raise HTTPException(status_code=422, detail=error.code)

    return _comment_out(comment, {})
```

`_comment_out` has moved: take it out of `project_routes.py` into `app/comments.py` (where the reply domain lives) and import it in both route files — otherwise the public file imports a private helper from its neighbour, exactly the kind of coupling the file was created to avoid.

- [x] **Step 5: Run the backend suite and commit**

```bash
cd backend && uv run pytest -q
git add backend/app/rate_limit.py backend/app/api/public_routes.py backend/app/comments.py backend/app/api/project_routes.py backend/tests
git commit -m "feat: гостевые реплики и ограничитель по адресу"
```

---

### Task 8: The project settings screen

**Files:**
- Create: `frontend/src/api/sharing.ts`, `frontend/src/screens/ProjectSettings.tsx`, `frontend/src/screens/ProjectSettings.test.tsx`, `frontend/src/screens/settings.css`
- Modify: `frontend/src/AppRoutes.tsx`, `frontend/src/screens/Project.tsx`, `frontend/src/api/errors.ts`, the three dictionaries

**Interfaces:**
- Produces: the `/projects/:projectId/settings` route, `settingsQueryKey(projectId)`, `projectSettings`, `setShare`, `checkSlug`, `renameSlug`.

The screen is a frame: today it carries the public link and the slug, tomorrow the deadline, the time zone and the calendar will land here. Hence sections rather than one form.

The link is shown by a read-only field plus a "copy" button, not as bare text: the address is long, and picking it out of a paragraph with the mouse is work that one button does.

- [x] **Step 1: Write failing tests**

`frontend/src/screens/ProjectSettings.test.tsx` — check that: the address is visible before publication; the publication toggle sends `{published, comments_enabled}`; turning comments off sends the same with `comments_enabled: false`; a taken slug shows the suggested variant and does not submit the form; a successful rename changes the displayed address; someone without the project-admin permission is met by an explanation rather than an empty form.

The harness follows the style of `src/test/project.ts`: handlers for `GET /api/projects/p1/settings`, `PUT /api/projects/p1/share`, `GET /api/projects/p1/slug-check`, `PUT /api/projects/p1/slug`.

- [x] **Step 2: The client**

`frontend/src/api/sharing.ts` — the types `ProjectSettings = {slug, public_url, public_sharing_enabled, share: {published, comments_enabled}}` and the functions `projectSettings(id)`, `setShare(id, {published, comments_enabled})`, `checkSlug(id, slug)`, `renameSlug(id, slug)`. The key is `["project", id, "settings"]`, under the same prefix as the rest of the project subtree.

- [x] **Step 3: The screen**

`ProjectSettings.tsx`: a heading with the project name, a "Public link" section (read-only address + "Copy", the publication toggle, the comments toggle — inactive until published), an "Address" section (the slug field, a live check with a suggestion, a "Save" button), and a warning that renaming the slug kills the previous address: a person must learn about that before pressing, not from a client whose link has stopped opening.

Copying uses `navigator.clipboard.writeText`; the absence of the API (an old browser, non-https) must not bring the screen down: the button then simply is not shown, and the field stays selectable.

- [x] **Step 4: The route and the way into the screen**

In `AppRoutes.tsx` — `<Route path="/projects/:projectId/settings" element={<ProjectSettings />} />` inside `RequireAuth`. In `Project.tsx` — a "Settings" link in `screen__actions`, visible only when `canWrite`.

- [x] **Step 5: Dictionaries and refusal codes**

The `settings.*` keys in the three dictionaries; the codes `slug_taken`, `slug_empty`, `public_sharing_disabled`, `not_published` — in `PLAIN_CODES` and in the `error` block of all three dictionaries.

- [x] **Step 6: Verify and commit**

```bash
cd frontend && npx vitest run --maxWorkers=2 && npm run lint && npx tsc -b
git add frontend/src && git commit -m "feat: экран настроек проекта"
```

---

### Task 9: The public page

**Files:**
- Create: `frontend/src/api/public.ts`, `frontend/src/screens/PublicProject.tsx`, `frontend/src/screens/PublicProject.test.tsx`, `frontend/src/public/guestName.ts`
- Modify: `frontend/src/AppRoutes.tsx`, `frontend/src/task/Comments.tsx`, the three dictionaries

**Interfaces:**
- Consumes: `GET/POST /api/public/{org}/{project}[/comments]`.
- Produces: the `/p/:orgSlug/:projectSlug` route, `rememberedGuestName()` / `rememberGuestName(name)`.

The page lies **outside** `RequireAuth`: a guest has no session, and checking for one would mean sending them to the sign-in page. The application header is not on it either — in its place are the organization name and the language switch: there is nowhere to offer a guest "Sign out" from.

The chart is the same `<Gantt>` with `canWrite={false}` and without `onSelectTask`: there is no task card on the public page. Internal notes are not in the response, so there is nowhere for them to come from in the markup either — the server made that decision.

The discussion is the project thread in full, the very one plan 4 learned to serve but which had nowhere to be shown.

The guest's name is asked once and remembered in the browser (`localStorage`, key `planora_guest_name`). Not in a cookie: the server never asks for it, and a cookie would travel with every request for nothing.

- [x] **Step 1: Write failing tests**

`PublicProject.test.tsx` — check that: the page opens without a session and shows the chart; there are no internal notes in the markup; with `comments_enabled: false` there is no reply form at all; the first reply asks for a name and sends `{body, guest_name}`; a name saved in the browser is not asked for again; a 404 shows the explanation "this link is not live" rather than an empty screen; a 429 refusal is explained in words.

- [x] **Step 2: Remembering the name**

`frontend/src/public/guestName.ts` — reading and writing `localStorage` guarded against an exception: in some browsers' private mode touching `localStorage` throws, and the page must not go down as a whole because of it.

- [x] **Step 3: The client and the page**

`api/public.ts`: `publicProjectQueryKey(org, project)`, `getPublicProject`, `listPublicComments`, `postPublicComment`. The state type is `ProjectState & { comments_enabled: boolean }`, where `tasks[].internal_note` and `assignee_ids` are optional.

`PublicProject.tsx`: three states (waiting, refusal, page), a header with the organization name and `<LocaleSwitch />`, `<Gantt canWrite={false} />`, and the discussion thread with a form in which a name field stands next to the reply field — it is shown only until the name is remembered.

- [x] **Step 4: Split the discussion thread**

`Comments.tsx` from plan 4 can only do the task thread under a session. The public page needs the project thread under the public routes. Extract the thread markup into `CommentThread` (it takes the list of replies, the submission state and a slot for the form fields), and let `Comments` and the public page be two of its callers. The markup is one — otherwise a guest's reply and a member's reply would diverge in appearance, even though it is one and the same reply.

- [x] **Step 5: The route**

In `AppRoutes.tsx`, **outside** `RequireAuth` and **before** `*`:

```tsx
      <Route path="/p/:orgSlug/:projectSlug" element={<PublicProject />} />
```

- [x] **Step 6: Verify and commit**

```bash
cd frontend && npx vitest run --maxWorkers=2 && npm run lint && npx tsc -b
git add frontend/src && git commit -m "feat: публичная страница проекта"
```

---

## Changes made along the way

- **`stored_link()` next to `link_of()`.** Settings need the row as it is, including a revoked one: otherwise unpublishing returned the comments toggle to the "on" position, and the owner's decision vanished before their eyes.
- **A task bar is not always a button** (`Bar` in `frontend/src/gantt/Row.tsx`). On the public page it neither opens the card nor moves, and a button there takes keyboard focus and is read out by a screen reader as pressable. Now in that case it is a `role="img"` with the same name. Chart tests that render it read-only ask for the bar by the new role.
- **`comment_out` and `author_names` moved into `app/comments.py`.** Both route files assemble them, and a second copy would have split the shape of one and the same reply across two feeds.

## What was left outside the plan

- **The task card on the public page.** A guest sees the chart and the project discussion; an individual task's thread is not served outward.
- **Live updates.** The specification promises the guest bars moving without a reload over WebSocket — that is a separate plan.
