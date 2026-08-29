"""Снимок проекта в том виде, в каком его рисуют оба формата.

Собирается один раз и читается обоими рисовальщиками. Без этого слоя PDF и
XLSX однажды разойдутся ровно там, где расхождение заметнее всего, — в числах
на обложке, которые человек сравнивает первыми.

Снимок уже локализован и уже урезан по правам: решать «что этому видно» внутри
рисовальщика значило бы принимать это решение дважды и однажды по-разному.
Урезание идёт теми же двумя флагами, что уже действуют на публичной странице
(`app.api.serialization.project_state`), — второй ветки сборки не заводится.
"""

import uuid
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from enum import StrEnum

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.api.serialization import project_state
from app.comments import author_names, list_comments
from app.export import budget
from app.export.budget import Orientation, Period, Window, Zoom
from app.export.labels import Labels, has_group_key
from app.models import Organization, Project, Revision, ScheduleMode, User
from app.proposals import proposal_state
from app.schedule import RELATIVE_EPOCH
from app.scorecard import scorecard_state

#: Сколько записей журнала попадает в документ. Журнал длиннее любого отчёта,
#: и «вся история» на большом проекте — это сотни страниц, которых никто не
#: просил.
HISTORY_LIMIT = 120

#: Сколько реплик обсуждения попадает в документ.
COMMENTS_LIMIT = 200


class ExportSection(StrEnum):
    """Что человек попросил положить в файл."""

    OVERVIEW = "overview"
    TASKS = "tasks"
    GANTT = "gantt"
    LINKS = "links"
    PROPOSAL = "proposal"
    SCORECARD = "scorecard"
    COMMENTS = "comments"
    HISTORY = "history"


#: Разделы, недоступные клиенту и гостю по ссылке.
#:
#: Правило одно и простое: **выгрузка не показывает больше, чем показывает
#: экран, с которого её позвали.** Публичная страница не отдаёт ни смету, ни
#: скоркард, ни журнал правок — и выгрузка с неё не должна становиться обходным
#: путём к ним.
#:
#: Каждый по своей причине. Смета — коммерческие ставки и себестоимость: по
#: ссылке обещаны сроки и объём, а не то, из чего сложилась цена. Скоркард —
#: внутреннее здоровье работы, включая «зависшие» и «без исполнителя».
#: Журнал правок показывает, сколько раз команда переносила сроки, — то же
#: самое, что уже гасит базовый план и величину отклонения на публичной
#: странице.
INTERNAL_SECTIONS: frozenset[ExportSection] = frozenset(
    {ExportSection.PROPOSAL, ExportSection.SCORECARD, ExportSection.HISTORY}
)


# --- строки документа ---------------------------------------------------------


@dataclass(frozen=True)
class DocCategory:
    id: str
    name: str
    color: str
    task_count: int


@dataclass(frozen=True)
class DocTask:
    id: str
    number: int
    category_id: str
    name: str
    #: Сырое значение статуса — по нему рисовальщик берёт цвет; рядом лежит
    #: уже переведённая подпись, чтобы он не ходил в словарь сам.
    status: str
    status_label: str
    criticality: str
    criticality_label: str
    progress_pct: int
    start: date
    end: date
    duration_days: int
    milestone: bool
    critical: bool
    late: bool
    #: Задача, появившаяся после утверждения плана. Отдельного поля в базе нет
    #: — признак выведен из пустого базового плана при утверждённом плане, ровно
    #: как на ленте (см. serialization.py).
    beyond_plan: bool
    assignees: list[str]
    baseline_start: date | None
    baseline_end: date | None
    deviation_days: int | None
    note: str | None


@dataclass(frozen=True)
class DocLink:
    #: Концы названы идентификаторами, а не именами: имена в проекте не
    #: уникальны, и стрелка, найденная по имени, однажды соединит не те строки.
    from_id: str
    to_id: str
    from_name: str
    to_name: str
    from_end: date
    to_start: date

    @property
    def broken(self) -> bool:
        """Связь нарушена: преемник начинается раньше, чем кончается предок."""
        return self.to_start <= self.from_end


@dataclass(frozen=True)
class DocKpi:
    total: int
    done: int
    in_progress: int
    blocked: int
    late: int
    progress_pct: int


@dataclass(frozen=True)
class DocProposalLine:
    name: str
    role: str
    effort: Decimal
    rate: Decimal

    @property
    def amount(self) -> Decimal:
        return self.effort * self.rate


