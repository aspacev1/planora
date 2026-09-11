"""Pure functions: a Jira issue field -> a Planora task field.

Nothing here touches the database or knows about mutations — this is the one
layer that can be checked against made-up objects, with no network and no
database (see tests/test_jira_mapping.py). The sync layer (app/jira/sync.py)
already assembles CreateTask/SetTaskFields out of this and decides what to do
with it.
"""

from dataclasses import dataclass
from datetime import date

from app.calendar import Calendar, count_working_days, first_working_on_or_after

#: The name of the custom field in classic (company-managed) Jira projects that
#: ties an issue to an epic. In team-managed projects the epic is an ordinary
#: `parent` and there is no separate field. The field's own id is
#: instance-specific (customfield_NNNNN) and is found by this name through
#: /rest/api/3/field — see resolve_epic_link_field in app/jira/sync.py.
EPIC_LINK_FIELD_NAME = "epic link"


def find_epic_link_field(fields: list[dict]) -> str | None:
    """The id of the "Epic Link" custom field among the instance's fields, if it exists."""
    for field in fields:
        if str(field.get("name", "")).strip().lower() == EPIC_LINK_FIELD_NAME:
            return field.get("id")
    return None


def issue_type_name(issue: dict) -> str:
    return str((issue.get("fields", {}) or {}).get("issuetype", {}).get("name", "")).strip().lower()


def is_epic(issue: dict) -> bool:
    return issue_type_name(issue) == "epic"


def is_milestone_type(issue: dict) -> bool:
    return issue_type_name(issue) == "milestone"


def epic_key_of(issue: dict, epic_link_field: str | None) -> str | None:
    """The key of this issue's epic, if it has one.

    Which category it ultimately lands in is decided by the caller: an unknown
    key (an epic outside the import's selection, an issue with no epic) is not an
    error here — it is a signal to use the default category.
    """
    fields = issue.get("fields", {}) or {}
    if epic_link_field:
        value = fields.get(epic_link_field)
        if isinstance(value, str) and value:
            return value
    parent = fields.get("parent")
    if isinstance(parent, dict):
        key = parent.get("key")
        return key if isinstance(key, str) else None
    return None


#: A Jira priority name -> a Planora criticality. The keys are lower case: the
#: comparison is case-insensitive, and Jira instances differ in their spelling.
_CRITICALITY_BY_PRIORITY = {
    "blocker": "critical",
    "highest": "critical",
    "high": "high",
    "medium": "normal",
    "low": "low",
    "lowest": "low",
}


def priority_to_criticality(priority_name: str | None) -> str:
    """Medium and an unknown name both become normal: the middle of the Jira
    scale and the middle of the Planora scale coincide, and it is better not to
    inflate or deflate the unknown."""
    return _CRITICALITY_BY_PRIORITY.get((priority_name or "").strip().lower(), "normal")


#: Substrings of a status name by which a task is considered blocked. The Jira
#: status category ("new" / "indeterminate" / "done") does not know this state at
#: all — Jira holds "blocked" in the text of the name rather than in a field —
#: so the flag is looked for here, before consulting the category.
_BLOCKED_MARKERS = ("block", "impediment", "on hold")


def issue_status(status_name: str | None, status_category_key: str | None) -> tuple[str, int]:
    """A Planora status and completion percentage, derived from the Jira status.

    The percentage is a rough estimate at the moment of an import or a move from
    another status, not a fact: Jira does not store a percentage at all.
    `in_progress` gets half, `done` gets a full hundred, `planned` and `blocked`
    get zero; a subsequent edit by a person (including by dragging on the chart)
    replaces it with the real one.
    """
    name = (status_name or "").strip().lower()
    if any(marker in name for marker in _BLOCKED_MARKERS):
        return "blocked", 0
    key = (status_category_key or "").strip().lower()
    if key == "done":
        return "done", 100
    if key == "indeterminate":
        return "in_progress", 50
    return "planned", 0


