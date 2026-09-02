"""Приглашения: выпуск и управление ими внутри организации плюс приём по ссылке.

Два роутера, потому что двери две. Управление живёт под `/api/org/...` и
требует прав владельца; приём — под `/api/invitations/...` и открыт тому, у
кого на руках ссылка: человек, который ещё не в организации, по определению не
может пройти проверку прав в ней.
"""

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.access import Action, can, parse_role
from app.auth import current_session
from app.config import get_settings
from app.db import get_db
from app.invitations import (
    InvitationError,
    Status,
    accept,
    create,
    ensure_capacity,
    reissue,
    revoke,
    status_of,
)
from app.invitations import by_token as invitation_by_token
from app.mail import mail_enabled, role_name, send as send_mail
from app.models import Invitation, Membership, Organization, Session, User
from app.orgs import current_membership, switch

router = APIRouter(prefix="/api/org/invitations", tags=["invitations"])
public_router = APIRouter(prefix="/api/invitations", tags=["invitations"])

#: Сколько адресов принимается за один раз. Потолок нужен не вместо часового
#: лимита, а до него: список на десять тысяч адресов не должен доходить до
#: базы, чтобы получить отказ.
MAX_EMAILS_PER_REQUEST = 50

#: Коды отказов домена, у которых статус ответа не 422. Всё остальное —
#: непринятая форма запроса, то есть 422.
_STATUS_BY_CODE = {
    "invite_rate_limited": 429,
    "project_not_found": 404,
    "invite_expired": 409,
    "invite_revoked": 409,
    "invite_accepted": 409,
    "invite_wrong_email": 403,
    # Не 422: форма запроса безупречна, а вот состояние организации таково,
    # что звать этого человека больше некуда — он уже внутри.
    "already_member": 409,
}


def as_http(error: InvitationError) -> HTTPException:
    return HTTPException(status_code=_STATUS_BY_CODE.get(error.code, 422), detail=error.code)


class InviteIn(BaseModel):
    # Пустой список — не забывчивость, а второй способ доставки: приглашение
    # без адреса, ссылку от которого зовущий отправит как ему удобно.
    emails: list[EmailStr] = Field(default_factory=list, max_length=MAX_EMAILS_PER_REQUEST)
    role: str
    project_ids: list[uuid.UUID] = Field(default_factory=list)
    #: Отправлять ли письма. Копирование ссылки — равноправный путь, а не
    #: запасной, поэтому отправка спрашивается, а не подразумевается.
    deliver: bool = True


class ReissueIn(BaseModel):
    deliver: bool = False


class IssuedOut(BaseModel):
    id: str
    email: str | None
    role: str
    expires_at: str
    #: Открытая ссылка. Возвращается только в ответ на выпуск и больше нигде:
    #: в базе лежит хеш токена, и восстановить её позже невозможно.
    url: str
    sent: bool
    #: Почему письмо не ушло. Приглашение при этом создано — оно существует
    #: независимо от того, доставили его письмом или нет.
    mail_error: str | None = None


class InvitationOut(BaseModel):
    id: str
    email: str | None
    role: str
    status: str
    project_ids: list[str]
    created_at: str
    expires_at: str
    last_sent_at: str | None
    invited_by: str | None
    accepted_at: str | None


class InvitationsOut(BaseModel):
    #: Настроена ли в установке почта. Без неё кнопка отправки не показывается
    #: вовсе — угадывать это по молчанию сервера интерфейс не должен.
    mail_enabled: bool
    invitations: list[InvitationOut]


class PreviewOut(BaseModel):
    org_name: str
    role: str
    #: Адрес, которому приглашение адресовано. Показывается, чтобы вошедший под
    #: другим аккаунтом понял, чьё это приглашение, и не гадал.
    email: str | None
    inviter_name: str | None
    expires_at: str


class JoinedOut(BaseModel):
    id: str
    name: str
    slug: str
    role: str


def _require_org_admin(membership: Membership) -> None:
    """Звать в организацию вправе владелец: ORG_ADMIN есть только у него.

    Спецификация добавляет к этому второе условие — «до подтверждения адреса
    нельзя приглашать других», и его здесь нет сознательно. Подтверждение
    адреса есть (`app.email_verification`), но оно не запирает приглашения:
    в установке без почты `users.email_verified_at` пуст у всех, и проверка
    закрыла бы приглашения вообще для всех, включая того, кто эту установку
    развернул, — то есть сломала бы ровно ту функцию, ради которой её пишут.
    """
    if not can(parse_role(membership.role), Action.ORG_ADMIN):
        raise HTTPException(status_code=403, detail="forbidden")


