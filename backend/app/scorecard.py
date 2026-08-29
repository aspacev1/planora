"""Скоркард проекта: недельная панель здоровья плана.

Устройство в двух словах. Метрики считаются по живому плану (таблицы задач;
неперенесённые предложения живут отдельно и сюда не попадают) и по журналу
ревизий. Неделя — ISO-неделя в таймзоне проекта (с наследованием от
организации), дни везде рабочие — через календарь проекта.

Планировщика в архитектуре нет намеренно, поэтому фиксация недель ленивая:
первый GET после границы недели дозаписывает недостающие недельные снимки и
пересчитывает текущую неделю. Снимки прошлых недель неизменяемы — это
летопись, по ней считаются серии и спарклайн; перезаписывается только строка
текущей недели, она же служит кэшем живого расчёта на пять минут. Метрики по
журналу (`date_shifts`, `close_rate`, `scope_growth`) восстанавливаются для
пропущенных недель точно; срезы состояния восстановить нельзя — они считаются
по текущему состоянию на конец той недели и помечаются `backfilled: true` в
details.

`finish_drift` — сдвиг прогнозного финиша за неделю — считается как разность
двух соседних снимков, поэтому у пропущенных недель точки отсчёта нет: они
пишутся `no_data`+`backfilled`, а не восстанавливаются проигрыванием журнала
(это отдельная задача, несоразмерная пользе). Первая же неделя без прошлого
снимка — тоже `no_data`: дрейф без базы неизмерим, а не равен нулю.

Правило «красная 2 недели подряд» срабатывает при записи снимка текущей
недели: через слой мутаций создаётся задача «Разобрать: {метрика}», и след
остаётся событием `rule_triggered`. Повтор подавляется до разрыва серии — по
уже записанным событиям, а не по отдельному флагу: событие и есть память о
том, что для этой серии задача уже создана.
"""

import logging
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.calendar import Calendar, CalendarError, count_working_days, end_date
from app.models import (
    Category,
    Membership,
    Organization,
    Project,
    Revision,
    ScheduleMode,
    ScorecardAlert,
    ScorecardAlertKind,
    ScorecardDirection,
    ScorecardMetric,
    ScorecardSnapshot,
    ScorecardStatus,
    Task,
    TaskAssignee,
    TaskStatus,
    User,
)
from app.mutations import AssignUser, CreateTask, InvalidOperation, MutationError, apply_op
from app.settings_resolution import (
    project_calendar,
    resolve_shift_threshold,
    resolve_timezone,
)

logger = logging.getLogger(__name__)

#: Константы MVP. Порог «красного»: цель × 2 для lte (при цели 0 — значение
#: больше 2), цель × 0.75 для gte; между целью и порогом — «жёлтый».
RISK_LTE_FACTOR = Decimal("2")
RISK_LTE_ZERO_LIMIT = Decimal("2")
RISK_GTE_FACTOR = Decimal("0.75")
#: «Зависла в работе» — больше стольких рабочих дней в in_progress.
STALE_WORKDAYS = 5
#: «Нереальный срок» — просрочка больше стольких рабочих дней без единой
#: правки дат в журнале.
UNREAL_OVERDUE_WORKDAYS = 10
#: Окно истории по умолчанию и потолок кэша текущей недели.
DEFAULT_WEEKS = 13
CURRENT_WEEK_TTL_SECONDS = 300
#: Сколько недель серия может тянуться в прошлое при чтении. Потолок, а не
#: точность: серия длиннее двух лет ничего не добавляет к бейджу.
MAX_STREAK_WEEKS = 104

_TWO_PLACES = Decimal("0.01")


@dataclass(frozen=True)
class MetricDef:
    key: str
    direction: str
    default_target: Decimal


METRICS: tuple[MetricDef, ...] = (
    MetricDef("overdue_tasks", ScorecardDirection.LTE, Decimal("2")),
    MetricDef("finish_drift", ScorecardDirection.LTE, Decimal("0")),
    MetricDef("scope_growth", ScorecardDirection.LTE, Decimal("3")),
    MetricDef("date_shifts", ScorecardDirection.LTE, Decimal("5")),
    MetricDef("close_rate", ScorecardDirection.GTE, Decimal("1.0")),
    MetricDef("stale_in_progress", ScorecardDirection.LTE, Decimal("3")),
    MetricDef("data_quality", ScorecardDirection.GTE, Decimal("90")),
)

METRIC_KEYS: tuple[str, ...] = tuple(m.key for m in METRICS)
_DEFS = {m.key: m for m in METRICS}

#: Заголовки для задачи, создаваемой правилом. Словарь здесь, а не в клиенте:
#: имя задачи ложится в базу, и переводит его тот, кто пишет, — на языке
#: организации. Тот же принцип, что у писем (app/mail).
_METRIC_LABELS = {
    "overdue_tasks": {"ru": "Просроченные задачи", "en": "Overdue tasks", "az": "Gecikmiş tapşırıqlar"},
    "finish_drift": {"ru": "Сдвиг финиша", "en": "Finish drift", "az": "Finiş sürüşməsi"},
    "scope_growth": {"ru": "Рост объёма", "en": "Scope growth", "az": "Həcm artımı"},
    "date_shifts": {"ru": "Сдвиги дат", "en": "Date shifts", "az": "Tarix sürüşmələri"},
    "close_rate": {"ru": "Закрываемость", "en": "Close rate", "az": "Bağlanma nisbəti"},
    "stale_in_progress": {"ru": "Зависшие в работе", "en": "Stale in progress", "az": "İşdə ilişib qalanlar"},
    "data_quality": {"ru": "Качество данных", "en": "Data quality", "az": "Məlumat keyfiyyəti"},
}
_RULE_TASK_TITLE = {"ru": "Разобрать: {label}", "en": "Investigate: {label}", "az": "Araşdır: {label}"}


