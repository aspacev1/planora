import logging
import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, Body, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as DbSession

from app.access import Action, can, needs_project_grant, parse_role, visible_op
from app.api.deps import ProjectContext, project_context
from app.api.serialization import comments_out, project_state
from app.auth import current_user
from app.calendar import CalendarError
from app.comments import CommentRejected, add_comment, comment_counts, list_comments
from app.db import get_db
from app.live import hub
from app.models import (
    Category,
    IdempotencyRecord,
    Membership,
    Project,
    ProjectAccess,
    Revision,
    Task,
    User,
)
from app.mutations import (
    MutationError,
    NotFoundInProject,
    PublicOp,
    ReasonRequired,
    UndoConflict,
    apply_op,
    last_undoable,
    to_internal,
    undo_batch,
)

# Псевдоним, потому что обработчик маршрута ниже называется так же — имя
# обработчика менять нельзя без нужды: из него FastAPI строит operationId,
# на который завязан снимок контракта.
from app.mutations import MAX_WIRE_DATE, undo_last as undo_last_revision
from app.orgs import current_membership
from app.plans import PlanVersionNotFound, approve_plan, plan_versions, restore_plan_version
from app.projects import create_project as create_project_entity
from app.schedule import apply_schedule, planned_schedule
from app.settings_input import (
    MAX_WORKING_DAYS,
    MIN_WORKING_DAYS,
    NULLABLE_PROJECT_FIELDS,
    ProjectSettingsIn,
    changes,
)
from app.slugs import slug_check

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/projects", tags=["projects"])


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class ProjectOut(BaseModel):
    id: str
    name: str
    slug: str


class CommentIn(BaseModel):
    body: str = Field(min_length=1)
    task_id: uuid.UUID | None = None
    #: Реплика «в сторону»: видна участникам, гостю публичной ссылки — нет.
    internal: bool = False


@router.post("", response_model=ProjectOut, status_code=201)
def create_project(
    payload: ProjectIn,
    membership: Membership = Depends(current_membership),
    db: DbSession = Depends(get_db),
):
    # scoped=... и здесь, не только у чтения: у нового проекта нет и не может
    # быть заранее выданного доступа, а сужённой роли он нужен на любое
    # действие — значит can() отказывает ей всегда, и это верно. Другой ответ
    # был бы дырой в самом сужении: редактор, запертый в горстке проектов,
    # заводил бы себе новые в обход списка — и не видел бы их потом в
    # /api/projects, потому что там та же проверка спрашивает выданный доступ,
    # а не создателя.
    if not can(parse_role(membership.role), Action.PROJECT_WRITE, scoped=membership.project_scoped):
        raise HTTPException(status_code=403, detail="forbidden")

    project = create_project_entity(db, org_id=membership.org_id, name=payload.name)
    return ProjectOut(id=str(project.id), name=project.name, slug=project.slug)


@router.get("", response_model=list[ProjectOut])
def list_projects(
    user: User = Depends(current_user),
    membership: Membership = Depends(current_membership),
    db: DbSession = Depends(get_db),
):
    role = parse_role(membership.role)
    if not can(role, Action.PROJECT_READ, project_granted=True):
        # Роль, которая не читает проекты ни при каком гранте (то есть
        # значение вне матрицы), не получает и списка. Тот же 404, что и у
        # отдельного проекта: пустой список сказал бы «проектов нет», а это
        # неправда.
        raise HTTPException(status_code=404, detail="project_not_found")

    query = select(Project).where(Project.org_id == membership.org_id)
    if needs_project_grant(role, scoped=membership.project_scoped):
        # Роль, которую зовут в проекты поимённо (или чьё собственное членство
        # сужено, см. Membership.project_scoped), видит ровно их. Фильтр
        # запросом, а не отсевом в Python: список проектов организации — это
        # ровно то, что от неё скрывают.
        query = query.join(ProjectAccess, ProjectAccess.project_id == Project.id).where(
            ProjectAccess.user_id == user.id
        )
    projects = db.scalars(query).all()
    return [ProjectOut(id=str(p.id), name=p.name, slug=p.slug) for p in projects]


