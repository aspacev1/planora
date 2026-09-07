import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.models import (
    CRITICALITY_LEVELS,
    RISK_FLAGS,
    TASK_STATUSES,
    Category,
    Comment,
    Criticality,
    RiskFlag,
    Dependency,
    Membership,
    Organization,
    Project,
    Revision,
    Task,
    TaskAssignee,
    TaskStatus,
    User,
)
from app.cascade import apply_dates, push_successors
from app.plans import deviation_days
from app.settings_resolution import project_calendar, resolve_shift_threshold


class MutationError(Exception):
    """Отказ применить операцию.

    Несёт стабильный машинный код для ответа и человеческий текст — для
    журнала. Текст в тело ответа не попадает: язык интерфейса по умолчанию
    азербайджанский, словарей сообщений сервер сознательно не держит (их
    составляет клиент), поэтому проза в `detail` непереводима.
    """

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class NotFoundInProject(MutationError):
    """Названная сущность не существует или принадлежит другому проекту.

    Отдельный класс от InvalidOperation: обращение к задаче чужой
    организации — это не ошибка формата запроса, и маршрут отвечает на него
    404, а не 422.
    """


class InvalidOperation(MutationError):
    """Операция составлена так, что применить её нельзя."""


class UndoConflict(MutationError):
    """Отменить просят не ту ревизию, что лежит наверху журнала.

    Клиент называет номер той ревизии, отмену которой он предлагает человеку:
    кнопка «Отменить» в тосте появляется после конкретного переноса и обещает
    вернуть именно его. Между показом кнопки и нажатием проходят секунды, и за
    эти секунды сосед по проекту успевает применить своё изменение — верх
    журнала уезжает, а безномерная отмена сняла бы чужую правку молча.

    Отдельный класс, потому что это не ошибка составления запроса: он верен, и
    повторённый после перечитывания состояния — пройдёт.
    """


class ReasonRequired(MutationError):
    """Правка уводит задачу от базового плана дальше порога, а причина не названа.

    Отдельный класс, потому что это не ошибка составления операции: операция
    верна, и стоит человеку объяснить сдвиг — та же самая операция пройдёт.
    Числа отклонения и порога несёт с собой: интерфейс считает их и сам, но
    последнее слово о них — за сервером, и расхождение должно быть видно, а не
    молча разрешаться в пользу клиента.
    """

    def __init__(self, deviation_days: int, threshold_days: int):
        super().__init__(
            "reason_required",
            f"отклонение {deviation_days} дн. при пороге {threshold_days} дн. требует причины",
        )
        self.deviation_days = deviation_days
        self.threshold_days = threshold_days


# --- внутреннее представление ------------------------------------------------
#
# Эти модели описывают операцию так, как её видит домен и как она лежит в
# журнале ревизий. У создающих операций есть поля восстановления — category_id,
# task_id, position, — потому что отмена удаления обязана вернуть строку под
# её прежним идентификатором и на прежнее место. По проводу такие поля
# принимать нельзя: они отдают клиенту назначение идентификаторов и позволяют
# положить строку на произвольный индекс. Публичный контракт — ниже,
# отдельными моделями; to_internal() переводит одно в другое.


class CreateCategory(BaseModel):
    type: Literal["create_category"] = "create_category"
    name: str
    color: str
    category_id: uuid.UUID | None = None
    position: int | None = None
    # Задачи, которые лежали в категории на момент её удаления. Поле
    # восстановления, зеркальное каскаду: delete_category уносит содержимое
    # категории вместе с ней, и обратная операция обязана вернуть не пустую
    # строку заголовка, а весь этап целиком — со связями, назначениями и
    # разговором каждой задачи (см. CreateTask ниже). По проводу, как и
    # остальные поля восстановления, не принимается: его нет в публичной
    # модели.
    tasks: list["CreateTask"] = Field(default_factory=list)


class CreateTask(BaseModel):
    type: Literal["create_task"] = "create_task"
    category_id: uuid.UUID
    name: str
    start_date: date
    duration_days: int
    description: str = ""
    internal_note: str = ""
    criticality: str = "normal"
    progress_pct: int = 0
    status: str = "planned"
    milestone: bool = False
    baseline_start: date | None = None
    baseline_duration: int | None = None
    task_id: uuid.UUID | None = None
    position: int | None = None
    # Поля восстановления удалённой задачи. Удаление уносит каскадом связи,
    # назначения и комментарии; без их снимка в inverse отмена возвращала бы
    # голую строку задачи, а разговор с клиентом и стрелки на диаграмме
    # пропадали бы безвозвратно. По проводу, как и остальные поля
    # восстановления, не принимаются — их нет в публичной модели.
    assignees: list[uuid.UUID] = Field(default_factory=list)
    dependencies: list[dict] = Field(default_factory=list)
    comments: list[dict] = Field(default_factory=list)


# CreateCategory ссылается на CreateTask раньше, чем тот объявлен: категория со
# своими задачами — это одна операция, и разорвать пару, переставив классы
# местами, нельзя (тогда на CreateCategory сослался бы CreateTask). Ссылка
# разрешается здесь, сразу после объявления второго из них.
CreateCategory.model_rebuild()


# --- поле восстановления автопереноса ------------------------------------------
#
# Операции, меняющие сроки, при включённом автопереносе двигают не только свою
# задачу, но и её последователей (см. app/cascade.py). Отмена обязана вернуть
# всех, а не одну, и вернуть точно — поэтому прямая операция записывает в
# журнал карту сдвинутых, а обратная получает её обратно этим полем и
# раскладывает даты дословно, ничего не пересчитывая.
#
# Тот же приём, что у SetProgress.status: связка отрабатывает в прямой
# операции, а обратная берёт готовое. Пересчитать автоперенос при отмене
# нельзя в принципе — «подвинуть на самое раннее» необратимо: перенос вперёд
# помнит, откуда пришёл, а вычисление этого не помнит.
#
# По проводу поле не принимается: клиент, приславший карту дат, разложил бы
# план в обход всякой проверки.

class MoveTask(BaseModel):
    type: Literal["move_task"] = "move_task"
    task_id: uuid.UUID
    start_date: date
    cascade: dict[uuid.UUID, date] | None = None


class SetDuration(BaseModel):
    type: Literal["set_duration"] = "set_duration"
    task_id: uuid.UUID
    duration_days: int
    cascade: dict[uuid.UUID, date] | None = None


class ResizeTask(BaseModel):
    """Старт и длительность разом — левая грань полоски.

    Отдельная операция, а не пара move_task + set_duration, по той же причине,
    по которой set_task_fields сохраняет три поля разом: левую грань тянут
    одним движением, конец задачи при этом стоит на месте, и в истории это
    обязано читаться как одно изменение. Пара операций дала бы две записи, две
    отмены и промежуточное состояние, которого человек не создавал, — задачу,
    уже сдвинутую, но ещё не укороченную.

    Правая грань этой операции не требует: там меняется одна длительность, и
    для неё уже есть set_duration.
    """

    type: Literal["resize_task"] = "resize_task"
    task_id: uuid.UUID
    start_date: date
    duration_days: int
    cascade: dict[uuid.UUID, date] | None = None


class SetMilestone(BaseModel):
    """Задача становится вехой или перестаёт ею быть.

    Отдельная операция, а не поле set_task_fields: превращение отрезка в точку
    схлопывает длительность, то есть меняет сроки, — и в истории это обязано
    читаться как изменение сроков, а не как правка текста.
    """

    type: Literal["set_milestone"] = "set_milestone"
    task_id: uuid.UUID
    milestone: bool
    # Поле восстановления — зеркально set_progress.status: веха схлопывает
    # длительность в один день, и отмена обязана вернуть ту, что стояла до
    # операции, а не выдуманную единицу. По проводу не принимается: длительность
    # с провода назначает set_duration.
    duration_days: int | None = None


class MoveCategory(BaseModel):
    """Сдвиг всей категории на N календарных дней.

    Одна операция, а не пачка move_task по числу задач, по той же причине, по
    которой set_task_fields сохраняет три поля разом: человек сделал одно
    движение — сводную полосу категории потащили вправо, — и история обязана
    показать одну запись, а отмена вернуть всё одним нажатием.

    Дни, а не целевая дата: у категории нет своих границ (сводная полоса
    рисуется по крайним датам её задач), и «перенести категорию на 3 марта»
    значило бы придумать ей начало, которого в модели нет.
    """

    type: Literal["move_category"] = "move_category"
    category_id: uuid.UUID
    days: int
    cascade: dict[uuid.UUID, date] | None = None


class DeleteTask(BaseModel):
    type: Literal["delete_task"] = "delete_task"
    task_id: uuid.UUID


class DeleteCategory(BaseModel):
    type: Literal["delete_category"] = "delete_category"
    category_id: uuid.UUID


class SetTaskFields(BaseModel):
    """Три текстовых поля разом.

    Карточка задачи сохраняет их одним действием; разбить это на три ревизии
    значило бы засорять историю тремя записями там, где человек сделал одно
    изменение.
    """

    type: Literal["set_task_fields"] = "set_task_fields"
    task_id: uuid.UUID
    name: str
    description: str
    internal_note: str


class SetCriticality(BaseModel):
    type: Literal["set_criticality"] = "set_criticality"
    task_id: uuid.UUID
    criticality: str


class SetRisk(BaseModel):
    """Флаг риска и причина одной операцией.

    Карточка меняет их одним жестом («есть риск — жду доступ»), и две записи
    в истории о нём — тот же довод, что у SetTaskFields. Обе границы в
    журнале словарём (см. _MAPPED_BOUNDS).
    """

    type: Literal["set_risk"] = "set_risk"
    task_id: uuid.UUID
    risk: str
    note: str = ""


