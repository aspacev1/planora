import uuid
from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.calendar import WEEKDAYS_MON_FRI
from app.db import Base


class Role(StrEnum):
    OWNER = "owner"
    EDITOR = "editor"
    VIEWER = "viewer"
    CLIENT = "client"


class Criticality(StrEnum):
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    CRITICAL = "critical"


# Выведен из Criticality, а не выписан вторым списком: два списка одних и тех
# же значений однажды разъедутся при добавлении уровня — ровно так же, как
# разъехался бы CHECK на роли, будь он выписан руками.
CRITICALITY_LEVELS: tuple[str, ...] = tuple(level.value for level in Criticality)


class TaskStatus(StrEnum):
    PLANNED = "planned"
    IN_PROGRESS = "in_progress"
    DONE = "done"
    BLOCKED = "blocked"


# Тем же приёмом, что CRITICALITY_LEVELS: список для CHECK и проверок слоя
# мутаций выводится из enum, а не выписывается второй раз руками.
TASK_STATUSES: tuple[str, ...] = tuple(status.value for status in TaskStatus)


class ScheduleMode(StrEnum):
    """Каким временем живёт план проекта.

    `relative` — предварительный план без дат: шкала «Месяц 1 / Неделя 1 /
    День 1», старт проекта ещё не назначен. `calendar` — старт назначен, у
    задач настоящие даты. Значение по умолчанию — `relative`: при создании
    проекта дата начала не спрашивается, её назначают, когда проект утверждён.
    """

    RELATIVE = "relative"
    CALENDAR = "calendar"


SCHEDULE_MODES: tuple[str, ...] = tuple(mode.value for mode in ScheduleMode)


class EffortUnit(StrEnum):
    """В чём оценивается трудоёмкость предложения: в днях или в часах.

    Свойство предложения целиком, а не каждой строки: смета, где одна строка
    в днях, а соседняя в часах, не складывается в один итог без вопроса
    «а что тут написано» на каждой строке.
    """

    DAYS = "days"
    HOURS = "hours"


# Тем же приёмом, что CRITICALITY_LEVELS: список для CHECK выводится из enum,
# а не выписывается второй раз руками.
EFFORT_UNITS: tuple[str, ...] = tuple(unit.value for unit in EffortUnit)


class ProposalStatus(StrEnum):
    """Этап предложения, который отмечает человек: черновик, отправлено,
    согласовано.

    «В плане» здесь нет намеренно: этот этап не отмечают, а выводят из ссылок
    строк на задачи (ProposalTask.plan_task_id). Хранимый флаг разошёлся бы с
    правдой первой же отменой переноса — отмена удаляет задачи, ссылки
    обнуляются базой, а флаг остался бы поднятым.
    """

    DRAFT = "draft"
    SENT = "sent"
    AGREED = "agreed"


PROPOSAL_STATUSES: tuple[str, ...] = tuple(status.value for status in ProposalStatus)


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


