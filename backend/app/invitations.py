"""Приглашения в организацию: выпуск, отзыв, повторный выпуск и приём.

Модуль ничего не знает про HTTP: он поднимает `InvitationError` с машинным
кодом, а превращать код в статус ответа — дело маршрута. Ровно так же устроены
мутации, и по той же причине: то же самое понадобится приёму приглашения при
регистрации, где HTTP-слой другой.
"""

import uuid
from datetime import datetime, timedelta
from enum import StrEnum

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.models import Invitation, Membership, Project, ProjectAccess, Role, User
from app.security import hash_token, new_token
from app.text import normalize_email

# Окно потолка приглашений. Час зашит, а не настраивается: настройкой задаётся
# сам потолок (`INVITE_RATE_LIMIT`), и второе число рядом с ним превращает
# понятное «столько-то в час» в задачу на умножение.
RATE_LIMIT_WINDOW = timedelta(hours=1)


class InvitationError(Exception):
    """Отказ домена приглашений, названный машинным кодом.

    Текста на человеческом языке здесь нет сознательно: язык читателя решается
    в браузере, и один и тот же отказ обязан читаться на трёх языках.
    """

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class Status(StrEnum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    REVOKED = "revoked"
    EXPIRED = "expired"


def status_of(invitation: Invitation, now: datetime) -> Status:
    """Состояние приглашения на заданный момент.

    Порядок проверок не случаен: принятое приглашение остаётся принятым и
    после истечения срока, и человек, открывший свою же старую ссылку, должен
    прочитать «вы уже в организации», а не «срок истёк» — по первому он пойдёт
    просить новую ссылку вместо того, чтобы просто войти.
    """
    if invitation.accepted_at is not None:
        return Status.ACCEPTED
    if invitation.revoked_at is not None:
        return Status.REVOKED
    if invitation.expires_at <= now:
        return Status.EXPIRED
    return Status.PENDING


def _unavailable(state: Status) -> InvitationError:
    """Отказ, который называет причину, а не «ссылка недействительна».

    Три состояния — три разных кода: по «просрочено» человек просит новую
    ссылку, по «принято» — просто входит, по «отозвано» — идёт к тому, кто
    звал. Одно общее сообщение не даёт выбрать ни одно из трёх действий.
    """
    return InvitationError(f"invite_{state.value}")


#: Роли, которые приглашением не выдаются. Владелец распоряжается организацией
#: целиком — удаляет проекты, переутверждает планы, зовёт кого угодно, — а
#: приглашение без адреса вдобавок достаётся предъявителю: владельцем
#: становился любой, кто открыл переславшуюся ссылку. Владельца назначает
#: владелец, действующему участнику и отдельным действием — тем самым
#: `PATCH /api/org/members/{user_id}`, где адресат назван поимённо.
NOT_INVITABLE: frozenset[Role] = frozenset({Role.OWNER})


def _parse_role(raw: str) -> Role:
    try:
        role = Role(raw)
    except ValueError as error:
        raise InvitationError("unknown_role") from error
    if role in NOT_INVITABLE:
        raise InvitationError("role_not_invitable")
    return role


def _checked_project_ids(
    db: DbSession, *, org_id: uuid.UUID, project_ids: list[uuid.UUID]
) -> list[str]:
    """Проекты, к которым приглашение сразу даёт доступ.

    Доступна любой приглашаемой роли, не только `client`: отмеченные проекты
    сужают членство целиком (см. Membership.project_scoped в app.models) — то
    есть позволяют позвать редактора или наблюдателя в конкретные проекты
    вместо всей организации сразу. Пустой список ничего не сужает: роль
    остаётся при своём — `client` по-прежнему не видит ни одного проекта, пока
    её не позовут поимённо, а `editor`/`viewer` видят всю организацию, как и
    без этой возможности.
    """
    if not project_ids:
        return []

    found = set(
        db.scalars(
            select(Project.id).where(Project.org_id == org_id, Project.id.in_(project_ids))
        ).all()
    )
    if len(found) != len(set(project_ids)):
        # Чужой проект неотличим от несуществующего — тем же принципом, что и
        # в маршрутах проекта.
        raise InvitationError("project_not_found")
    return [str(project_id) for project_id in project_ids]


def issued_within_window(db: DbSession, *, org_id: uuid.UUID, now: datetime) -> int:
    """Сколько приглашений организация выпустила за последний час.

    Считаются два события, каждое из которых может отправить письмо: создание
    записи и отправка письма по уже существующей. Выпуск ссылки для
    копирования в потолок не идёт — письма при нём не уходит, а потолок стоит
    ровно против того, чтобы установка превратилась в бесплатный рассыльщик с
    чужого домена.
    """
    since = now - RATE_LIMIT_WINDOW
    return db.scalar(
        select(func.count())
        .select_from(Invitation)
        .where(
            Invitation.org_id == org_id,
            or_(Invitation.created_at >= since, Invitation.last_sent_at >= since),
        )
    )


def ensure_capacity(db: DbSession, *, org_id: uuid.UUID, now: datetime, wanted: int) -> None:
    limit = get_settings().invite_rate_limit
    if issued_within_window(db, org_id=org_id, now=now) + wanted > limit:
        raise InvitationError("invite_rate_limited")


def _expiry(now: datetime) -> datetime:
    return now + timedelta(days=get_settings().invite_ttl_days)


def _is_member(db: DbSession, *, org_id: uuid.UUID, email: str) -> bool:
    """Состоит ли обладатель этого адреса в организации уже сейчас.

    Спрашивается до выпуска, а не после приёма: приглашение действующему
    участнику ничего не меняет — `accept` роли не трогает, — но выглядит как
    действие. Зовущий, промахнувшийся строкой в списке адресов, увидел бы
    «приглашение отправлено» и стал бы ждать, пока человек «войдёт», хотя тот
    внутри со вчера. Отказ называет это словами.
    """
    return (
        db.scalar(
            select(Membership.id)
            .join(User, User.id == Membership.user_id)
            .where(Membership.org_id == org_id, User.email == email)
        )
        is not None
    )


def _pending_for(
    db: DbSession, *, org_id: uuid.UUID, email: str, now: datetime
) -> Invitation | None:
    for invitation in db.scalars(
        select(Invitation).where(Invitation.org_id == org_id, Invitation.email == email)
    ).all():
        if status_of(invitation, now) is Status.PENDING:
            return invitation
    return None


def create(
    db: DbSession,
    *,
    org_id: uuid.UUID,
    inviter_id: uuid.UUID,
    role: str,
    emails: list[str],
    project_ids: list[uuid.UUID],
    now: datetime,
) -> list[tuple[Invitation, str]]:
    """Выпускает приглашения и возвращает их вместе с открытыми токенами.

    Открытый токен возвращается только отсюда и больше нигде: в базе лежит
    хеш, и восстановить ссылку позже невозможно — её показывают один раз.

    Пустой список адресов — не ошибка, а второй способ доставки: одно
    приглашение без адреса, ссылку от которого зовущий отправит как ему
    удобно. Такое приглашение достаётся предъявителю, и это осознанный размен.
    """
    parsed_role = _parse_role(role)
    stored_projects = _checked_project_ids(db, org_id=org_id, project_ids=project_ids)

    normalized: list[str | None] = []
    for raw in emails:
        address = normalize_email(raw)
        if not address:
            raise InvitationError("invalid_email")
        # Отказ на весь список, а не пропуск одного адреса: список набирают
        # вставкой из письма, и «пятерых позвали, шестого молча не стали»
        # обнаружилось бы через неделю по отсутствию человека. Проверка идёт
        # до создания записей — иначе часть приглашений уже существовала бы к
        # моменту отказа, и повторная отправка исправленного списка выпустила
        # бы их второй раз.
        if _is_member(db, org_id=org_id, email=address):
            raise InvitationError("already_member")
        if address not in normalized:
            normalized.append(address)
    recipients: list[str | None] = normalized or [None]

    ensure_capacity(db, org_id=org_id, now=now, wanted=len(recipients))

    issued: list[tuple[Invitation, str]] = []
    for address in recipients:
        # Живое приглашение на тот же адрес переиздаётся, а не дублируется:
        # два действующих токена на один адрес означают, что отозвать «то
        # самое письмо» уже нельзя — ровно то, ради чего повторная отправка
        # убивает прежний токен.
        existing = (
            None if address is None else _pending_for(db, org_id=org_id, email=address, now=now)
        )
        if existing is not None:
            existing.role = parsed_role.value
            existing.project_ids = stored_projects
            issued.append((existing, reissue(db, existing, now=now)))
            continue

        raw, hashed = new_token()
        invitation = Invitation(
            org_id=org_id,
            email=address,
            role=parsed_role.value,
            project_ids=stored_projects,
            token_hash=hashed,
            invited_by=inviter_id,
            # Момент задаётся явно, а не берётся у базы: по нему считается срок
            # жизни ссылки и часовой потолок, и три разных представления о
            # «сейчас» в одной записи однажды разъедутся — сначала в тестах,
            # потом на установке, где сервер приложения и сервер базы стоят в
            # разных часовых поясах.
            created_at=now,
            expires_at=_expiry(now),
        )
        db.add(invitation)
        issued.append((invitation, raw))

    db.flush()
    return issued


def reissue(db: DbSession, invitation: Invitation, *, now: datetime) -> str:
    """Выпускает новую ссылку взамен прежней и возвращает открытый токен.

    Прежний токен умирает в тот же момент: без этого отозвать уже отправленное
    письмо становится невозможно — старая ссылка продолжала бы работать рядом
    с новой. Срок жизни отсчитывается заново: ссылка, выпущенная сегодня,
    должна жить столько же, сколько любая другая выпущенная сегодня.
    """
    state = status_of(invitation, now)
    if state in (Status.ACCEPTED, Status.REVOKED):
        raise _unavailable(state)

    raw, hashed = new_token()
    invitation.token_hash = hashed
    invitation.expires_at = _expiry(now)
    db.flush()
    return raw


def revoke(db: DbSession, invitation: Invitation, *, now: datetime) -> None:
    """Убивает неиспользованное приглашение. Ссылка перестаёт работать сразу.

    Принятое приглашение не отзывается: членство уже создано, и снять его —
    другое действие над другой сущностью. Повторный отзыв — не ошибка: он
    ничего не меняет, а требовать от интерфейса угадывать состояние кнопки
    ради 409 значит ломать её на любой гонке двух вкладок.
    """
    state = status_of(invitation, now)
    if state is Status.ACCEPTED:
        raise _unavailable(state)
    if state is Status.REVOKED:
        return
    invitation.revoked_at = now
    db.flush()


def by_token(db: DbSession, raw_token: str) -> Invitation | None:
    """Приглашение по открытому токену. В базе лежит хеш — ищем по нему."""
    if not raw_token:
        return None
    return db.scalar(select(Invitation).where(Invitation.token_hash == hash_token(raw_token)))


def check_recipient(invitation: Invitation, email: str) -> None:
    """Тот ли это адрес, которому приглашение адресовано.

    Приглашение без адреса достаётся предъявителю — проверять нечего. С
    адресом — привязано к нему намертво: иначе пересланная ссылка пускает в
    организацию кого угодно, а именно этого приглашение с адресом и не должно
    допускать.
    """
    if invitation.email is not None and invitation.email != normalize_email(email):
        raise InvitationError("invite_wrong_email")


def accept(db: DbSession, invitation: Invitation, *, user: User, now: datetime) -> Membership:
    """Принимает приглашение: членство, доступы к проектам, отметка о приёме.

    Роль существующего членства не трогается. Приглашение — это способ позвать
    человека, а не способ переписать роль тому, кто уже внутри: иначе
    приглашение, выписанное на свой же адрес и принятое по невнимательности,
    разжаловало бы последнего владельца организации, и починить это стало бы
    некому. По той же причине не трогается и сужение (project_scoped)
    существующего членства: приглашение с отмеченными проектами, принятое тем,
    кто уже видел всю организацию, не должно молча урезать его до этого списка.
    """
    state = status_of(invitation, now)
    if state is not Status.PENDING:
        raise _unavailable(state)
    check_recipient(invitation, user.email)

    membership = db.scalar(
        select(Membership).where(
            Membership.org_id == invitation.org_id, Membership.user_id == user.id
        )
    )
    if membership is None:
        membership = Membership(
            org_id=invitation.org_id,
            user_id=user.id,
            role=invitation.role,
            # Отмеченные в приглашении проекты сужают новое членство целиком,
            # какой бы ни была роль: пустой список ничего не сужает — роль
            # остаётся при своём поведении по умолчанию (см. _checked_project_ids).
            project_scoped=bool(invitation.project_ids),
        )
        db.add(membership)

    grant_project_access(db, user_id=user.id, project_ids=invitation.project_ids)

    invitation.accepted_at = now
    invitation.accepted_by = user.id
    db.flush()
    return membership


def grant_project_access(db: DbSession, *, user_id: uuid.UUID, project_ids: list) -> None:
    """Выдаёт поимённый доступ к проектам, пропуская уже выданный.

    Проекты сверяются с базой ещё раз, а не берутся из приглашения на веру:
    между выпуском ссылки и её приёмом проходят дни, и проект за это время
    могли удалить. Ссылка на исчезнувший проект — не повод отказать человеку
    во входе в организацию.
    """
    wanted = {uuid.UUID(str(project_id)) for project_id in project_ids}
    if not wanted:
        return

    alive = set(db.scalars(select(Project.id).where(Project.id.in_(wanted))).all())
    already = set(
        db.scalars(
            select(ProjectAccess.project_id).where(
                ProjectAccess.user_id == user_id, ProjectAccess.project_id.in_(alive)
            )
        ).all()
    )
    for project_id in sorted(alive - already, key=str):
        db.add(ProjectAccess(project_id=project_id, user_id=user_id))
    db.flush()