# --- связка прогресса и статуса ----------------------------------------------
#
# Правило ровно из трёх пунктов, и только из них:
#   set_progress до 100        → статус становится 'done';
#   set_progress ниже 100 из
#   статуса 'done'             → статус становится 'in_progress';
#   set_status в 'done'        → прогресс становится 100.
# Уход из 'done' в другой статус прогресс не трогает, даже когда тот стоит на
# 100: выдуманное «почти готово» (99?) было бы значением, которого человек не
# вводил, а честного кандидата у системы нет.


class SetProgress(BaseModel):
    type: Literal["set_progress"] = "set_progress"
    task_id: uuid.UUID
    progress_pct: int
    # Поле восстановления: отмена обязана вернуть статус, который стоял до
    # операции, а не тот, который выведет связка (из 'blocked' связка не
    # угадала бы никогда). По проводу не принимается — статусом с провода
    # управляет set_status.
    status: str | None = None


class SetStatus(BaseModel):
    type: Literal["set_status"] = "set_status"
    task_id: uuid.UUID
    status: str
    # Поле восстановления — зеркально set_progress.status: отмена ухода в
    # 'done' обязана вернуть прежний прогресс, а не оставить 100.
    progress_pct: int | None = None


class RenameCategory(BaseModel):
    type: Literal["rename_category"] = "rename_category"
    category_id: uuid.UUID
    name: str


class SetCategoryColor(BaseModel):
    type: Literal["set_category_color"] = "set_category_color"
    category_id: uuid.UUID
    color: str


class ReorderTask(BaseModel):
    type: Literal["reorder_task"] = "reorder_task"
    task_id: uuid.UUID
    category_id: uuid.UUID
    position: int


class ReorderCategory(BaseModel):
    """Категория встаёт на другое место в списке этапов.

    Отдельная операция от reorder_task, а не общая «переставить строку»:
    у задачи место описывается парой (категория, номер) — её и переносят из
    одного этапа в другой, — а у категории родителя нет вовсе, и номер один.
    Общая операция несла бы у половины вызовов пустой category_id, то есть
    описывала бы не то, что произошло.
    """

    type: Literal["reorder_category"] = "reorder_category"
    category_id: uuid.UUID
    position: int


class AddDependency(BaseModel):
    type: Literal["add_dependency"] = "add_dependency"
    from_task_id: uuid.UUID
    to_task_id: uuid.UUID
    # Новая связь двигает последователя ровно так же, как перенос
    # предшественника: она и означает «эта работа ждёт ту».
    cascade: dict[uuid.UUID, date] | None = None


class RemoveDependency(BaseModel):
    type: Literal["remove_dependency"] = "remove_dependency"
    from_task_id: uuid.UUID
    to_task_id: uuid.UUID
    # Обратная к add_dependency: снятая связь возвращает последователей туда,
    # откуда их подвинуло её появление. Сама по себе снятая связь не двигает
    # ничего — автоперенос назад не тянет (см. app/cascade.py).
    cascade: dict[uuid.UUID, date] | None = None


class AssignUser(BaseModel):
    type: Literal["assign_user"] = "assign_user"
    task_id: uuid.UUID
    user_id: uuid.UUID


class UnassignUser(BaseModel):
    type: Literal["unassign_user"] = "unassign_user"
    task_id: uuid.UUID
    user_id: uuid.UUID


class ApplyPositions(BaseModel):
    """Внутренняя операция: расставить позиции по готовой карте.

    Существует только как обратная к reorder_task. По проводу не принимается —
    в публичном реестре её нет: иначе клиент прислал бы произвольную карту и
    расставил строки в обход всякой проверки порядка.
    """

    type: Literal["apply_positions"] = "apply_positions"
    positions: dict[uuid.UUID, int]
    categories: dict[uuid.UUID, uuid.UUID]


class ApplyCategoryPositions(BaseModel):
    """Внутренняя операция: расставить порядок категорий по готовой карте.

    Существует только как обратная к reorder_category — по той же причине, по
    которой существует apply_positions, и с тем же запретом на провод: карта,
    присланная клиентом, расставила бы этапы в обход всякой проверки порядка.
    """

    type: Literal["apply_category_positions"] = "apply_category_positions"
    positions: dict[uuid.UUID, int]


Op = Annotated[
    CreateCategory
    | CreateTask
    | MoveTask
    | MoveCategory
    | ResizeTask
    | SetDuration
    | SetMilestone
    | DeleteTask
    | DeleteCategory
    | SetTaskFields
    | SetCriticality
    | SetRisk
    | SetProgress
    | SetStatus
    | RenameCategory
    | SetCategoryColor
    | ReorderTask
    | ReorderCategory
    | ApplyPositions
    | ApplyCategoryPositions
    | AddDependency
    | RemoveDependency
    | AssignUser
    | UnassignUser,
    Field(discriminator="type"),
]

_MODELS = {
    "create_category": CreateCategory,
    "create_task": CreateTask,
    "move_task": MoveTask,
    "move_category": MoveCategory,
    "resize_task": ResizeTask,
    "set_duration": SetDuration,
    "set_milestone": SetMilestone,
    "delete_task": DeleteTask,
    "delete_category": DeleteCategory,
    "set_task_fields": SetTaskFields,
    "set_criticality": SetCriticality,
    "set_risk": SetRisk,
    "set_progress": SetProgress,
    "set_status": SetStatus,
    "rename_category": RenameCategory,
    "set_category_color": SetCategoryColor,
    "reorder_task": ReorderTask,
    "reorder_category": ReorderCategory,
    "apply_positions": ApplyPositions,
    "apply_category_positions": ApplyCategoryPositions,
    "add_dependency": AddDependency,
    "remove_dependency": RemoveDependency,
    "assign_user": AssignUser,
    "unassign_user": UnassignUser,
}


# --- контракт по проводу -----------------------------------------------------
#
# Границы длин повторяют ширину колонок: без них строка длиннее varchar
# приезжает в базу и возвращается пятисоткой на ошибке усечения, а не честным
# отказом клиенту. extra="forbid" выбран сознательно вместо тихого
# игнорирования: клиент, приславший task_id в расчёте, что сервер его учтёт,
# должен узнать об этом сразу, а не гадать потом, почему строка оказалась не
# там.
#
# Позиция задачи — исключение, и осознанное: место строки в списке выбирает
# человек, а не сервер. Он и так выбирает его перетаскиванием (reorder_task
# принимает позицию по проводу с самого начала), а «плюс» на границе строк
# заводит задачу сразу там, куда указали. Без этого поля вставка посередине
# была бы парой операций — создать в конце и переставить, — то есть двумя
# записями в истории и двумя нажатиями «Отменить» на одно действие человека.
# Назначение идентификаторов за сервером остаётся: task_id по проводу
# по-прежнему не принимается.

#: Дальний край дат, которые принимает провод. Не date.max: календарь ищет
#: рабочие дни на годы вперёд от старта (перенос конца за праздники), и дата
#: у самого края опрокидывала бы арифметику дат за пределы поддерживаемого.
#: 2200 год — заведомо дальше любого реального плана и заведомо ближе края.
MAX_WIRE_DATE = date(2200, 12, 31)


class _Wire(BaseModel):
    model_config = ConfigDict(extra="forbid", use_enum_values=True)

    @field_validator("description", "internal_note", mode="after", check_fields=False)
    @classmethod
    def _within_max_text_len(cls, value: str) -> str:
        # Потолок читается в момент вызова, а не запекается в Field при
        # импорте модуля: MAX_TEXT_LEN — настройка установки, и заданное в
        # .env значение обязано действовать, а не значение, случившееся при
        # первом импорте (в тестах это ещё и делало monkeypatch бессильным).
        limit = get_settings().max_text_len
        if len(value) > limit:
            raise ValueError(f"длиннее потолка в {limit} символов")
        return value


class PublicCreateCategory(_Wire):
    type: Literal["create_category"] = "create_category"
    name: str = Field(min_length=1, max_length=200)
    color: str = Field(min_length=1, max_length=9)


class PublicCreateTask(_Wire):
    type: Literal["create_task"] = "create_task"
    category_id: uuid.UUID
    name: str = Field(min_length=1, max_length=300)
    start_date: date = Field(le=MAX_WIRE_DATE)
    duration_days: int = Field(ge=1)
    #: Место строки в списке категории. Не прислана — задача встаёт в конец,
    #: как и раньше; названная — на этот номер, а занявшие его строки едут
    #: вниз (см. _create_task).
    position: int | None = Field(default=None, ge=0)
    description: str = ""
    internal_note: str = ""
    criticality: Criticality = Criticality.NORMAL
    progress_pct: int = Field(default=0, ge=0, le=100)
    status: TaskStatus = TaskStatus.PLANNED
    milestone: bool = False
    baseline_start: date | None = Field(default=None, le=MAX_WIRE_DATE)
    baseline_duration: int | None = Field(default=None, ge=1)


class PublicMoveTask(_Wire):
    type: Literal["move_task"] = "move_task"
    task_id: uuid.UUID
    start_date: date = Field(le=MAX_WIRE_DATE)


#: Дальний край сдвига категории. Десять лет в обе стороны — заведомо больше
#: любого настоящего переноса и заведомо меньше того, чем можно опрокинуть
#: арифметику дат. Настоящую границу всё равно держит MAX_WIRE_DATE: сдвиг,
#: уводящий задачу за неё, отбивается при применении.
MAX_WIRE_SHIFT_DAYS = 3650


class PublicMoveCategory(_Wire):
    type: Literal["move_category"] = "move_category"
    category_id: uuid.UUID
    days: int = Field(ge=-MAX_WIRE_SHIFT_DAYS, le=MAX_WIRE_SHIFT_DAYS)


class PublicResizeTask(_Wire):
    type: Literal["resize_task"] = "resize_task"
    task_id: uuid.UUID
    start_date: date = Field(le=MAX_WIRE_DATE)
    duration_days: int = Field(ge=1)