class Organization(Base):
    __tablename__ = "organizations"

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String(200))
    slug: Mapped[str] = mapped_column(String(100), unique=True)

    default_locale: Mapped[str] = mapped_column(String(5), default="az")
    default_timezone: Mapped[str] = mapped_column(String(64), default="Asia/Baku")
    working_days: Mapped[int] = mapped_column(Integer, default=WEEKDAYS_MON_FRI)
    week_start: Mapped[int] = mapped_column(Integer, default=0)
    holiday_calendar: Mapped[list] = mapped_column(JSON, default=list)
    default_shift_threshold_days: Mapped[int] = mapped_column(Integer, default=2)
    public_sharing_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    default_comments_enabled: Mapped[bool] = mapped_column(Boolean, default=True)


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = _uuid_pk()
    email: Mapped[str] = mapped_column(String(320), unique=True)
    password_hash: Mapped[str] = mapped_column(String(200))
    name: Mapped[str] = mapped_column(String(200))
    locale: Mapped[str] = mapped_column(String(5), default="az")
    # Часовой пояс читателя — уровень 4 настроек. Nullable, и `null` здесь не
    # «пусто», а «спросить у браузера»: пояс человека меняется вместе с ним,
    # и записанный однажды при заведении аккаунта он врал бы после первой же
    # поездки. Пояс организации сюда не копируется по той же причине, по
    # которой проект не копирует её настройки: копия расходится с оригиналом.
    timezone: Mapped[str | None] = mapped_column(String(64))
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # Последняя активность этого человека — момент последнего запроса с его
    # валидной сессией, а не производная от Session.last_used_at. Строки
    # сессий подметаются (выход, просрочка, недельный простой без обращений —
    # см. app.auth), и агрегат по ним слепнет ровно тогда, когда об
    # активности спрашивают после давнего перерыва: свежих строк уже нет, а
    # человек продолжает пользоваться продуктом. Отдельное поле переживает
    # эту уборку. Обновляется тем же шагом, что и last_used_at, — не на
    # каждый запрос. Кормит панель директора (см. admin_routes).
    last_active_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Membership(Base):
    __tablename__ = "memberships"
    __table_args__ = (
        UniqueConstraint("org_id", "user_id"),
        # Свободный String(16) пускал в колонку любое значение, а Role(...)
        # на нём поднимал ValueError уже в запросе. Список выведен из Role,
        # чтобы не разъехаться с ним при добавлении роли.
        CheckConstraint(
            "role IN (" + ", ".join(f"'{role.value}'" for role in Role) + ")",
            name="ck_memberships_role",
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"))
    # Спрашивается на каждом запросе с сессией; составной (org_id, user_id)
    # ведёт не с той колонки и для этого поиска бесполезен.
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(16))
    # Видит ли это членство только те проекты, куда его позвали поимённо, —
    # независимо от роли. Роли `client` и гостю по ссылке это и так решает
    # сама роль (см. `_NEEDS_GRANT` в app.access); колонка нужна ради
    # остальных ролей — приглашающий вправе позвать редактора или наблюдателя
    # в конкретные проекты, а не сразу во все проекты организации. По
    # умолчанию False: приглашение без отмеченных проектов не сужает роль,
    # которая по умолчанию видит всю организацию, — иначе включение этой
    # возможности само по себе урезало бы права уже приглашённым.
    project_scoped: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[uuid.UUID] = _uuid_pk()
    # По владельцу сессии ищут «выйти на всех устройствах» и уборка
    # просроченных при входе.
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    token_hash: Mapped[str] = mapped_column(String(128), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Организация, выбранная переключателем. Живёт на сессии, а не на
    # пользователе: с одной вкладки смотрят свою компанию, с другой — чужую,
    # куда позвали, и общее поле у пользователя перебрасывало бы обе вкладки
    # разом. SET NULL, а не CASCADE: удалённая организация не должна уносить
    # с собой сессию — человек просто вернётся к первой доступной.
    active_org_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="SET NULL")
    )

    # Последнее обращение с этой сессией — для idle-таймаута: украденная кука
    # с брошенного устройства не должна жить все тридцать дней срока годности
    # только потому, что её однажды выдали. Обновляется с шагом (см.
    # app.auth), а не на каждый запрос: иначе каждое чтение проекта — это
    # ещё и запись в таблицу сессий.
    last_used_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ThrottleEvent(Base):
    """Событие для счётчиков частоты: одна строка — одна учтённая попытка.

    В базе, а не в памяти процесса, потому что вход и регистрацию — в
    отличие от гостевых комментариев — стерегут не от заливки, а от перебора
    паролей: предохранитель, который обнуляется перезапуском процесса и не
    виден соседней реплике, там не предохранитель. База — единственное
    общее хранилище этой архитектуры (внешних сервисов у продукта нет).

    Ключ — произвольная строка вида «login:ip:…»; составитель сам отвечает
    за её уникальность между применениями. Старые строки подметаются
    попутно при каждом обращении к своему ключу.
    """

    __tablename__ = "throttle_events"
    __table_args__ = (Index("ix_throttle_events_bucket_at", "bucket", "at"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    bucket: Mapped[str] = mapped_column(String(120))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AiUsage(Base):
    """Расход токенов LLM организацией за календарные сутки.

    Отдельно от AiSession.tokens_used: сессия считает свой разговор, а
    бюджет — всё, что организация потратила за день, включая точечные
    действия вроде разбиения задачи, у которых сессии нет вовсе.
    """

    __tablename__ = "ai_usage"
    __table_args__ = (UniqueConstraint("org_id", "day"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE")
    )
    day: Mapped[date] = mapped_column(Date)
    tokens: Mapped[int] = mapped_column(Integer, default=0)


class IdempotencyRecord(Base):
    """Ответ, однажды выданный на пишущий запрос с ключом идемпотентности.

    Повтор запроса с тем же ключом (ретрай сети, двойной клик) получает
    сохранённый ответ вместо второго применения: мутация «сдвинуть на день»,
    применённая дважды, — это сдвиг на два дня, и клиент, чей первый ответ
    потерялся в сети, не должен уметь это устроить.

    Строки живут сутки и подметаются попутно: ретраи приходят в течение
    секунд, ключ старше суток — это уже не ретрай.
    """

    __tablename__ = "idempotency_records"
    __table_args__ = (UniqueConstraint("project_id", "key"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE")
    )
    key: Mapped[str] = mapped_column(String(120))
    response: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class EmailVerification(Base):
    """Одноразовая ссылка подтверждения адреса.

    Устроена как сессия: наружу уходит открытый токен, в базе лежит его
    хеш — утечка дампа не даёт подтвердить чужой адрес. Строка живёт до
    истечения срока, поэтому таблица не растёт: следующая выдача сносит
    прежние ссылки владельца, а просроченные подметает подтверждение.

    Погашенная строка не удаляется, а помечается `used_at`: ссылку из письма
    открывают повторно — из истории браузера, из того же письма на другом
    устройстве, — и без этой отметки второй заход отвечал бы «ссылка не
    подходит» человеку, у которого всё в порядке. Подтвердить ею что-либо
    второй раз нельзя: отметка проверяется раньше срока годности.
    """

    __tablename__ = "email_verifications"

    id: Mapped[uuid.UUID] = _uuid_pk()
    # Ищется по владельцу на каждой повторной отправке и на подтверждении.
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    token_hash: Mapped[str] = mapped_column(String(128), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    #: Когда письмо действительно ушло. Пусто — не ушло: токен выдаётся до
    #: отправки и переживает недоступный почтовый сервер, а пауза между
    #: повторами считается от письма, а не от строки в таблице.
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    #: Когда ссылкой воспользовались. Пусто — ссылка ещё годная.
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)


class PasswordReset(Base):
    """Одноразовая ссылка восстановления пароля.

    Та же дисциплина, что у EmailVerification: наружу уходит открытый токен,
    в базе лежит его хеш. Таблица отдельная, а не общая с подтверждением:
    ссылка восстановления — это вход в аккаунт, и жить она должна заметно
    короче, а ошибка в общем коде не должна превращать письмо «подтвердите
    адрес» в ключ от чужого пароля.
    """

    __tablename__ = "password_resets"

    id: Mapped[uuid.UUID] = _uuid_pk()
    # Ищется по владельцу на каждой повторной просьбе и при погашении.
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    token_hash: Mapped[str] = mapped_column(String(128), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Project(Base):
    __tablename__ = "projects"
    __table_args__ = (
        UniqueConstraint("org_id", "slug"),
        # Тот же принцип, что у CHECK-ограничений задачи: инвариант держит
        # база, а не только слой приложения — второй путь записи не должен
        # уметь положить режим, которого не существует.
        CheckConstraint(
            "schedule_mode IN (" + ", ".join(f"'{mode}'" for mode in SCHEDULE_MODES) + ")",
            name="ck_projects_schedule_mode",
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(200))
    slug: Mapped[str] = mapped_column(String(100))
    deadline: Mapped[date | None] = mapped_column(Date)
    plan_approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    plan_version: Mapped[int] = mapped_column(Integer, default=0)

    # Относительный план или календарный (см. ScheduleMode). В относительном
    # режиме `start_date` пуста, а даты задач — координаты на относительной
    # оси: день N проекта хранится как RELATIVE_EPOCH + (N-1) (см.
    # app.schedule). Источник истины — старт + длительности + связи + рабочий
    # календарь; дат окончания в базе нет и в этом режиме тоже.
    #
    # server_default — по той же причине, что у Task.status: NOT NULL без
    # значения сломал бы второй путь записи.
    schedule_mode: Mapped[str] = mapped_column(
        Text, default=ScheduleMode.RELATIVE, server_default=text("'relative'")
    )
    # Назначенная дата старта. Появляется при привязке плана к календарю и
    # остаётся якорем: от неё считают относительное представление уже
    # календарного проекта и сдвиг всех задач при переносе старта.
    start_date: Mapped[date | None] = mapped_column(Date)

    # nullable = «наследовать от организации»
    timezone: Mapped[str | None] = mapped_column(String(64))
    working_days: Mapped[int | None] = mapped_column(Integer)
    shift_threshold_days: Mapped[int | None] = mapped_column(Integer)

    holidays_extra: Mapped[list] = mapped_column(JSON, default=list)
    workdays_extra: Mapped[list] = mapped_column(JSON, default=list)
    # Автоперенос по связям: последователь не начинается раньше, чем кончился
    # его предшественник. Выключен по умолчанию — до него связь не двигала
    # ничего вовсе, и включённый он меняет смысл каждой связи в проекте разом
    # (см. app/cascade.py). Свойство проекта, а не организации: в одном
    # проекте план ведут по цепочке, в соседнем — руками, и общая настройка
    # заставила бы выбирать одно на всех.
    auto_schedule: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )


class ProjectAccess(Base):
    """Доступ к одному проекту, выданный человеку поимённо.

    Нужна роли `client` и гостю по ссылке всегда (см. `_NEEDS_GRANT` в
    app.access), а остальным ролям — когда их собственное членство сужено
    (`Membership.project_scoped`, см. там же). Несуженному членству записи
    здесь не значат ничего — его право читать проект следует из роли одной.
    """

    __tablename__ = "project_access"
    __table_args__ = (UniqueConstraint("project_id", "user_id"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    # Спрашивается на каждом чтении проекта ролью, которой нужен явный доступ,
    # и при сборке списка проектов такого человека — то есть с этой колонки.
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )


class ShareLink(Base):
    """Публичная ссылка на проект.

    Токен лежит открытым текстом — сознательно, в отличие от приглашения,
    где хранится хеш. Приглашение показывается один раз и уходит адресату;
    публичную ссылку владелец копирует снова и снова, из настроек проекта,
    и сервер, забывший её, оставил бы единственный способ «показать ссылку
    ещё раз» — выпустить новую и убить действующую. Цена размена названа
    прямо: утёкший дамп базы отдаёт чтение опубликованных проектов, а не
    доступ к организациям.

    Отозванная ссылка не удаляется, а помечается `revoked_at`: старый адрес
    обязан отвечать «ссылка больше не действует», а не «такого проекта нет».
    """

    __tablename__ = "share_links"
    __table_args__ = (
        # Действующая ссылка у проекта одна. Частичный индекс, а не обычное
        # ограничение уникальности: отозванных ссылок у проекта сколько
        # угодно — это журнал того, какой адрес когда умер.
        Index(
            "uq_share_links_active_project",
            "project_id",
            unique=True,
            postgresql_where=text("revoked_at IS NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    token: Mapped[str] = mapped_column(String(64), unique=True)
    comments_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Comment(Base):
    """Реплика к проекту или к одной его задаче.

    Автор — либо участник с аккаунтом, либо гость по ссылке, назвавший себя
    именем. Ровно один из двух: комментарий без автора не подписан никем, а
    комментарий с обоими — это участник, притворившийся гостем. Держит это
    ограничение база, а не проверка в маршруте: маршрутов, создающих
    комментарий, уже два.
    """

    __tablename__ = "comments"
    __table_args__ = (
        CheckConstraint(
            "num_nonnulls(author_user_id, guest_name) = 1",
            name="ck_comments_single_author",
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    # null — комментарий к проекту целиком, а не к задаче. Лента задачи
    # ищется ровно по этой колонке.
    task_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), index=True
    )
    # CASCADE, а не SET NULL: обнулённый автор оставил бы запись без подписи
    # вовсе — ни аккаунта, ни имени гостя, — то есть нарушил бы ограничение
    # ниже прямо в момент удаления человека.
    author_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE")
    )
    guest_name: Mapped[str | None] = mapped_column(String(80))
    body: Mapped[str] = mapped_column(Text)
    # Внутренняя реплика: видна участникам, гостю публичной ссылки — нет.
    # По умолчанию false — разговор с клиентом остаётся общим, как и был;
    # признак ставит автор, решивший говорить «в сторону». server_default
    # закрывает и старые строки: до появления признака все реплики были
    # публичными по факту.
    internal: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    # clock_timestamp(), а не now(): now() отдаёт время начала транзакции, и
    # две реплики, вставленные в одной, получают одинаковую метку — а
    # порядок в разговоре держится именно на ней. У журнала ревизий для
    # этого есть seq, у комментариев его нет и заводить его незачем.
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.clock_timestamp()
    )


class Invitation(Base):
    """Приглашение в организацию: одноразовое, с сроком жизни и ролью внутри.

    Живёт в базе и после принятия — это журнал того, кто кого привёл, а
    `accepted_at` заодно служит признаком «токен больше не работает».
    """

    __tablename__ = "invitations"
    __table_args__ = (
        # Тем же способом, что и у членства: список выведен из Role, чтобы
        # роль в приглашении нельзя было завести мимо матрицы прав.
        CheckConstraint(
            "role IN (" + ", ".join(f"'{role.value}'" for role in Role) + ")",
            name="ck_invitations_role",
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    # null — приглашение только по ссылке: оно достаётся предъявителю, и это
    # осознанный размен, а не недосмотр.
    email: Mapped[str | None] = mapped_column(String(320))
    role: Mapped[str] = mapped_column(String(16))
    # Проекты, к которым приглашение сразу даёт доступ. Нужны роли `client`;
    # у остальных ролей список пуст. Хранится списком id, а не таблицей
    # связей: он читается и переписывается целиком, поиска по нему нет.
    project_ids: Mapped[list] = mapped_column(JSON, default=list)
    # Хранится хеш, как у пароля и у сессии: дамп базы не должен раздавать
    # доступ к организациям. Прямое следствие — открытую ссылку показываем
    # один раз, в момент выпуска.
    token_hash: Mapped[str] = mapped_column(String(128), unique=True)
    # SET NULL: ушедший из организации человек не уносит с собой запись о том,
    # кого он привёл.
    invited_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    accepted_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Заполняется только отправкой письма. Выпуск ссылки для копирования его
    # не трогает: письма не было, и в потолок рассылки такой выпуск не идёт.
    last_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Category(Base):
    __tablename__ = "categories"

    id: Mapped[uuid.UUID] = _uuid_pk()
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(200))
    color: Mapped[str] = mapped_column(String(9))
    position: Mapped[int] = mapped_column(Integer, default=0)


class Task(Base):
    __tablename__ = "tasks"
    __table_args__ = (
        # Позиция уникальна внутри категории — это и есть модель порядка.
        # DEFERRABLE INITIALLY DEFERRED: перестановка перенумеровывает
        # несколько строк одной транзакцией, и проверка в момент каждого
        # UPDATE ловила бы промежуточные дубли, которых в итоге нет.
        UniqueConstraint(
            "category_id",
            "position",
            name="uq_tasks_category_position",
            deferrable=True,
            initially="DEFERRED",
        ),
        # Инварианты домена держит база, а не только слой мутаций: второй
        # путь записи (восстановление из журнала, ручной SQL) не должен уметь
        # положить строку, которую слой мутаций не принял бы.
        CheckConstraint("progress_pct BETWEEN 0 AND 100", name="ck_tasks_progress_pct"),
        CheckConstraint("duration_days >= 1", name="ck_tasks_duration_days"),
        # Веха — точка на шкале, и один день это и означает. Инвариант держит
        # база, а не только слой мутаций: веха с длительностью в неделю
        # рисуется ромбом, а считается отрезком, и расхождение между тем, что
        # видно, и тем, что посчитано, — худший род ошибки в диаграмме.
        CheckConstraint(
            "NOT milestone OR duration_days = 1", name="ck_tasks_milestone_duration"
        ),
        CheckConstraint(
            "criticality IN (" + ", ".join(f"'{level}'" for level in CRITICALITY_LEVELS) + ")",
            name="ck_tasks_criticality",
        ),
        CheckConstraint(
            "status IN (" + ", ".join(f"'{status}'" for status in TASK_STATUSES) + ")",
            name="ck_tasks_status",
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    # Строки ганта группируются по категории — выборка идёт с этой колонки.
    category_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("categories.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(300))
    description: Mapped[str] = mapped_column(Text, default="")
    internal_note: Mapped[str] = mapped_column(Text, default="")
    start_date: Mapped[date] = mapped_column(Date)
    duration_days: Mapped[int] = mapped_column(Integer)
    # Веха: сдача этапа, согласование, дедлайн подрядчика — то, что происходит
    # в день, а не длится. Признак задачи, а не отдельная таблица: у вехи те же
    # имя, категория, статус, исполнители, комментарии и связи, и вторая
    # сущность означала бы второй набор операций, второй журнал и вторую
    # отмену ради одного различия в отрисовке.
    #
    # Длительность у вехи всё равно хранится (и равна одному дню — см.
    # ограничение выше): расчёт даты окончания, снимки плана и порог сдвига
    # спрашивают её у всех задач одинаково, и nullable-колонка добавила бы в
    # каждый из них ветку «а если веха».
    milestone: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    criticality: Mapped[str] = mapped_column(String(16), default="normal")
    progress_pct: Mapped[int] = mapped_column(Integer, default=0)
    # server_default — не только для миграции по живой таблице: второй путь
    # записи (ручной SQL) без него получил бы NOT NULL без значения.
    status: Mapped[str] = mapped_column(Text, default="planned", server_default=text("'planned'"))
    position: Mapped[int] = mapped_column(Integer, default=0)
    baseline_start: Mapped[date | None] = mapped_column(Date)
    baseline_duration: Mapped[int | None] = mapped_column(Integer)
    # Откуда взялась задача. В истории остаётся «создана AI-сессией от
    # 10 августа», и без этого поля такой записи неоткуда взяться: журнал
    # ревизий хранит операцию, а не её происхождение.
    created_by_ai_session_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("ai_sessions.id", ondelete="SET NULL")
    )
    # Когда задача стала «сделано» и когда взята в работу. Ставятся слоем
    # мутаций при переходе статуса и чистятся при уходе из него (см.
    # _stamp_status_change в app.mutations): скоркарду нужны «закрыто на этой
    # неделе» и «висит в работе N дней», а журнал ревизий отвечает на эти
    # вопросы только проходом по всем записям задачи. Колонка — последняя
    # граница, а не история: полную летопись переходов по-прежнему хранит
    # журнал.
    done_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    in_progress_since: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PlanVersion(Base):
    """Утверждённый план: снимок дат и длительностей на момент утверждения.

    Отдельная таблица, а не только baseline_* у задачи: базовые поля задачи
    хранят последнюю версию, а летопись «что обещали в январе, что в марте»
    требует всех предыдущих. Версии нумеруются внутри проекта, и уникальное
    ограничение держит эту нумерацию: два одновременных утверждения иначе
    получили бы один номер.
    """

    __tablename__ = "plan_versions"
    __table_args__ = (UniqueConstraint("project_id", "version"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    version: Mapped[int] = mapped_column(Integer)
    # SET NULL: удаление аккаунта не должно ни падать по внешнему ключу,
    # ни уносить летопись утверждений — запись остаётся, автор забывается.
    approved_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    approved_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    # jsonb по той же причине, что и журнал ревизий: снимок читается целиком,
    # но по нему же ищут задачу при сравнении версий.
    snapshot: Mapped[dict] = mapped_column(JSONB)


class TaskAssignee(Base):
    __tablename__ = "task_assignees"
    __table_args__ = (UniqueConstraint("task_id", "user_id"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    task_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"))
    # «Задачи этого человека» ищутся с колонки user_id; составной уникальный
    # (task_id, user_id) ведёт не с неё и здесь бесполезен.
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )


class Dependency(Base):
    __tablename__ = "dependencies"
    __table_args__ = (UniqueConstraint("from_task_id", "to_task_id"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    # Связи проекта читаются целиком на каждый GET состояния.
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    from_task_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"))
    # Обратный конец: «кто ждёт эту задачу» и снимок связей при её удалении.
    # Прямой конец покрыт префиксом уникального (from_task_id, to_task_id).
    to_task_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), index=True
    )


class OrgLlmCredential(Base):
    """Подключение LLM: одно на организацию.

    `base_url` и `model` — обязательные настройки, а не константы: без них
    BYOK работает с одним облаком по одной зашитой модели, и обещание «можно
    подсунуть локальную модель» остаётся на словах.

    Ключ шифруется симметрично секретом приложения и наружу не отдаётся
    никогда — только признак «ключ настроен».
    """

    __tablename__ = "org_llm_credentials"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), unique=True
    )
    provider: Mapped[str] = mapped_column(String(32), default="openai")
    base_url: Mapped[str] = mapped_column(String(300))
    model: Mapped[str] = mapped_column(String(100))
    encrypted_key: Mapped[str] = mapped_column(Text)


class JiraConnection(Base):
    """Подключение Jira: одно на организацию.

    Basic-аутентификация Jira Cloud — email участника и API-токен, выпущенный
    в его профиле (id.atlassian.com/manage-profile/security/api-tokens).
    OAuth 2.0 (3LO) устроен сложнее — своё приложение, редиректы, обновляемые
    токены — и в MVP не нужен: организация, вводящая сюда свои же учётные
    данные, доверяет собственному инстансу Jira ровно так же, как доверяет
    адресу и ключу LLM.

    Токен шифруется тем же способом, что ключ LLM (см. OrgLlmCredential), и
    наружу не отдаётся никогда — только признак «подключено».
    """

    __tablename__ = "jira_connections"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), unique=True
    )
    base_url: Mapped[str] = mapped_column(String(300))
    email: Mapped[str] = mapped_column(String(320))
    encrypted_token: Mapped[str] = mapped_column(Text)


class JiraProjectLink(Base):
    """Проект Planora, заведённый импортом из проекта Jira.

    Одна связь на проект: второй импорт того же плана из другой строки Jira
    не имеет смысла — планом либо управляет Jira, либо нет. `jql` хранит
    запрос исходного импорта (по умолчанию — все задачи проекта Jira), и
    повторная синхронизация спрашивает Jira о том же подмножестве, а не обо
    всём инстансе.
    """

    __tablename__ = "jira_project_links"

    id: Mapped[uuid.UUID] = _uuid_pk()
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), unique=True
    )
    jira_project_key: Mapped[str] = mapped_column(String(64))
    jql: Mapped[str] = mapped_column(Text)
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class JiraCategoryLink(Base):
    """Этап плана, заведённый из эпика Jira, — привязка для повторной синхронизации.

    Отдельная таблица от JiraTaskLink, а не общая с признаком «вид строки»:
    категория и задача ссылаются на разные таблицы плана, и общая колонка
    держала бы половину значений пустыми на каждой строке.
    """

    __tablename__ = "jira_category_links"
    __table_args__ = (UniqueConstraint("project_id", "issue_key"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    category_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("categories.id", ondelete="CASCADE"), unique=True
    )
    issue_key: Mapped[str] = mapped_column(String(64))


class JiraTaskLink(Base):
    """Задача плана, заведённая из строки Jira, — привязка для повторной синхронизации.

    `issue_key`, а не внутренний числовой id Jira: ключ виден человеку в
    самой Jira и меняется только явным переносом задачи между проектами, а
    числовой id не нужен нигде в этом продукте.

    `task_id` — SET NULL, а не CASCADE, вопреки остальным привязкам этого
    модуля: удаление задачи человеком в Planora — осознанное решение, и
    повторная синхронизация не должна его отменять, воскрешая строку по
    первому же совпадению ключа. Строка с `task_id IS NULL` — надгробие: она
    остаётся в таблице только затем, чтобы этот самый ключ больше не считался
    новым (см. app/jira/sync.py:_sync_tasks).

    `pushed_due_date` — дата, последней отправленная в Jira кнопкой «Отправить
    в Jira» (см. app/jira/sync.py:push_project). `NULL` — сроки этой задачи
    ведёт Jira: обычная синхронизация подтягивает `duedate` оттуда как обычно.
    Заполненное значение переворачивает направление для дат этой конкретной
    задачи: она заведена человеком в Planora как источник правды по срокам, и
    обычная синхронизация больше не трогает её старт и длительность — только
    отправка снова меняет это поле. Свойство задачи, а не проекта целиком:
    в одном плане часть строк может остаться под Jira, а часть — перейти под
    ручное управление, по мере того как их даты поправляют здесь.
    """

    __tablename__ = "jira_task_links"
    __table_args__ = (UniqueConstraint("project_id", "issue_key"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    task_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tasks.id", ondelete="SET NULL"), unique=True
    )
    issue_key: Mapped[str] = mapped_column(String(64))
    pushed_due_date: Mapped[date | None] = mapped_column(Date)


class AiSession(Base):
    """Интервью, конспект и черновик — до применения в проект.

    Живёт отдельно от проекта, потому что проекта до применения не существует:
    AI ничего не пишет в проект без явного подтверждения человека.
    """

    __tablename__ = "ai_sessions"

    id: Mapped[uuid.UUID] = _uuid_pk()
    org_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    # Заполняется после применения: до него проекта нет.
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("projects.id", ondelete="SET NULL")
    )
    # SET NULL — по той же причине, что у plan_versions.approved_by.
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    # Язык интервью фиксируется на сессии, а не берётся из профиля каждый раз:
    # человек, переключивший интерфейс посреди интервью, иначе получил бы
    # черновик наполовину на одном языке, наполовину на другом.
    locale: Mapped[str] = mapped_column(String(5), default="az")
    status: Mapped[str] = mapped_column(String(16), default="interview")
    transcript: Mapped[list] = mapped_column(JSONB, default=list)
    summary: Mapped[list] = mapped_column(JSONB, default=list)
    draft: Mapped[dict] = mapped_column(JSONB, default=dict)
    tokens_used: Mapped[int] = mapped_column(Integer, default=0)
    applied_batch_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Revision(Base):
    __tablename__ = "revisions"
    __table_args__ = (
        UniqueConstraint("project_id", "seq"),
        # GIN по полезной нагрузке: история задачи ищется вхождением
        # task_id в op (см. serialization), и без индекса это последовательное
        # чтение всего журнала проекта на каждое открытие карточки.
        Index("ix_revisions_op_gin", "op", postgresql_using="gin"),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    seq: Mapped[int] = mapped_column(Integer)
    # SET NULL: журнал ревизий переживает удаление автора — история проекта
    # не собственность аккаунта.
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    # jsonb, а не json: все три фичи, ради которых ведётся журнал, ищут по
    # содержимому полезной нагрузки. json хранит сырой текст, не умеет
    # операторов вхождения и не индексируется GIN. Продукт только под
    # Postgres; менять это после появления боевых записей — переписывание
    # таблицы, сегодня — бесплатно.
    op: Mapped[dict] = mapped_column(JSONB)
    inverse: Mapped[dict] = mapped_column(JSONB)
    reason: Mapped[str | None] = mapped_column(Text)
    # Пакет ревизий читается целиком при отмене групповой операции.
    batch_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    # Номер ревизии, которую эта отменила. Без него «отменить последнее»
    # означало бы отменить свою же отмену: журнал линеен, и вторая ревизия
    # сверху после отмены — это она сама. Внешнего ключа нет намеренно:
    # ссылаться пришлось бы на составной (project_id, seq), а выигрыш от такой
    # ссылки нулевой — ревизии не удаляются.
    undoes_seq: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Proposal(Base):
    """Коммерческое предложение проекта: настройки сметы.

    Одна строка на проект, и заводится она лениво — первым изменением, а не
    созданием проекта: у большинства проектов предложения нет, и пустая
    строка на каждый из них была бы записью ради записи. Чтение без строки
    отдаёт значения по умолчанию (см. app.proposals).

    Ставка и налог живут здесь, а не в организации: предложение составляется
    под конкретного клиента, и в соседних проектах и валюта, и налог свои.
    """

    __tablename__ = "proposals"
    __table_args__ = (
        # Тот же принцип, что у schedule_mode: инвариант держит база, а не
        # только слой приложения.
        CheckConstraint(
            "effort_unit IN (" + ", ".join(f"'{unit}'" for unit in EFFORT_UNITS) + ")",
            name="ck_proposals_effort_unit",
        ),
        CheckConstraint("hours_per_day >= 1", name="ck_proposals_hours_per_day"),
        CheckConstraint("tax_rate_pct >= 0", name="ck_proposals_tax_rate_pct"),
        CheckConstraint(
            "status IN (" + ", ".join(f"'{status}'" for status in PROPOSAL_STATUSES) + ")",
            name="ck_proposals_status",
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    # unique: предложение у проекта одно. Второе — это другой проект, а не
    # вторая строка здесь.
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), unique=True
    )
    effort_unit: Mapped[str] = mapped_column(
        Text, default=EffortUnit.DAYS, server_default=text("'days'")
    )
    # Сколько часов считать рабочим днём при переносе почасовой сметы в план:
    # у плана длительности в днях, и без этого числа их не из чего получить.
    hours_per_day: Mapped[int] = mapped_column(Integer, default=8, server_default=text("8"))
    # Numeric, а не Float: налог — деньги, и 18% обязаны оставаться ровно
    # восемнадцатью, а не 17.999999.
    tax_rate_pct: Mapped[Decimal] = mapped_column(
        Numeric(5, 2), default=Decimal("0"), server_default=text("0")
    )
    # Код ISO 4217. Хранится, а не выводится из языка: язык интерфейса и
    # валюта сделки — независимые вещи.
    currency: Mapped[str] = mapped_column(String(3), default="USD", server_default=text("'USD'"))
    # Допущения и примечания предложения целиком — «оценки по текущему объёму»,
    # «ставки без стоимости лицензий». Свободный текст, а не список: пункты
    # пишут строками, и структура списка не добавила бы к ним ничего.
    notes: Mapped[str] = mapped_column(Text, default="", server_default=text("''"))
    # Этап сделки, отмеченный рукой: черновик, отправлено клиенту, согласовано.
    # Отметки времени рядом — подписи под полосой этапов («отправлено 27 авг»);
    # шаг назад их снимает, чтобы полоса не называла дату этапа, которого
    # больше нет.
    status: Mapped[str] = mapped_column(
        Text, default=ProposalStatus.DRAFT, server_default=text("'draft'")
    )
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    agreed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ProposalCategory(Base):
    """Раздел предложения: группа работ со своими строками.

    Своя таблица, а не Category плана: раздел сметы живёт до плана и без
    плана, а категория диаграммы несёт цвет и участвует в порядке ленты —
    смешение двух жизней в одной таблице означало бы, что черновик сметы
    виден на диаграмме.
    """

    __tablename__ = "proposal_categories"

    id: Mapped[uuid.UUID] = _uuid_pk()
    proposal_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("proposals.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(200))
    # Одна строка о разделе целиком — «понять цели, людей и требования»:
    # в таблице сметы она стоит на строке раздела, рядом с суммой его работ.
    description: Mapped[str] = mapped_column(Text, default="", server_default=text("''"))
    position: Mapped[int] = mapped_column(Integer, default=0)


class ProposalTask(Base):
    """Строка сметы: работа, роль, трудоёмкость и ставка.

    Цена не хранится намеренно: она равна effort × rate, и хранимая копия
    разъехалась бы с сомножителями первой же правкой. Считают её оба конца
    заново — клиент для экрана, сервер нигде не пересказывает.
    """

    __tablename__ = "proposal_tasks"
    __table_args__ = (
        CheckConstraint("effort >= 0", name="ck_proposal_tasks_effort"),
        CheckConstraint("rate >= 0", name="ck_proposal_tasks_rate"),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    # Обе ссылки сразу: раздел — для порядка на экране, предложение — чтобы
    # строки проекта читались одним запросом, без прохода по разделам.
    proposal_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("proposals.id", ondelete="CASCADE"), index=True
    )
    category_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("proposal_categories.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(300))
    # Короткое описание — колонка таблицы; подробное — карточка строки.
    description: Mapped[str] = mapped_column(Text, default="")
    details: Mapped[str] = mapped_column(Text, default="")
    # Роль исполнителя словами («дизайнер», «senior backend»), а не ссылка на
    # участника: смету пишут до того, как известно, кто именно будет делать.
    role: Mapped[str] = mapped_column(String(120), default="")
    # Трудоёмкость в единицах предложения (см. Proposal.effort_unit). Numeric:
    # полдня — это 0.5, а не 0.5000000000000001.
    effort: Mapped[Decimal] = mapped_column(
        Numeric(8, 2), default=Decimal("0"), server_default=text("0")
    )
    # Ставка за единицу трудоёмкости, в валюте предложения.
    rate: Mapped[Decimal] = mapped_column(
        Numeric(12, 2), default=Decimal("0"), server_default=text("0")
    )
    notes: Mapped[str] = mapped_column(Text, default="")
    risks: Mapped[str] = mapped_column(Text, default="")
    assumptions: Mapped[str] = mapped_column(Text, default="")
    position: Mapped[int] = mapped_column(Integer, default=0)
    # Задача плана, в которую строка уже перенесена. SET NULL, а не CASCADE:
    # удаление задачи — в том числе отменой пачки переноса — возвращает строку
    # в переносимые, а не уносит её из предложения. По этой ссылке перенос
    # пропускает уже перенесённое: без неё второй перенос удваивал план.
    plan_task_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tasks.id", ondelete="SET NULL"), index=True
    )
    # Для подсказок ролей: «последняя ставка этой роли» — ставка самой свежей
    # строки, и свежесть не из чего вывести без метки. clock_timestamp, а не
    # now(): строки, заведённые одной транзакцией (сбор из плана), должны
    # различаться по времени, а now() у всех них одно.
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.clock_timestamp()
    )


class ProposalComment(Base):
    """Реплика к строке сметы.

    Своя таблица, а не Comment проекта: та жёстко связана с задачами плана
    (task_id ведёт в tasks) и с публичной страницей, а обсуждение сметы —
    внутренний разговор участников, гостям оно не отдаётся вовсе. Поэтому и
    автор здесь обязателен: гостя, подписанного именем, не бывает.
    """

    __tablename__ = "proposal_comments"

    id: Mapped[uuid.UUID] = _uuid_pk()
    proposal_task_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("proposal_tasks.id", ondelete="CASCADE"), index=True
    )
    # CASCADE, как у Comment: реплика без автора не подписана никем.
    author_user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE")
    )
    body: Mapped[str] = mapped_column(Text)
    # clock_timestamp по той же причине, что у Comment: порядок разговора
    # держится на метке, и две реплики одной транзакции неразличимы по now().
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.clock_timestamp()
    )


class ScorecardDirection(StrEnum):
    """Куда должна смотреть метрика скоркарда: «не больше цели» или «не меньше»."""

    LTE = "lte"
    GTE = "gte"


SCORECARD_DIRECTIONS: tuple[str, ...] = tuple(d.value for d in ScorecardDirection)


class ScorecardStatus(StrEnum):
    """Оценка недели по метрике. `no_data` — источника нет или метрика
    выключена: серый прочерк, в сериях и правилах не участвует."""

    OK = "ok"
    WARN = "warn"
    RISK = "risk"
    NO_DATA = "no_data"


SCORECARD_STATUSES: tuple[str, ...] = tuple(s.value for s in ScorecardStatus)


class ScorecardAlertKind(StrEnum):
    RULE_TRIGGERED = "rule_triggered"
    METRIC_RISK = "metric_risk"


SCORECARD_ALERT_KINDS: tuple[str, ...] = tuple(k.value for k in ScorecardAlertKind)


class ScorecardMetric(Base):
    """Настройка метрики скоркарда — на проект, не на организацию.

    Строки заводятся лениво, первым открытием скоркарда проекта (см.
    app.scorecard.ensure_metrics): дефолты — только сид, дальше владелец,
    цель и включённость правятся PATCH-ем и действуют в своём проекте.
    Направление в таблице всё же хранится, хотя оно жёстко следует из ключа:
    снимок копирует конфиг на момент записи, и без колонки здесь копировать
    было бы неоткуда при смене констант в коде.
    """

    __tablename__ = "scorecard_metrics"
    __table_args__ = (
        UniqueConstraint("project_id", "metric_key"),
        # Тот же принцип, что у schedule_mode: инвариант держит база, а не
        # только слой приложения.
        CheckConstraint(
            "direction IN (" + ", ".join(f"'{d}'" for d in SCORECARD_DIRECTIONS) + ")",
            name="ck_scorecard_metrics_direction",
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    metric_key: Mapped[str] = mapped_column(String(40))
    # SET NULL: удаление аккаунта оставляет метрику без владельца, а не
    # уносит её настройку.
    owner_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    # Numeric, а не Float: цель «90%» обязана оставаться ровно девяноста.
    target_value: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    direction: Mapped[str] = mapped_column(String(3))
    # Порог «жёлтого» — задел на будущее, в MVP не используется: статусы
    # считаются от цели множителями-константами (см. app.scorecard).
    warn_value: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    position: Mapped[int] = mapped_column(Integer, default=0)


class ScorecardSnapshot(Base):
    """Недельный снимок метрики: значение, статус и копия конфига на момент
    записи.

    Снимки прошлых недель неизменяемы — это летопись, по которой считаются
    серии и спарклайн. Перезаписывается только строка текущей недели: она же
    служит кэшем живого расчёта (см. app.scorecard). Цель и направление
    копируются в снимок сознательно: правка цели сегодня не должна
    перекрашивать прошлые недели.
    """

    __tablename__ = "scorecard_snapshots"
    __table_args__ = (
        UniqueConstraint("project_id", "metric_key", "week_start"),
        # История читается «все метрики проекта за N недель» — с этой пары.
        Index("ix_scorecard_snapshots_project_week", "project_id", "week_start"),
        CheckConstraint(
            "direction IN (" + ", ".join(f"'{d}'" for d in SCORECARD_DIRECTIONS) + ")",
            name="ck_scorecard_snapshots_direction",
        ),
        CheckConstraint(
            "status IN (" + ", ".join(f"'{s}'" for s in SCORECARD_STATUSES) + ")",
            name="ck_scorecard_snapshots_status",
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    metric_key: Mapped[str] = mapped_column(String(40))
    # Понедельник ISO-недели в таймзоне проекта.
    week_start: Mapped[date] = mapped_column(Date)
    # NULL — данных нет (источник отсутствует или метрика была выключена).
    value: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    target_value: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    direction: Mapped[str] = mapped_column(String(3))
    status: Mapped[str] = mapped_column(String(8))
    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    # NULL — снимок записан не человеком, а ленивой фиксацией на GET.
    computed_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    # Сериализованный drill-down: id и краткие атрибуты задач метрики. jsonb
    # по правилу журнала: прошлые недели читаются только отсюда, и по ключам
    # внутри однажды придётся искать.
    details: Mapped[dict] = mapped_column(JSONB, default=dict)


class ScorecardAlert(Base):
    """Событие панели «Требует внимания».

    `metric_risk` живёт, пока метрика в красном на текущей неделе;
    `rule_triggered` — след сработавшего правила «красная 2 недели подряд»
    со ссылкой на созданную задачу в payload. Закрытые события не удаляются,
    а помечаются resolved_at: по ним видно, когда серия оборвалась, и по ним
    же подавляется повтор правила внутри одной серии.
    """

    __tablename__ = "scorecard_alerts"
    __table_args__ = (
        CheckConstraint(
            "kind IN (" + ", ".join(f"'{k}'" for k in SCORECARD_ALERT_KINDS) + ")",
            name="ck_scorecard_alerts_kind",
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    # События читаются пачкой на каждый GET скоркарда — с этой колонки.
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    metric_key: Mapped[str] = mapped_column(String(40))
    week_start: Mapped[date] = mapped_column(Date)
    kind: Mapped[str] = mapped_column(String(16))
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
