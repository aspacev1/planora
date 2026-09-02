"""Состояние проекта и лента комментариев в том виде, в каком они уходят по проводу.

Вынесено из маршрута, потому что читателей у одного и того же состояния стало
двое: рабочий экран участника и публичная страница гостя. Разница между ними —
не другой набор полей, а два признака видимости, и держать её здесь дешевле,
чем поддерживать вторую сборку того же ответа, которая однажды разойдётся с
первой ровно на то поле, которое гостю видеть нельзя.
"""

from collections.abc import Sequence
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.calendar import end_date
from app.comments import author_names
from app.critical import critical_tasks
from app.models import (
    Category,
    Comment,
    Dependency,
    Organization,
    Project,
    ScheduleMode,
    Task,
    TaskAssignee,
)
from app.schedule import relative_calendar
from app.settings_resolution import project_calendar, resolve_shift_threshold, resolve_timezone


def project_state(
    db: DbSession,
    project: Project,
    org: Organization,
    *,
    show_notes: bool,
    show_people: bool = True,
    undoable: dict | None = None,
) -> dict:
    """Проект целиком: календарь, категории, задачи, связи.

    `undoable` — то, что отменит кнопка «Отменить», уже приведённое к виду,
    в каком его вправе увидеть спрашивающий. Собирается снаружи: решение «кому
    что видно» живёт в матрице прав, а не здесь, и снимок удалённой задачи
    несёт внутреннюю заметку, которую подпись кнопки выдать не должна.

    `show_notes` — внутренняя заметка; её не видят ни `client`, ни гость.
    `show_people` — исполнители задач. Гостю они не отдаются даже
    идентификаторами: состав организации — не то, что публикуют вместе с
    планом, и по спецификации его не видит даже `client` с аккаунтом.

    Поднимает `CalendarError`, если рабочих дней в календаре не осталось:
    решение, каким кодом это назвать, принимает маршрут.
    """
    # Относительный план живёт на оси без настоящих дат, и календарь у него —
    # одна недельная маска: праздники и объявленные рабочие дни лягут на план
    # при привязке к дате старта (см. app.schedule).
    relative = project.schedule_mode == ScheduleMode.RELATIVE
    calendar = relative_calendar(project, org) if relative else project_calendar(project, org)

    # Позиции могут совпадать в одном крайнем случае (строка, восстановленная
    # отменой на позицию, которую с тех пор занял другой ряд), поэтому id —
    # обязательный второй ключ сортировки, а не только position.
    categories = db.scalars(
        select(Category)
        .where(Category.project_id == project.id)
        .order_by(Category.position, Category.id)
    ).all()
    tasks = db.scalars(
        select(Task).where(Task.project_id == project.id).order_by(Task.position, Task.id)
    ).all()

    # Один запрос на весь проект, а не по запросу на задачу: на сотне задач
    # второе дало бы сотню запросов ради одного экрана.
    assignees: dict[str, list[str]] = {str(t.id): [] for t in tasks}
    if show_people:
        for task_id, user_id in db.execute(
            select(TaskAssignee.task_id, TaskAssignee.user_id)
            .join(Task, Task.id == TaskAssignee.task_id)
            .where(Task.project_id == project.id)
            .order_by(TaskAssignee.user_id)
        ).all():
            assignees[str(task_id)].append(str(user_id))

    dependencies = db.execute(
        select(Dependency.from_task_id, Dependency.to_task_id)
        .where(Dependency.project_id == project.id)
        .order_by(Dependency.from_task_id, Dependency.to_task_id)
    ).all()

    ends = [end_date(t.start_date, t.duration_days, calendar) for t in tasks]
    # Критический путь — вместе с состоянием, а не отдельным запросом: он
    # рисуется на тех же полосках, и второй поход к серверу означал бы
    # диаграмму, которая дорисовывается через кадр после появления. Считает
    # сервер: запас меряется рабочими днями, а календарь — свойство проекта
    # (см. app/critical.py).
    critical = critical_tasks(
        {t.id: t.start_date for t in tasks},
        {t.id: finish for t, finish in zip(tasks, ends)},
        dependencies,
        calendar,
    )
    # Конец базового плана считает сервер по тому же календарю, что и текущий:
    # призрак под полоской обязан стоять там же, где стояла бы настоящая
    # полоска с теми датами, а клиент календарной арифметики не повторяет.
    baseline_ends = [
        end_date(t.baseline_start, t.baseline_duration, calendar)
        if t.baseline_start is not None and t.baseline_duration is not None
        else None
        for t in tasks
    ]

    return {
        "id": str(project.id),
        "name": project.name,
        "slug": project.slug,
        "deadline": project.deadline.isoformat() if project.deadline else None,
        # План: утверждён ли и какой версией. По этим двум значениям интерфейс
        # отличает черновик (правки свободны) от утверждённого плана и знает,
        # какую кнопку показать — «Утвердить» или «Переутвердить».
        "plan_approved_at": (
            project.plan_approved_at.isoformat() if project.plan_approved_at else None
        ),
        "plan_version": project.plan_version,
        # Режим расписания и назначенный старт. По ним интерфейс выбирает
        # шкалу — «Месяц 1 / Неделя 1» или настоящие месяцы — и знает, какую
        # кнопку показать: «Назначить дату старта» или «Изменить».
        "schedule_mode": project.schedule_mode,
        "start_date": project.start_date.isoformat() if project.start_date else None,
        # Автоперенос по связям: включён ли он на этом проекте. Интерфейсу
        # нужен не только рубильник в настройках — при включённом переносе он
        # не предлагает подвинуть задачу вручную (см. DependencyNudge):
        # предложение сделать то, что уже сделано, читается как сбой.
        "auto_schedule": project.auto_schedule,
        # То, что отменит кнопка «Отменить», — вместе с состоянием, а не
        # отдельным запросом: кнопка обязана быть неактивной сразу, а не
        # оживать через кадр после отрисовки.
        "undoable": undoable,
        # Максимум по датам окончания задач; пустой проект не имеет конца.
        "project_end": max(ends).isoformat() if ends else None,
        # Календарь едет вместе с состоянием: интерфейс заливает нерабочие дни
        # и рисует выходные ещё до первого клика, а не догадывается о них.
        "calendar": {
            "working_days": calendar.working_days,
            "holidays": sorted(d.isoformat() for d in calendar.holidays),
            "extra_workdays": sorted(d.isoformat() for d in calendar.extra_workdays),
        },
        # Разрешённые значения, а не сырые nullable-колонки проекта: кто их
        # унаследовал от организации, а кто задал сам — не дело интерфейса.
        "settings": {
            "shift_threshold_days": resolve_shift_threshold(project, org),
            "timezone": resolve_timezone(project, org),
        },
        # Сырые переопределения — рядом с разрешёнными значениями, но отдельно
        # от них. Экрану настроек нужно именно это различие: `null` там
        # означает «наследовать», и показать его как унаследованное число
        # значило бы предложить человеку переопределить то, что он и не
        # переопределял.
        "overrides": {
            "timezone": project.timezone,
            "working_days": project.working_days,
            "shift_threshold_days": project.shift_threshold_days,
            "holidays_extra": list(project.holidays_extra or []),
            "workdays_extra": list(project.workdays_extra or []),
        },
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
                "end_date": task_end.isoformat(),
                # Веха рисуется ромбом в своём дне, а не отрезком. Признак, а
                # не вывод из «длительность равна одному дню»: однодневных
                # задач полно, и вехой они не становятся.
                "milestone": t.milestone,
                # Задача без запаса: сдвинь её на день — на день уедет весь
                # проект. Считанное значение, а не хранимое: оно выводится из
                # дат и связей и разошлось бы с ними на первой же правке.
                "critical": t.id in critical,
                "criticality": t.criticality,
                "progress_pct": t.progress_pct,
                # Статус не секретнее прогресса: публичная страница показывает
                # те же полоски, и обе выдачи собираются этой одной функцией.
                "status": t.status,
                "position": t.position,
                "assignee_ids": assignees[str(t.id)],
                # Базовый план едет с задачей всегда, а не по отдельному
                # запросу: под каждой полоской рисуется его призрак, и второй
                # поход к серверу ради него означал бы диаграмму, которая
                # дорисовывается через кадр после появления.
                #
                # Пустые baseline_* при утверждённом плане — это и есть
                # признак «сверх первоначального плана»: отдельного флага нет,
                # потому что он был бы вычислим из этих же двух полей и однажды
                # разошёлся бы с ними.
                "baseline_start": t.baseline_start.isoformat() if t.baseline_start else None,
                "baseline_duration": t.baseline_duration,
                "baseline_end": baseline_end.isoformat() if baseline_end else None,
                **({"internal_note": t.internal_note} if show_notes else {}),
            }
            for t, task_end, baseline_end in zip(tasks, ends, baseline_ends)
        ],
        "dependencies": [
            {"from_task_id": str(source), "to_task_id": str(target)}
            for source, target in dependencies
        ],
    }


def comments_out(db: DbSession, comments: Sequence[Comment]) -> list[dict]:
    """Лента реплик.

    Автор отдаётся одинаково для участника и для гостя — именем и признаком
    `guest`. Идентификатор участника наружу не выходит: подписи под репликой
    он не нужен, а публичная страница показывает ту же ленту, что и рабочий
    экран.
    """
    names: dict[UUID, str] = author_names(db, comments)
    return [
        {
            "id": str(comment.id),
            "task_id": str(comment.task_id) if comment.task_id else None,
            "author": {
                "name": (
                    comment.guest_name
                    if comment.guest_name is not None
                    else names.get(comment.author_user_id, "")
                ),
                "guest": comment.guest_name is not None,
            },
            "body": comment.body,
            "created_at": comment.created_at.isoformat(),
            # Гостю поле не врёт: в его ленту внутренние реплики не попадают
            # вовсе (list_comments include_internal=False), так что здесь
            # у него всегда false. Участнику признак нужен, чтобы лента
            # различала «в сторону» и общий разговор.
            "internal": comment.internal,
        }
        for comment in comments
    ]