class PublicSetDuration(_Wire):
    type: Literal["set_duration"] = "set_duration"
    task_id: uuid.UUID
    duration_days: int = Field(ge=1)


class PublicSetMilestone(_Wire):
    type: Literal["set_milestone"] = "set_milestone"
    task_id: uuid.UUID
    milestone: bool


class PublicDeleteTask(_Wire):
    type: Literal["delete_task"] = "delete_task"
    task_id: uuid.UUID


class PublicDeleteCategory(_Wire):
    type: Literal["delete_category"] = "delete_category"
    category_id: uuid.UUID


class PublicSetTaskFields(_Wire):
    type: Literal["set_task_fields"] = "set_task_fields"
    task_id: uuid.UUID
    name: str = Field(min_length=1, max_length=300)
    description: str = ""
    internal_note: str = ""


class PublicSetCriticality(_Wire):
    type: Literal["set_criticality"] = "set_criticality"
    task_id: uuid.UUID
    criticality: Criticality


class PublicSetRisk(_Wire):
    type: Literal["set_risk"] = "set_risk"
    task_id: uuid.UUID
    risk: RiskFlag
    note: str = Field(default="", max_length=300)


class PublicSetProgress(_Wire):
    type: Literal["set_progress"] = "set_progress"
    task_id: uuid.UUID
    progress_pct: int = Field(ge=0, le=100)


class PublicSetStatus(_Wire):
    type: Literal["set_status"] = "set_status"
    task_id: uuid.UUID
    status: TaskStatus


class PublicRenameCategory(_Wire):
    type: Literal["rename_category"] = "rename_category"
    category_id: uuid.UUID
    name: str = Field(min_length=1, max_length=200)


class PublicSetCategoryColor(_Wire):
    type: Literal["set_category_color"] = "set_category_color"
    category_id: uuid.UUID
    color: str = Field(min_length=1, max_length=9)


class PublicReorderTask(_Wire):
    type: Literal["reorder_task"] = "reorder_task"
    task_id: uuid.UUID
    category_id: uuid.UUID
    position: int = Field(ge=0)


class PublicReorderCategory(_Wire):
    type: Literal["reorder_category"] = "reorder_category"
    category_id: uuid.UUID
    position: int = Field(ge=0)


class PublicAddDependency(_Wire):
    type: Literal["add_dependency"] = "add_dependency"
    from_task_id: uuid.UUID
    to_task_id: uuid.UUID


class PublicRemoveDependency(_Wire):
    type: Literal["remove_dependency"] = "remove_dependency"
    from_task_id: uuid.UUID
    to_task_id: uuid.UUID


class PublicAssignUser(_Wire):
    type: Literal["assign_user"] = "assign_user"
    task_id: uuid.UUID
    user_id: uuid.UUID


class PublicUnassignUser(_Wire):
    type: Literal["unassign_user"] = "unassign_user"
    task_id: uuid.UUID
    user_id: uuid.UUID


# ApplyPositions и ApplyCategoryPositions публичного зеркала не имеют и иметь
# не должны: обе внутренние.


PublicOp = Annotated[
    PublicCreateCategory
    | PublicCreateTask
    | PublicMoveTask
    | PublicMoveCategory
    | PublicResizeTask
    | PublicSetDuration
    | PublicSetMilestone
    | PublicDeleteTask
    | PublicDeleteCategory
    | PublicSetTaskFields
    | PublicSetCriticality
    | PublicSetRisk
    | PublicSetProgress
    | PublicSetStatus
    | PublicRenameCategory
    | PublicSetCategoryColor
    | PublicReorderTask
    | PublicReorderCategory
    | PublicAddDependency
    | PublicRemoveDependency
    | PublicAssignUser
    | PublicUnassignUser,
    Field(discriminator="type"),
]


def to_internal(op) -> Op:
    """Операция с провода → внутреннее представление.

    Поля восстановления не переносятся просто потому, что их нет в публичной
    модели: назначение идентификаторов и позиций остаётся за сервером.
    """
    return _MODELS[op.type].model_validate(op.model_dump())


def _next_seq(db: DbSession, project: Project) -> int:
    current = db.scalar(
        select(func.coalesce(func.max(Revision.seq), 0)).where(Revision.project_id == project.id)
    )
    return current + 1


def _require_task(db: DbSession, project: Project, task_id: uuid.UUID) -> Task:
    task = db.get(Task, task_id)
    if task is None or task.project_id != project.id:
        raise NotFoundInProject("task_not_found", "задача не найдена в этом проекте")
    return task


def _require_category(db: DbSession, project: Project, category_id: uuid.UUID) -> Category:
    category = db.get(Category, category_id)
    if category is None or category.project_id != project.id:
        raise NotFoundInProject("category_not_found", "категория не найдена в этом проекте")
    return category


def _make_room(db: DbSession, category_id: uuid.UUID, position: int) -> None:
    """Освобождает названный слот в категории, сдвигая занявшие его строки вниз.

    Нужно двум путям сразу. Первый — вставка строки посередине: «плюс» на
    границе строк заводит задачу там, куда указали, а сосед, стоявший на этом
    номере, вместе со всеми, кто ниже, съезжает на единицу. Второй — отмена
    удаления: задача возвращается на свой прежний номер, а он с тех пор мог
    достаться другой строке (перестановка перенумеровывает список подряд и
    закрывает дыру от удалённой). Без этого сдвига отмена падала бы нарушением
    уникальности (category_id, position) — то есть пятисоткой вместо возврата
    задачи.

    Свободный слот не трогается вовсе: сдвигать соседей ради номера, который и
    так ничей, значило бы менять порядок там, где его никто не менял.

    Сдвиг на единицу порядок сохраняет и уникальности не нарушает: отображение
    монотонное, а промежуточные состояния держит отложенная проверка
    ограничения (DEFERRABLE INITIALLY DEFERRED, см. models.Task).
    """
    occupied = db.scalar(
        select(func.count())
        .select_from(Task)
        .where(Task.category_id == category_id, Task.position == position)
    )
    if not occupied:
        return
    # Строки грузятся объектами, а не сдвигаются одним UPDATE: те же задачи уже
    # могут лежать в сессии, и массовое обновление мимо ORM оставило бы их с
    # прежними номерами до конца запроса.
    for row in db.scalars(
        select(Task).where(Task.category_id == category_id, Task.position >= position)
    ).all():
        row.position += 1
    db.flush()


def _find_dependency(
    db: DbSession, project: Project, from_task_id: uuid.UUID, to_task_id: uuid.UUID
) -> Dependency | None:
    """Связь по обоим концам, ограниченная этим проектом.

    project_id в условии избыточен, пока обе задачи уже проверены
    _require_task, — но он же делает запрос верным сам по себе, без опоры на
    то, что вызывающий не забыл проверку.
    """
    return db.scalar(
        select(Dependency).where(
            Dependency.project_id == project.id,
            Dependency.from_task_id == from_task_id,
            Dependency.to_task_id == to_task_id,
        )
    )


def _find_assignment(
    db: DbSession, task_id: uuid.UUID, user_id: uuid.UUID
) -> TaskAssignee | None:
    return db.scalar(
        select(TaskAssignee).where(
            TaskAssignee.task_id == task_id, TaskAssignee.user_id == user_id
        )
    )


# Поля, которые карточка задачи сохраняет одним действием.
_TASK_FIELDS = ("name", "description", "internal_note")


def _snapshot_task_links(db: DbSession, task: Task) -> dict:
    """Связи, назначения и комментарии задачи — в форме для журнала.

    Снимается перед удалением: каскад унесёт эти строки вместе с задачей, и
    другого источника для их восстановления не существует — журнал ревизий
    хранит операции над задачами, а не над их окружением.
    """
    assignees = [
        str(row.user_id)
        for row in db.scalars(
            select(TaskAssignee).where(TaskAssignee.task_id == task.id).order_by(TaskAssignee.id)
        )
    ]
    dependencies = [
        {"from_task_id": str(row.from_task_id), "to_task_id": str(row.to_task_id)}
        for row in db.scalars(
            select(Dependency)
            .where((Dependency.from_task_id == task.id) | (Dependency.to_task_id == task.id))
            .order_by(Dependency.id)
        )
    ]
    comments = [
        {
            "id": str(row.id),
            "author_user_id": str(row.author_user_id) if row.author_user_id else None,
            "guest_name": row.guest_name,
            "body": row.body,
            "created_at": row.created_at.isoformat(),
        }
        for row in db.scalars(
            select(Comment).where(Comment.task_id == task.id).order_by(Comment.created_at)
        )
    ]
    snapshot = {}
    if assignees:
        snapshot["assignees"] = assignees
    if dependencies:
        snapshot["dependencies"] = dependencies
    if comments:
        snapshot["comments"] = comments
    return snapshot


def _stamp_status_change(task: Task, previous_status: str) -> None:
    """Метки времени статуса: done_at и in_progress_since.

    Ставятся на входе в статус, чистятся на выходе — колонка хранит последнюю
    границу, а не историю (летопись переходов остаётся за журналом ревизий).
    Здесь, а не в ветках set_status/set_progress по отдельности: статус меняют
    две операции плюс создание задачи, и три копии этого правила разошлись бы
    первой же правкой. Отмена проходит тем же путём и ставит текущее время,
    а не прежнее, — «когда задача снова стала сделанной» и есть ответ на
    вопрос, который эти метки обслуживают (см. app.scorecard).
    """
    if task.status == previous_status:
        return
    now = datetime.now(timezone.utc)
    if task.status == TaskStatus.DONE:
        task.done_at = now
    elif previous_status == TaskStatus.DONE:
        task.done_at = None
    if task.status == TaskStatus.IN_PROGRESS:
        task.in_progress_since = now
    elif previous_status == TaskStatus.IN_PROGRESS:
        task.in_progress_since = None