def _undoable(db: DbSession, context: ProjectContext) -> dict | None:
    """Запись, которую снимет кнопка «Отменить», — или None.

    Проходит через visible_op: снимок удалённой задачи несёт внутреннюю
    заметку, и подпись кнопки не должна её выдать.
    """
    if not context.can(Action.PROJECT_WRITE):
        return None
    revision = last_undoable(db, context.project)
    if revision is None:
        return None
    return {
        "seq": revision.seq,
        "op": visible_op(revision.op, context.role, project_granted=context.granted),
        "batch_id": str(revision.batch_id) if revision.batch_id else None,
    }


@router.get("/{project_id}")
def get_project(
    context: ProjectContext = Depends(project_context), db: DbSession = Depends(get_db)
):
    try:
        return project_state(
            db,
            context.project,
            context.org,
            show_notes=context.can(Action.READ_INTERNAL_NOTE),
            undoable=_undoable(db, context),
        )
    except CalendarError as error:
        # Той же формы, что и отказы мутаций: 422 с машинным кодом. Раньше
        # здесь была голая пятисотка — вырожденную маску задаёт человек, и
        # проект переставал читаться без объяснения.
        raise HTTPException(status_code=422, detail=error.code)


def _revision_entry(revision: Revision, actor_name: str | None, op: dict) -> dict:
    """Запись журнала в том виде, в каком её читает клиент.

    Одна форма на два пути: ленту истории запрашивают по HTTP, а новые ревизии
    приходят в сокет. Собранные порознь, они разойдутся на первом же добавленном
    поле, и клиенту придётся разбирать две формы одного события.

    `op` приходит параметром, а не берётся из ревизии: кому что видно, решается
    у получателя (в HTTP — по роли спрашивающего, в сокете — по роли каждого
    подписчика отдельно), и решать это здесь значило бы решать дважды.
    """
    return {
        "seq": revision.seq,
        "created_at": revision.created_at.isoformat(),
        # Автора может не быть: операции AI и системные записи идут без
        # человека, и выдумывать им автора нельзя.
        "actor": (
            {"id": str(revision.actor_user_id), "name": actor_name}
            if actor_name is not None
            else None
        ),
        # Причина — текст человека: отдаётся как есть и не переводится.
        "reason": revision.reason,
        # Пачка и пометка отмены. По batch_id лента сворачивает применение AI
        # в одну строку; по undoes_seq помечает отменённые записи — запись об
        # отмене всегда новее отменённой, так что при чтении с головы журнала
        # пара сходится на клиенте без второго запроса.
        "batch_id": str(revision.batch_id) if revision.batch_id else None,
        "undoes_seq": revision.undoes_seq,
        "op": op,
    }


# Ключи операций, несущие идентификаторы сущностей, — по виду сущности.
# Словарь, а не разбор по типам операций: новая операция с task_id получает
# имя в ленте бесплатно, без правки этого места.
_OP_ID_KEYS = {
    "task": ("task_id", "from_task_id", "to_task_id"),
    "category": ("category_id",),
    "user": ("user_id",),
}


def _referenced_ids(op: dict) -> set[str]:
    """Все идентификаторы сущностей, которые упоминает операция."""
    return {
        str(op[key]) for keys in _OP_ID_KEYS.values() for key in keys if op.get(key)
    }