@dataclass(frozen=True)
class DocProposalGroup:
    name: str
    lines: list[DocProposalLine]


@dataclass(frozen=True)
class DocProposal:
    currency: str
    tax_rate_pct: Decimal
    groups: list[DocProposalGroup]

    @property
    def subtotal(self) -> Decimal:
        return sum(
            (line.amount for group in self.groups for line in group.lines), Decimal(0)
        )

    @property
    def tax(self) -> Decimal:
        return self.subtotal * self.tax_rate_pct / 100

    @property
    def total(self) -> Decimal:
        return self.subtotal + self.tax


@dataclass(frozen=True)
class DocMetric:
    key: str
    label: str
    owner: str
    target: float
    direction: str
    #: Значение и состояние по неделям, в порядке недель.
    values: list[float | None]
    statuses: list[str]


@dataclass(frozen=True)
class DocScorecard:
    weeks: list[date]
    metrics: list[DocMetric]


@dataclass(frozen=True)
class DocComment:
    task_name: str | None
    author: str
    internal: bool
    created_at: date
    body: str


@dataclass(frozen=True)
class DocEvent:
    at: date
    actor: str
    event: str
    subject: str


@dataclass(frozen=True)
class Layout:
    """Как лента ложится на бумагу. Считается один раз — рисовальщику остаётся
    рисовать, а не решать."""

    window: Window
    zoom: Zoom
    orientation: Orientation
    slices: list[Window]


@dataclass(frozen=True)
class ExportDocument:
    labels: Labels
    project_name: str
    org_name: str
    plan_approved: bool
    plan_version: int
    dated: bool
    start: date
    end: date
    deadline: date | None
    today: date
    generated_at: date
    client_copy: bool
    sections: frozenset[ExportSection]
    layout: Layout
    kpi: DocKpi
    categories: list[DocCategory]
    tasks: list[DocTask]
    links: list[DocLink] = field(default_factory=list)
    proposal: DocProposal | None = None
    scorecard: DocScorecard | None = None
    comments: list[DocComment] = field(default_factory=list)
    history: list[DocEvent] = field(default_factory=list)

    def has(self, section: ExportSection) -> bool:
        return section in self.sections

    @property
    def plan_badge(self) -> str:
        if self.plan_approved:
            return self.labels("doc", "approved", v=self.plan_version)
        return self.labels("doc", "draft")

    def tasks_of(self, category_id: str) -> list[DocTask]:
        return [t for t in self.tasks if t.category_id == category_id]

    def file_stem(self) -> str:
        """Имя файла без расширения. Дата — в ISO: имя файла сортируется в
        папке получателя, а не читается как фраза."""
        safe = "".join(
            ch if ch.isalnum() or ch in " -_()" else "-" for ch in self.project_name
        ).strip()
        return f"Planora - {safe} - {self.generated_at.isoformat()}"


# --- сборка -------------------------------------------------------------------


def _parse(value: str | None) -> date | None:
    return date.fromisoformat(value) if value else None


def build_document(
    db: DbSession,
    project: Project,
    org: Organization,
    *,
    sections: frozenset[ExportSection],
    locale: str,
    show_notes: bool,
    show_people: bool,
    client_copy: bool,
    today: date,
    period: Period,
    zoom: Zoom | None,
    orientation: Orientation,
) -> ExportDocument:
    """Снимок проекта под запрошенный состав.

    `zoom=None` — «решай сам»: масштаб выбирается по длине окна (см. budget).
    Умолчание живёт на сервере, а не в окне экспорта, потому что маршрут зовут
    и мимо окна — закладкой, скриптом, публичной ссылкой.
    """
    labels = Labels(locale)
    state = project_state(db, project, org, show_notes=show_notes, show_people=show_people)
    dated = project.schedule_mode == ScheduleMode.CALENDAR

    names = _assignee_names(db, state) if show_people else {}
    categories, tasks = _plan(state, labels, today, dated, names, client_copy)

    whole = budget.project_window(
        [t.start for t in tasks],
        [t.end for t in tasks],
        fallback=project.start_date or RELATIVE_EPOCH,
    )
    window = budget.resolve_window(period, whole, today, dated=dated)
    chosen = zoom or budget.default_zoom(window.days, orientation)
    budget.require_within_budget(window, chosen, orientation)

    layout = Layout(
        window=window,
        zoom=chosen,
        orientation=orientation,
        slices=budget.slice_window(window, chosen, orientation),
    )

    return ExportDocument(
        labels=labels,
        project_name=project.name,
        org_name=org.name,
        plan_approved=project.plan_approved_at is not None,
        plan_version=project.plan_version,
        dated=dated,
        start=whole.start,
        end=whole.end,
        deadline=project.deadline,
        today=today,
        generated_at=today,
        client_copy=client_copy,
        sections=sections,
        layout=layout,
        kpi=_kpi(tasks),
        categories=categories,
        tasks=tasks,
        links=_links(state) if ExportSection.LINKS in sections else [],
        proposal=(
            _proposal(db, project) if ExportSection.PROPOSAL in sections else None
        ),
        scorecard=(
            _scorecard(db, project, org, labels)
            if ExportSection.SCORECARD in sections
            else None
        ),
        comments=(
            _comments(db, project, state, include_internal=show_notes)
            if ExportSection.COMMENTS in sections
            else []
        ),
        history=(
            _history(db, project, labels, state)
            if ExportSection.HISTORY in sections
            else []
        ),
    )