def _add_task(db: DbSession, project: Project, op: CreateTask) -> Task:
    """Строка задачи — со всеми проверками и выбором места в списке.

    Отдельно от ветки `create_task` в `_apply`, потому что задачу создают
    двое: сама операция и восстановление категории вместе с её содержимым
    (см. CreateCategory.tasks). Второй набор этих проверок разошёлся бы с
    первым на первой же правке — и разошёлся бы молча, ведь ошибиться здесь
    можно только в пользу базы: строку, которую отвергнет CHECK, вернёт
    пятисотка вместо честного кода отказа.

    Окружение задачи — связи, назначения, разговор — здесь не восстанавливается:
    у категории это делается отдельным проходом, когда созданы уже все её
    строки (см. _restore_task_links).
    """
    if op.duration_days < 1:
        raise InvalidOperation("duration_too_short", "длительность должна быть не меньше одного дня")
    # Та же проверка, что у set_criticality/set_progress: внутренняя
    # модель приходит не только с провода (где границы держит публичная),
    # но и из журнала — и не должна уметь положить строку, которую CHECK
    # в базе всё равно отвергнет пятисоткой.
    if op.criticality not in CRITICALITY_LEVELS:
        raise InvalidOperation("unknown_criticality", f"неизвестный уровень: {op.criticality}")
    if not 0 <= op.progress_pct <= 100:
        raise InvalidOperation(
            "progress_out_of_range", f"процент вне 0..100: {op.progress_pct}"
        )
    if op.status not in TASK_STATUSES:
        raise InvalidOperation("unknown_status", f"неизвестный статус: {op.status}")
    if op.milestone and op.duration_days != 1:
        # То же ограничение, что держит база: веха — точка на шкале.
        # Проверка здесь, а не только в CHECK, чтобы отказ был честным
        # кодом операции, а не пятисоткой на нарушении ограничения.
        raise InvalidOperation(
            "milestone_has_duration", "у вехи длительность ровно один день"
        )
    # Внешний ключ гарантирует лишь, что категория где-то существует —
    # не то, что она принадлежит этому проекту. Без явной проверки задача
    # может незаметно оказаться под категорией чужого проекта.
    _require_category(db, project, op.category_id)
    # Потолок из настроек (MAX_TASKS_PER_PROJECT): проверяется здесь, а не
    # в маршруте, потому что это правило домена, а не формы запроса.
    limit = get_settings().max_tasks_per_project
    existing = db.scalar(
        select(func.count()).select_from(Task).where(Task.project_id == project.id)
    )
    if existing >= limit:
        raise InvalidOperation(
            "task_limit_reached", f"в проекте уже {existing} задач при потолке {limit}"
        )
    # Тот же принцип, что и для категорий: наибольшая занятая позиция + 1,
    # а не COUNT(*) — иначе номер, освободившийся после удаления,
    # достаётся следующей же созданной задаче ещё раз. Считается внутри
    # категории: позиция и есть номер строки в её списке — раньше номер
    # брался по всему проекту, и у категорий были дырявые, зависящие от
    # порядка создания нумерации, которые уникальным ограничением
    # (category_id, position) не удержать.
    if op.position is None:
        position = db.scalar(
            select(func.coalesce(func.max(Task.position), -1) + 1).where(
                Task.category_id == op.category_id
            )
        )
    else:
        position = op.position
        _make_room(db, op.category_id, position)
    task = Task(
        id=op.task_id or uuid.uuid4(),
        project_id=project.id,
        category_id=op.category_id,
        name=op.name,
        description=op.description,
        internal_note=op.internal_note,
        start_date=op.start_date,
        duration_days=op.duration_days,
        criticality=op.criticality,
        progress_pct=op.progress_pct,
        status=op.status,
        milestone=op.milestone,
        position=position,
        baseline_start=op.baseline_start,
        baseline_duration=op.baseline_duration,
    )
    # Задача, рождённая сразу в done или in_progress (перенос из сметы,
    # восстановление из журнала), получает метку входа в статус здесь: другого
    # перехода у неё не будет.
    _stamp_status_change(task, TaskStatus.PLANNED.value)
    db.add(task)
    db.flush()
    return task


def _task_payload(task: Task) -> dict:
    """Задача в том виде, в каком она ложится в журнал, — полями create_task.

    Одна форма на три места: запись о создании, снимок для отмены удаления и
    снимок задачи внутри удалённой категории. Три списка одних и тех же полей
    разошлись бы на первом же добавленном — и отмена возвращала бы задачу без
    него.
    """
    return {
        "type": "create_task",
        "task_id": str(task.id),
        "category_id": str(task.category_id),
        "name": task.name,
        "start_date": task.start_date.isoformat(),
        "duration_days": task.duration_days,
        "description": task.description,
        "internal_note": task.internal_note,
        "criticality": task.criticality,
        "progress_pct": task.progress_pct,
        "status": task.status,
        "milestone": task.milestone,
        "position": task.position,
        "baseline_start": task.baseline_start.isoformat() if task.baseline_start else None,
        "baseline_duration": task.baseline_duration,
    }


def _task_snapshot(db: DbSession, task: Task) -> dict:
    """Задача целиком — со связями, назначениями и разговором.

    Снимается перед удалением: каскад уносит окружение вместе со строкой, и
    отмена без него вернула бы голое имя.
    """
    return _task_payload(task) | _snapshot_task_links(db, task)


def _restore_task_links(db: DbSession, project: Project, task: Task, op: CreateTask) -> None:
    """Возвращает восстановленной задаче то, что унёс каскад удаления.

    Мир с момента удаления мог уйти вперёд, поэтому каждая строка
    восстанавливается по возможности, а не по требованию: связь со второй
    задачей, которой больше нет, назначение на пользователя, чей аккаунт
    удалён, — молча пропускаются. Пропуск — это ровно то, что каскад сделал бы
    с такой строкой сам; отказ всей отмены из-за неё оставил бы человека
    вовсе без задачи.
    """
    if op.assignees:
        existing_users = set(db.scalars(select(User.id).where(User.id.in_(op.assignees))))
        for user_id in op.assignees:
            if user_id in existing_users and _find_assignment(db, task.id, user_id) is None:
                db.add(TaskAssignee(task_id=task.id, user_id=user_id))

    for link in op.dependencies:
        from_id = uuid.UUID(link["from_task_id"])
        to_id = uuid.UUID(link["to_task_id"])
        other_id = to_id if from_id == task.id else from_id
        other = db.get(Task, other_id)
        if other is None or other.project_id != project.id:
            continue
        if _find_dependency(db, project, from_id, to_id) is None:
            db.add(Dependency(project_id=project.id, from_task_id=from_id, to_task_id=to_id))

    for row in op.comments:
        author_id = uuid.UUID(row["author_user_id"]) if row.get("author_user_id") else None
        if author_id is not None and db.get(User, author_id) is None:
            # Ограничение «ровно один автор» не даст переподписать реплику
            # гостевым именем, а реплика без автора запрещена — пропуск.
            continue
        db.add(
            Comment(
                id=uuid.UUID(row["id"]),
                project_id=project.id,
                task_id=task.id,
                author_user_id=author_id,
                guest_name=row.get("guest_name"),
                body=row["body"],
                created_at=datetime.fromisoformat(row["created_at"]),
            )
        )

    db.flush()


def _cascade(
    db: DbSession,
    project: Project,
    seeds: set[uuid.UUID],
    given: dict[uuid.UUID, date] | None,
) -> tuple[dict, dict]:
    """Автоперенос по связям — и две карты дат для журнала.

    Возвращает пару «в прямую операцию, в обратную»: куда последователи встали
    и откуда пришли. Обе уже приведены к виду, в каком лежат в журнале, —
    строки, а не объекты.

    `given` — карта из журнала: значит, идёт отмена, и раскладывать даты надо
    дословно. Пересчитывать автоперенос здесь нельзя в принципе: «подвинуть на
    самое раннее» необратимо — перенос вперёд помнит, откуда пришёл, а
    вычисление этого не помнит.
    """
    if given is not None:
        was = apply_dates(db, project, given)
        return _dates_out(given), _dates_out(was)

    if not project.auto_schedule:
        return {}, {}

    org = db.get(Organization, project.org_id)
    cal = project_calendar(project, org)
    was = push_successors(db, project, cal, seeds)
    # Прямая операция несёт новые даты, обратная — прежние. Новые берутся у
    # самих задач, а не пересчитываются вторым проходом: их только что и
    # расставил перенос.
    moved = {
        task.id: task.start_date
        for task in db.scalars(select(Task).where(Task.id.in_(was))).all()
    } if was else {}
    return _dates_out(moved), _dates_out(was)


def _dates_out(dates: dict[uuid.UUID, date]) -> dict[str, str]:
    """Карта дат в том виде, в каком она лежит в журнале."""
    return {str(task_id): moment.isoformat() for task_id, moment in dates.items()}


def _with_cascade(payload: dict, cascade: dict) -> dict:
    """Карта сдвинутых — в запись журнала, и только если кого-то сдвинуло.

    Пустое поле не пишется: запись `"cascade": {}` у каждой второй операции
    засоряла бы журнал следом того, чего не происходило.
    """
    return payload | {"cascade": cascade} if cascade else payload


def _swap(payload: dict) -> dict:
    """Обратная операция отличается от прямой только местами from и to.

    Один помощник вместо ветки инверсии в каждой операции: пара границ —
    это уже полное описание и прямого действия, и обратного.
    """
    return {**payload, "from": payload["to"], "to": payload["from"]}


