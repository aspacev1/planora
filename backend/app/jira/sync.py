"""Importing a project from Jira and re-syncing it — assembling mutations.

An import creates a new Planora project as a batch of ordinary mutations with a
shared `batch_id`, by the same technique as applying an AI draft (see
app.ai.intake.apply_draft): the history of tasks created from Jira is no
different from the history of any others, and one "Undo" button undoes the whole
batch. Jira epics become categories and the other issues become plan rows; an
issue with no epic goes into the default category.

A sync repeats the same walk over the saved query (JQL) and decides for every
row: not created — create it, created and diverged — update the changed fields,
created and matching — skip it. It does **not**:
  - locally delete tasks/categories that disappeared from the Jira selection
    (Jira is not the source of truth about deletion — a person may have crossed a
    row out here deliberately while leaving it open in Jira);
  - move a task into another category if its epic changed in Jira (a move is
    reorder_task, which asks for a new position, and guessing a place in someone
    else's task list is not an automatic sync's business);
  - demote a milestone back into an ordinary task if the issue type changed in Jira.
Updating dates and statuses that are already created does happen, though: for a
linked project Jira is the source of truth on deadlines and statuses, not
Planora — with one exception. As soon as a particular task's due date is pushed
to Jira with the "Push to Jira" button (`push_project`), that same task is marked
`JiraTaskLink.pushed_due_date`, and from then on its start and duration no longer
come from Jira on an ordinary sync — their source of truth has switched to
Planora for that one row, not for the whole project. The push, meanwhile, is
one-way and not automatic: it changes fields only on a button press, sends only
the Due Date (the one system date field present on any Jira Cloud site — Start
Date exists only with Advanced Roadmaps) and never creates issues in Jira out of
tasks that exist only in Planora.
"""

import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.calendar import end_date
from app.config import get_settings
from app.jira.client import ISSUE_FIELDS, JiraClient
from app.jira.errors import JiraError
from app.jira.mapping import (
    IssueTaskFields,
    epic_key_of,
    find_epic_link_field,
    is_epic,
    issue_summary,
    task_fields_from_issue,
)
from app.models import (
    Category,
    JiraCategoryLink,
    JiraProjectLink,
    JiraTaskLink,
    Organization,
    Project,
    ScheduleMode,
    Task,
    User,
)
from app.mutations import (
    CreateCategory,
    CreateTask,
    RenameCategory,
    ResizeTask,
    SetCriticality,
    SetMilestone,
    SetStatus,
    SetTaskFields,
    apply_op,
)
from app.projects import create_project
from app.settings_resolution import project_calendar

# The palette is presentation, not data: the same short set of six colours the
# manual category-creation form and the application of an AI draft offer (see
# app/ai/intake.py:_COLORS). We do not introduce a shared module for six lines —
# it would weigh more than the price of carrying the palette three times.
_COLORS = ("#3b82f6", "#a855f7", "#f97316", "#10b981", "#ef4444", "#eab308")

_DEFAULT_CATEGORY_NAME = {"ru": "Без эпика", "az": "Epiksiz", "en": "No epic"}

#: The link key of the default category — not a Jira issue key (Jira has no such
#: keys: they are always `PROJECT-number`), so it cannot collide with any real
#: epic. It exists so that a repeated sync finds the already created default
#: category by its link rather than by name: the name depends on the locale of
#: whoever ran it, the link does not.
_NO_EPIC_LINK_KEY = "__no_epic__"


def _color(index: int) -> str:
    return _COLORS[index % len(_COLORS)]


def _default_category_name(locale: str) -> str:
    return _DEFAULT_CATEGORY_NAME.get(locale, _DEFAULT_CATEGORY_NAME["az"])


def default_jql(jira_project_key: str) -> str:
    """The default query: the whole project, from old issues to new ones."""
    return f'project = "{jira_project_key}" ORDER BY created ASC'


def _now() -> datetime:
    return datetime.now(UTC)


def resolve_epic_link_field(client: JiraClient) -> str | None:
    """The id of the "Epic Link" custom field, if the instance has one.

    A refusal here must not bring the whole import down — on some instances the
    field list is unavailable without administrator rights, and without the field
    the epic of team-managed projects (an ordinary `parent`) keeps being
    determined. Classic (company-managed) projects in that case simply fail to
    find their epic through the old field and land in the default category — the
    plan is not broken by that, only more sparsely labelled.
    """
    try:
        return find_epic_link_field(client.list_fields())
    except JiraError:
        return None


@dataclass
class SyncResult:
    created_categories: int = 0
    created_tasks: int = 0
    updated_tasks: int = 0


def _fetch_issues(client: JiraClient, jql: str, epic_link_field: str | None, limit: int) -> list[dict]:
    fields = list(ISSUE_FIELDS)
    if epic_link_field:
        fields.append(epic_link_field)
    return client.search_issues(jql, fields=fields, max_results=limit)


