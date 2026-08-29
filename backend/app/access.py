from enum import StrEnum

from app.models import Role


class Action(StrEnum):
    PROJECT_READ = "project_read"
    PROJECT_WRITE = "project_write"
    PROJECT_ADMIN = "project_admin"
    ORG_ADMIN = "org_admin"
    COMMENT = "comment"
    READ_INTERNAL_NOTE = "read_internal_note"
    # Утверждение и переутверждение — разные права, а не одно: первое доступно
    # редактору, второе спецификация оставляет владельцу. Переутверждение
    # стирает базовый план, от которого считаются все объяснённые сдвиги, —
    # то есть обнуляет накопленную летопись отставания, и это решение уровня
    # владельца, а не рядовая правка сроков.
    PLAN_APPROVE = "plan_approve"
    PLAN_REAPPROVE = "plan_reapprove"
    # Удаление проекта — отдельное право, а не часть PROJECT_ADMIN: настройки
    # правит и редактор, но удаление уносит с собой журнал ревизий — то есть
    # и всякую возможность отмены. Решение такого веса, как и переутверждение
    # плана, спецификация оставляет владельцу.
    PROJECT_DELETE = "project_delete"
    # Выгрузка проекта файлом. Отдельное право, хотя сегодня его имеет каждый,
    # кто вправе проект читать: снимок плана, унесённый файлом, живёт дальше
    # своей жизнью и отзыву не подлежит — в отличие от публичной ссылки,
    # которую можно закрыть. Названное право даёт установке, которой это
    # важно, один рычаг вместо разбирательства по маршрутам.
    #
    # Разница в содержимом файла правом не выражается: её решают уже
    # существующие READ_INTERNAL_NOTE и правило показа исполнителей, ровно те
    # же, что действуют на публичной странице.
    PROJECT_EXPORT = "project_export"


_MATRIX: dict[Role | None, frozenset[Action]] = {
    Role.OWNER: frozenset(Action),
    Role.EDITOR: frozenset(
        {
            Action.PROJECT_READ,
            Action.PROJECT_WRITE,
            Action.PROJECT_ADMIN,
            Action.COMMENT,
            Action.READ_INTERNAL_NOTE,
            Action.PLAN_APPROVE,
            Action.PROJECT_EXPORT,
        }
    ),
    Role.VIEWER: frozenset(
        {
            Action.PROJECT_READ,
            Action.COMMENT,
            Action.READ_INTERNAL_NOTE,
            Action.PROJECT_EXPORT,
        }
    ),
    # Клиент и гость по ссылке выгружают клиентский экземпляр: тот же урез,
    # что уже действует на публичной странице. Отказать им было бы странно —
    # то же самое они видят на экране и могут снять снимком экрана.
    Role.CLIENT: frozenset(
        {Action.PROJECT_READ, Action.COMMENT, Action.PROJECT_EXPORT}
    ),
    None: frozenset({Action.PROJECT_READ, Action.COMMENT, Action.PROJECT_EXPORT}),
}

# Роли, которые видят только те проекты, куда их позвали явно, — независимо от
# того, сужено ли конкретное членство (см. needs_project_grant).
_NEEDS_GRANT: frozenset[Role | None] = frozenset({Role.CLIENT, None})


# Значение роли, которого нет в Role. Не None: None — это гость по ссылке, у
# которого права есть. Незнакомая роль не должна получать вообще ничего.
UNKNOWN_ROLE = "__unknown__"


def parse_role(raw: str | None) -> Role | str | None:
    """Роль из записи членства в вид, понятный can().

    Role(raw) на испорченном значении поднимает ValueError — то есть пятисотку
    ещё до того, как спросят can(), и запертая по умолчанию матрица прав
    оказывается недостижимой. Незнакомое значение — это отказ, а не авария.
    """
    if raw is None:
        return None
    try:
        return Role(raw)
    except ValueError:
        return UNKNOWN_ROLE