def _apply(db: DbSession, project: Project, op) -> tuple[dict, dict]:
    """Применяет операцию и возвращает пару (что записать в op, что записать в inverse)."""

    if isinstance(op, CreateCategory):
        # max(position) + 1, а не COUNT(*): удаление пробивает дыру в
        # нумерации, и COUNT(*) после удаления вновь выдаёт уже занятый
        # номер. coalesce(..., -1) даёт 0 для пустой коллекции без отдельной
        # ветки.
        position = (
            op.position
            if op.position is not None
            else db.scalar(
                select(func.coalesce(func.max(Category.position), -1) + 1).where(
                    Category.project_id == project.id
                )
            )
        )
        category = Category(
            id=op.category_id or uuid.uuid4(),
            project_id=project.id,
            name=op.name,
            color=op.color,
            position=position,
        )
        db.add(category)
        db.flush()
        forward = {
            "type": "create_category", "category_id": str(category.id), "name": op.name,
            "color": op.color, "position": category.position,
        }
        # Задачи из снимка (отмена каскадного удаления) создаются все до
        # единой, и только потом каждой возвращается её окружение: задачи
        # одной категории ссылаются друг на друга, и связь к соседу, которого
        # ещё не создали, была бы молча пропущена — см. _restore_task_links.
        if op.tasks:
            restored = [_add_task(db, project, task_op) for task_op in op.tasks]
            for task, task_op in zip(restored, op.tasks):
                _restore_task_links(db, project, task, task_op)
            forward["tasks"] = [_task_payload(task) for task in restored]
        return (forward, {"type": "delete_category", "category_id": str(category.id)})

    if isinstance(op, CreateTask):
        task = _add_task(db, project, op)
        _restore_task_links(db, project, task, op)
        return (_task_payload(task), {"type": "delete_task", "task_id": str(task.id)})

    if isinstance(op, MoveTask):
        task = _require_task(db, project, op.task_id)
        previous = task.start_date
        task.start_date = op.start_date
        db.flush()
        moved, back = _cascade(db, project, {task.id}, op.cascade)
        return (
            _with_cascade(
                {"type": "move_task", "task_id": str(task.id), "from": previous.isoformat(),
                 "to": op.start_date.isoformat()},
                moved,
            ),
            _with_cascade(
                {"type": "move_task", "task_id": str(task.id), "from": op.start_date.isoformat(),
                 "to": previous.isoformat()},
                back,
            ),
        )

    if isinstance(op, ResizeTask):
        if op.duration_days < 1:
            raise InvalidOperation("duration_too_short", "длительность должна быть не меньше одного дня")
        task = _require_task(db, project, op.task_id)
        if task.milestone:
            # У вехи нет граней, которые можно тянуть: она точка. Причина та
            # же, что у set_duration, — признак ставил человек, и снимать его
            # тоже ему.
            raise InvalidOperation(
                "task_is_milestone", "у вехи длительность не меняется: сначала снимите признак"
            )
        # Обе границы — парой словарей, как у set_task_fields: операция меняет
        # два поля разом, и читаться она обязана как одно изменение.
        forward = {
            "type": "resize_task",
            "task_id": str(task.id),
            "from": {
                "start_date": task.start_date.isoformat(),
                "duration_days": task.duration_days,
            },
            "to": {
                "start_date": op.start_date.isoformat(),
                "duration_days": op.duration_days,
            },
        }
        task.start_date = op.start_date
        task.duration_days = op.duration_days
        db.flush()
        moved, back = _cascade(db, project, {task.id}, op.cascade)
        return _with_cascade(forward, moved), _with_cascade(_swap(forward), back)

    if isinstance(op, MoveCategory):
        if op.days == 0:
            # Ноль дней — не изменение, а запись в истории обещала бы, что
            # что-то произошло. У move_task такого отбоя нет намеренно: там
            # ноль означает «вернули на прежнюю дату», и это всё-таки жест по
            # одной задаче. Здесь же нулём сдвигается вся категория — то есть
            # не сдвигается ничего.
            raise InvalidOperation("empty_shift", "сдвиг на ноль дней ничего не меняет")
        category = _require_category(db, project, op.category_id)
        tasks = db.scalars(
            select(Task).where(Task.category_id == category.id).order_by(Task.position, Task.id)
        ).all()
        if not tasks:
            raise InvalidOperation("category_empty", "в категории нет задач: двигать нечего")
        shift = timedelta(days=op.days)
        for task in tasks:
            moved = task.start_date + shift
            if moved > MAX_WIRE_DATE or moved < date.min + timedelta(days=1):
                # Тот же дальний край, что и у дат с провода: сдвиг не должен
                # уметь положить в базу дату, которую провод не принял бы.
                raise InvalidOperation(
                    "date_out_of_range", f"сдвиг уводит «{task.name}» за границу дат"
                )
            task.start_date = moved
        db.flush()
        # Последователи вне категории — тоже последователи: этап уехал, и
        # работа, ждущая его задач, обязана уехать с ним. Задачи самой
        # категории при этом уже подвинуты, и автоперенос их не трогает — они
        # и есть исходные точки обхода.
        pushed, back = _cascade(db, project, {task.id for task in tasks}, op.cascade)
        return (
            _with_cascade(
                {
                    "type": "move_category",
                    "category_id": str(category.id),
                    "days": op.days,
                    # Задачи названы поимённо, а не только числом дней: история
                    # обязана показать, что именно уехало, а карточка отмены —
                    # сказать, сколько строк вернётся.
                    "task_ids": [str(task.id) for task in tasks],
                },
                pushed,
            ),
            _with_cascade(
                {
                    "type": "move_category",
                    "category_id": str(category.id),
                    "days": -op.days,
                    "task_ids": [str(task.id) for task in tasks],
                },
                back,
            ),
        )

    if isinstance(op, SetMilestone):
        task = _require_task(db, project, op.task_id)
        previous_duration = task.duration_days
        forward = {
            "type": "set_milestone",
            "task_id": str(task.id),
            "from": task.milestone,
            "to": op.milestone,
        }
        inverse = _swap(forward)
        task.milestone = op.milestone
        if op.duration_days is not None:
            # Поле восстановления: журнал диктует точную длительность, и
            # схлопывание не пересчитывается — оно уже отработало в прямой
            # операции.
            task.duration_days = op.duration_days
        elif op.milestone:
            # Веха — точка на шкале: длительность схлопывается в день. Это и
            # есть то, что отмена обязана уметь вернуть, поэтому обе границы
            # уходят в журнал ниже.
            task.duration_days = 1
        db.flush()
        if task.duration_days != previous_duration:
            forward |= {"duration_from": previous_duration, "duration_to": task.duration_days}
            inverse |= {"duration_from": task.duration_days, "duration_to": previous_duration}
        return forward, inverse

    if isinstance(op, SetDuration):
        if op.duration_days < 1:
            raise InvalidOperation("duration_too_short", "длительность должна быть не меньше одного дня")
        task = _require_task(db, project, op.task_id)
        if task.milestone and op.duration_days != 1:
            # Веха длительности не имеет. Молча превратить её обратно в отрезок
            # эта операция не вправе: признак вехи ставил человек, и снимать
            # его — тоже его решение (set_milestone).
            raise InvalidOperation(
                "task_is_milestone", "у вехи длительность не меняется: сначала снимите признак"
            )
        previous = task.duration_days
        task.duration_days = op.duration_days
        db.flush()
        moved, back = _cascade(db, project, {task.id}, op.cascade)
        return (
            _with_cascade(
                {"type": "set_duration", "task_id": str(task.id), "from": previous,
                 "to": op.duration_days},
                moved,
            ),
            _with_cascade(
                {"type": "set_duration", "task_id": str(task.id), "from": op.duration_days,
                 "to": previous},
                back,
            ),
        )

    if isinstance(op, SetTaskFields):
        task = _require_task(db, project, op.task_id)
        before = {field: getattr(task, field) for field in _TASK_FIELDS}
        after = {
            "name": op.name,
            "description": op.description,
            "internal_note": op.internal_note,
        }
        for field, value in after.items():
            setattr(task, field, value)
        db.flush()
        forward = {
            "type": "set_task_fields",
            "task_id": str(task.id),
            "from": before,
            "to": after,
        }
        return forward, _swap(forward)

    if isinstance(op, SetCriticality):
        if op.criticality not in CRITICALITY_LEVELS:
            raise InvalidOperation(
                "unknown_criticality", f"неизвестный уровень: {op.criticality}"
            )
        task = _require_task(db, project, op.task_id)
        forward = {
            "type": "set_criticality",
            "task_id": str(task.id),
            "from": task.criticality,
            "to": op.criticality,
        }
        task.criticality = op.criticality
        db.flush()
        return forward, _swap(forward)

    if isinstance(op, SetRisk):
        if op.risk not in RISK_FLAGS:
            raise InvalidOperation("unknown_risk", f"неизвестный флаг риска: {op.risk}")
        task = _require_task(db, project, op.task_id)
        forward = {
            "type": "set_risk",
            "task_id": str(task.id),
            "from": {"risk": task.risk, "note": task.risk_note},
            "to": {"risk": op.risk, "note": op.note},
        }
        task.risk = op.risk
        task.risk_note = op.note
        db.flush()
        return forward, _swap(forward)

    if isinstance(op, SetProgress):
        if not 0 <= op.progress_pct <= 100:
            raise InvalidOperation(
                "progress_out_of_range", f"процент вне 0..100: {op.progress_pct}"
            )
        if op.status is not None and op.status not in TASK_STATUSES:
            raise InvalidOperation("unknown_status", f"неизвестный статус: {op.status}")
        task = _require_task(db, project, op.task_id)
        previous_status = task.status
        forward = {
            "type": "set_progress",
            "task_id": str(task.id),
            "from": task.progress_pct,
            "to": op.progress_pct,
        }
        inverse = _swap(forward)
        if op.status is not None:
            # Поле восстановления: статус ложится как продиктовано журналом,
            # связка не пересчитывается — она уже отработала в прямой операции.
            task.status = op.status
        elif op.progress_pct >= 100:
            # Связка (см. комментарий у модели): дотянутый до конца прогресс —
            # это и есть «сделано».
            task.status = TaskStatus.DONE.value
        elif task.status == TaskStatus.DONE:
            # Прогресс отступил от 100 у сделанной задачи — она снова в работе.
            # Прочие статусы ('planned', 'blocked') не трогаются: движение
            # прогресса о них ничего не говорит.
            task.status = TaskStatus.IN_PROGRESS.value
        task.progress_pct = op.progress_pct
        _stamp_status_change(task, previous_status)
        db.flush()
        if task.status != previous_status:
            # Обе границы статуса — в журнал: отмена обязана вернуть прежний
            # статус дословно, а не выводить его связкой заново (из 'blocked'
            # связка не угадала бы никогда).
            forward |= {"status_from": previous_status, "status_to": task.status}
            inverse |= {"status_from": task.status, "status_to": previous_status}
        return forward, inverse

    if isinstance(op, SetStatus):
        if op.status not in TASK_STATUSES:
            raise InvalidOperation("unknown_status", f"неизвестный статус: {op.status}")
        if op.progress_pct is not None and not 0 <= op.progress_pct <= 100:
            raise InvalidOperation(
                "progress_out_of_range", f"процент вне 0..100: {op.progress_pct}"
            )
        task = _require_task(db, project, op.task_id)
        previous_progress = task.progress_pct
        forward = {
            "type": "set_status",
            "task_id": str(task.id),
            "from": task.status,
            "to": op.status,
        }
        inverse = _swap(forward)
        previous_status = task.status
        task.status = op.status
        if op.progress_pct is not None:
            # Поле восстановления — как status у set_progress: журнал диктует
            # точное значение, связка не пересчитывается.
            task.progress_pct = op.progress_pct
        elif op.status == TaskStatus.DONE:
            # Связка (см. комментарий у модели): «сделано» — это весь объём.
            # Обратного правила нет: уход из 'done' прогресс не трогает.
            task.progress_pct = 100
        _stamp_status_change(task, previous_status)
        db.flush()
        if task.progress_pct != previous_progress:
            forward |= {"progress_from": previous_progress, "progress_to": task.progress_pct}
            inverse |= {"progress_from": task.progress_pct, "progress_to": previous_progress}
        return forward, inverse

    if isinstance(op, RenameCategory):
        category = _require_category(db, project, op.category_id)
        forward = {
            "type": "rename_category",
            "category_id": str(category.id),
            "from": category.name,
            "to": op.name,
        }
        category.name = op.name
        db.flush()
        return forward, _swap(forward)

    if isinstance(op, SetCategoryColor):
        category = _require_category(db, project, op.category_id)
        forward = {
            "type": "set_category_color",
            "category_id": str(category.id),
            "from": category.color,
            "to": op.color,
        }
        category.color = op.color
        db.flush()
        return forward, _swap(forward)

    if isinstance(op, AssignUser):
        task = _require_task(db, project, op.task_id)
        # Без этой проверки задачу можно повесить на постороннего, и сам факт
        # его существования утёк бы наружу: попадание в ответ проекта — это
        # уже наблюдаемое различие между «такого адреса нет» и «есть».
        member = db.scalar(
            select(Membership.id).where(
                Membership.org_id == project.org_id, Membership.user_id == op.user_id
            )
        )
        if member is None:
            raise InvalidOperation("user_not_in_organization", "пользователь не в этой организации")
        if _find_assignment(db, task.id, op.user_id) is not None:
            raise InvalidOperation("already_assigned", "этот человек уже назначен")
        db.add(TaskAssignee(task_id=task.id, user_id=op.user_id))
        db.flush()
        pair = {"task_id": str(task.id), "user_id": str(op.user_id)}
        return {"type": "assign_user", **pair}, {"type": "unassign_user", **pair}

    if isinstance(op, UnassignUser):
        # Проверки членства здесь нет намеренно: снять назначение с того, кто
        # уже покинул организацию, — законное действие, а не отказ.
        task = _require_task(db, project, op.task_id)
        assignment = _find_assignment(db, task.id, op.user_id)
        if assignment is None:
            raise NotFoundInProject("assignment_not_found", "назначение не найдено")
        db.delete(assignment)
        db.flush()
        pair = {"task_id": str(task.id), "user_id": str(op.user_id)}
        return {"type": "unassign_user", **pair}, {"type": "assign_user", **pair}

    if isinstance(op, AddDependency):
        # Связи по спеку — стрелки на картинке, а не правило расчёта: даты по
        # ним не пересчитываются. Но мусор в них допускать нельзя.
        if op.from_task_id == op.to_task_id:
            raise InvalidOperation("self_dependency", "задача не может зависеть от себя")
        # Обе стороны через _require_task: связь с задачей чужого проекта
        # отсекается тем же механизмом, что и всё остальное.
        _require_task(db, project, op.from_task_id)
        _require_task(db, project, op.to_task_id)
        if _find_dependency(db, project, op.from_task_id, op.to_task_id) is not None:
            raise InvalidOperation("dependency_exists", "такая связь уже есть")
        # Цикл — тоже мусор, даже для «просто стрелок»: диаграмма рисует их
        # рёбрами, и кольцо A→B→A читается как план, который никогда не
        # начнётся. Проверка обходом от to к from по существующим рёбрам:
        # если из to достижима from, новое ребро замыкает кольцо.
        edges: dict[uuid.UUID, list[uuid.UUID]] = {}
        for row in db.scalars(
            select(Dependency).where(Dependency.project_id == project.id)
        ):
            edges.setdefault(row.from_task_id, []).append(row.to_task_id)
        frontier = [op.to_task_id]
        seen: set[uuid.UUID] = set()
        while frontier:
            node = frontier.pop()
            if node == op.from_task_id:
                raise InvalidOperation("dependency_cycle", "связь замыкает кольцо")
            if node in seen:
                continue
            seen.add(node)
            frontier.extend(edges.get(node, ()))
        db.add(
            Dependency(
                project_id=project.id,
                from_task_id=op.from_task_id,
                to_task_id=op.to_task_id,
            )
        )
        db.flush()
        ends = {"from_task_id": str(op.from_task_id), "to_task_id": str(op.to_task_id)}
        # Новая связь двигает последователя ровно так же, как перенос
        # предшественника: она и означает «эта работа ждёт ту». Исходная точка
        # обхода — предшественник: сам он не двигается, а вот всё, что от него
        # теперь зависит, обязано встать после него.
        moved, back = _cascade(db, project, {op.from_task_id}, op.cascade)
        return (
            _with_cascade({"type": "add_dependency", **ends}, moved),
            _with_cascade({"type": "remove_dependency", **ends}, back),
        )

    if isinstance(op, RemoveDependency):
        _require_task(db, project, op.from_task_id)
        _require_task(db, project, op.to_task_id)
        dependency = _find_dependency(db, project, op.from_task_id, op.to_task_id)
        if dependency is None:
            raise NotFoundInProject("dependency_not_found", "связь не найдена в этом проекте")
        db.delete(dependency)
        db.flush()
        ends = {"from_task_id": str(op.from_task_id), "to_task_id": str(op.to_task_id)}
        # Снятие связи само по себе не двигает ничего: автоперенос назад не
        # тянет (см. app/cascade.py). Карта дат сюда приходит только как поле
        # восстановления — когда эта операция обратна add_dependency и обязана
        # вернуть последователей туда, откуда их подвинула новая связь.
        moved, back = _cascade(db, project, set(), op.cascade)
        return (
            _with_cascade({"type": "remove_dependency", **ends}, moved),
            _with_cascade({"type": "add_dependency", **ends}, back),
        )

    if isinstance(op, ReorderTask):
        if op.position < 0:
            raise InvalidOperation("negative_position", "позиция не может быть отрицательной")
        task = _require_task(db, project, op.task_id)
        _require_category(db, project, op.category_id)

        # Снимок по всему проекту, а не по одной категории: перенос между
        # категориями меняет обе, и половинчатая карта отменялась бы
        # наполовину.
        rows = db.scalars(
            select(Task).where(Task.project_id == project.id).order_by(Task.position, Task.id)
        ).all()
        before_pos = {str(row.id): row.position for row in rows}
        before_cat = {str(row.id): str(row.category_id) for row in rows}

        siblings = [
            row for row in rows if row.category_id == op.category_id and row.id != task.id
        ]
        # Позиция за концом списка — не отказ: перетаскивание в самый низ
        # присылает индекс, равный длине, и это нормальный жест.
        index = min(op.position, len(siblings))
        ordered = siblings[:index] + [task] + siblings[index:]

        task.category_id = op.category_id
        for slot, row in enumerate(ordered):
            row.position = slot
        db.flush()

        # В журнал идёт дифф, а не снимок всего проекта: перестановка задевает
        # одну-две категории, а снимок на тысячу задач писал бы килобайты в
        # jsonb на каждое перетаскивание — и ровно столько же тащил бы в
        # ответе мутации и в истории. Отмене нужны только строки, чьи позиция
        # или категория изменились: остальные и так стоят как стояли.
        changed = [
            row
            for row in rows
            if before_pos[str(row.id)] != row.position
            or before_cat[str(row.id)] != str(row.category_id)
        ]
        forward = {
            "type": "reorder_task",
            "task_id": str(task.id),
            "from": {str(row.id): before_pos[str(row.id)] for row in changed},
            "to": {str(row.id): row.position for row in changed},
            "categories_from": {str(row.id): before_cat[str(row.id)] for row in changed},
            "categories_to": {str(row.id): str(row.category_id) for row in changed},
        }
        inverse = {
            "type": "apply_positions",
            "positions": {str(row.id): before_pos[str(row.id)] for row in changed},
            "categories": {str(row.id): before_cat[str(row.id)] for row in changed},
        }
        return forward, inverse

    if isinstance(op, ReorderCategory):
        if op.position < 0:
            raise InvalidOperation("negative_position", "позиция не может быть отрицательной")
        category = _require_category(db, project, op.category_id)

        # Порядок читается тем же ключом, каким его читает лента: позиция, а
        # при равенстве — идентификатор. Равенство встречается по-настоящему:
        # категории создаются с max(position) + 1, но отмена удаления
        # возвращает этап на его прежний номер, который с тех пор мог достаться
        # соседу.
        rows = db.scalars(
            select(Category)
            .where(Category.project_id == project.id)
            .order_by(Category.position, Category.id)
        ).all()
        before_pos = {str(row.id): row.position for row in rows}

        others = [row for row in rows if row.id != category.id]
        # Позиция за концом списка — не отказ: бросок в самый низ присылает
        # индекс, равный длине.
        index = min(op.position, len(others))
        ordered = others[:index] + [category] + others[index:]
        for slot, row in enumerate(ordered):
            row.position = slot
        db.flush()

        # В журнал идёт дифф, а не снимок: перестановка задевает отрезок между
        # старым и новым местом, а не весь список (см. reorder_task выше).
        changed = [row for row in rows if before_pos[str(row.id)] != row.position]
        forward = {
            "type": "reorder_category",
            "category_id": str(category.id),
            "from": {str(row.id): before_pos[str(row.id)] for row in changed},
            "to": {str(row.id): row.position for row in changed},
        }
        inverse = {
            "type": "apply_category_positions",
            "positions": {str(row.id): before_pos[str(row.id)] for row in changed},
        }
        return forward, inverse

    if isinstance(op, ApplyCategoryPositions):
        before_categories: dict[str, int] = {}
        for raw_id, position in op.positions.items():
            row = _require_category(db, project, raw_id)
            before_categories[str(row.id)] = row.position
            row.position = position
        db.flush()
        # Ключи приводятся к строкам: в модели они uuid.UUID, а json.dumps на
        # пути в jsonb на таком ключе падает — запись журнала не легла бы вовсе.
        forward = {
            "type": "apply_category_positions",
            "positions": {str(key): value for key, value in op.positions.items()},
        }
        inverse = {"type": "apply_category_positions", "positions": before_categories}
        return forward, inverse

    if isinstance(op, ApplyPositions):
        before_pos: dict[str, int] = {}
        before_cat: dict[str, str] = {}
        for raw_id, position in op.positions.items():
            row = _require_task(db, project, raw_id)
            # Обе карты пишутся одной рукой и обязаны совпадать по ключам, но
            # запись журнала — данные, а не код: рассинхрон должен быть
            # отказом с кодом, а не KeyError, который наружу выйдет
            # пятисоткой.
            target_category = op.categories.get(raw_id)
            if target_category is None:
                raise InvalidOperation(
                    "positions_categories_mismatch",
                    f"в карте категорий нет задачи {raw_id}",
                )
            # Категорию с тех пор могли удалить: вставка в неё упала бы по
            # внешнему ключу — тоже пятисоткой, хотя это обычный отказ
            # «категории больше нет».
            _require_category(db, project, target_category)
            before_pos[str(row.id)] = row.position
            before_cat[str(row.id)] = str(row.category_id)
            row.position = position
            row.category_id = target_category
        db.flush()
        # Ключи приводятся к строкам: в модели они uuid.UUID, а json.dumps
        # на пути в jsonb на таком ключе падает — запись журнала не легла бы
        # вовсе.
        forward = {
            "type": "apply_positions",
            "positions": {str(key): value for key, value in op.positions.items()},
            "categories": {str(key): str(value) for key, value in op.categories.items()},
        }
        inverse = {
            "type": "apply_positions",
            "positions": before_pos,
            "categories": before_cat,
        }
        return forward, inverse

    if isinstance(op, DeleteCategory):
        category = _require_category(db, project, op.category_id)
        # Категория уходит вместе со своим содержимым: этап отменили целиком —
        # и разбирать его по строке, чтобы избавиться от заголовка, значит
        # столько удалений, сколько в нём задач, и столько же записей в
        # истории на одно решение человека.
        #
        # Прежде непустую категорию удалять запрещалось (`category_not_empty`),
        # и запрет был не капризом: каскад унёс бы задачи, а обратная операция
        # вернула бы пустой заголовок. Отвечает на это не запрет, а снимок —
        # тот же, каким отменяется удаление задачи, только по каждой строке
        # этапа. Предупредить человека о том, что уйдёт вместе с категорией,
        # обязан интерфейс: сервер такому предупреждению не место.
        tasks = db.scalars(
            select(Task).where(Task.category_id == category.id).order_by(Task.position, Task.id)
        ).all()
        snapshot = {
            "type": "create_category",
            "category_id": str(category.id),
            "name": category.name,
            "color": category.color,
            "position": category.position,
        }
        if tasks:
            snapshot["tasks"] = [_task_snapshot(db, task) for task in tasks]
        for task in tasks:
            db.delete(task)
        # Флаш до удаления самой категории, а не один общий следом: связь этих
        # двух таблиц описана только внешним ключом, порядок удалений
        # SQLAlchemy по нему не выводит — и снесённая первой категория унесла
        # бы задачи каскадом базы, оставив ORM удалять уже несуществующие
        # строки (и жаловаться на это предупреждением).
        db.flush()
        db.delete(category)
        db.flush()
        forward = {"type": "delete_category", "category_id": str(op.category_id)}
        # Число задач — в самой записи: «удалил категорию» об удалённом вместе
        # с ней этапе умалчивает, а считать их в ленте истории не по чему —
        # снимок восстановления виден не каждой роли.
        if tasks:
            forward["tasks"] = len(tasks)
        return (forward, snapshot)

    if isinstance(op, DeleteTask):
        task = _require_task(db, project, op.task_id)
        # Снимок несёт и окружение задачи — связи, назначения, разговор:
        # каскад уносит их вместе со строкой, и отмена без них вернула бы
        # голое имя.
        snapshot = _task_snapshot(db, task)
        db.delete(task)
        db.flush()
        return ({"type": "delete_task", "task_id": str(op.task_id)}, snapshot)

    raise InvalidOperation("unknown_operation", f"неизвестная операция: {op!r}")