def _names_for(db: DbSession, project: Project, ops: list[dict]) -> dict[str, str]:
    """uuid → имя для всего, на что ссылаются операции страницы.

    Лента всего проекта без имён нечитаема: «перенёс старт с 12 на 19 марта»
    не говорит, чей это старт. Карточке задачи имена не нужны — там сущность
    одна и она в заголовке, — но форма ответа одна на обоих: две формы одного
    журнала разъехались бы на первом же добавленном поле.

    Имена живых задач и категорий берутся из таблиц; удалённых — из снимка
    восстановления в их delete-ревизии: журнал — единственное место, где имя
    пережило удаление. Идентификатор, имени которого нет нигде (пользователь
    стёр аккаунт), в словарь не попадает — клиент обходится фразой без имени.
    """
    ids: dict[str, set[str]] = {kind: set() for kind in _OP_ID_KEYS}
    for op in ops:
        for kind, keys in _OP_ID_KEYS.items():
            for key in keys:
                if op.get(key):
                    ids[kind].add(str(op[key]))

    names: dict[str, str] = {}
    for kind, model in (("task", Task), ("category", Category), ("user", User)):
        if ids[kind]:
            for row in db.execute(
                select(model.id, model.name).where(model.id.in_(ids[kind]))
            ):
                names[str(row.id)] = row.name

    # Удалённые задачи и категории: имя достаётся из inverse их delete-ревизии.
    # Свежайшая запись побеждает — переименованная и потом удалённая сущность
    # называется так, как в момент удаления.
    for op_type, key, missing in (
        ("delete_task", "task_id", ids["task"] - set(names)),
        ("delete_category", "category_id", ids["category"] - set(names)),
    ):
        if not missing:
            continue
        deletions = db.scalars(
            select(Revision)
            .where(
                Revision.project_id == project.id,
                Revision.op["type"].astext == op_type,
                Revision.op[key].astext.in_(missing),
            )
            .order_by(Revision.seq.desc())
        ).all()
        for revision in deletions:
            entity_id = str(revision.op[key])
            name = revision.inverse.get("name")
            if entity_id not in names and name:
                names[entity_id] = name

    # Задачи, унесённые каскадом вместе со своей категорией: своей записи об
    # удалении у них нет вовсе — их имена лежат в снимке восстановления
    # категории, списком внутри её inverse. Без этого прохода записи о таких
    # задачах читались бы в ленте без подлежащего: «перенёс старт с 12 на 19
    # марта» — а чей это старт, сказать больше нечем.
    orphaned = ids["task"] - set(names)
    if orphaned:
        cascades = db.scalars(
            select(Revision)
            .where(
                Revision.project_id == project.id,
                Revision.op["type"].astext == "delete_category",
            )
            .order_by(Revision.seq.desc())
        ).all()
        for revision in cascades:
            for snapshot in revision.inverse.get("tasks", []):
                task_id = str(snapshot.get("task_id"))
                if task_id in orphaned and task_id not in names and snapshot.get("name"):
                    names[task_id] = snapshot["name"]
    return names


@router.get("/{project_id}/revisions")
def list_revisions(
    task_id: uuid.UUID | None = None,
    actor_id: uuid.UUID | None = None,
    types: list[str] | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=1000),
    before_seq: int | None = Query(default=None, ge=1),
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    """Журнал изменений проекта, при желании — одной задачи.

    Запись отдаётся параметрами, а не готовой фразой: язык читателя решается в
    браузере, и один и тот же перенос обязан читаться на трёх языках. Сервер
    словарей сообщений не держит сознательно (см. MutationError).

    Фильтры — по автору и по типам операций — считает сервер, а не клиент:
    лента листается курсором, и клиентский отсев превращал бы «Показать ещё»
    в лотерею — страница есть, а подходящих записей в ней может не быть.

    Обратная операция наружу не выходит: она нужна отмене, а отмену делает
    сервер (`POST /{project_id}/undo`), клиенту она ни к чему. Отдавать её
    значило бы удваивать вес ленты и заодно удваивать поверхность, на которой
    заметка может утечь.
    """
    query = select(Revision).where(Revision.project_id == context.project.id)
    if task_id is not None:
        # Поиск по содержимому jsonb — то, ради чего колонка и объявлена jsonb:
        # выбирать все ревизии проекта и отсеивать их в Python значило бы
        # тащить журнал целиком ради одной карточки.
        query = query.where(Revision.op["task_id"].astext == str(task_id))
    if actor_id is not None:
        query = query.where(Revision.actor_user_id == actor_id)
    if types:
        query = query.where(Revision.op["type"].astext.in_(types))
    # Курсор для «показать раньше»: следующая страница начинается со
    # старейшей записи предыдущей. Номер, а не смещение: журнал растёт с
    # головы, и OFFSET сдвигался бы с каждой новой ревизией.
    if before_seq is not None:
        query = query.where(Revision.seq < before_seq)
    # Новые сверху: ленту читают с последнего события. seq, а не created_at, —
    # две операции одной секунды по времени неразличимы, а по номеру всегда.
    revisions = db.scalars(query.order_by(Revision.seq.desc()).limit(limit)).all()

    actors = {
        row.id: row.name
        for row in db.scalars(
            select(User).where(
                User.id.in_({r.actor_user_id for r in revisions if r.actor_user_id})
            )
        ).all()
    }

    # Имена — по видимой форме операции, а не по хранимой: то, что роль не
    # вправе видеть, не должно и называться.
    ops = [
        visible_op(revision.op, context.role, project_granted=context.granted)
        for revision in revisions
    ]
    names = _names_for(db, context.project, ops)

    return [
        {
            **_revision_entry(revision, actors.get(revision.actor_user_id), op),
            "names": {
                entity_id: names[entity_id]
                for entity_id in _referenced_ids(op)
                if entity_id in names
            },
        }
        for revision, op in zip(revisions, ops)
    ]