def _link(raw_token: str) -> str:
    return f"{get_settings().public_base_url.rstrip('/')}/invite/{raw_token}"


def _moment(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _deliver(
    db: DbSession,
    invitation: Invitation,
    *,
    url: str,
    org: Organization,
    inviter_name: str,
    now: datetime,
) -> tuple[bool, str | None]:
    """Отправляет письмо, если есть кому и чем. Неудача не откатывает выпуск.

    Возвращается признак отправки и код причины, а не исключение: приглашение
    уже создано, ссылка уже в ответе, и интерфейсу остаётся сказать «письмо не
    ушло, скопируйте ссылку» — это не отказ в действии.
    """
    if invitation.email is None or not mail_enabled():
        return False, None
    # Язык письма — язык организации: о языке получателя, который ещё ничего в
    # этой установке не открывал, неизвестно ничего.
    locale = org.default_locale
    sent = send_mail(
        to=invitation.email,
        template="invitation",
        locale=locale,
        params={
            "org": org.name,
            "inviter": inviter_name,
            "role": role_name(invitation.role, locale),
            "link": url,
            # Дата, а не дата со временем: час и минуты в чужом часовом поясе
            # ничего читателю не говорят, а ISO-форма читается на всех трёх
            # языках одинаково.
            "expires": invitation.expires_at.date().isoformat(),
        },
    )
    if not sent:
        # Причина отказа уже в журнале со стеком: наружу уходит один код —
        # разбирать по нему, чем именно ответил чужой почтовый сервер, всё
        # равно некому, а совет на экране от этого не меняется.
        return False, "mail_failed"
    invitation.last_sent_at = now
    db.flush()
    return True, None


def _issued_out(
    invitation: Invitation, raw_token: str, *, sent: bool, mail_error: str | None
) -> IssuedOut:
    return IssuedOut(
        id=str(invitation.id),
        email=invitation.email,
        role=invitation.role,
        expires_at=invitation.expires_at.isoformat(),
        url=_link(raw_token),
        sent=sent,
        mail_error=mail_error,
    )


@router.post("", response_model=list[IssuedOut], status_code=201)
def create_invitations(
    payload: InviteIn,
    membership: Membership = Depends(current_membership),
    db: DbSession = Depends(get_db),
):
    _require_org_admin(membership)
    now = datetime.now(timezone.utc)
    org = db.get(Organization, membership.org_id)
    inviter = db.get(User, membership.user_id)

    try:
        issued = create(
            db,
            org_id=membership.org_id,
            inviter_id=membership.user_id,
            role=payload.role,
            emails=[str(email) for email in payload.emails],
            project_ids=payload.project_ids,
            now=now,
        )
    except InvitationError as error:
        raise as_http(error)

    out: list[IssuedOut] = []
    for invitation, raw_token in issued:
        sent, mail_error = (False, None)
        if payload.deliver:
            sent, mail_error = _deliver(
                db,
                invitation,
                url=_link(raw_token),
                org=org,
                inviter_name=inviter.name,
                now=now,
            )
        out.append(_issued_out(invitation, raw_token, sent=sent, mail_error=mail_error))
    return out


@router.get("", response_model=InvitationsOut)
def list_invitations(
    membership: Membership = Depends(current_membership), db: DbSession = Depends(get_db)
):
    """Приглашения организации, новые сверху.

    Отдаются все, включая принятые: приглашение живёт в базе и после приёма —
    это журнал того, кто кого привёл. Открытых ссылок в ответе нет ни у одного
    из них, и быть не может: сервер их не помнит.
    """
    _require_org_admin(membership)
    now = datetime.now(timezone.utc)

    rows = db.execute(
        select(Invitation, User.name)
        .outerjoin(User, User.id == Invitation.invited_by)
        .where(Invitation.org_id == membership.org_id)
        .order_by(Invitation.created_at.desc(), Invitation.id)
    ).all()

    return InvitationsOut(
        mail_enabled=mail_enabled(),
        invitations=[
            InvitationOut(
                id=str(invitation.id),
                email=invitation.email,
                role=invitation.role,
                status=status_of(invitation, now).value,
                project_ids=[str(project_id) for project_id in invitation.project_ids],
                created_at=invitation.created_at.isoformat(),
                expires_at=invitation.expires_at.isoformat(),
                last_sent_at=_moment(invitation.last_sent_at),
                invited_by=inviter_name,
                accepted_at=_moment(invitation.accepted_at),
            )
            for invitation, inviter_name in rows
        ],
    )


def _own_invitation(db: DbSession, membership: Membership, invitation_id: uuid.UUID) -> Invitation:
    invitation = db.get(Invitation, invitation_id)
    # Приглашение чужой организации неотличимо от несуществующего.
    if invitation is None or invitation.org_id != membership.org_id:
        raise HTTPException(status_code=404, detail="invite_not_found")
    return invitation


@router.post("/{invitation_id}/reissue", response_model=IssuedOut)
def reissue_invitation(
    invitation_id: uuid.UUID,
    payload: ReissueIn,
    membership: Membership = Depends(current_membership),
    db: DbSession = Depends(get_db),
):
    """Выпускает новую ссылку взамен прежней — она же «отправить ещё раз».

    Одно действие, а не два: прежний токен умирает в обоих случаях, потому что
    иначе отозвать уже отправленное письмо становится невозможно. Отличается
    только доставка — уйдёт ли письмо или ссылку скопируют руками.
    """
    _require_org_admin(membership)
    invitation = _own_invitation(db, membership, invitation_id)
    now = datetime.now(timezone.utc)

    if payload.deliver and invitation.email is not None and mail_enabled():
        # Письмо расходует тот же часовой потолок, что и создание: он стоит
        # против рассылки, а не против записей в таблице.
        try:
            ensure_capacity(db, org_id=membership.org_id, now=now, wanted=1)
        except InvitationError as error:
            raise as_http(error)

    try:
        raw_token = reissue(db, invitation, now=now)
    except InvitationError as error:
        raise as_http(error)

    sent, mail_error = (False, None)
    if payload.deliver:
        sent, mail_error = _deliver(
            db,
            invitation,
            url=_link(raw_token),
            org=db.get(Organization, membership.org_id),
            inviter_name=db.get(User, membership.user_id).name,
            now=now,
        )
    return _issued_out(invitation, raw_token, sent=sent, mail_error=mail_error)


@router.delete("/{invitation_id}", status_code=204)
def revoke_invitation(
    invitation_id: uuid.UUID,
    membership: Membership = Depends(current_membership),
    db: DbSession = Depends(get_db),
):
    _require_org_admin(membership)
    invitation = _own_invitation(db, membership, invitation_id)
    try:
        revoke(db, invitation, now=datetime.now(timezone.utc))
    except InvitationError as error:
        raise as_http(error)


def _by_token_or_404(db: DbSession, token: str) -> Invitation:
    invitation = invitation_by_token(db, token)
    if invitation is None:
        raise HTTPException(status_code=404, detail="invite_not_found")
    return invitation


@public_router.get("/{token}", response_model=PreviewOut)
def preview_invitation(token: str, db: DbSession = Depends(get_db)):
    """Что за приглашение на руках — до входа и до регистрации.

    Отвечает и анониму: человек с непринятым приглашением по определению ещё
    не в организации, и требовать от него войти, прежде чем он узнает, куда
    его зовут, — это просить подписать не глядя.
    """
    invitation = _by_token_or_404(db, token)
    state = status_of(invitation, datetime.now(timezone.utc))
    if state is not Status.PENDING:
        # Три состояния — три разных кода: по «просрочено» человек просит новую
        # ссылку, по «принято» просто входит, по «отозвано» идёт к тому, кто звал.
        raise HTTPException(status_code=409, detail=f"invite_{state.value}")

    org = db.get(Organization, invitation.org_id)
    inviter = db.get(User, invitation.invited_by) if invitation.invited_by else None
    return PreviewOut(
        org_name=org.name,
        role=invitation.role,
        email=invitation.email,
        inviter_name=inviter.name if inviter else None,
        expires_at=invitation.expires_at.isoformat(),
    )


@public_router.post("/{token}/accept", response_model=JoinedOut)
def accept_invitation(
    token: str,
    session: Session = Depends(current_session),
    db: DbSession = Depends(get_db),
):
    """Принимает приглашение от имени вошедшего.

    Членство появляется только здесь — по явному действию человека, а не по
    совпадению адреса при регистрации. Сессия сразу переключается на новую
    организацию: человек нажал «принять» и должен оказаться внутри, а не
    искать её в переключателе.
    """
    invitation = _by_token_or_404(db, token)
    user = db.get(User, session.user_id)
    try:
        membership = accept(db, invitation, user=user, now=datetime.now(timezone.utc))
    except InvitationError as error:
        raise as_http(error)

    switch(db, session, membership.org_id)
    org = db.get(Organization, membership.org_id)
    return JoinedOut(id=str(org.id), name=org.name, slug=org.slug, role=membership.role)