def _guard_shift_threshold(db: DbSession, project: Project, op, reason: str | None) -> None:
    """Проверка «отклонение от базового плана больше порога → причина обязательна».

    Живёт в слое мутаций, а не в маршруте, ровно по той причине, по которой
    спецификация называет правило одним независимо от способа ввода:
    перетаскивание мышью, правка поля в карточке и применение пачки от AI
    приходят сюда одной дорогой, а в маршруте их было бы три.

    Проверка идёт до применения: промежуточного состояния «сдвинуто, но не
    объяснено» в системе не существует, и получиться оно не должно даже на
    время одной транзакции.

    Отмена (undo) проходит через ту же проверку сознательно. Она не
    привилегированное действие: если возврат к прежнему значению уводит задачу
    от базового плана дальше порога, объяснение нужно ровно так же, как при
    любом другом способе туда попасть.

    Задачи, подвинутые автопереносом, здесь не считаются, и это решение, а не
    упущение. Порог спрашивает «объясните, что вы делаете», а автоперенос —
    не то, что человек делает, а следствие связей, которые он расставил
    раньше: он двигает одну задачу, и цепочка едет за ней по правилу, которое
    он сам и включил. Спрашивать причину ещё раз за каждое звено цепочки
    значило бы задать один и тот же вопрос столько раз, сколько связей.
    Отклонение самих звеньев при этом не скрывается: бейдж на полоске и
    признак «план разошёлся с согласованным» считаются по датам и показывают
    их, кто бы эти даты ни подвинул.

    Проверка идёт до применения, а прямой расчёт переноса — во время, поэтому
    посчитать здесь будущую цепочку нечем, не повторив весь расчёт вторым
    проходом. Это второй довод к тому же решению, но не первый: будь расчёт
    бесплатным, ответ остался бы тем же.
    """
    if reason:
        return

    if isinstance(op, MoveTask):
        task = _require_task(db, project, op.task_id)
        deviation = deviation_days(task, start_date=op.start_date)
    elif isinstance(op, SetDuration):
        task = _require_task(db, project, op.task_id)
        deviation = deviation_days(task, duration_days=op.duration_days)
    elif isinstance(op, ResizeTask):
        # Единственная операция, у которой оба измерения меняются одним
        # движением, — и единственная, которой честно спросить наибольшее из
        # двух отклонений. Правило «названное измерение и меряется» её не
        # касается: она называет оба.
        task = _require_task(db, project, op.task_id)
        deviation = deviation_days(
            task, start_date=op.start_date, duration_days=op.duration_days
        )
    elif isinstance(op, MoveCategory):
        # Сдвиг категории — тот же перенос сроков, только разом по многим
        # задачам, и порог обязан считаться по нему так же. Берётся наибольшее
        # отклонение: категорию сдвинули одним движением, и объяснение у него
        # одно — на самую уехавшую из её задач. Считать порог по каждой
        # отдельно значило бы спросить причину столько раз, сколько строк в
        # категории, за одно движение руки.
        shift = timedelta(days=op.days)
        deviations = [
            deviation_days(task, start_date=task.start_date + shift)
            for task in db.scalars(
                select(Task).where(Task.category_id == op.category_id)
            ).all()
        ]
        measured = [value for value in deviations if value is not None]
        deviation = max(measured) if measured else None
    elif isinstance(op, SetMilestone):
        # Веха схлопывает длительность — то есть меняет сроки, и порог здесь
        # тот же, что у set_duration. Длительность после операции известна:
        # либо продиктована журналом (отмена), либо это один день.
        task = _require_task(db, project, op.task_id)
        after = op.duration_days if op.duration_days is not None else (1 if op.milestone else None)
        deviation = None if after is None else deviation_days(task, duration_days=after)
    else:
        # Остальные операции базового плана не касаются. Создание задачи —
        # тоже: у созданной после утверждения задачи базового плана нет, она
        # помечается «сверх первоначального плана» и от объяснений свободна.
        return

    if deviation is None:
        return

    org = db.get(Organization, project.org_id)
    threshold = resolve_shift_threshold(project, org)
    if deviation > threshold:
        raise ReasonRequired(deviation, threshold)