class _CategoryAssigner:
    """The category for a task: by its epic, if one was created, otherwise the default.

    The default category is created lazily, by the first task with no epic: a plan
    where every task has an epic must not get an extra empty stage.
    """

    def __init__(
        self,
        db: DbSession,
        project: Project,
        *,
        by_epic_key: dict[str, uuid.UUID],
        existing_default_id: uuid.UUID | None,
        locale: str,
        next_color_index: int,
        actor: User,
        batch_id: uuid.UUID,
        reason: str | None,
    ):
        self._db = db
        self._project = project
        self._by_epic_key = by_epic_key
        self._default_id = existing_default_id
        self._locale = locale
        self._color_index = next_color_index
        self._actor = actor
        self._batch_id = batch_id
        self._reason = reason
        self.created_default = False

    def for_issue(self, issue: dict, epic_link_field: str | None) -> uuid.UUID:
        epic_key = epic_key_of(issue, epic_link_field)
        if epic_key is not None and epic_key in self._by_epic_key:
            return self._by_epic_key[epic_key]
        if self._default_id is None:
            revision = apply_op(
                self._db,
                self._project,
                CreateCategory(
                    name=_default_category_name(self._locale), color=_color(self._color_index)
                ),
                actor_id=self._actor.id,
                batch_id=self._batch_id,
                reason=self._reason,
            )
            self._default_id = uuid.UUID(revision.op["category_id"])
            self._db.add(
                JiraCategoryLink(
                    project_id=self._project.id,
                    category_id=self._default_id,
                    issue_key=_NO_EPIC_LINK_KEY,
                )
            )
            self.created_default = True
        return self._default_id

    @property
    def default_category_id(self) -> uuid.UUID | None:
        return self._default_id


def _sync_categories(
    db: DbSession,
    project: Project,
    epics: list[dict],
    existing: dict[str, JiraCategoryLink],
    *,
    actor: User,
    batch_id: uuid.UUID,
    reason: str | None,
) -> tuple[dict[str, uuid.UUID], int]:
    by_key: dict[str, uuid.UUID] = {}
    created = 0
    for index, epic in enumerate(epics):
        key = epic.get("key")
        link = existing.get(key)
        name = issue_summary(epic)
        category = db.get(Category, link.category_id) if link is not None else None
        # The category may have been deleted by hand since — the link is then
        # orphaned. This epic's tasks still have to be created (Jira did not delete
        # it), so a new category is created here anew — unlike JiraTaskLink below:
        # there an orphaned link is silently skipped, because a person may have
        # deleted the task deliberately, while a category with not a single row
        # carries no such decision.
        if link is not None and category is None:
            db.delete(link)
        if category is None:
            revision = apply_op(
                db,
                project,
                CreateCategory(name=name, color=_color(index)),
                actor_id=actor.id,
                batch_id=batch_id,
                reason=reason,
            )
            category_id = uuid.UUID(revision.op["category_id"])
            db.add(JiraCategoryLink(project_id=project.id, category_id=category_id, issue_key=key))
            created += 1
        else:
            category_id = category.id
            if category.name != name:
                apply_op(
                    db,
                    project,
                    RenameCategory(category_id=category_id, name=name),
                    actor_id=actor.id,
                    batch_id=batch_id,
                    reason=reason,
                )
        by_key[key] = category_id
    return by_key, created


def _dates_from_jira(link: JiraTaskLink) -> bool:
    """Whether Jira drives this task's dates. `False` means the dates were pushed
    to Jira (see app/jira/sync.py:push_project), and an ordinary sync has no say over them."""
    return link.pushed_due_date is None


def _task_needs_update(task: Task, fields: IssueTaskFields, link: JiraTaskLink) -> bool:
    dates_differ = not fields.milestone and (
        task.start_date != fields.start_date or task.duration_days != fields.duration_days
    )
    return (
        task.name != fields.name
        or task.description != fields.description
        or task.criticality != fields.criticality
        or task.status != fields.status
        or (fields.milestone and not task.milestone)
        or (dates_differ and _dates_from_jira(link))
    )


