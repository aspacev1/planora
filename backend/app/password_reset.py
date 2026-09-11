"""Password recovery: issuing a link by mail and redeeming it.

Mail here is not a convenience but the only proof: a person without a password
can confirm the account is theirs only through access to their own mailbox.
That is why recovery does not work in an installation without a mail server
(MAIL_TRANSPORT=none) — and that is more honest than pretending a message went
out.

The token is stored as a hash and is redeemed on first use — the same
discipline as sessions and address confirmation (app.email_verification). There
is one difference: this link opens the whole account, so it lives for hours
rather than a day, and redeeming it closes every session — recovery is used
precisely when there is a suspicion that the password has leaked.
"""

import logging
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session as DbSession

from app import mail
from app.config import get_settings
from app.models import PasswordReset, Session, User
from app.security import hash_password, hash_token, new_token

logger = logging.getLogger(__name__)

# Hours, not a day as with address confirmation: that link merely sets a flag,
# this one sets a new password. The key to an account must not sit for a week in
# a mailbox that someone else may already be reading.
RESET_TTL = timedelta(hours=2)

# A pause between repeated requests. The recovery form accepts any address, and
# without a pause it is a free mailer aimed at someone else's mailbox (the same
# arithmetic as for resending a confirmation).
RESEND_COOLDOWN = timedelta(minutes=1)


class ResetError(Exception):
    """The link was not accepted. `code` goes outward as is, with no prose."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def issue_token(db: DbSession, user: User) -> str:
    """A new recovery token. It redeems the previous ones: the last link wins."""
    db.execute(delete(PasswordReset).where(PasswordReset.user_id == user.id))
    raw, hashed = new_token()
    db.add(
        PasswordReset(
            user_id=user.id,
            token_hash=hashed,
            expires_at=datetime.now(timezone.utc) + RESET_TTL,
        )
    )
    db.flush()
    return raw


def reset_link(raw_token: str) -> str:
    base = get_settings().public_base_url.rstrip("/")
    return f"{base}/reset-password?{urlencode({'token': raw_token})}"


def send_reset(db: DbSession, user: User) -> bool:
    """Issues a link and sends a message. False means the message did not go out.

    The token is issued before sending and stays issued even if the message did
    not go out: a repeated request will issue a new one and redeem this one, and
    a rollback would improve nothing.
    """
    link = reset_link(issue_token(db, user))
    return mail.send(
        to=user.email,
        template="reset_password",
        locale=user.locale,
        params={
            "name": user.name,
            "link": link,
            "hours": int(RESET_TTL.total_seconds() // 3600),
        },
    )


def sent_recently(db: DbSession, user: User) -> bool:
    latest = db.scalar(
        select(func.max(PasswordReset.created_at)).where(PasswordReset.user_id == user.id)
    )
    return latest is not None and latest > datetime.now(timezone.utc) - RESEND_COOLDOWN


def redeem_token(db: DbSession, raw_token: str, *, new_password: str) -> User:
    """Redeems the link, sets a new password and closes all of the owner's sessions.

    All of them, not "except the current one": a person who forgot their
    password has no session, while for someone using recovery to evict an
    intruder, the foreign sessions are exactly what must die. Their own will
    open on the next sign-in.
    """
    record = db.scalar(
        select(PasswordReset).where(PasswordReset.token_hash == hash_token(raw_token))
    )
    if record is None:
        raise ResetError("invalid_token")

    if record.expires_at < datetime.now(timezone.utc):
        # An expired row is removed right away: it is good for nothing anymore.
        db.delete(record)
        db.flush()
        raise ResetError("token_expired")

    user = db.get(User, record.user_id)
    user.password_hash = hash_password(new_password)
    db.execute(delete(PasswordReset).where(PasswordReset.user_id == user.id))
    db.execute(delete(Session).where(Session.user_id == user.id))
    db.flush()
    return user