class ScorecardError(Exception):
    """Отказ скоркарда — с машинным кодом, по правилам отказов мутаций."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


# --- неделя и время -----------------------------------------------------------


def project_tz(project: Project, org: Organization) -> ZoneInfo:
    """Таймзона проекта (с наследованием от организации). Непригодное имя —
    UTC, а не авария: имя проверяется на записи, но база могла быть правлена
    руками, и скоркард — не то место, где проект должен перестать читаться."""
    name = resolve_timezone(project, org)
    try:
        return ZoneInfo(name)
    except (KeyError, ValueError):
        logger.warning("непригодная таймзона %r, скоркард считает в UTC", name)
        return ZoneInfo("UTC")


def week_start_of(d: date) -> date:
    """Понедельник ISO-недели, в которую попадает дата."""
    return d - timedelta(days=d.weekday())


def _week_bounds_utc(week_start: date, tz: ZoneInfo) -> tuple[datetime, datetime]:
    """Границы недели [понедельник 00:00; следующий понедельник 00:00) в
    таймзоне проекта — как absolute-время для сравнения с метками журнала."""
    start = datetime.combine(week_start, time.min, tzinfo=tz)
    return start, start + timedelta(days=7)


def _in_week(stamp: datetime | None, week_start: date, tz: ZoneInfo) -> bool:
    if stamp is None:
        return False
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return week_start <= stamp.astimezone(tz).date() <= week_start + timedelta(days=6)


# --- конфиг метрик ------------------------------------------------------------


def ensure_metrics(db: DbSession, project: Project) -> list[ScorecardMetric]:
    """Конфиги метрик проекта; недостающие — сеются дефолтами.

    Первое открытие скоркарда заводит их все; появившаяся в новой версии
    кода метрика досеется тем же путём. Владельцы у сида пустые: дефолт — это
    цель и направление, а не назначение людей.
    """
    existing = {
        m.metric_key: m
        for m in db.scalars(
            select(ScorecardMetric).where(ScorecardMetric.project_id == project.id)
        ).all()
    }
    created = False
    for position, definition in enumerate(METRICS):
        if definition.key in existing:
            continue
        db.add(
            ScorecardMetric(
                project_id=project.id,
                metric_key=definition.key,
                target_value=definition.default_target,
                direction=definition.direction,
                enabled=True,
                position=position,
            )
        )
        created = True
    if created:
        db.flush()
    configs = db.scalars(
        select(ScorecardMetric)
        .where(ScorecardMetric.project_id == project.id)
        .order_by(ScorecardMetric.position, ScorecardMetric.metric_key)
    ).all()
    return [c for c in configs if c.metric_key in _DEFS]


# --- статус -------------------------------------------------------------------


def metric_status(value: Decimal | None, target: Decimal, direction: str) -> str:
    """ok — факт удовлетворяет цели; risk — хуже порога; warn — между."""
    if value is None:
        return ScorecardStatus.NO_DATA.value
    if direction == ScorecardDirection.LTE:
        if value <= target:
            return ScorecardStatus.OK.value
        limit = RISK_LTE_ZERO_LIMIT if target == 0 else target * RISK_LTE_FACTOR
        return (
            ScorecardStatus.RISK.value if value > limit else ScorecardStatus.WARN.value
        )
    if value >= target:
        return ScorecardStatus.OK.value
    return (
        ScorecardStatus.RISK.value
        if value < target * RISK_GTE_FACTOR
        else ScorecardStatus.WARN.value
    )


# --- контекст расчёта ---------------------------------------------------------


@dataclass(frozen=True)
class _PlanView:
    """Живой план, прочитанный один раз на расчёт: задачи, даты окончания,
    исполнители и календарь. Дат окончания в базе нет — они считаются здесь,
    тем же end_date, что и на Ганте."""

    tasks: list[Task]
    #: Дата окончания по календарю проекта; пусто у относительного плана и у
    #: задач с вырожденным календарём.
    ends: dict[uuid.UUID, date]
    assignees: dict[uuid.UUID, list[uuid.UUID]]
    names: dict[uuid.UUID, str]
    calendar: Calendar
    #: Календарный ли режим. Относительная ось не сравнивается с «сегодня»,
    #: и метрики, привязанные к настоящим датам, отвечают no_data.
    dated: bool


def _plan_view(db: DbSession, project: Project, org: Organization) -> _PlanView:
    tasks = list(
        db.scalars(
            select(Task).where(Task.project_id == project.id).order_by(Task.position, Task.id)
        ).all()
    )
    calendar = project_calendar(project, org)
    dated = project.schedule_mode == ScheduleMode.CALENDAR
    ends: dict[uuid.UUID, date] = {}
    if dated:
        for task in tasks:
            try:
                ends[task.id] = end_date(task.start_date, task.duration_days, calendar)
            except CalendarError:
                # Вырожденный календарь уже отказал на Ганте; скоркард просто
                # не судит такую задачу, а не валит весь расчёт.
                continue
    rows = db.execute(
        select(TaskAssignee.task_id, TaskAssignee.user_id)
        .join(Task, Task.id == TaskAssignee.task_id)
        .where(Task.project_id == project.id)
    ).all()
    assignees: dict[uuid.UUID, list[uuid.UUID]] = {}
    for task_id, user_id in rows:
        assignees.setdefault(task_id, []).append(user_id)
    user_ids = {user_id for _, user_id in rows}
    names = (
        {
            user.id: user.name
            for user in db.scalars(select(User).where(User.id.in_(user_ids))).all()
        }
        if user_ids
        else {}
    )
    return _PlanView(
        tasks=tasks, ends=ends, assignees=assignees, names=names,
        calendar=calendar, dated=dated,
    )


def _entry(plan: _PlanView, task: Task, **extra) -> dict:
    end = plan.ends.get(task.id)
    entry = {
        "id": str(task.id),
        "name": task.name,
        "status": task.status,
        "end_date": end.isoformat() if end else None,
        "assignees": [
            plan.names.get(user_id, "")
            for user_id in plan.assignees.get(task.id, [])
        ],
    }
    entry.update(extra)
    return entry


def _overdue_workdays(plan: _PlanView, end: date, ref: date) -> int:
    """Просрочка в рабочих днях: рабочие дни после даты окончания по дату
    расчёта включительно."""
    if end >= ref:
        return 0
    return count_working_days(end + timedelta(days=1), ref, plan.calendar)


# --- метрики ------------------------------------------------------------------


def _overdue_list(plan: _PlanView, ref: date) -> list[tuple[Task, int]]:
    found: list[tuple[Task, int]] = []
    for task in plan.tasks:
        end = plan.ends.get(task.id)
        if task.status == TaskStatus.DONE or end is None or end >= ref:
            continue
        found.append((task, _overdue_workdays(plan, end, ref)))
    found.sort(key=lambda pair: pair[1], reverse=True)
    return found


def _compute_overdue(plan: _PlanView, ref: date) -> tuple[Decimal | None, dict]:
    """Число просроченных задач; средняя глубина просрочки — в details.

    Средняя вкатана сюда, а не отдельной метрикой: это второй ракурс одного
    факта, и держать под ним отдельную строку — дублировать сигнал.
    """
    if not plan.dated:
        return None, {}
    overdue = _overdue_list(plan, ref)
    avg_days = (
        (Decimal(sum(days for _, days in overdue)) / Decimal(len(overdue)))
        .quantize(_TWO_PLACES, rounding=ROUND_HALF_UP)
        if overdue
        else Decimal("0")
    )
    details = {
        "tasks": [_entry(plan, task, days_overdue=days) for task, days in overdue],
        "avg_days": float(avg_days),
    }
    return Decimal(len(overdue)), details


def _signed_working_days(frm: date, to: date, calendar: Calendar) -> int:
    """Рабочих дней между двумя датами, со знаком: плюс — `to` позже `frm`.

    Величина считается как просрочка — рабочие дни строго после ранней даты
    по позднюю включительно; знак навешивается направлением.
    """
    if frm == to:
        return 0
    lo, hi = (frm, to) if frm < to else (to, frm)
    magnitude = count_working_days(lo + timedelta(days=1), hi, calendar)
    return magnitude if to > frm else -magnitude


def _projected_finish(plan: _PlanView) -> date | None:
    """Прогнозный финиш плана — самая поздняя дата окончания среди незакрытых
    задач. Пусто, если считать не по чему (относительный план, нет дат)."""
    ends = [
        plan.ends[task.id]
        for task in plan.tasks
        if task.status != TaskStatus.DONE and task.id in plan.ends
    ]
    return max(ends) if ends else None


def _compute_finish_drift(
    db: DbSession, project: Project, plan: _PlanView, week_start: date
) -> tuple[Decimal | None, dict]:
    """Сдвиг прогнозного финиша за неделю, в рабочих днях со знаком.

    Значение — насколько финиш уехал против записанного в снимке прошлой
    недели: плюс — срок поехал вправо (плохо), минус — подтянули. Без прошлой
    точки (первая неделя, разрыв серии) — no_data: дрейф без базы неизмерим.
    Прогноз всё равно фиксируется в details, чтобы следующей неделе было от
    чего считать. Относительный план настоящих дат не имеет — no_data.
    """
    if not plan.dated:
        return None, {}
    projected = _projected_finish(plan)
    prev_details = db.scalar(
        select(ScorecardSnapshot.details).where(
            ScorecardSnapshot.project_id == project.id,
            ScorecardSnapshot.metric_key == "finish_drift",
            ScorecardSnapshot.week_start == week_start - timedelta(days=7),
        )
    )
    previous: date | None = None
    if prev_details and prev_details.get("projected_finish"):
        try:
            previous = date.fromisoformat(prev_details["projected_finish"])
        except (ValueError, TypeError):
            previous = None
    details = {
        "projected_finish": projected.isoformat() if projected else None,
        "previous_finish": previous.isoformat() if previous else None,
        "shift_days": None,
    }
    if projected is None or previous is None:
        return None, details
    try:
        shift = _signed_working_days(previous, projected, plan.calendar)
    except CalendarError:
        # Вырожденный календарь уже отказал на Ганте; дрейф просто не судится.
        return None, details
    details["shift_days"] = shift
    return Decimal(shift), details


def _compute_scope(
    db: DbSession, project: Project, plan: _PlanView, week_start: date, tz: ZoneInfo
) -> tuple[Decimal, dict]:
    """Чистый прирост объёма за неделю: создано минус закрыто.

    Создание берётся из журнала (`create_task`, кроме восстановлений отменой),
    закрытие — те же done, что у close_rate. Восстановление удалённого новым
    объёмом не считается: намеренная асимметрия с date_shifts, где отмена —
    такой же сдвиг, как прямая правка. Задачи внутри `create_category` тут не
    в счёт: свежая категория создаётся пустой, а с задачами она приходит
    только при отмене каскадного удаления — а её мы и отсекаем по undoes_seq.
    """
    begin, end = _week_bounds_utc(week_start, tz)
    revisions = db.scalars(
        select(Revision)
        .where(
            Revision.project_id == project.id,
            Revision.created_at >= begin,
            Revision.created_at < end,
            Revision.undoes_seq.is_(None),
            Revision.op["type"].astext == "create_task",
        )
        .order_by(Revision.seq)
    ).all()
    tasks_by_id = {task.id: task for task in plan.tasks}
    added: list[dict] = []
    for revision in revisions:
        op = revision.op
        try:
            task_id = uuid.UUID(op["task_id"])
        except (KeyError, TypeError, ValueError):
            logger.warning("непригодная запись журнала при счёте объёма")
            continue
        task = tasks_by_id.get(task_id)
        if task is not None:
            added.append(_entry(plan, task, added_in_week=True))
        else:
            # Задачу успели удалить позже — имя берём из журнала, чтобы в
            # drill-down она осталась видимой.
            added.append(
                {
                    "id": str(task_id),
                    "name": op.get("name", ""),
                    "status": None,
                    "end_date": None,
                    "assignees": [],
                    "added_in_week": True,
                }
            )
    closed = [
        _entry(plan, task, closed_in_week=True)
        for task in plan.tasks
        if _in_week(task.done_at, week_start, tz)
    ]
    details = {
        "tasks": added + closed,
        "added": added,
        "closed": closed,
        "added_count": len(added),
        "closed_count": len(closed),
    }
    return Decimal(len(added) - len(closed)), details


def _shift_delta(op: dict) -> int:
    """На сколько дней операция изменила start_date/duration_days."""
    kind = op.get("type")
    try:
        if kind == "move_task":
            return abs(
                (date.fromisoformat(op["to"]) - date.fromisoformat(op["from"])).days
            )
        if kind == "set_duration":
            return abs(int(op["to"]) - int(op["from"]))
        if kind == "resize_task":
            start_delta = abs(
                (
                    date.fromisoformat(op["to"]["start_date"])
                    - date.fromisoformat(op["from"]["start_date"])
                ).days
            )
            duration_delta = abs(
                int(op["to"]["duration_days"]) - int(op["from"]["duration_days"])
            )
            return max(start_delta, duration_delta)
        if kind == "move_category":
            return abs(int(op["days"]))
    except (KeyError, TypeError, ValueError):
        # Журнал старых версий мог писать поля иначе; непонятная запись — не
        # сдвиг, а не авария чтения скоркарда.
        logger.warning("непригодная запись журнала при счёте сдвигов: %r", kind)
    return 0


def _compute_date_shifts(
    db: DbSession, project: Project, org: Organization, plan: _PlanView,
    week_start: date, tz: ZoneInfo,
) -> tuple[Decimal, dict]:
    """Операции журнала за неделю, сдвинувшие даты на ≥ порога проекта.

    Считаются операции, а не задачи: три переноса одной задачи — три сдвига.
    Отмена — тоже перенос: даты она меняет так же, как прямая операция.
    """
    threshold = max(resolve_shift_threshold(project, org), 1)
    begin, end = _week_bounds_utc(week_start, tz)
    revisions = db.scalars(
        select(Revision)
        .where(
            Revision.project_id == project.id,
            Revision.created_at >= begin,
            Revision.created_at < end,
            Revision.op["type"].astext.in_(
                ("move_task", "resize_task", "set_duration", "move_category")
            ),
        )
        .order_by(Revision.seq)
    ).all()
    tasks_by_id = {task.id: task for task in plan.tasks}
    count = 0
    entries: list[dict] = []
    for revision in revisions:
        delta = _shift_delta(revision.op)
        if delta < threshold:
            continue
        count += 1
        if revision.op["type"] == "move_category":
            category_id = uuid.UUID(revision.op["category_id"])
            for task in plan.tasks:
                if task.category_id == category_id:
                    entries.append(_entry(plan, task, delta_days=delta))
            continue
        task = tasks_by_id.get(uuid.UUID(revision.op["task_id"]))
        if task is None:
            # Задачу успели удалить; операция считается, в списке её нет.
            continue
        entries.append(_entry(plan, task, delta_days=delta))
    return Decimal(count), {"tasks": entries, "threshold": threshold}


def _compute_close_rate(
    plan: _PlanView, week_start: date, tz: ZoneInfo
) -> tuple[Decimal | None, dict]:
    """done за неделю ÷ задач с датой окончания в этой неделе.

    Ничего не было в срок и ничего не закрыто — no_data, а не 1.0: мёртвая
    неделя без единого движения не «в норме», о ней просто нечего сказать.
    Есть закрытия при пустом знаменателе — 1.0: неделя без обещаний, но с
    работой не проваливается.
    """
    if not plan.dated:
        return None, {}
    week_end = week_start + timedelta(days=6)
    due = [
        task
        for task in plan.tasks
        if (end := plan.ends.get(task.id)) is not None and week_start <= end <= week_end
    ]
    done = [
        task for task in plan.tasks if _in_week(task.done_at, week_start, tz)
    ]
    details = {
        "tasks": [_entry(plan, task, closed_in_week=True) for task in done]
        + [
            _entry(plan, task, closed_in_week=False)
            for task in due
            if not _in_week(task.done_at, week_start, tz)
        ],
        "done": len(done),
        "due": len(due),
    }
    if not due:
        if not done:
            return None, details
        return Decimal("1.00"), details
    rate = (Decimal(len(done)) / Decimal(len(due))).quantize(
        _TWO_PLACES, rounding=ROUND_HALF_UP
    )
    return rate, details


def _compute_stale(plan: _PlanView, ref: date, tz: ZoneInfo) -> tuple[Decimal, dict]:
    """Задачи в in_progress дольше STALE_WORKDAYS рабочих дней.

    Считается по in_progress_since — настоящему времени взятия в работу, а не
    по датам плана, поэтому работает и у относительного проекта.
    """
    entries: list[dict] = []
    for task in plan.tasks:
        if task.status != TaskStatus.IN_PROGRESS or task.in_progress_since is None:
            continue
        stamp = task.in_progress_since
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=timezone.utc)
        since = stamp.astimezone(tz).date()
        if since > ref:
            continue
        # Полные рабочие дни с момента взятия: день взятия не в счёт.
        in_progress_days = count_working_days(since, ref, plan.calendar) - 1
        if in_progress_days > STALE_WORKDAYS:
            entries.append(_entry(plan, task, in_progress_days=in_progress_days))
    entries.sort(key=lambda e: e["in_progress_days"], reverse=True)
    return Decimal(len(entries)), {"tasks": entries}


def _date_edited_ids(
    db: DbSession, project: Project
) -> tuple[set[uuid.UUID], set[uuid.UUID]]:
    """Задачи и категории, чьи даты хоть раз правили руками (за всю жизнь
    проекта). Для «нереального срока»: план, который никто не трогал, — не
    план, а заглушка."""
    ops = db.scalars(
        select(Revision.op).where(
            Revision.project_id == project.id,
            Revision.op["type"].astext.in_(
                ("move_task", "resize_task", "set_duration", "move_category")
            ),
        )
    ).all()
    task_ids: set[uuid.UUID] = set()
    category_ids: set[uuid.UUID] = set()
    for op in ops:
        try:
            if op["type"] == "move_category":
                category_ids.add(uuid.UUID(op["category_id"]))
            else:
                task_ids.add(uuid.UUID(op["task_id"]))
        except (KeyError, TypeError, ValueError):
            continue
    return task_ids, category_ids


def _compute_data_quality(
    db: DbSession, project: Project, plan: _PlanView, ref: date
) -> tuple[Decimal, dict]:
    """(1 − непригодных/всех) × 100%.

    Непригодна задача, у которой нет исполнителя (вехи не в счёт — веху не
    исполняют), или у которой «нереальный срок»: просрочена больше
    UNREAL_OVERDUE_WORKDAYS рабочих дней и даты ни разу не правились, либо
    создана AI и даты так и не тронуты.
    """
    edited_tasks, edited_categories = _date_edited_ids(db, project)

    def dates_edited(task: Task) -> bool:
        return task.id in edited_tasks or task.category_id in edited_categories

    unassigned: list[dict] = []
    unreal: list[dict] = []
    for task in plan.tasks:
        reasons = []
        if not task.milestone and not plan.assignees.get(task.id):
            reasons.append("unassigned")
        end = plan.ends.get(task.id)
        badly_overdue = (
            plan.dated
            and end is not None
            and task.status != TaskStatus.DONE
            and _overdue_workdays(plan, end, ref) > UNREAL_OVERDUE_WORKDAYS
        )
        if (badly_overdue and not dates_edited(task)) or (
            task.created_by_ai_session_id is not None and not dates_edited(task)
        ):
            reasons.append("unreal_deadline")
        if "unassigned" in reasons:
            unassigned.append(_entry(plan, task, reasons=reasons))
        if "unreal_deadline" in reasons:
            unreal.append(_entry(plan, task, reasons=reasons))
    total = len(plan.tasks)
    unassigned_ids = {e["id"] for e in unassigned}
    unreal_ids = {e["id"] for e in unreal}
    both = len(unassigned_ids & unreal_ids)
    # bad — размер объединения: задача с обеими бедами плоха один раз.
    bad = len(unassigned_ids | unreal_ids)
    value = (
        Decimal("100.00")
        if total == 0
        else (Decimal(total - bad) * Decimal("100") / Decimal(total)).quantize(
            _TWO_PLACES, rounding=ROUND_HALF_UP
        )
    )
    # affected и both отданы наружу, чтобы чек-лист причин сходился с
    # процентом: len(unassigned) + len(unreal) − both == affected.
    details = {
        "total": total,
        "affected": bad,
        "both": both,
        "unassigned": unassigned,
        "unreal_deadline": unreal,
    }
    return value, details


def _compute_metric(
    db: DbSession, project: Project, org: Organization, plan: _PlanView,
    key: str, week_start: date, ref: date, tz: ZoneInfo,
) -> tuple[Decimal | None, dict]:
    """Значение и drill-down метрики за неделю. `ref` — дата расчёта: сегодня
    для текущей недели, воскресенье недели — для дозаписи пропущенной."""
    if key == "overdue_tasks":
        return _compute_overdue(plan, ref)
    if key == "finish_drift":
        return _compute_finish_drift(db, project, plan, week_start)
    if key == "scope_growth":
        return _compute_scope(db, project, plan, week_start, tz)
    if key == "date_shifts":
        return _compute_date_shifts(db, project, org, plan, week_start, tz)
    if key == "close_rate":
        return _compute_close_rate(plan, week_start, tz)
    if key == "stale_in_progress":
        return _compute_stale(plan, ref, tz)
    if key == "data_quality":
        return _compute_data_quality(db, project, plan, ref)
    # Неизвестная метрика: источника нет.
    return None, {}


# --- снимки и фиксация --------------------------------------------------------


def _week_rows(
    db: DbSession, project: Project, week_start: date
) -> dict[str, ScorecardSnapshot]:
    rows = db.scalars(
        select(ScorecardSnapshot).where(
            ScorecardSnapshot.project_id == project.id,
            ScorecardSnapshot.week_start == week_start,
        )
    ).all()
    return {row.metric_key: row for row in rows}


def _lock_project(db: DbSession, project: Project) -> None:
    """Сериализует запись снимков: два конкурентных GET на границе недели
    иначе разошлись бы на уникальном ограничении пятисоткой. Тот же приём и
    тот же замок, что у слоя мутаций."""
    db.execute(select(Project.id).where(Project.id == project.id).with_for_update())


def _compute_week_values(
    db: DbSession, project: Project, org: Organization, plan: _PlanView,
    configs: list[ScorecardMetric], week_start: date, ref: date, tz: ZoneInfo,
) -> dict[str, tuple[Decimal | None, str, dict]]:
    """(значение, статус, details) по каждой метрике недели. Выключенная
    метрика не считается вовсе: её ответ — no_data, и тратить на неё журнал
    незачем."""
    computed: dict[str, tuple[Decimal | None, str, dict]] = {}
    for config in configs:
        if not config.enabled:
            computed[config.metric_key] = (None, ScorecardStatus.NO_DATA.value, {})
            continue
        value, details = _compute_metric(
            db, project, org, plan, config.metric_key, week_start, ref, tz
        )
        status = metric_status(value, config.target_value, config.direction)
        computed[config.metric_key] = (value, status, details)
    return computed


def _backfill_missing_weeks(
    db: DbSession, project: Project, org: Organization,
    configs: list[ScorecardMetric], plan: _PlanView,
    current_week: date, tz: ZoneInfo,
) -> None:
    """Дозаписывает недостающие недельные снимки между последним записанным и
    текущей неделей.

    Журнальные метрики (date_shifts, close_rate, scope_growth) считаются точно
    по журналу той недели; срезы состояния восстановить нельзя — они считаются
    по текущему состоянию на воскресенье той недели и помечаются
    `backfilled: true`. finish_drift — разность соседних снимков, у пропущенной
    недели точки отсчёта нет, поэтому она пишется no_data+backfilled, а не
    восстанавливается. Записанные ранее недели не трогаются: снимки прошлых
    недель неизменяемы.
    """
    last = db.scalar(
        select(ScorecardSnapshot.week_start)
        .where(ScorecardSnapshot.project_id == project.id)
        .order_by(ScorecardSnapshot.week_start.desc())
        .limit(1)
    )
    if last is None or last >= current_week - timedelta(days=7):
        return
    week = last + timedelta(days=7)
    while week < current_week:
        existing = _week_rows(db, project, week)
        ref = week + timedelta(days=6)
        computed = _compute_week_values(db, project, org, plan, configs, week, ref, tz)
        for config in configs:
            if config.metric_key in existing:
                continue
            value, status, details = computed[config.metric_key]
            if config.metric_key == "finish_drift":
                # У пропущенной недели нет базы для дрейфа — no_data, и без
                # projected_finish, чтобы следующая неделя не зацепилась за
                # прогноз, снятый с сегодняшнего плана.
                value, status, details = (
                    None, ScorecardStatus.NO_DATA.value, {"backfilled": True},
                )
            elif config.metric_key not in ("date_shifts", "close_rate", "scope_growth"):
                details = details | {"backfilled": True}
            db.add(
                ScorecardSnapshot(
                    project_id=project.id,
                    metric_key=config.metric_key,
                    week_start=week,
                    value=value,
                    target_value=config.target_value,
                    direction=config.direction,
                    status=status,
                    computed_at=datetime.now(timezone.utc),
                    computed_by=None,
                    details=details,
                )
            )
        # Флаш на каждой неделе, а не в конце: снимок недели N должен быть
        # виден, когда считается неделя N+1 (finish_drift читает предыдущую).
        db.flush()
        week += timedelta(days=7)


def _upsert_current_week(
    db: DbSession, project: Project, configs: list[ScorecardMetric],
    computed: dict[str, tuple[Decimal | None, str, dict]],
    current_week: date, actor_id: uuid.UUID | None,
) -> dict[str, ScorecardSnapshot]:
    rows = _week_rows(db, project, current_week)
    now = datetime.now(timezone.utc)
    for config in configs:
        value, status, details = computed[config.metric_key]
        row = rows.get(config.metric_key)
        if row is None:
            row = ScorecardSnapshot(
                project_id=project.id,
                metric_key=config.metric_key,
                week_start=current_week,
            )
            db.add(row)
            rows[config.metric_key] = row
        row.value = value
        row.target_value = config.target_value
        row.direction = config.direction
        row.status = status
        row.details = details
        row.computed_at = now
        row.computed_by = actor_id
    db.flush()
    return rows


# --- события и правило --------------------------------------------------------


def _org_locale(org: Organization) -> str:
    return org.default_locale if org.default_locale in ("ru", "en", "az") else "az"


def _last_working_day(week_start: date, calendar: Calendar) -> date:
    """Последний рабочий день недели — срок задачи «Разобрать». Неделя без
    рабочих дней отдаёт воскресенье: срок хуже точного, но задача важнее."""
    day = week_start + timedelta(days=6)
    while day > week_start and not calendar.is_working(day):
        day -= timedelta(days=1)
    return day


def _rule_task_start(plan: _PlanView, current_week: date) -> date:
    if plan.dated:
        return _last_working_day(current_week, plan.calendar)
    # У относительного плана настоящих дат нет — задача встаёт в конец
    # относительной оси, где её увидят первой.
    from app.schedule import RELATIVE_EPOCH

    return max((task.start_date for task in plan.tasks), default=RELATIVE_EPOCH)


def _create_rule_task(
    db: DbSession, project: Project, org: Organization, plan: _PlanView,
    config: ScorecardMetric, current_week: date,
) -> Task | None:
    """Задача «Разобрать: {метрика}» через слой мутаций — с журналом и отменой.

    Исполнитель — владелец метрики, срок — конец недели, категория — первая в
    проекте. Проекту без категорий задачу положить некуда — правило молча
    пропускается до появления первой категории (события тоже нет: пустое
    событие со ссылкой в никуда не сказало бы ничего).
    """
    category_id = db.scalar(
        select(Category.id)
        .where(Category.project_id == project.id)
        .order_by(Category.position, Category.id)
        .limit(1)
    )
    if category_id is None:
        logger.warning(
            "правило скоркарда: в проекте %s нет категорий, задача не создана",
            project.id,
        )
        return None
    locale = _org_locale(org)
    label = _METRIC_LABELS.get(config.metric_key, {}).get(locale, config.metric_key)
    title = _RULE_TASK_TITLE[locale].format(label=label)
    start = _rule_task_start(plan, current_week)
    batch_id = uuid.uuid4()
    try:
        revision = apply_op(
            db,
            project,
            CreateTask(
                category_id=category_id, name=title, start_date=start, duration_days=1
            ),
            actor_id=None,
            batch_id=batch_id,
        )
    except MutationError as error:
        # Потолок задач, вырожденный календарь — правило не вправе валить
        # чтение скоркарда; след остаётся в журнале приложения.
        logger.warning("правило скоркарда: задача не создана (%s)", error.code)
        return None
    task_id = uuid.UUID(revision.op["task_id"])
    if config.owner_user_id is not None:
        try:
            apply_op(
                db,
                project,
                AssignUser(task_id=task_id, user_id=config.owner_user_id),
                actor_id=None,
                batch_id=batch_id,
            )
        except InvalidOperation:
            # Владелец успел покинуть организацию — задача остаётся без
            # исполнителя, как и метрика без владельца.
            logger.warning("правило скоркарда: владелец метрики вне организации")
    return db.get(Task, task_id)


def _risk_series_start(
    statuses: dict[date, str], current_week: date
) -> date:
    """Понедельник первой недели непрерывной красной серии, включая текущую."""
    week = current_week
    while statuses.get(week - timedelta(days=7)) == ScorecardStatus.RISK.value:
        week -= timedelta(days=7)
        if current_week - week > timedelta(weeks=MAX_STREAK_WEEKS):
            break
    return week


def _alert_task_source(metric_key: str, details: dict) -> list[dict]:
    """Список задач под алертом, зависящий от метрики: качество бьёт по двум
    множествам (объединяем без дублей), объём — по добавленным, остальные — по
    общему списку drill-down."""
    if metric_key == "data_quality":
        merged: dict[str, dict] = {}
        for entry in details.get("unassigned", []) + details.get("unreal_deadline", []):
            merged.setdefault(entry["id"], entry)
        return list(merged.values())
    if metric_key == "scope_growth":
        return details.get("added", [])
    return details.get("tasks") or []


def _alert_payload(
    config: ScorecardMetric,
    value: Decimal | None,
    details: dict,
    previous_value: Decimal | None,
) -> dict:
    """Полезная нагрузка события: значение, дельта к прошлой неделе, кто тянет
    вниз и топ-3 задачи. Дельта и адресат превращают «X в риске» из констатации
    в подсказку, что именно и у кого разбирать."""
    payload: dict = {"value": float(value) if value is not None else None}
    if value is not None and previous_value is not None:
        payload["delta"] = float(value - previous_value)
    else:
        payload["delta"] = None

    tasks = _alert_task_source(config.metric_key, details)
    payload["total"] = len(tasks)
    payload["tasks"] = [
        {
            "id": entry["id"],
            "name": entry["name"],
            "assignee": (entry.get("assignees") or [None])[0],
            **({"days_overdue": entry["days_overdue"]} if "days_overdue" in entry else {}),
        }
        for entry in tasks[:3]
    ]

    # Самый частый первый исполнитель по всему списку — «у кого больше всего».
    counts: dict[str, int] = {}
    for entry in tasks:
        name = (entry.get("assignees") or [None])[0]
        if name:
            counts[name] = counts.get(name, 0) + 1
    if counts:
        top = max(counts.items(), key=lambda pair: pair[1])
        payload["top_assignee"] = {"name": top[0], "count": top[1]}
    else:
        payload["top_assignee"] = None
    return payload


def _update_alerts(
    db: DbSession, project: Project, org: Organization, plan: _PlanView,
    configs: list[ScorecardMetric],
    computed: dict[str, tuple[Decimal | None, str, dict]],
    current_week: date,
) -> None:
    """Жизненный цикл событий при записи снимка текущей недели.

    metric_risk живёт, пока метрика красная; правило «красная 2 недели
    подряд» создаёт задачу один раз на серию — повтор подавляется уже
    записанным rule_triggered этой серии, разорванная серия закрывает его.
    """
    alerts = db.scalars(
        select(ScorecardAlert).where(ScorecardAlert.project_id == project.id)
    ).all()
    by_metric: dict[str, list[ScorecardAlert]] = {}
    for alert in alerts:
        by_metric.setdefault(alert.metric_key, []).append(alert)

    history = db.scalars(
        select(ScorecardSnapshot).where(
            ScorecardSnapshot.project_id == project.id,
            ScorecardSnapshot.week_start < current_week,
        )
    ).all()
    statuses_by_metric: dict[str, dict[date, str]] = {}
    values_by_metric: dict[str, dict[date, Decimal | None]] = {}
    for row in history:
        statuses_by_metric.setdefault(row.metric_key, {})[row.week_start] = row.status
        values_by_metric.setdefault(row.metric_key, {})[row.week_start] = row.value

    now = datetime.now(timezone.utc)
    previous_week = current_week - timedelta(days=7)
    for config in configs:
        value, status, details = computed[config.metric_key]
        previous_value = values_by_metric.get(config.metric_key, {}).get(previous_week)
        own = by_metric.get(config.metric_key, [])
        active_risk = [
            a
            for a in own
            if a.kind == ScorecardAlertKind.METRIC_RISK and a.resolved_at is None
        ]
        active_rule = [
            a
            for a in own
            if a.kind == ScorecardAlertKind.RULE_TRIGGERED and a.resolved_at is None
        ]
        if status != ScorecardStatus.RISK.value:
            for alert in active_risk + active_rule:
                alert.resolved_at = now
            continue

        payload = _alert_payload(config, value, details, previous_value)
        if active_risk:
            # Событие уже открыто — освежается только полезная нагрузка:
            # неделя начала риска и время создания остаются исходными.
            active_risk[0].payload = payload
        else:
            db.add(
                ScorecardAlert(
                    project_id=project.id,
                    metric_key=config.metric_key,
                    week_start=current_week,
                    kind=ScorecardAlertKind.METRIC_RISK.value,
                    payload=payload,
                )
            )

        statuses = statuses_by_metric.get(config.metric_key, {})
        previous_risk = (
            statuses.get(current_week - timedelta(days=7))
            == ScorecardStatus.RISK.value
        )
        if not previous_risk:
            continue
        series_start = _risk_series_start(statuses, current_week)
        already_fired = any(
            a.kind == ScorecardAlertKind.RULE_TRIGGERED
            and a.week_start >= series_start
            for a in own
        )
        if already_fired:
            continue
        task = _create_rule_task(db, project, org, plan, config, current_week)
        if task is None:
            continue
        db.add(
            ScorecardAlert(
                project_id=project.id,
                metric_key=config.metric_key,
                week_start=current_week,
                kind=ScorecardAlertKind.RULE_TRIGGERED.value,
                payload={"task_id": str(task.id), "task_name": task.name},
            )
        )
    db.flush()


# --- чтение состояния ---------------------------------------------------------


def _streak(statuses: dict[date, str], current_week: date, status: str) -> int:
    """Недель подряд (включая текущую) в текущем статусе. Считается по
    снимкам при чтении, а не хранится: хранимая серия разошлась бы с
    летописью при первом же пересчёте текущей недели."""
    if status == ScorecardStatus.NO_DATA.value:
        return 0
    streak = 1
    week = current_week - timedelta(days=7)
    while statuses.get(week) == status and streak < MAX_STREAK_WEEKS:
        streak += 1
        week -= timedelta(days=7)
    return streak


def _owner_names(db: DbSession, configs: list[ScorecardMetric]) -> dict[uuid.UUID, str]:
    ids = {c.owner_user_id for c in configs if c.owner_user_id is not None}
    if not ids:
        return {}
    return {
        user.id: user.name
        for user in db.scalars(select(User).where(User.id.in_(ids))).all()
    }


def _build_outlook(
    db: DbSession, project: Project,
    current_rows: dict[str, ScorecardSnapshot], today: date,
) -> dict:
    """Прогноз финиша и ближайшая веха для шапки скоркарда.

    Дёшево на кэш-хите: финиш берётся из снимка finish_drift, веха — одним
    запросом. Ближайшая — первая незакрытая веха от сегодня вперёд; если
    впереди пусто, показываем последнюю просроченную. Относительный план
    настоящих дат не имеет — outlook пуст.
    """
    if project.schedule_mode != ScheduleMode.CALENDAR:
        return {"projected_finish": None, "milestone": None}
    finish_row = current_rows.get("finish_drift")
    projected = None
    if finish_row is not None and finish_row.details:
        projected = finish_row.details.get("projected_finish")

    milestones = db.scalars(
        select(Task).where(
            Task.project_id == project.id,
            Task.milestone.is_(True),
            Task.status != TaskStatus.DONE,
        )
    ).all()
    chosen: Task | None = None
    status = None
    upcoming = sorted(
        (t for t in milestones if t.start_date >= today), key=lambda t: t.start_date
    )
    if upcoming:
        chosen, status = upcoming[0], "upcoming"
    else:
        overdue = sorted(
            (t for t in milestones if t.start_date < today),
            key=lambda t: t.start_date,
            reverse=True,
        )
        if overdue:
            chosen, status = overdue[0], "overdue"
    milestone = (
        {
            "id": str(chosen.id),
            "name": chosen.name,
            "date": chosen.start_date.isoformat(),
            "status": status,
        }
        if chosen is not None
        else None
    )
    return {"projected_finish": projected, "milestone": milestone}


#: Поля details, которые выносятся прямо в строку метрики (а не в drill-down):
#: второй ракурс, без которого значение читается наполовину.
_ROW_DETAIL_FIELDS = {
    "overdue_tasks": ("avg_days",),
    "scope_growth": ("added_count", "closed_count"),
}


def _build_state(
    db: DbSession, project: Project, configs: list[ScorecardMetric],
    current_rows: dict[str, ScorecardSnapshot], current_week: date, weeks: int,
    today: date,
) -> dict:
    weeks = max(1, weeks)
    horizon = current_week - timedelta(days=7 * (weeks - 1))
    # Читается глубже окна: серия считается за пределами спарклайна.
    floor = current_week - timedelta(days=7 * MAX_STREAK_WEEKS)
    rows = db.scalars(
        select(ScorecardSnapshot)
        .where(
            ScorecardSnapshot.project_id == project.id,
            ScorecardSnapshot.week_start >= floor,
        )
        .order_by(ScorecardSnapshot.week_start)
    ).all()
    by_metric: dict[str, dict[date, ScorecardSnapshot]] = {}
    for row in rows:
        by_metric.setdefault(row.metric_key, {})[row.week_start] = row

    owners = _owner_names(db, configs)
    metrics: list[dict] = []
    for config in configs:
        own = by_metric.get(config.metric_key, {})
        current = own.get(current_week)
        status = current.status if current else ScorecardStatus.NO_DATA.value
        statuses = {week: row.status for week, row in own.items()}
        history = [
            {
                "week_start": week.isoformat(),
                "value": float(row.value) if row.value is not None else None,
                "status": row.status,
            }
            for week, row in sorted(own.items())
            if horizon <= week <= current_week
        ]
        owner = None
        if config.owner_user_id is not None:
            owner = {
                "id": str(config.owner_user_id),
                "name": owners.get(config.owner_user_id, ""),
            }
        entry = {
            "key": config.metric_key,
            "direction": config.direction,
            "target": float(config.target_value),
            "enabled": config.enabled,
            "owner": owner,
            "value": (
                float(current.value)
                if current is not None and current.value is not None
                else None
            ),
            "status": status,
            "streak": _streak(statuses, current_week, status),
            "history": history,
        }
        # Второй ракурс метрики — сразу в строку: средняя просрочка, разбивка
        # объёма. `.get`, а не индекс: снимок в старом TTL-окне после деплоя
        # может ещё не нести новых полей.
        current_details = current.details or {} if current is not None else {}
        for field in _ROW_DETAIL_FIELDS.get(config.metric_key, ()):
            entry[field] = current_details.get(field)
        metrics.append(entry)

    alerts = db.scalars(
        select(ScorecardAlert)
        .where(
            ScorecardAlert.project_id == project.id,
            ScorecardAlert.resolved_at.is_(None),
            # Событие снятой метрики иначе висело бы вечно: _update_alerts
            # ходит только по текущим конфигам и не закрыло бы его.
            ScorecardAlert.metric_key.in_(METRIC_KEYS),
        )
        .order_by(ScorecardAlert.created_at.desc())
    ).all()
    alerts_out = [
        {
            "id": str(alert.id),
            "metric_key": alert.metric_key,
            "kind": alert.kind,
            "week_start": alert.week_start.isoformat(),
            "created_at": alert.created_at.isoformat(),
            "payload": alert.payload,
        }
        for alert in alerts
    ]

    quality_row = current_rows.get("data_quality")
    data_quality = None
    if quality_row is not None and quality_row.value is not None:
        details = quality_row.details or {}
        unassigned = len(details.get("unassigned", []))
        unreal = len(details.get("unreal_deadline", []))
        # affected/both — из details; если снимок из старого TTL-окна их не
        # несёт, восстанавливаем из двух списков (both там нет — оценим 0).
        data_quality = {
            "value": float(quality_row.value),
            "total": details.get("total", 0),
            "affected": details.get("affected", unassigned + unreal),
            "both": details.get("both", 0),
            "unassigned": unassigned,
            "unreal_deadline": unreal,
        }

    computed_stamps = [r.computed_at for r in current_rows.values() if r.computed_at]
    return {
        "week": {
            "number": current_week.isocalendar()[1],
            "start": current_week.isoformat(),
            "end": (current_week + timedelta(days=6)).isoformat(),
        },
        "computed_at": max(computed_stamps).isoformat() if computed_stamps else None,
        "metrics": metrics,
        "alerts": alerts_out,
        "outlook": _build_outlook(db, project, current_rows, today),
        "data_quality": data_quality,
    }


def scorecard_state(
    db: DbSession,
    project: Project,
    org: Organization,
    *,
    weeks: int = DEFAULT_WEEKS,
    actor_id: uuid.UUID | None = None,
    force: bool = False,
) -> dict:
    """Состояние скоркарда — с побочным эффектом ленивой фиксации.

    Текущая неделя считается вживую с кэшем в пять минут: кэш — это её же
    снимок, то есть он переживает перезапуск и общий для всех реплик, в
    отличие от памяти процесса. `force` (кнопка «Пересчитать») пропускает кэш;
    прошлые недели не пересчитываются никогда.
    """
    tz = project_tz(project, org)
    today = datetime.now(tz).date()
    current_week = week_start_of(today)
    configs = ensure_metrics(db, project)

    current_rows = _week_rows(db, project, current_week)
    now = datetime.now(timezone.utc)
    fresh = (
        not force
        and all(c.metric_key in current_rows for c in configs)
        and all(
            row.computed_at is not None
            and row.computed_at >= now - timedelta(seconds=CURRENT_WEEK_TTL_SECONDS)
            for row in current_rows.values()
        )
    )
    last_before = db.scalar(
        select(ScorecardSnapshot.week_start)
        .where(
            ScorecardSnapshot.project_id == project.id,
            ScorecardSnapshot.week_start < current_week,
        )
        .order_by(ScorecardSnapshot.week_start.desc())
        .limit(1)
    )
    gap = last_before is not None and last_before < current_week - timedelta(days=7)

    if force or gap or not fresh:
        # Замок на строке проекта: конкурентные GET на границе недели иначе
        # разъехались бы на уникальном ограничении снимков.
        _lock_project(db, project)
        plan = _plan_view(db, project, org)
        _backfill_missing_weeks(db, project, org, configs, plan, current_week, tz)
        computed = _compute_week_values(
            db, project, org, plan, configs, current_week, today, tz
        )
        current_rows = _upsert_current_week(
            db, project, configs, computed, current_week, actor_id
        )
        _update_alerts(db, project, org, plan, configs, computed, current_week)

    return _build_state(db, project, configs, current_rows, current_week, weeks, today)


def patch_metric(
    db: DbSession, project: Project, org: Organization, key: str, changes: dict
) -> None:
    """Правка конфига метрики: владелец, цель, включённость.

    Направление не правится — оно жёстко следует из ключа метрики. Владелец
    проверяется на членство в организации: чужой идентификатор не должен ни
    лечь в конфиг, ни подтвердить своим отказом существование аккаунта.
    """
    if key not in _DEFS:
        raise ScorecardError("metric_not_found", f"неизвестная метрика: {key}")
    ensure_metrics(db, project)
    config = db.scalar(
        select(ScorecardMetric).where(
            ScorecardMetric.project_id == project.id,
            ScorecardMetric.metric_key == key,
        )
    )
    if "owner_user_id" in changes:
        owner_id = changes["owner_user_id"]
        if owner_id is not None:
            member = db.scalar(
                select(Membership.id).where(
                    Membership.org_id == project.org_id,
                    Membership.user_id == owner_id,
                )
            )
            if member is None:
                raise ScorecardError(
                    "user_not_in_organization", "владелец метрики не в этой организации"
                )
        config.owner_user_id = owner_id
    if "target_value" in changes:
        target = Decimal(str(changes["target_value"]))
        if target < 0:
            raise ScorecardError("target_out_of_range", "цель не бывает отрицательной")
        config.target_value = target.quantize(_TWO_PLACES, rounding=ROUND_HALF_UP)
    if "enabled" in changes:
        config.enabled = bool(changes["enabled"])
    db.flush()


def metric_tasks(
    db: DbSession, project: Project, org: Organization, key: str, week: date | None
) -> dict:
    """Drill-down метрики за неделю: прошлые недели — из details снимка
    (летопись), текущая — живой расчёт без записи."""
    if key not in _DEFS:
        raise ScorecardError("metric_not_found", f"неизвестная метрика: {key}")
    tz = project_tz(project, org)
    today = datetime.now(tz).date()
    current_week = week_start_of(today)
    week_start = week_start_of(week) if week is not None else current_week
    if week_start > current_week:
        raise ScorecardError("week_in_future", "неделя ещё не наступила")

    if week_start == current_week:
        configs = {c.metric_key: c for c in ensure_metrics(db, project)}
        config = configs[key]
        if not config.enabled:
            value, details = None, {}
        else:
            plan = _plan_view(db, project, org)
            value, details = _compute_metric(
                db, project, org, plan, key, week_start, today, tz
            )
        return {
            "metric_key": key,
            "week_start": week_start.isoformat(),
            "value": float(value) if value is not None else None,
            "details": details,
        }

    row = db.scalar(
        select(ScorecardSnapshot).where(
            ScorecardSnapshot.project_id == project.id,
            ScorecardSnapshot.metric_key == key,
            ScorecardSnapshot.week_start == week_start,
        )
    )
    return {
        "metric_key": key,
        "week_start": week_start.isoformat(),
        "value": float(row.value) if row is not None and row.value is not None else None,
        "details": row.details if row is not None else {},
    }