def apply_op(
    db: DbSession,
    project: Project,
    op,
    *,
    actor_id: uuid.UUID | None,
    reason: str | None = None,
    batch_id: uuid.UUID | None = None,
    undoes_seq: int | None = None,
) -> Revision:
    # Блокировка строки проекта на всё время применения операции. Без неё два
    # запроса, правящих один проект, считают max(seq)+1 из одного и того же
    # снимка: проигравший нарушает уникальное ограничение (project_id, seq), и
    # вызывающий получает голую пятисотку. Та же гонка дублирует position, где
    # ограничения нет вовсе и расхождение остаётся незамеченным. Совместное
    # редактирование одного проекта — нормальный режим этого продукта, а не
    # редкий случай; когда конкуренции нет, блокировка не стоит ничего.
    db.execute(select(Project.id).where(Project.id == project.id).with_for_update())
    # Причина из одних пробелов — это отсутствие причины. Нормализуется здесь,
    # а не в маршруте: правило порога живёт в этом слое, и проверять здесь
    # одно, а хранить другое означало бы две разные истины об одном значении.
    reason = reason.strip() or None if reason else None
    _guard_shift_threshold(db, project, op, reason)
    forward, inverse = _apply(db, project, op)
    revision = Revision(
        project_id=project.id,
        seq=_next_seq(db, project),
        actor_user_id=actor_id,
        op=forward,
        inverse=inverse,
        reason=reason,
        batch_id=batch_id,
        undoes_seq=undoes_seq,
    )
    db.add(revision)
    db.flush()
    return revision


