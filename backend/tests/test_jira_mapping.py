"""The pure functions of app/jira/mapping.py — with no network and no database."""

from app.calendar import Calendar
from app.jira.mapping import (
    description_text,
    epic_key_of,
    find_epic_link_field,
    is_epic,
    is_milestone_type,
    issue_schedule,
    issue_status,
    priority_to_criticality,
    task_fields_from_issue,
    task_name,
)

# Mon-Fri, no holidays — the same calendar taken by default for an organization
# with no overrides.
_CAL = Calendar(working_days=0b0011111, holidays=frozenset(), extra_workdays=frozenset())


def _issue(**fields) -> dict:
    return {"key": "PROJ-1", "fields": fields}


def test_приоритет_переводится_в_критичность():
    assert priority_to_criticality("Highest") == "critical"
    assert priority_to_criticality("Blocker") == "critical"
    assert priority_to_criticality("High") == "high"
    assert priority_to_criticality("Medium") == "normal"
    assert priority_to_criticality("Low") == "low"
    assert priority_to_criticality("Lowest") == "low"
    assert priority_to_criticality(None) == "normal"
    assert priority_to_criticality("совсем незнакомое") == "normal"


def test_статус_по_названию_и_категории():
    assert issue_status("To Do", "new") == ("planned", 0)
    assert issue_status("In Progress", "indeterminate") == ("in_progress", 50)
    assert issue_status("Done", "done") == ("done", 100)
    # The name decides before the category: Jira holds "blocked" in text, not in a
    # field.
    assert issue_status("Blocked", "indeterminate") == ("blocked", 0)
    assert issue_status("On Hold", "new") == ("blocked", 0)
    # An unknown category means planned rather than a crash.
    assert issue_status("Custom", "") == ("planned", 0)


def test_adf_разбирается_в_читаемый_текст():
    adf = {
        "type": "doc",
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "Первый абзац."}]},
            {
                "type": "bulletList",
                "content": [
                    {
                        "type": "listItem",
                        "content": [
                            {"type": "paragraph", "content": [{"type": "text", "text": "Пункт один"}]}
                        ],
                    },
                    {
                        "type": "listItem",
                        "content": [
                            {"type": "paragraph", "content": [{"type": "text", "text": "Пункт два"}]}
                        ],
                    },
                ],
            },
        ],
    }
    text = description_text(adf)
    assert "Первый абзац." in text
    assert "- Пункт один" in text
    assert "- Пункт два" in text


def test_описание_без_adf_и_пустое():
    assert description_text(None) == ""
    assert description_text("уже строка") == "уже строка"


def test_epic_key_по_полю_epic_link_и_по_parent():
    issue_classic = _issue(customfield_10014="EPIC-1")
    assert epic_key_of(issue_classic, "customfield_10014") == "EPIC-1"

    issue_next_gen = _issue(parent={"key": "EPIC-2"})
    assert epic_key_of(issue_next_gen, None) == "EPIC-2"

    assert epic_key_of(_issue(), "customfield_10014") is None


def test_find_epic_link_field_регистронезависимо():
    fields = [
        {"id": "customfield_10011", "name": "Story point estimate"},
        {"id": "customfield_10014", "name": "Epic Link"},
    ]
    assert find_epic_link_field(fields) == "customfield_10014"
    assert find_epic_link_field([{"id": "x", "name": "Sprint"}]) is None


def test_is_epic_и_is_milestone_по_типу_задачи():
    assert is_epic({"fields": {"issuetype": {"name": "Epic"}}})
    assert not is_epic({"fields": {"issuetype": {"name": "Story"}}})
    assert is_milestone_type({"fields": {"issuetype": {"name": "Milestone"}}})


def test_расписание_обычной_задачи_по_датам_jira():
    issue = _issue(
        issuetype={"name": "Task"},
        created="2026-03-02T10:00:00.000+0400",
        duedate="2026-03-06",
    )
    start, duration, milestone = issue_schedule(issue, _CAL)
    assert milestone is False
    assert start.isoformat() == "2026-03-02"  # Monday, already a working day
    assert duration == 5  # Mon..Fri inclusive


def test_расписание_без_срока_один_день():
    issue = _issue(issuetype={"name": "Task"}, created="2026-03-02T10:00:00.000+0400", duedate=None)
    start, duration, milestone = issue_schedule(issue, _CAL)
    assert (start.isoformat(), duration, milestone) == ("2026-03-02", 1, False)


def test_расписание_срок_раньше_старта_не_даёт_отрицательную_длительность():
    issue = _issue(
        issuetype={"name": "Task"}, created="2026-03-06T10:00:00.000+0400", duedate="2026-03-02"
    )
    start, duration, milestone = issue_schedule(issue, _CAL)
    assert duration == 1


def test_расписание_старт_выравнивается_на_рабочий_день():
    # Saturday is a non-working day, so the start slides to Monday.
    issue = _issue(issuetype={"name": "Task"}, created="2026-02-28T10:00:00.000+0400", duedate=None)
    start, _, _ = issue_schedule(issue, _CAL)
    assert start.isoformat() == "2026-03-02"


def test_расписание_вехи_один_день_по_сроку():
    issue = _issue(
        issuetype={"name": "Milestone"},
        created="2026-03-01T10:00:00.000+0400",
        duedate="2026-03-10",
    )
    start, duration, milestone = issue_schedule(issue, _CAL)
    assert (duration, milestone) == (1, True)
    assert start.isoformat() == "2026-03-10"


def test_имя_задачи_несёт_ключ_jira():
    issue = _issue(summary="Починить вход")
    assert task_name(issue) == "[PROJ-1] Починить вход"


def test_task_fields_from_issue_собирает_всё_разом():
    issue = _issue(
        summary="Логотип",
        description="Знак и написание",
        issuetype={"name": "Task"},
        status={"name": "In Progress", "statusCategory": {"key": "indeterminate"}},
        priority={"name": "High"},
        created="2026-03-02T10:00:00.000+0400",
        duedate="2026-03-04",
    )
    fields = task_fields_from_issue(issue, _CAL)
    assert fields.name == "[PROJ-1] Логотип"
    assert fields.description == "Знак и написание"
    assert fields.criticality == "high"
    assert fields.status == "in_progress"
    assert fields.progress_pct == 50
    assert fields.milestone is False
    assert fields.start_date.isoformat() == "2026-03-02"
    assert fields.duration_days == 3
