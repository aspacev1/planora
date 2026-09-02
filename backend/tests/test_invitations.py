"""Приглашения как домен: выпуск, отзыв, повторный выпуск и приём.

Тесты бьют по функциям модуля, а не по HTTP: те же правила действуют и на
приёме по ссылке, и на регистрации по ней, а HTTP-слой у этих двух путей
разный. Отдельно проверяется то, что спецификация требует держать в тестах
явно: токен лежит хешем, принятое приглашение не срабатывает второй раз, роль
из ссылки не подменяется, лимит срабатывает.
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.auth import register
from app.config import get_settings
from app.invitations import (
    InvitationError,
    Status,
    accept,
    by_token,
    create,
    reissue,
    revoke,
    status_of,
)
from app.models import Invitation, Membership, Project, ProjectAccess, Role
from app.orgs import member_of, remove_membership
from app.projects import create_project
from app.security import hash_token

def granted_project_ids(db, *, user_id):
    """Проекты, к которым у человека есть явный доступ, — глазами теста."""
    return set(
        db.scalars(select(ProjectAccess.project_id).where(ProjectAccess.user_id == user_id)).all()
    )

NOW = datetime(2026, 8, 11, 12, 0, tzinfo=timezone.utc)


def _owner(db, *, name="Acme", email="owner@example.com"):
    user = register(db, name=name, email=email, password="s3cret-pass")
    db.flush()
    membership = db.scalar(select(Membership).where(Membership.user_id == user.id))
    return user, membership.org_id


def _invite(
    db, org_id, inviter_id, *, role="viewer", emails=("guest@example.com",), projects=(), now=NOW
):
    [(invitation, token)] = create(
        db,
        org_id=org_id,
        inviter_id=inviter_id,
        role=role,
        emails=list(emails),
        project_ids=list(projects),
        now=now,
    )
    return invitation, token


def test_the_token_is_stored_hashed_and_never_in_the_open(db):
    owner, org_id = _owner(db)
    invitation, token = _invite(db, org_id, owner.id)

    assert invitation.token_hash != token
    assert invitation.token_hash == hash_token(token)
    # Прямое следствие: найти приглашение можно только предъявив токен.
    assert by_token(db, token).id == invitation.id
    assert by_token(db, "не тот токен") is None


def test_an_invitation_without_an_address_belongs_to_whoever_holds_the_link(db):
    owner, org_id = _owner(db)
    [(invitation, token)] = create(
        db, org_id=org_id, inviter_id=owner.id, role="viewer", emails=[], project_ids=[], now=NOW
    )
    stranger = register(db, name="Stranger", email="stranger@example.com", password="s3cret-pass")
    db.flush()

    assert invitation.email is None
    accept(db, invitation, user=stranger, now=NOW)
    assert db.scalar(
        select(Membership).where(Membership.user_id == stranger.id, Membership.org_id == org_id)
    ) is not None


def test_accepting_creates_a_membership_with_the_role_from_the_invitation(db):
    owner, org_id = _owner(db)
    invitation, _ = _invite(db, org_id, owner.id, role="viewer")
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.flush()

    membership = accept(db, invitation, user=guest, now=NOW)

    # Роль зафиксирована в момент приглашения: принимающий на неё не влияет
    # ничем — ни адресом, ни тем, как он открыл ссылку.
    assert membership.role == Role.VIEWER
    assert invitation.accepted_at == NOW
    assert invitation.accepted_by == guest.id


def test_an_accepted_invitation_does_not_work_a_second_time(db):
    owner, org_id = _owner(db)
    invitation, _ = _invite(db, org_id, owner.id)
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    other = register(db, name="Other", email="other@example.com", password="s3cret-pass")
    db.flush()

    accept(db, invitation, user=guest, now=NOW)
    with pytest.raises(InvitationError) as error:
        accept(db, invitation, user=other, now=NOW)
    assert error.value.code == "invite_accepted"


def test_an_expired_invitation_says_so_instead_of_failing_silently(db):
    owner, org_id = _owner(db)
    invitation, _ = _invite(db, org_id, owner.id)
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.flush()

    later = NOW + timedelta(days=get_settings().invite_ttl_days + 1)
    assert status_of(invitation, later) is Status.EXPIRED
    with pytest.raises(InvitationError) as error:
        accept(db, invitation, user=guest, now=later)
    assert error.value.code == "invite_expired"


def test_a_revoked_invitation_dies_immediately(db):
    owner, org_id = _owner(db)
    invitation, _ = _invite(db, org_id, owner.id)
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.flush()

    revoke(db, invitation, now=NOW)
    with pytest.raises(InvitationError) as error:
        accept(db, invitation, user=guest, now=NOW)
    assert error.value.code == "invite_revoked"


def test_an_accepted_invitation_reads_as_accepted_even_after_its_date(db):
    """Порядок проверок в status_of: принятое остаётся принятым и после срока.

    Иначе человек, открывший свою же старую ссылку, пойдёт просить новую
    вместо того, чтобы просто войти.
    """
    owner, org_id = _owner(db)
    invitation, _ = _invite(db, org_id, owner.id)
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.flush()

    accept(db, invitation, user=guest, now=NOW)
    assert status_of(invitation, NOW + timedelta(days=365)) is Status.ACCEPTED


def test_an_invitation_addressed_to_someone_is_not_accepted_by_another_account(db):
    owner, org_id = _owner(db)
    invitation, _ = _invite(db, org_id, owner.id, emails=("guest@example.com",))
    stranger = register(db, name="Stranger", email="stranger@example.com", password="s3cret-pass")
    db.flush()

    with pytest.raises(InvitationError) as error:
        accept(db, invitation, user=stranger, now=NOW)
    assert error.value.code == "invite_wrong_email"
    assert invitation.accepted_at is None


def test_the_address_binds_regardless_of_case(db):
    owner, org_id = _owner(db)
    invitation, _ = _invite(db, org_id, owner.id, emails=("Guest@Example.com",))
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.flush()

    accept(db, invitation, user=guest, now=NOW)
    assert invitation.accepted_by == guest.id


def test_reissuing_kills_the_previous_link(db):
    owner, org_id = _owner(db)
    invitation, first = _invite(db, org_id, owner.id)

    second = reissue(db, invitation, now=NOW)

    assert second != first
    # Старая ссылка перестаёт находить приглашение — иначе отозвать «то самое
    # отправленное письмо» было бы нечем.
    assert by_token(db, first) is None
    assert by_token(db, second).id == invitation.id


def test_reissuing_starts_the_lifetime_over(db):
    owner, org_id = _owner(db)
    invitation, _ = _invite(db, org_id, owner.id)
    was = invitation.expires_at

    reissue(db, invitation, now=NOW + timedelta(days=3))

    assert invitation.expires_at > was


def test_an_accepted_invitation_cannot_be_reissued_or_revoked(db):
    owner, org_id = _owner(db)
    invitation, _ = _invite(db, org_id, owner.id)
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.flush()
    accept(db, invitation, user=guest, now=NOW)

    with pytest.raises(InvitationError) as reissue_error:
        reissue(db, invitation, now=NOW)
    assert reissue_error.value.code == "invite_accepted"

    with pytest.raises(InvitationError) as revoke_error:
        revoke(db, invitation, now=NOW)
    assert revoke_error.value.code == "invite_accepted"


def test_revoking_twice_changes_nothing_and_is_not_an_error(db):
    owner, org_id = _owner(db)
    invitation, _ = _invite(db, org_id, owner.id)

    revoke(db, invitation, now=NOW)
    first_time = invitation.revoked_at
    revoke(db, invitation, now=NOW + timedelta(hours=1))

    assert invitation.revoked_at == first_time


def test_a_second_invitation_to_the_same_address_reissues_the_live_one(db):
    """Два действующих токена на один адрес означали бы, что отозвать «то самое
    письмо» уже нельзя: отзыв убил бы одну ссылку, а вторая продолжила бы
    работать рядом."""
    owner, org_id = _owner(db)
    first_invitation, first_token = _invite(db, org_id, owner.id)
    second_invitation, second_token = _invite(db, org_id, owner.id)

    assert second_invitation.id == first_invitation.id
    assert by_token(db, first_token) is None
    assert by_token(db, second_token).id == first_invitation.id
    assert db.scalar(select(Invitation).where(Invitation.org_id == org_id)) is not None


def test_a_new_invitation_is_issued_once_the_previous_one_is_accepted(db):
    """Принятое приглашение не переиздаётся: на его месте выпускается новое.

    Позвать по тому же адресу второй раз можно ровно тогда, когда человек из
    организации вышел, — пока он внутри, выпуск отвечает `already_member`.
    Именно этот путь здесь и проходится: принял, ушёл, позвали заново.
    """
    owner, org_id = _owner(db)
    first_invitation, _ = _invite(db, org_id, owner.id)
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.flush()
    accept(db, first_invitation, user=guest, now=NOW)
    remove_membership(db, member_of(db, org_id=org_id, user_id=guest.id))

    second_invitation, _ = _invite(db, org_id, owner.id)

    assert second_invitation.id != first_invitation.id


def test_the_hourly_ceiling_stops_the_next_batch(db, monkeypatch):
    monkeypatch.setenv("INVITE_RATE_LIMIT", "2")
    get_settings.cache_clear()
    try:
        owner, org_id = _owner(db)
        create(
            db,
            org_id=org_id,
            inviter_id=owner.id,
            role="viewer",
            emails=["one@example.com", "two@example.com"],
            project_ids=[],
            now=NOW,
        )

        with pytest.raises(InvitationError) as error:
            _invite(db, org_id, owner.id, emails=("three@example.com",))
        assert error.value.code == "invite_rate_limited"

        # Потолок часовой, а не вечный: за окном он отпускает.
        _invite(db, org_id, owner.id, emails=("three@example.com",), now=NOW + timedelta(hours=2))
    finally:
        get_settings.cache_clear()


def test_the_ceiling_counts_the_whole_batch_before_issuing_any_of_it(db, monkeypatch):
    monkeypatch.setenv("INVITE_RATE_LIMIT", "2")
    get_settings.cache_clear()
    try:
        owner, org_id = _owner(db)
        with pytest.raises(InvitationError):
            create(
                db,
                org_id=org_id,
                inviter_id=owner.id,
                role="viewer",
                emails=["one@example.com", "two@example.com", "three@example.com"],
                project_ids=[],
                now=NOW,
            )
        # Отказ до первой вставки: наполовину разосланная пачка хуже, чем
        # отказанная целиком — половину адресов пришлось бы вычислять глазами.
        assert db.scalar(select(Invitation).where(Invitation.org_id == org_id)) is None
    finally:
        get_settings.cache_clear()


def test_the_ceiling_belongs_to_the_organization_not_to_the_installation(db, monkeypatch):
    monkeypatch.setenv("INVITE_RATE_LIMIT", "1")
    get_settings.cache_clear()
    try:
        first_owner, first_org = _owner(db, name="Acme", email="acme@example.com")
        second_owner, second_org = _owner(db, name="Globex", email="globex@example.com")

        _invite(db, first_org, first_owner.id, emails=("one@example.com",))
        _invite(db, second_org, second_owner.id, emails=("two@example.com",))
    finally:
        get_settings.cache_clear()


def test_a_client_invitation_grants_the_projects_it_names(db):
    owner, org_id = _owner(db)
    project = create_project(db, org_id=org_id, name="Redesign")
    other = create_project(db, org_id=org_id, name="Launch")
    db.flush()

    invitation, _ = _invite(db, org_id, owner.id, role="client", projects=(project.id,))
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.flush()
    accept(db, invitation, user=guest, now=NOW)

    assert granted_project_ids(db, user_id=guest.id) == {project.id}
    assert other.id not in granted_project_ids(db, user_id=guest.id)


def test_an_editor_invited_with_projects_is_scoped_to_them(db):
    """Отмеченные проекты сужают членство целиком, независимо от роли: у
    редактора, позванного в конкретные проекты, доступ к организации сузился
    до них же — той же записью project_access, что и у client."""
    owner, org_id = _owner(db)
    project = create_project(db, org_id=org_id, name="Redesign")
    other = create_project(db, org_id=org_id, name="Internal")
    db.flush()

    invitation, _ = _invite(db, org_id, owner.id, role="editor", projects=(project.id,))
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.flush()
    membership = accept(db, invitation, user=guest, now=NOW)

    assert membership.role == Role.EDITOR
    assert membership.project_scoped is True
    assert granted_project_ids(db, user_id=guest.id) == {project.id}
    assert other.id not in granted_project_ids(db, user_id=guest.id)


def test_a_viewer_invited_without_projects_keeps_seeing_the_whole_org(db):
    """Пустой список проектов ничего не сужает: наблюдатель без отметок ведёт
    себя ровно так же, как и до появления этой возможности."""
    owner, org_id = _owner(db)
    invitation, _ = _invite(db, org_id, owner.id, role="viewer", projects=())
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.flush()

    membership = accept(db, invitation, user=guest, now=NOW)

    assert membership.role == Role.VIEWER
    assert membership.project_scoped is False
    assert granted_project_ids(db, user_id=guest.id) == set()


def test_accepting_does_not_scope_the_membership_of_someone_already_inside(db):
    """Как и роль, сужение существующего членства приглашением не трогается —
    иначе владелец, открывший собственную же ссылку по невнимательности,
    оказался бы заперт в списке чужого выбора."""
    owner, org_id = _owner(db)
    project = create_project(db, org_id=org_id, name="Redesign")
    db.flush()
    invitation, _ = _invite(db, org_id, owner.id, emails=(), role="editor", projects=(project.id,))

    membership = accept(db, invitation, user=owner, now=NOW)

    assert membership.role == Role.OWNER
    assert membership.project_scoped is False


def test_a_project_of_another_organization_cannot_be_granted(db):
    owner, org_id = _owner(db)
    _, foreign_org = _owner(db, name="Globex", email="globex@example.com")
    foreign = create_project(db, org_id=foreign_org, name="Secret")
    db.flush()

    with pytest.raises(InvitationError) as error:
        _invite(db, org_id, owner.id, role="client", projects=(foreign.id,))
    assert error.value.code == "project_not_found"


def test_an_unknown_role_is_refused_at_the_door(db):
    owner, org_id = _owner(db)
    with pytest.raises(InvitationError) as error:
        _invite(db, org_id, owner.id, role="superuser")
    assert error.value.code == "unknown_role"


def test_a_project_deleted_between_the_invitation_and_the_acceptance_is_skipped(db):
    """Ссылка на исчезнувший проект — не повод отказать человеку во входе."""
    owner, org_id = _owner(db)
    alive = create_project(db, org_id=org_id, name="Redesign")
    doomed = create_project(db, org_id=org_id, name="Cancelled")
    db.flush()

    invitation, _ = _invite(db, org_id, owner.id, role="client", projects=(alive.id, doomed.id))
    db.delete(db.get(Project, doomed.id))
    db.flush()

    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.flush()
    accept(db, invitation, user=guest, now=NOW)

    assert granted_project_ids(db, user_id=guest.id) == {alive.id}


def test_accepting_does_not_rewrite_the_role_of_an_existing_membership(db):
    """Приглашение зовёт снаружи, а не переписывает роль тому, кто уже внутри.

    Иначе владелец, открывший собственную же ссылку по невнимательности,
    разжаловал бы сам себя — и починить это стало бы некому. Приглашение здесь
    именно ссылочное: выпуск на свой адрес отбивается раньше, кодом
    `already_member`, а ссылка без адреса достаётся предъявителю и до `accept`
    доходит.
    """
    owner, org_id = _owner(db)
    invitation, _ = _invite(db, org_id, owner.id, emails=(), role="viewer")

    membership = accept(db, invitation, user=owner, now=NOW)

    assert membership.role == Role.OWNER
    assert (
        len(db.scalars(select(Membership).where(Membership.user_id == owner.id)).all()) == 1
    )


def test_accepting_twice_over_does_not_duplicate_project_access(db):
    # Приглашения ссылочные: позвать по адресу того, кто уже внутри, выпуск не
    # даёт (`already_member`), а ссылка без адреса до приёма доходит — и второй
    # приём обязан оставить доступ к проекту одним, а не двумя.
    owner, org_id = _owner(db)
    project = create_project(db, org_id=org_id, name="Redesign")
    db.flush()
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.flush()

    first, _ = _invite(db, org_id, owner.id, role="client", emails=(), projects=(project.id,))
    accept(db, first, user=guest, now=NOW)
    second, _ = _invite(db, org_id, owner.id, role="client", emails=(), projects=(project.id,))
    accept(db, second, user=guest, now=NOW)

    rows = db.scalars(select(ProjectAccess).where(ProjectAccess.user_id == guest.id)).all()
    assert len(rows) == 1


def test_an_invitation_survives_acceptance_as_a_record_of_who_invited_whom(db):
    owner, org_id = _owner(db)
    invitation, _ = _invite(db, org_id, owner.id)
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.flush()
    accept(db, invitation, user=guest, now=NOW)

    stored = db.get(Invitation, invitation.id)
    assert stored.invited_by == owner.id
    assert stored.accepted_by == guest.id


def test_an_empty_address_is_refused_rather_than_turned_into_a_link_invitation(db):
    owner, org_id = _owner(db)
    with pytest.raises(InvitationError) as error:
        _invite(db, org_id, owner.id, emails=("   ",))
    assert error.value.code == "invalid_email"


def test_the_same_address_twice_in_one_batch_produces_one_invitation(db):
    owner, org_id = _owner(db)
    issued = create(
        db,
        org_id=org_id,
        inviter_id=owner.id,
        role="viewer",
        emails=["guest@example.com", "GUEST@example.com"],
        project_ids=[],
        now=NOW,
    )
    assert len(issued) == 1


def test_a_random_uuid_is_not_a_token(db):
    assert by_token(db, str(uuid.uuid4())) is None
    assert by_token(db, "") is None


def test_the_owner_role_is_not_handed_out_by_an_invitation(db):
    """Владельца приглашением не назначают.

    Владелец распоряжается организацией целиком, а приглашение без адреса вдобавок
    достаётся предъявителю: владельцем становился любой, кто открыл переславшуюся
    ссылку. Назначают его поимённо и другим действием — PATCH /api/org/members.
    Код отказа отдельный, а не общий `unknown_role`: роль существует, её просто
    нельзя выдать этим способом.
    """
    owner, org_id = _owner(db)

    with pytest.raises(InvitationError) as failure:
        _invite(db, org_id, owner.id, role="owner")

    assert failure.value.code == "role_not_invitable"


def test_an_address_already_inside_the_organization_is_refused(db):
    """Звать того, кто уже внутри, нечем: приглашение ничего бы не изменило.

    `accept` роли действующего членства не трогает — то есть такое приглашение
    выглядело бы действием, ничего не делая. Зовущий узнаёт об этом сразу, а не
    через неделю ожидания, что человек «наконец войдёт».
    """
    owner, org_id = _owner(db)
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.add(Membership(org_id=org_id, user_id=guest.id, role="viewer"))
    db.flush()

    with pytest.raises(InvitationError) as failure:
        _invite(db, org_id, owner.id, emails=("guest@example.com",))

    assert failure.value.code == "already_member"


def test_one_address_already_inside_refuses_the_whole_batch(db):
    """Отказ на весь список, и до того, как выпущено хоть одно приглашение.

    Иначе часть приглашений уже существовала бы к моменту отказа, и повторная
    отправка исправленного списка выпустила бы их второй раз — с новыми
    ссылками взамен только что разосланных.
    """
    owner, org_id = _owner(db)
    guest = register(db, name="Guest", email="guest@example.com", password="s3cret-pass")
    db.add(Membership(org_id=org_id, user_id=guest.id, role="viewer"))
    db.flush()

    with pytest.raises(InvitationError):
        create(
            db,
            org_id=org_id,
            inviter_id=owner.id,
            role="viewer",
            emails=["fresh@example.com", "guest@example.com"],
            project_ids=[],
            now=NOW,
        )

    assert db.scalars(select(Invitation).where(Invitation.org_id == org_id)).all() == []


def test_a_member_of_another_organization_is_still_invitable(db):
    """Проверка смотрит на эту организацию, а не на пользователей вообще.

    Человек, работающий в чужой компании, — самый обычный приглашаемый: своя
    организация у него есть у каждого, кто пришёл с улицы.
    """
    owner, org_id = _owner(db)
    register(db, name="Stranger", email="stranger@example.com", password="s3cret-pass")
    db.flush()

    invitation, _ = _invite(db, org_id, owner.id, emails=("stranger@example.com",))

    assert invitation.email == "stranger@example.com"


def test_a_bearer_invitation_is_not_measured_against_the_roster(db):
    """У ссылки без адреса адресата нет — сверять не с чем.

    Отказывать ей потому, что «кто-то в организации уже есть», значило бы
    запретить второй способ доставки во всякой непустой организации.
    """
    owner, org_id = _owner(db)

    invitation, _ = _invite(db, org_id, owner.id, emails=())

    assert invitation.email is None


def test_a_bearer_invitation_cannot_smuggle_the_owner_role_either(db):
    owner, org_id = _owner(db)

    with pytest.raises(InvitationError) as failure:
        _invite(db, org_id, owner.id, role="owner", emails=())

    assert failure.value.code == "role_not_invitable"


def test_an_unknown_role_is_still_told_apart_from_a_forbidden_one(db):
    owner, org_id = _owner(db)

    with pytest.raises(InvitationError) as failure:
        _invite(db, org_id, owner.id, role="admiral")

    assert failure.value.code == "unknown_role"