def _assignee_names(db: DbSession, state: dict) -> dict[str, str]:
    ids = {
        uuid.UUID(person)
        for task in state["tasks"]
        for person in task["assignee_ids"]
    }
    if not ids:
        return {}
    rows = db.execute(select(User.id, User.name).where(User.id.in_(ids))).all()
    return {str(uid): name for uid, name in rows}


def _plan(
    state: dict,
    labels: Labels,
    today: date,
    dated: bool,
    names: dict[str, str],
    client_copy: bool,
) -> tuple[list[DocCategory], list[DocTask]]:
    approved = state["plan_approved_at"] is not None
    tasks: list[DocTask] = []

    # Нумерация сквозная и идёт по категориям, а не по порядку задач в ответе:
    # в документе номер — это место строки в таблице, и таблица сгруппирована.
    order = {c["id"]: i for i, c in enumerate(state["categories"])}
    ordered = sorted(
        state["tasks"], key=lambda t: (order.get(t["category_id"], 0), t["position"])
    )

    for number, raw in enumerate(ordered, start=1):
        start = date.fromisoformat(raw["start_date"])
        end = date.fromisoformat(raw["end_date"])
        baseline_start = _parse(raw["baseline_start"])
        baseline_end = _parse(raw["baseline_end"])

        # Клиентский экземпляр: базовый план и расхождения с ним ему не
        # обещаны — то же правило, что уже гасит их на публичной странице.
        if client_copy:
            baseline_start = baseline_end = None

        tasks.append(
            DocTask(
                id=raw["id"],
                number=number,
                category_id=raw["category_id"],
                name=raw["name"],
                status=raw["status"],
                status_label=labels("status", raw["status"]),
                criticality=raw["criticality"],
                criticality_label=labels("criticality", raw["criticality"]),
                progress_pct=raw["progress_pct"],
                start=start,
                end=end,
                duration_days=raw["duration_days"],
                milestone=raw["milestone"],
                critical=raw["critical"],
                # Просрочка выводится из дат, а у относительного плана дат нет:
                # «позади сегодня» на оси «День N» не определено.
                late=dated and raw["status"] != "done" and end < today,
                beyond_plan=approved and baseline_start is None and not client_copy,
                assignees=[
                    names[i] for i in raw["assignee_ids"] if i in names
                ],
                baseline_start=baseline_start,
                baseline_end=baseline_end,
                deviation_days=(
                    (end - baseline_end).days if baseline_end is not None else None
                ),
                note=raw.get("internal_note"),
            )
        )

    counts: dict[str, int] = {}
    for task in tasks:
        counts[task.category_id] = counts.get(task.category_id, 0) + 1
    categories = [
        DocCategory(
            id=c["id"], name=c["name"], color=c["color"], task_count=counts.get(c["id"], 0)
        )
        for c in state["categories"]
    ]
    return categories, tasks


def _kpi(tasks: list[DocTask]) -> DocKpi:
    def count(status: str) -> int:
        return sum(1 for t in tasks if t.status == status)

    return DocKpi(
        total=len(tasks),
        done=count("done"),
        in_progress=count("in_progress"),
        blocked=count("blocked"),
        late=sum(1 for t in tasks if t.late),
        progress_pct=(
            round(sum(t.progress_pct for t in tasks) / len(tasks)) if tasks else 0
        ),
    )