def _apply_task_update(
    db: DbSession,
    project: Project,
    task: Task,
    fields: IssueTaskFields,
    link: JiraTaskLink,
    *,
    actor: User,
    batch_id: uuid.UUID,
    reason: str | None,
) -> None:
    if task.name != fields.name or task.description != fields.description:
        apply_op(
            db,
            project,
            SetTaskFields(
                task_id=task.id,
                name=fields.name,
                description=fields.description,
                internal_note=task.internal_note,
            ),
            actor_id=actor.id,
            batch_id=batch_id,
            reason=reason,
        )
    if task.criticality != fields.criticality:
        apply_op(
            db,
            project,
            SetCriticality(task_id=task.id, criticality=fields.criticality),
            actor_id=actor.id,
            batch_id=batch_id,
            reason=reason,
        )
    # A milestone is only promoted, never demoted — see the module docstring.
    if fields.milestone and not task.milestone:
        apply_op(
            db,
            project,
            SetMilestone(task_id=task.id, milestone=True),
            actor_id=actor.id,
            batch_id=batch_id,
            reason=reason,
        )
    if (
        not task.milestone
        and not fields.milestone
        and _dates_from_jira(link)
        and (task.start_date != fields.start_date or task.duration_days != fields.duration_days)
    ):
        apply_op(
            db,
            project,
            ResizeTask(
                task_id=task.id, start_date=fields.start_date, duration_days=fields.duration_days
            ),
            actor_id=actor.id,
            batch_id=batch_id,
            reason=reason,
        )
    if task.status != fields.status:
        apply_op(
            db,
            project,
            SetStatus(task_id=task.id, status=fields.status),
            actor_id=actor.id,
            batch_id=batch_id,
            reason=reason,
        )


def _sync_tasks(
    db: DbSession,
    project: Project,
    others: list[dict],
    category_by_epic: dict[str, uuid.UUID],
    existing: dict[str, JiraTaskLink],
    *,
    epic_link_field: str | None,
    calendar,
    locale: str,
    default_category_id: uuid.UUID | None,
    color_index: int,
    actor: User,
    batch_id: uuid.UUID,
    reason: str | None,
) -> tuple[int, int, bool]:
    """Returns (tasks created, tasks updated, whether a new default category was
    created)."""
    assigner = _CategoryAssigner(
        db,
        project,
        by_epic_key=category_by_epic,
        existing_default_id=default_category_id,
        locale=locale,
        next_color_index=color_index,
        actor=actor,
        batch_id=batch_id,
        reason=reason,
    )
    created = updated = 0
    for issue in others:
        key = issue.get("key")
        fields = task_fields_from_issue(issue, calendar)
        link = existing.get(key)
        if link is None:
            category_id = assigner.for_issue(issue, epic_link_field)
            revision = apply_op(
                db,
                project,
                CreateTask(
                    category_id=category_id,
                    name=fields.name,
                    description=fields.description,
                    start_date=fields.start_date,
                    duration_days=fields.duration_days,
                    criticality=fields.criticality,
                    status=fields.status,
                    progress_pct=fields.progress_pct,
                    milestone=fields.milestone,
                ),
                actor_id=actor.id,
                batch_id=batch_id,
                reason=reason,
            )
            task_id = uuid.UUID(revision.op["task_id"])
            db.add(JiraTaskLink(project_id=project.id, task_id=task_id, issue_key=key))
            created += 1
            continue

        if link.task_id is None:
            # The task has been deleted locally since — the link remains as a
            # headstone (task_id nulled by the FK's SET NULL, see the model) rather
            # than resurrecting the task anew: the decision to get rid of a plan row
            # is left to the person who made it.
            continue
        task = db.get(Task, link.task_id)
        if _task_needs_update(task, fields, link):
            _apply_task_update(db, project, task, fields, link, actor=actor, batch_id=batch_id, reason=reason)
            updated += 1

    return created, updated, assigner.created_default


def _sync(
    db: DbSession,
    project: Project,
    client: JiraClient,
    jql: str,
    *,
    actor: User,
    reason: str | None,
    existing_category_links: dict[str, JiraCategoryLink],
    existing_task_links: dict[str, JiraTaskLink],
) -> tuple[SyncResult, uuid.UUID]:
    org = db.get(Organization, project.org_id)
    calendar = project_calendar(project, org)
    epic_link_field = resolve_epic_link_field(client)

    issues = _fetch_issues(client, jql, epic_link_field, get_settings().jira_max_issues_per_sync)
    epics = [issue for issue in issues if is_epic(issue)]
    others = [issue for issue in issues if not is_epic(issue)]

    batch_id = uuid.uuid4()
    category_by_epic, created_categories = _sync_categories(
        db, project, epics, existing_category_links, actor=actor, batch_id=batch_id, reason=reason
    )
    default_link = existing_category_links.get(_NO_EPIC_LINK_KEY)
    default_category_id = default_link.category_id if default_link else None
    # The same orphaned-link check as for epics in _sync_categories: the default
    # category may have been deleted by hand too.
    if default_link is not None and db.get(Category, default_link.category_id) is None:
        db.delete(default_link)
        default_category_id = None

    created_tasks, updated_tasks, created_default_category = _sync_tasks(
        db,
        project,
        others,
        category_by_epic,
        existing_task_links,
        epic_link_field=epic_link_field,
        calendar=calendar,
        locale=actor.locale,
        default_category_id=default_category_id,
        color_index=len(epics),
        actor=actor,
        batch_id=batch_id,
        reason=reason,
    )

    result = SyncResult(
        created_categories=created_categories + (1 if created_default_category else 0),
        created_tasks=created_tasks,
        updated_tasks=updated_tasks,
    )
    return result, batch_id