def _refuse(error: MutationError):
    """Отказ мутации → отказ HTTP. Форма одна на все маршруты, которые пишут.

    Три разных статуса не по вкусу, а по смыслу: чужая сущность неотличима от
    несуществующей (404), непроизнесённая причина снимается тем же запросом с
    добавленным полем (409), а неверно составленная операция не пройдёт
    никогда (422).

    Устаревший номер отменяемой ревизии — тоже 409: запрос верен, состояние
    под ним изменилось, и клиенту достаточно перечитать проект.
    """
    if isinstance(error, NotFoundInProject):
        return HTTPException(status_code=404, detail=error.code)
    if isinstance(error, UndoConflict):
        return HTTPException(status_code=409, detail=error.code)
    if isinstance(error, ReasonRequired):
        return HTTPException(
            status_code=409,
            detail=error.code,
            headers={
                "X-Shift-Deviation-Days": str(error.deviation_days),
                "X-Shift-Threshold-Days": str(error.threshold_days),
            },
        )
    return HTTPException(status_code=422, detail=error.code)


def _project_slug_taken(db: DbSession, org_id: uuid.UUID, slug: str, *, except_id) -> bool:
    return (
        db.scalar(
            select(Project.id).where(
                Project.org_id == org_id, Project.slug == slug, Project.id != except_id
            )
        )
        is not None
    )