def _links(state: dict) -> list[DocLink]:
    by_id = {t["id"]: t for t in state["tasks"]}
    out: list[DocLink] = []
    for edge in state["dependencies"]:
        source, target = by_id.get(edge["from_task_id"]), by_id.get(edge["to_task_id"])
        if source is None or target is None:
            continue
        out.append(
            DocLink(
                from_id=source["id"],
                to_id=target["id"],
                from_name=source["name"],
                to_name=target["name"],
                from_end=date.fromisoformat(source["end_date"]),
                to_start=date.fromisoformat(target["start_date"]),
            )
        )
    return out


def _proposal(db: DbSession, project: Project) -> DocProposal | None:
    state = proposal_state(db, project)
    groups = [
        DocProposalGroup(
            name=category["name"],
            lines=[
                DocProposalLine(
                    name=line["name"],
                    role=line["role"],
                    effort=Decimal(str(line["effort"])),
                    rate=Decimal(str(line["rate"])),
                )
                for line in category["tasks"]
            ],
        )
        for category in state["categories"]
    ]
    # Пустая смета — не раздел с нулями, а отсутствие раздела: лист «Смета» из
    # одних заголовков читается как поломка выгрузки.
    if not any(group.lines for group in groups):
        return None
    return DocProposal(
        currency=state["currency"],
        tax_rate_pct=Decimal(str(state["tax_rate_pct"])),
        groups=groups,
    )


def _scorecard(
    db: DbSession, project: Project, org: Organization, labels: Labels
) -> DocScorecard | None:
    state = scorecard_state(db, project, org)
    metrics = state["metrics"]
    if not metrics:
        return None

    # Недели берутся из истории первой метрики: снимки сеются всем метрикам
    # одной транзакцией, и набор недель у них общий.
    weeks = [date.fromisoformat(p["week_start"]) for p in metrics[0]["history"]]
    weeks.append(date.fromisoformat(state["week"]["start"]))

    out: list[DocMetric] = []
    for metric in metrics:
        history = {p["week_start"]: p for p in metric["history"]}
        values: list[float | None] = []
        statuses: list[str] = []
        for week in weeks[:-1]:
            point = history.get(week.isoformat())
            values.append(point["value"] if point else None)
            statuses.append(point["status"] if point else "no_data")
        values.append(metric["value"])
        statuses.append(metric["status"])
        out.append(
            DocMetric(
                key=metric["key"],
                label=labels("metric", metric["key"]),
                owner=(metric["owner"] or {}).get("name", "") if metric["owner"] else "",
                target=metric["target"],
                direction=metric["direction"],
                values=values,
                statuses=statuses,
            )
        )
    return DocScorecard(weeks=weeks, metrics=out)


def _comments(
    db: DbSession, project: Project, state: dict, *, include_internal: bool
) -> list[DocComment]:
    names = {t["id"]: t["name"] for t in state["tasks"]}
    rows = list_comments(
        db, project, include_internal=include_internal, limit=COMMENTS_LIMIT
    )
    authors = author_names(db, rows)
    return [
        DocComment(
            task_name=names.get(str(c.task_id)) if c.task_id else None,
            author=(
                c.guest_name
                if c.guest_name is not None
                else authors.get(c.author_user_id, "")
            ),
            internal=c.internal,
            created_at=c.created_at.date(),
            body=c.body,
        )
        for c in rows
    ]


def _history(
    db: DbSession, project: Project, labels: Labels, state: dict
) -> list[DocEvent]:
    """Журнал правок — датой, автором и названием операции.

    Названием, а не пересказом: пересказ каждой из двадцати трёх операций
    завёл бы на сервере второй `formatEvent.ts`, который разошёлся бы с первым
    на первой же новой операции. Незнакомая операция подписывается общим
    «Правка плана» и не роняет документ.
    """
    task_names = {t["id"]: t["name"] for t in state["tasks"]}
    category_names = {c["id"]: c["name"] for c in state["categories"]}

    rows = db.execute(
        select(Revision, User.name)
        .outerjoin(User, User.id == Revision.actor_user_id)
        .where(Revision.project_id == project.id)
        .order_by(Revision.seq.desc())
        .limit(HISTORY_LIMIT)
    ).all()

    out: list[DocEvent] = []
    for revision, actor in rows:
        payload = revision.op or {}
        name = payload.get("op", "")
        if not has_group_key("event", name, labels.locale):
            name = "unknown"
        out.append(
            DocEvent(
                at=revision.created_at.date(),
                actor=actor or "",
                event=labels("event", name),
                subject=(
                    task_names.get(payload.get("task_id", ""))
                    or category_names.get(payload.get("category_id", ""))
                    or ""
                ),
            )
        )
    return out