def import_project(
    db: DbSession,
    *,
    org: Organization,
    client: JiraClient,
    jira_project_key: str,
    name: str,
    jql: str | None,
    actor: User,
) -> tuple[Project, uuid.UUID, SyncResult]:
    """Creates a Planora project from a Jira project. It creates nothing if Jira
    does not answer or the query finds no issues at all — an empty project without
    a single row would be worse than an honest refusal."""
    query = jql or default_jql(jira_project_key)
    project = create_project(db, org_id=org.id, name=name)
    # A plan with real Jira dates is calendar-based, not relative, by the same
    # decision as applying an AI draft (see app.ai.intake.apply_draft).
    project.schedule_mode = ScheduleMode.CALENDAR
    db.flush()

    result, batch_id = _sync(
        db,
        project,
        client,
        query,
        actor=actor,
        reason=None,
        existing_category_links={},
        existing_task_links={},
    )
    db.add(
        JiraProjectLink(
            project_id=project.id, jira_project_key=jira_project_key, jql=query, last_synced_at=_now()
        )
    )
    db.flush()
    return project, batch_id, result


def sync_project(
    db: DbSession,
    *,
    org: Organization,
    client_factory: Callable[[], JiraClient],
    project: Project,
    actor: User,
) -> tuple[SyncResult, uuid.UUID]:
    """Re-syncing an already created project — see the module docstring for what
    it does not do.

    The client is built by `client_factory` rather than being a ready object: the
    Jira connection may have been turned off in the settings after this project was
    created from it, and "the project is not linked" is a more precise refusal for
    an unlinked project than "Jira is not connected", even when both conditions are
    true at once. So the link is checked before the client is built.
    """
    link = db.scalar(select(JiraProjectLink).where(JiraProjectLink.project_id == project.id))
    if link is None:
        raise JiraError("jira_not_linked", "проект не заведён из Jira")
    client = client_factory()

    existing_categories = {
        row.issue_key: row
        for row in db.scalars(
            select(JiraCategoryLink).where(JiraCategoryLink.project_id == project.id)
        )
    }
    existing_tasks = {
        row.issue_key: row
        for row in db.scalars(select(JiraTaskLink).where(JiraTaskLink.project_id == project.id))
    }

    reason = f"Синхронизация с Jira ({link.jira_project_key})"
    result, batch_id = _sync(
        db,
        project,
        client,
        link.jql,
        actor=actor,
        reason=reason,
        existing_category_links=existing_categories,
        existing_task_links=existing_tasks,
    )
    link.last_synced_at = _now()
    db.flush()
    return result, batch_id


@dataclass
class PushResult:
    pushed: int = 0
    unchanged: int = 0
    #: [{"issue_key": ..., "code": ...}] — one issue rejected by Jira must not hide
    #: the success of the rest, hence a list rather than the first exception.
    failed: list[dict] = field(default_factory=list)


def push_project(
    db: DbSession,
    *,
    org: Organization,
    client_factory: Callable[[], JiraClient],
    project: Project,
    actor: User,  # noqa: ARG001 — the parameter keeps the shape of
    # sync_project/import_project; the push does not go through apply_op (it changes
    # only jira_task_links, not the plan), and there is nowhere here for a mutation
    # author to come from.
) -> PushResult:
    """Pushes to Jira the dates of the tasks that have diverged from what was sent
    there last time — the "Push to Jira" button. It changes only the Due Date (see
    the JiraClient.update_issue_due_date docstring) and only on tasks created from
    Jira; it creates nothing in Jira and does not touch the Planora plan — see the
    module docstring for how this changes the behaviour of the next sync for pushed
    tasks.
    """
    link = db.scalar(select(JiraProjectLink).where(JiraProjectLink.project_id == project.id))
    if link is None:
        raise JiraError("jira_not_linked", "проект не заведён из Jira")
    client = client_factory()
    calendar = project_calendar(project, org)

    rows = db.execute(
        select(JiraTaskLink, Task)
        .join(Task, Task.id == JiraTaskLink.task_id)
        .where(JiraTaskLink.project_id == project.id, JiraTaskLink.task_id.is_not(None))
    ).all()

    result = PushResult()
    for task_link, task in rows:
        due = end_date(task.start_date, task.duration_days, calendar)
        if task_link.pushed_due_date == due:
            result.unchanged += 1
            continue
        try:
            client.update_issue_due_date(task_link.issue_key, due)
        except JiraError as error:
            result.failed.append({"issue_key": task_link.issue_key, "code": error.code})
            continue
        task_link.pushed_due_date = due
        result.pushed += 1

    db.flush()
    return result