def _adf_to_text(node: object) -> str:
    """The text of an Atlassian Document Format (ADF) document — an issue's
    description in the Jira Cloud REST API v3 arrives as this tree, not as a string.

    It parses exactly the node types needed for readable plain text: paragraphs
    and line breaks become newlines, list items become a line with a dash, and
    the remaining structural nodes (the document as a whole, lists, quotes) are
    simply unwrapped into a concatenation of their contents. An unknown node type
    does not break the parse — it too is unwrapped into its contents, if there
    are any, or yields an empty string.
    """
    if node is None:
        return ""
    if isinstance(node, str):
        return node
    if not isinstance(node, dict):
        return ""

    node_type = node.get("type")
    if node_type == "text":
        return str(node.get("text", ""))
    if node_type == "hardBreak":
        return "\n"
    if node_type == "rule":
        return "---\n"

    rendered = "".join(_adf_to_text(child) for child in node.get("content") or [])
    if node_type == "listItem":
        return f"- {rendered.strip()}\n"
    if node_type in {"paragraph", "heading", "codeBlock"}:
        return rendered + "\n"
    return rendered


def description_text(description: object) -> str:
    """An issue's description as plain text — from ADF or from an already
    finished string (some old Jira Server data returns the description as a string)."""
    return _adf_to_text(description).strip()


def issue_schedule(
    issue: dict, calendar: Calendar
) -> tuple[date, int, bool]:
    """The start, the duration in working days and the milestone flag for a plan task.

    A milestone takes its date from the due date (or from the creation date, if
    there is no due date) and always occupies one day — by the same rule as a
    milestone created by hand (see ck_tasks_milestone_duration in
    app/models.py). An ordinary task starts on the Jira creation date, aligned to
    the nearest working day, and runs until the due date; with no due date it is
    one day as well. A due date earlier than the creation date (a real case when
    fields are set carelessly) does not yield a negative or zero duration — the
    task collapses into that same single day.
    """
    fields = issue.get("fields", {}) or {}
    created_raw = fields.get("created")
    due_raw = fields.get("duedate")

    if is_milestone_type(issue):
        day = date.fromisoformat((due_raw or created_raw)[:10])
        return first_working_on_or_after(day, calendar), 1, True

    start = first_working_on_or_after(date.fromisoformat(created_raw[:10]), calendar)
    if not due_raw:
        return start, 1, False
    due = date.fromisoformat(due_raw[:10])
    if due < start:
        return start, 1, False
    return start, count_working_days(start, due, calendar), False


def issue_summary(issue: dict) -> str:
    return str((issue.get("fields", {}) or {}).get("summary", "")).strip() or issue.get("key", "")


def task_name(issue: dict) -> str:
    """The Planora task's name, with the Jira key at the front — the only trace
    by which a person finds the original issue in Jira itself: the task card
    carries no Jira link in its description (see app/jira/sync.py:_task_fields)."""
    return f"[{issue.get('key', '')}] {issue_summary(issue)}"


@dataclass(frozen=True)
class IssueTaskFields:
    name: str
    description: str
    start_date: date
    duration_days: int
    criticality: str
    status: str
    progress_pct: int
    milestone: bool


def task_fields_from_issue(issue: dict, calendar: Calendar) -> IssueTaskFields:
    """Every field of a Planora task at once — what CreateTask uses and what (on
    a divergence from the plan row) updates use on a repeated sync."""
    fields = issue.get("fields", {}) or {}
    status_field = fields.get("status", {}) or {}
    status, progress = issue_status(
        status_field.get("name"), (status_field.get("statusCategory") or {}).get("key")
    )
    start, duration, milestone = issue_schedule(issue, calendar)
    return IssueTaskFields(
        name=task_name(issue),
        description=description_text(fields.get("description")),
        start_date=start,
        duration_days=duration,
        criticality=priority_to_criticality((fields.get("priority") or {}).get("name")),
        status=status,
        progress_pct=progress,
        milestone=milestone,
    )