def needs_project_grant(role: Role | str | None, *, scoped: bool = False) -> bool:
    """Видит ли эта роль (или это конкретное членство) только те проекты,
    куда её позвали поимённо.

    `scoped` — не свойство роли, а свойство членства (Membership.project_scoped):
    приглашающий вправе сузить и редактора, и наблюдателя до конкретных
    проектов, не трогая саму роль и её матрицу прав. `client` и гость по
    ссылке сужены всегда, независимо от значения `scoped`, — их и спрашивать
    не о чем, отсюда `or`, а не замена.

    Владелец не сужается никогда, даже если на его записи членства зачем-то
    стоит `project_scoped=True` (например, редактора с сужением повысили): он
    один распоряжается организацией целиком, и запертый в горстке проектов
    владелец — это организация без администратора.

    Спрашивается снаружи — списком проектов и загрузкой одного проекта: им
    нужно знать не только «можно ли», но и «по какому правилу отбирать».
    Знание о том, какие роли устроены так, остаётся здесь, в единственном
    месте, где решается доступ.
    """
    if role is Role.OWNER:
        return False
    return role in _NEEDS_GRANT or scoped


def can(
    role: Role | None, action: Action, *, project_granted: bool = False, scoped: bool = False
) -> bool:
    if needs_project_grant(role, scoped=scoped) and not project_granted:
        return False
    # .get с пустым множеством по умолчанию: незнакомая роль не находит себя в
    # матрице и не может ничего — матрица заперта по умолчанию.
    return action in _MATRIX.get(role, frozenset())


def require(
    role: Role | None, action: Action, *, project_granted: bool = False, scoped: bool = False
) -> None:
    if not can(role, action, project_granted=project_granted, scoped=scoped):
        raise PermissionError(f"{role or 'guest'} не может выполнить {action}")


# Поля журнала, показывать которые вправе не каждый. Сегодня оно ровно одно —
# спецификация обещает, что сложной видимости по полям не будет.
_NOTE_FIELD = "internal_note"


def _carries_note(payload: dict) -> bool:
    """Есть ли заметка где-нибудь в записи, включая вложенные словари и списки."""
    return any(key == _NOTE_FIELD or _nested_note(value) for key, value in payload.items())


def _nested_note(value: object) -> bool:
    """Заметка внутри значения — словаря или списка словарей."""
    if isinstance(value, dict):
        return _carries_note(value)
    if isinstance(value, list):
        return any(_nested_note(item) for item in value)
    return False


def _without_note(payload: dict) -> dict:
    """Копия записи без заметки — на любой глубине вложенности.

    Плоской проверки «есть ли такой ключ в корне» не хватает: set_task_fields
    кладёт заметку не в корень, а внутрь from и to, и на нём такая проверка
    молча не срабатывает — заметка уезжает в ответ. Обход по вложенным
    словарям делает правило нечувствительным к форме записи, а значит и к
    форме операций, которых ещё нет.

    Списки обходятся наравне со словарями, и это не запас на будущее: снимок
    удалённой категории несёт свои задачи именно списком, и заметка каждой из
    них лежит на два уровня вглубь — в словаре внутри списка внутри записи.
    """
    return {
        key: _prune_note(value)
        for key, value in payload.items()
        if key != _NOTE_FIELD
    }


def _prune_note(value):
    """Значение без заметки: словарь — по ключам, список — поэлементно."""
    if isinstance(value, dict):
        return _without_note(value)
    if isinstance(value, list):
        return [_prune_note(item) for item in value]
    return value


def visible_op(payload: dict, role: Role | None, *, project_granted: bool = False) -> dict:
    """Запись журнала в том виде, в каком её вправе увидеть эта роль.

    Решение о видимости живёт здесь, а не в маршруте: то же самое понадобится
    истории изменений на карточке задачи, и её автор не должен заново
    выяснять, какие операции несут заметку. create_task кладёт internal_note
    в op наравне с остальными полями, delete_task — в inverse (снимок для
    отмены), set_task_fields — внутрь обеих границ.

    Возвращает новый словарь: revision.op / revision.inverse на самой записи
    не трогаются, иначе будущая отмена восстановила бы задачу без заметки.
    """
    if not _carries_note(payload):
        return payload
    if can(role, Action.READ_INTERNAL_NOTE, project_granted=project_granted):
        return payload
    return _without_note(payload)
