"""Чистые функции: поле задачи Jira → поле задачи Planora.

Ничего здесь не трогает базу и не знает про мутации — это тот единственный
слой, что достаточно проверить на выдуманных объектах, без сети и без базы.
Своих тестов у него сейчас нет: tests/test_jira_mapping.py удалён вместе с
остальными тестами Jira. Слой синхронизации (app/jira/sync.py) уже собирает
из этого CreateTask/SetTaskFields и решает, что с этим делать.
"""

from dataclasses import dataclass
from datetime import date

from app.calendar import Calendar, count_working_days, first_working_on_or_after

#: Название пользовательского поля классических (company-managed) проектов
#: Jira, которым задача привязана к эпику. У team-managed проектов эпик —
#: обычный `parent`, отдельного поля нет. Id самого поля инстанс-специфичен
#: (customfield_NNNNN) и находится по этому имени через /rest/api/3/field —
#: см. resolve_epic_link_field в app/jira/sync.py.
EPIC_LINK_FIELD_NAME = "epic link"


def find_epic_link_field(fields: list[dict]) -> str | None:
    """Id пользовательского поля «Epic Link» среди полей инстанса, если оно есть."""
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
    """Ключ эпика этой задачи, если он есть.

    Категория, на которую он в итоге ляжет, решает вызывающий: неизвестный
    ключ (эпик вне выборки импорта, задача без эпика) здесь не ошибка — это
    сигнал воспользоваться категорией по умолчанию.
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


#: Название приоритета Jira → критичность Planora. Ключи — нижним регистром:
#: сравнение регистронезависимо, инстансы Jira расходятся в написании.
_CRITICALITY_BY_PRIORITY = {
    "blocker": "critical",
    "highest": "critical",
    "high": "high",
    "medium": "normal",
    "low": "low",
    "lowest": "low",
}


def priority_to_criticality(priority_name: str | None) -> str:
    """Medium и незнакомое имя — normal: середина шкалы Jira и середина
    шкалы Planora совпадают, а неизвестное лучше не завышать и не занижать."""
    return _CRITICALITY_BY_PRIORITY.get((priority_name or "").strip().lower(), "normal")


#: Подстроки названия статуса, по которым задача считается заблокированной.
#: Категория статуса Jira («new» / «indeterminate» / «done») этого состояния
#: не знает вовсе — Jira держит «заблокировано» текстом названия, не полем, —
#: и признак ищется здесь, до обращения к категории.
_BLOCKED_MARKERS = ("block", "impediment", "on hold")


def issue_status(status_name: str | None, status_category_key: str | None) -> tuple[str, int]:
    """Статус и процент выполнения Planora — производные статуса Jira.

    Процент — грубая оценка на момент импорта или переноса из другого
    статуса, а не факт: Jira процента не хранит вовсе. `in_progress`
    получает половину, `done` — все сто, `planned` и `blocked` — ноль;
    последующая правка человеком (в том числе через drag на диаграмме)
    заменяет её на настоящую.
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
    """Текст документа Atlassian Document Format (ADF) — описание задачи в
    Jira Cloud REST API v3 приходит этим деревом, не строкой.

    Разбирает ровно те типы узлов, что нужны для читаемого plain-text: абзацы
    и разрывы строк переводятся в перевод строки, элементы списка — в строку
    с тире, остальные структурные узлы (документ целиком, списки, цитаты)
    просто разворачиваются в конкатенацию содержимого. Незнакомый тип узла не
    роняет разбор — он тоже разворачивается в содержимое, если оно есть, или
    даёт пустую строку.
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
    """Описание задачи как обычный текст — из ADF или уже готовой строки
    (некоторые старые данные Jira Server отдают описание строкой)."""
    return _adf_to_text(description).strip()


def issue_schedule(
    issue: dict, calendar: Calendar
) -> tuple[date, int, bool]:
    """Старт, длительность в рабочих днях и признак вехи для задачи плана.

    Веха берёт дату из срока (или из даты создания, если срока нет) и всегда
    занимает один день — тем же правилом, что и веха, заведённая руками (см.
    ck_tasks_milestone_duration в app/models.py). Обычная задача стартует с
    даты создания в Jira, выровненной на ближайший рабочий день, и тянется до
    срока; без срока — тоже один день. Срок раньше даты создания (реальный
    случай при неаккуратно расставленных полях) не даёт отрицательную или
    нулевую длительность — задача сворачивается в тот же один день.
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
    """Имя задачи Planora, с ключом Jira в начале — единственный след, по
    которому человек находит исходную строку в самой Jira: карточка задачи
    описания Jira-ссылки не несёт (см. app/jira/sync.py:_task_fields)."""
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
    """Все поля задачи Planora разом — то, что use CreateTask и (при
    расхождении со строкой плана) обновления при повторной синхронизации."""
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