@router.get("/{project_id}/slug-check")
def check_project_slug(
    slug: str = Query(min_length=1, max_length=100),
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    """Свободен ли слаг внутри этой организации — и что предложить, если занят."""
    context.require(Action.PROJECT_ADMIN)

    def taken(candidate: str) -> bool:
        return _project_slug_taken(
            db, context.project.org_id, candidate, except_id=context.project.id
        )

    return slug_check(slug, is_taken=taken)


def _replayed_response(db: DbSession, project_id: uuid.UUID, key: str) -> dict | None:
    """Ответ, уже выданный на этот ключ, — или None, если ключ свежий."""
    return db.scalar(
        select(IdempotencyRecord.response).where(
            IdempotencyRecord.project_id == project_id, IdempotencyRecord.key == key
        )
    )


def _remember_response(
    db: DbSession, project_id: uuid.UUID, key: str, response: dict
) -> dict:
    """Записывает ответ под ключом. При гонке двух одинаковых запросов
    отдаёт ответ победителя, откатив свою — вторую — попытку целиком."""
    # Попутная уборка: ключи старше суток — уже не ретраи.
    db.execute(
        IdempotencyRecord.__table__.delete().where(
            IdempotencyRecord.project_id == project_id,
            IdempotencyRecord.created_at
            < datetime.now(timezone.utc) - timedelta(hours=24),
        )
    )
    try:
        with db.begin_nested():
            db.add(IdempotencyRecord(project_id=project_id, key=key, response=response))
            db.flush()
        return response
    except IntegrityError:
        # Победитель уже применил операцию и записал ответ — наша попытка
        # откатывается целиком, чтобы не примениться второй раз.
        db.rollback()
        return _replayed_response(db, project_id, key) or response


def _publish(
    background: BackgroundTasks, db: DbSession, project_id: uuid.UUID, event: dict
) -> None:
    """Коммит и рассылка события в комнату проекта.

    Одна форма на все пишущие маршруты — тем же порядком, что и в мутациях:
    сперва коммит (клиент, получив сигнал, перечитывает проект, и до коммита
    перечитал бы старое), затем задача рассылки. До волны 3 в хаб публиковал
    только маршрут мутаций: отмена, откат пачки, настройки, план и
    комментарии соседних вкладок доезжали до людей только перезагрузкой.
    """
    db.commit()
    background.add_task(hub.publish, project_id, event)


@router.patch("/{project_id}")
def update_project(
    payload: ProjectSettingsIn,
    background: BackgroundTasks,
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    """Уровень 3 настроек: слаг, целевая дата и переопределения организации.

    `null` в часовом поясе, рабочих днях и пороге — это «наследовать», а не
    «пусто», и отличается он от «поле не прислали» тем, что второе просто не
    попадает в набор изменений. Без этой разницы сбросить переопределение было
    бы нечем: любой запрос без поля стирал бы его.

    Правки не проходят через журнал ревизий: журнал — история плана, а не
    история настроек. Смешать их значило бы наполнить историю задачи записями
    о том, что кто-то поменял часовой пояс.
    """
    context.require(Action.PROJECT_ADMIN)
    project = context.project

    # Замок строки проекта — тот же, что у мутаций (apply_op): настройки
    # календаря и порога двигают раскладку и участвуют в проверке порога, и
    # правка настроек, идущая вперемешку с применением операции, давала бы
    # мутации порог до правки, а раскладку — после.
    db.execute(select(Project.id).where(Project.id == project.id).with_for_update())

    updates = changes(payload, nullable=NULLABLE_PROJECT_FIELDS)
    if "slug" in updates and _project_slug_taken(
        db, project.org_id, updates["slug"], except_id=project.id
    ):
        raise HTTPException(status_code=409, detail="slug_taken")

    for field, value in updates.items():
        setattr(project, field, value)

    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="slug_taken")

    if updates:
        # Запись о правке — в журнал приложения: журнал ревизий — история
        # плана, а не настроек, но след «кто и что поменял» обязан остаться.
        logger.info(
            "настройки проекта %s изменил %s: %s",
            project.id,
            context.user.id,
            ", ".join(sorted(updates)),
        )

    response = get_project(context, db)
    if updates:
        # Настройки двигают раскладку у всех (календарь, порог), но записи в
        # журнале не имеют — событие несёт синтетический op: клиенту от него
        # нужен только повод перечитать проект.
        _publish(
            background,
            db,
            project.id,
            {"type": "revision", "op": {"type": "settings_changed"}},
        )
    return response


class ScheduleIn(BaseModel):
    """Привязка плана к дате старта — или её предпросмотр.

    `working_days` — маска новой рабочей недели, если её выбрали в том же
    окне; None — оставить действующую. `shift_tasks=False` — при повторной
    смене старта календарного проекта оставить даты задач как есть; для
    относительного проекта значения не имеет — его задачи раскладываются по
    календарю всегда.
    """

    start_date: date = Field(le=MAX_WIRE_DATE)
    working_days: int | None = Field(default=None, ge=MIN_WORKING_DAYS, le=MAX_WORKING_DAYS)
    shift_tasks: bool = True


def _schedule_out(plan) -> dict:
    return {
        "start_date": plan.start_date.isoformat(),
        "end_date": plan.end_date.isoformat() if plan.end_date else None,
    }


@router.post("/{project_id}/schedule/preview")
def preview_schedule(
    payload: ScheduleIn,
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    """Что станет с планом после привязки к дате: границы проекта до записи.

    Окно привязки обязано показать рассчитанную дату завершения до
    подтверждения — обещание «учтём выходные и праздники» без этой цифры
    непроверяемо.
    """
    context.require(Action.PROJECT_ADMIN)
    try:
        plan = planned_schedule(
            db,
            context.project,
            context.org,
            start=payload.start_date,
            working_days=payload.working_days,
            shift_tasks=payload.shift_tasks,
        )
    except CalendarError as error:
        raise HTTPException(status_code=422, detail=error.code)
    return _schedule_out(plan)


@router.post("/{project_id}/schedule")
def assign_schedule(
    payload: ScheduleIn,
    background: BackgroundTasks,
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    """Назначение (или перенос) даты старта проекта.

    Право — то же, что у настроек (PROJECT_ADMIN): действие меняет систему
    отсчёта всего плана и рабочую неделю, а не одну задачу. Через журнал
    ревизий не проходит по той же причине, что и настройки: это не правка
    плана, и отмены у него нет — обратный путь остаётся видом «Относительный
    план», который никуда не девается.
    """
    context.require(Action.PROJECT_ADMIN)
    project = context.project

    # Замок строки проекта — тот же, что у настроек и мутаций: раскладка задач
    # по календарю не должна идти вперемешку с чьим-то переносом задачи.
    db.execute(select(Project.id).where(Project.id == project.id).with_for_update())

    try:
        plan = apply_schedule(
            db,
            project,
            context.org,
            start=payload.start_date,
            working_days=payload.working_days,
            shift_tasks=payload.shift_tasks,
        )
    except CalendarError as error:
        db.rollback()
        raise HTTPException(status_code=422, detail=error.code)

    # След — в журнал приложения, как у правки настроек: в журнале ревизий
    # этого действия нет.
    logger.info(
        "дата старта проекта %s назначена %s: %s",
        project.id,
        context.user.id,
        plan.start_date.isoformat(),
    )

    response = get_project(context, db)
    # Синтетический op — как settings_changed: соседним вкладкам от события
    # нужен только повод перечитать проект.
    _publish(
        background,
        db,
        project.id,
        {"type": "revision", "op": {"type": "schedule_changed"}},
    )
    return response


@router.delete("/{project_id}", status_code=204)
def delete_project(
    background: BackgroundTasks,
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    """Удаление проекта целиком.

    Право — своё, а не PROJECT_ADMIN: вместе с проектом каскад уносит журнал
    ревизий, то есть и всякую возможность отмены. Необратимое действие такого
    веса, как и переутверждение плана, остаётся за владельцем.

    Через журнал ревизий удаление не проходит намеренно: журнал живёт внутри
    проекта и умирает вместе с ним — записи «проект удалён» негде было бы
    лежать.
    """
    context.require(Action.PROJECT_DELETE)
    project = context.project

    # След в журнале приложения — как у правки настроек: записи в журнале
    # ревизий у этого действия нет и быть не может.
    logger.info("проект %s удалил %s", project.id, context.user.id)

    db.delete(project)
    # Соседние вкладки узнают о судьбе проекта тем же способом, что и о любом
    # изменении: перечитыванием по сигналу. Перечитав, они получат 404 —
    # честный ответ «проекта больше нет».
    _publish(
        background,
        db,
        project.id,
        {"type": "revision", "op": {"type": "project_deleted"}},
    )
    return None


@router.post("/{project_id}/undo", status_code=201)
def undo_last(
    background: BackgroundTasks,
    reason: str | None = Body(default=None, embed=True),
    expected_seq: int | None = Body(default=None, embed=True),
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    """Отмена последнего изменения.

    Произвольная ревизия из середины журнала не отменяется по-прежнему: это
    другая функция («вернуть вот это одно»), и её обратная операция построена
    для того состояния, которого уже нет. `expected_seq` — не выбор ревизии, а
    условие: отменяется всё тот же верх журнала, но лишь пока он тот самый,
    который клиент назвал человеку. Разошлись — отказ 409, а не молчаливая
    отмена чужой правки, влезшей в зазор между показом кнопки и нажатием.

    Причина принимается, потому что отмена проходит ту же проверку порога, что
    и всякое изменение сроков: возврат, уводящий задачу от базового плана
    дальше порога, объясняется ровно так же.
    """
    context.require(Action.PROJECT_WRITE)

    # Выбор отменяемой ревизии — внутри undo_last, под замком проекта: выбор
    # здесь, в маршруте, давал бы двум одновременным нажатиям одну и ту же
    # ревизию, и второе отменяло бы уже отменённое (см. mutations.undo_last).
    # По той же причине там же, а не здесь, сверяется expected_seq.
    try:
        applied, revision = undo_last_revision(
            db,
            context.project,
            actor_id=context.user.id,
            reason=reason,
            expected_seq=expected_seq,
        )
    except MutationError as error:
        raise _refuse(error)

    # Отмена — такая же ревизия, как и мутация, и разъезжается по комнате той
    # же формой события.
    _publish(
        background,
        db,
        context.project.id,
        {"type": "revision", **_revision_entry(applied, context.user.name, applied.op)},
    )

    return {
        "seq": applied.seq,
        "undone_seq": revision.seq,
        "op": visible_op(applied.op, context.role, project_granted=context.granted),
    }


@router.post("/{project_id}/batches/{batch_id}/undo", status_code=201)
def undo_whole_batch(
    batch_id: uuid.UUID,
    background: BackgroundTasks,
    reason: str | None = Body(default=None, embed=True),
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    """Откат пачки целиком — одной кнопкой, как обещано про применение AI.

    Причина принимается по той же логике, что у одиночной отмены: откат
    проходит проверку порога, и пачка, двигавшая сроки дальше порога, без
    причины была бы неоткатываемой.
    """
    context.require(Action.PROJECT_WRITE)

    try:
        applied = undo_batch(
            db, context.project, batch_id, actor_id=context.user.id, reason=reason
        )
    except MutationError as error:
        raise _refuse(error)

    # Одно событие на пачку, а не по событию на отмену: клиент по сигналу
    # перечитывает проект целиком, и десять сигналов подряд — это десять
    # одинаковых перечитываний.
    _publish(
        background,
        db,
        context.project.id,
        {
            "type": "revision",
            **_revision_entry(applied[-1], context.user.name, applied[-1].op),
        },
    )

    return {"undone": len(applied), "seq": applied[-1].seq}


@router.post("/{project_id}/plan/approvals", status_code=201)
def approve_plan_route(
    background: BackgroundTasks,
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    """Утверждение плана, оно же переутверждение.

    Один маршрут, а не два: действие ровно одно — снять снимок и обновить
    базовые значения, — а различие в том, кому оно позволено. Второй маршрут
    отличался бы от первого только проверкой права, и разъехались бы они на
    первой же правке снимка.
    """
    first_time = context.project.plan_version == 0
    context.require(Action.PLAN_APPROVE if first_time else Action.PLAN_REAPPROVE)

    version = approve_plan(db, context.project, actor_id=context.user.id)
    payload = {
        "version": version.version,
        "approved_at": version.approved_at.isoformat(),
        "tasks": len(version.snapshot),
    }
    # Утверждение меняет базовые значения всех задач — соседние вкладки должны
    # увидеть новые «обещания», не дожидаясь перезагрузки.
    _publish(
        background,
        db,
        context.project.id,
        {"type": "revision", "op": {"type": "plan_approved"}},
    )
    return payload


@router.post("/{project_id}/plan/approvals/{version}/restore", status_code=201)
def restore_plan_version_route(
    version: int,
    background: BackgroundTasks,
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    """Возврат обещания к версии из летописи — переутверждение её снимка.

    Право — то же, что у переутверждения: восстановление меняет baseline
    всех задач ровно так же.
    """
    context.require(Action.PLAN_REAPPROVE)
    try:
        restored = restore_plan_version(
            db, context.project, version, actor_id=context.user.id
        )
    except PlanVersionNotFound:
        raise HTTPException(status_code=404, detail="plan_version_not_found")
    payload = {
        "version": restored.version,
        "restored_from": version,
        "approved_at": restored.approved_at.isoformat(),
        "tasks": len(restored.snapshot),
    }
    _publish(
        background,
        db,
        context.project.id,
        {"type": "revision", "op": {"type": "plan_approved"}},
    )
    return payload


@router.get("/{project_id}/plan/approvals")
def list_plan_versions(
    context: ProjectContext = Depends(project_context), db: DbSession = Depends(get_db)
):
    """Летопись утверждений: что обещали в январе, что в марте.

    Снимок отдаётся целиком — в нём нет внутренних заметок, только даты,
    длительности и названия, а названия видит всякий, кто вправе читать
    проект.
    """
    versions = plan_versions(db, context.project)
    approvers = {
        row.id: row.name
        for row in db.scalars(
            select(User).where(User.id.in_({v.approved_by for v in versions if v.approved_by}))
        ).all()
    }
    return [
        {
            "version": version.version,
            "approved_at": version.approved_at.isoformat(),
            "approved_by": (
                {"id": str(version.approved_by), "name": approvers[version.approved_by]}
                if version.approved_by in approvers
                else None
            ),
            "snapshot": version.snapshot,
        }
        for version in versions
    ]


@router.post("/{project_id}/mutations", status_code=201)
def apply_mutation(
    background: BackgroundTasks,
    op: PublicOp = Body(..., embed=True),
    reason: str | None = Body(default=None),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key", max_length=120),
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    context.require(Action.PROJECT_WRITE)

    # Ключ идемпотентности: повтор запроса (ретрай сети, двойной клик)
    # получает первый ответ, а не второе применение — «сдвинуть на день»
    # дважды — это сдвиг на два дня.
    if idempotency_key:
        replayed = _replayed_response(db, context.project.id, idempotency_key)
        if replayed is not None:
            return replayed

    try:
        revision = apply_op(
            db, context.project, to_internal(op), actor_id=context.user.id, reason=reason
        )
    except MutationError as error:
        # Сущность чужого проекта — не ошибка формата запроса, а непроизнесённая
        # причина снимается тем же запросом с добавленным полем: разбор кодов
        # общий для всех пишущих маршрутов.
        raise _refuse(error)

    # Заметка внутрь события кладётся как есть: кому её видно, решает каждый
    # сокет отдельно — в одной комнате сидят и редактор, и клиент.
    event = {"type": "revision", **_revision_entry(revision, context.user.name, revision.op)}

    seen = {"role": context.role, "project_granted": context.granted}
    payload = {
        "seq": revision.seq,
        "op": visible_op(revision.op, **seen),
        "inverse": visible_op(revision.inverse, **seen),
    }

    if idempotency_key:
        remembered = _remember_response(db, context.project.id, idempotency_key, payload)
        if remembered is not payload:
            # Гонка двух одинаковых запросов: наша попытка откатана, победил
            # первый — его ответ и уходит, рассылать нечего.
            return remembered

    # Коммит явный, до постановки рассылки в очередь, и это не перестраховка.
    # Разослать можно только то, что уже лежит в базе: получив сигнал, клиент
    # перезапрашивает проект целиком — и, придя раньше коммита, не увидел бы
    # изменения, а второго сигнала не будет. Полагаться здесь на коммит из
    # get_db нельзя: фоновые задачи выполняются раньше, чем закрывается
    # зависимость с yield. Повторный коммит на выходе безвреден — коммитить
    # уже нечего.
    db.commit()
    background.add_task(hub.publish, context.project.id, event)

    return payload


@router.get("/{project_id}/comments")
def list_project_comments(
    task_id: uuid.UUID | None = None,
    limit: int = Query(default=100, ge=1, le=200),
    before: uuid.UUID | None = None,
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    """Лента проекта — та же самая, что видна на публичной странице.

    Гостевые реплики приходят участнику вместе с остальными: смысл публичной
    ссылки в том, чтобы разговор с клиентом жил в проекте, а не в почте.

    Отдаётся хвост разговора; «показать раньше» — курсором before.
    """
    try:
        rows = list_comments(
            db, context.project, task_id=task_id, limit=limit, before=before
        )
    except CommentRejected as error:
        raise HTTPException(status_code=404, detail=error.code)
    return comments_out(db, rows)


@router.get("/{project_id}/comments/counts")
def project_comment_counts(
    context: ProjectContext = Depends(project_context), db: DbSession = Depends(get_db)
):
    """Сколько реплик у каждой задачи — числом на строке ленты.

    Отдельным маршрутом, а не полем в состоянии проекта: комментарий состояния
    не меняет и ревизии не рождает, поэтому состояние после него не
    перезапрашивается, и счётчик, вшитый в него, показывал бы вчерашнее число
    до ближайшей правки плана. Здесь же он обновляется вместе с самой лентой
    реплик — по тому же событию сокета.
    """
    return {str(task_id): count for task_id, count in comment_counts(db, context.project).items()}


@router.post("/{project_id}/comments", status_code=201)
def create_project_comment(
    payload: CommentIn,
    background: BackgroundTasks,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key", max_length=120),
    context: ProjectContext = Depends(project_context),
    db: DbSession = Depends(get_db),
):
    context.require(Action.COMMENT)

    # Тот же механизм, что у мутаций: ретрай сети не должен рождать дубль
    # реплики.
    if idempotency_key:
        replayed = _replayed_response(db, context.project.id, idempotency_key)
        if replayed is not None:
            return replayed
    try:
        comment = add_comment(
            db,
            context.project,
            body=payload.body,
            task_id=payload.task_id,
            author=context.user,
            internal=payload.internal,
        )
    except CommentRejected as error:
        # task_not_found — не ошибка формата: та же 404, что и у мутаций,
        # ссылающихся на чужую задачу.
        status = 404 if error.code == "task_not_found" else 422
        raise HTTPException(status_code=status, detail=error.code)
    response = comments_out(db, [comment])[0]
    if idempotency_key:
        remembered = _remember_response(db, context.project.id, idempotency_key, response)
        if remembered is not response:
            return remembered
    # Событие несёт только факт «в ленте новое», не текст: внутреннюю реплику
    # нельзя раздавать в комнату, где сидит и клиент, а решать по подписчику,
    # как у ревизий, здесь не из чего — тело реплики клиент дочитает по HTTP,
    # где фильтр уже есть.
    _publish(background, db, context.project.id, {"type": "comment"})
    return response