# Операции, хранящие в журнале обе границы: имя поля модели, в которое ложится
# скалярное `to`. Отображение, а не цепочка elif: цепочка растёт вместе с
# числом операций и перестаёт читаться, а здесь новая операция — одна строка.
_SCALAR_BOUNDS_FIELD = {
    "move_task": "start_date",
    "set_duration": "duration_days",
    "set_criticality": "criticality",
    "set_milestone": "milestone",
    "set_progress": "progress_pct",
    "set_status": "status",
    "rename_category": "name",
    "set_category_color": "color",
}

# Операции, у которых `to` — не скаляр, а словарь полей: они разворачиваются
# в модель целиком.
_MAPPED_BOUNDS = frozenset({"set_task_fields", "resize_task", "set_risk"})

# Связанное поле, границы которого операция несёт сверх собственных: имя
# поля модели и пара ключей журнала. Присутствуют в записи только когда
# связка сработала — иначе восстановление читало бы значения, которых
# операция не меняла.
_COUPLED_BOUNDS_FIELD = {
    "set_progress": ("status", "status_from", "status_to"),
    "set_status": ("progress_pct", "progress_from", "progress_to"),
    "set_milestone": ("duration_days", "duration_from", "duration_to"),
}


def _op_from_dict(payload: dict):
    """Восстанавливает операцию из записи журнала.

    Операции с парой границ хранят и from, и to, поэтому значение берётся из
    to — так одна и та же запись читается и как прямая операция, и как
    обратная (её inverse отличается лишь порядком этих двух полей).
    """
    kind = payload["type"]
    model = _MODELS[kind]
    data = dict(payload)
    if kind in _SCALAR_BOUNDS_FIELD:
        data[_SCALAR_BOUNDS_FIELD[kind]] = data.pop("to")
        data.pop("from", None)
    elif kind in _MAPPED_BOUNDS:
        data.update(data.pop("to"))
        data.pop("from", None)
    if kind in _COUPLED_BOUNDS_FIELD:
        # Связанное поле — тем же правилом, что и основное: значение из
        # *_to, так что запись читается и как прямая операция, и как
        # обратная. Без него отмена доверила бы восстановление связке, а
        # связка прежнего значения не знает (см. SetProgress.status).
        field, bound_from, bound_to = _COUPLED_BOUNDS_FIELD[kind]
        if bound_to in data:
            data[field] = data.pop(bound_to)
        data.pop(bound_from, None)
    return model.model_validate(data)


def undo(
    db: DbSession,
    project: Project,
    revision: Revision,
    *,
    actor_id: uuid.UUID | None,
    reason: str | None = None,
    batch_id: uuid.UUID | None = None,
) -> Revision:
    # Каждый соседний помощник перепроверяет project_id, а undo принимал
    # ревизию на веру. Маршрут берёт номер ревизии из адреса, и без этой
    # проверки это ровно межарендная запись: чужая ревизия применилась бы к
    # своему проекту.
    if revision.project_id != project.id:
        raise NotFoundInProject("revision_not_found", "ревизия не найдена в этом проекте")
    return apply_op(
        db,
        project,
        _op_from_dict(revision.inverse),
        actor_id=actor_id,
        reason=reason,
        batch_id=batch_id,
        undoes_seq=revision.seq,
    )


def undo_last(
    db: DbSession,
    project: Project,
    *,
    actor_id: uuid.UUID | None,
    reason: str | None = None,
    expected_seq: int | None = None,
) -> tuple[Revision, Revision]:
    """Отмена последнего изменения: выбор ревизии и применение — одним замком.

    Выбор здесь, а не в маршруте, закрывает гонку двойной отмены: два
    одновременных нажатия «Отменить» читали last_undoable из одного снимка,
    оба находили одну и ту же ревизию — и проигравший блокировку внутри
    apply_op применял её отмену второй раз, возвращая проект туда, откуда
    первый только что ушёл. Под замком проекта второй запрос ждёт первого и
    выбирает уже следующую ревизию — или узнаёт, что отменять нечего.

    `expected_seq` — номер ревизии, отмену которой клиент обещал человеку.
    Проверка здесь, под тем же замком: сверка на клиенте отделена от отмены
    сетевым путешествием, и в этот зазор влезает ровно то изменение, от
    которого сверка защищала. Без номера отменяется просто верх журнала — так
    зовёт лента истории, у которой номер тоже есть, и так остаётся возможной
    отмена вслепую (скрипт, консоль).

    Возвращает пару (запись отмены, отменённая ревизия): маршруту нужны обе.
    """
    db.execute(select(Project.id).where(Project.id == project.id).with_for_update())
    revision = last_undoable(db, project)
    if revision is None:
        raise NotFoundInProject("nothing_to_undo", "отменять нечего")
    if expected_seq is not None and revision.seq != expected_seq:
        raise UndoConflict(
            "undo_conflict",
            f"наверху журнала ревизия {revision.seq}, а отменить просят {expected_seq}",
        )
    applied = undo(db, project, revision, actor_id=actor_id, reason=reason)
    return applied, revision


def last_undoable(db: DbSession, project: Project) -> Revision | None:
    """Ревизия, которую отменит кнопка «Отменить».

    Самая новая из тех, что ещё никем не отменены и сами не являются отменой.
    Без второго условия повторное нажатие возвращало бы отменённое обратно —
    и человек, нажавший «Отменить» дважды, оказывался бы там же, откуда
    начал, вместо того чтобы отступить на два шага.
    """
    undone = select(Revision.undoes_seq).where(
        Revision.project_id == project.id, Revision.undoes_seq.is_not(None)
    )
    return db.scalar(
        select(Revision)
        .where(
            Revision.project_id == project.id,
            Revision.undoes_seq.is_(None),
            Revision.seq.not_in(undone),
        )
        .order_by(Revision.seq.desc())
        .limit(1)
    )


def undo_batch(
    db: DbSession,
    project: Project,
    batch_id: uuid.UUID,
    *,
    actor_id: uuid.UUID | None,
    reason: str | None = None,
) -> list[Revision]:
    """Откат пачки целиком — той, что применил AI одной кнопкой.

    Порядок обратный: пачка создаёт категорию, потом задачи в ней, и откат
    с начала упёрся бы в непустую категорию.

    Уже отменённые ревизии пропускаются: повторное нажатие на ту же кнопку —
    это не приказ применить обратную операцию второй раз. Сами отмены тоже не
    отменяются — по той же причине, по которой их обходит `last_undoable`;
    возврата отката («вернуть пачку обратно») в первой версии нет.

    Отмены получают общий свой batch_id: в журнале откат пачки читается одним
    действием, а не россыпью не связанных между собой записей.

    Причина принимается и раздаётся каждой отмене: откат проходит ту же
    проверку порога, что и всякое изменение сроков, и без причины пачка,
    двигавшая даты дальше порога, была бы неоткатываемой вовсе.
    """
    # Тот же замок и по той же причине, что в undo_last: без него два
    # одновременных отката читают список ревизий из одного снимка и каждый
    # применяет все отмены — по две на ревизию.
    db.execute(select(Project.id).where(Project.id == project.id).with_for_update())
    undone = select(Revision.undoes_seq).where(
        Revision.project_id == project.id, Revision.undoes_seq.is_not(None)
    )
    revisions = db.scalars(
        select(Revision)
        .where(
            Revision.project_id == project.id,
            Revision.batch_id == batch_id,
            Revision.undoes_seq.is_(None),
            Revision.seq.not_in(undone),
        )
        .order_by(Revision.seq.desc())
    ).all()

    if not revisions:
        raise NotFoundInProject("batch_not_found", "пачка не найдена в этом проекте")

    undo_batch_id = uuid.uuid4()
    return [
        undo(db, project, revision, actor_id=actor_id, reason=reason, batch_id=undo_batch_id)
        for revision in revisions
    ]
