"""Email address confirmation: issuing a link and redeeming it.

Confirmation forbids nothing. It answers one question — do messages reach this
person — and therefore does not stand in the way of signing in: an installation
without a mail server must stay fully usable, and there `email_verified_at`
stays empty for everyone (specification §3). The moment confirmation starts
blocking something, such an installation stops working entirely.

The token is stored as a hash and fires once — the same as a session token in
app.auth: one and the same discipline for every secret that goes outward. A
redeemed row is not deleted but flagged, though: a link from an email is
followed twice, and the second visit is told "the address is already confirmed"
rather than "this link does not fit".
"""

import logging
from datetime import datetime, timedelta, timezone
from typing import NamedTuple
from urllib.parse import urlencode

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session as DbSession

from app import mail
from app.config import get_settings
from app.models import EmailVerification, User
from app.security import hash_token, new_token

logger = logging.getLogger(__name__)

# A day: the message is read that same evening or the next morning, while a link
# that lives for a week sits in the mailbox all that time as a ready key.
VERIFICATION_TTL = timedelta(hours=24)

# A pause between repeated sends. The "send again" button is a mailer aimed at
# any address entered at registration, and without a pause a single account turns
# the application into a free mailer aimed at someone else's mailbox.
RESEND_COOLDOWN = timedelta(minutes=1)


class VerificationError(Exception):
    """The link was not accepted. `code` goes outward as is, with no prose."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class Confirmation(NamedTuple):
    """The outcome of redeeming a link.

    `already_verified` means the link was not opened for the first time. This is
    not a refusal: the address is confirmed, there is nothing for the person to
    do, and telling them about an invalid link would mean frightening them with
    success.
    """

    user: User
    already_verified: bool


def issue_token(db: DbSession, user: User) -> str:
    """A new confirmation token. It redeems the previous ones: the last link wins.

    Otherwise every repeated send would leave another working key behind it, and
    "the link stopped working" after a resend would become untrue when an
    incident is investigated.
    """
    db.execute(delete(EmailVerification).where(EmailVerification.user_id == user.id))
    raw, hashed = new_token()
    db.add(
        EmailVerification(
            user_id=user.id,
            token_hash=hashed,
            expires_at=datetime.now(timezone.utc) + VERIFICATION_TTL,
        )
    )
    db.flush()
    return raw


def verification_link(raw_token: str) -> str:
    base = get_settings().public_base_url.rstrip("/")
    return f"{base}/verify-email?{urlencode({'token': raw_token})}"


def send_verification(db: DbSession, user: User) -> bool:
    """Issues a link and sends a message. False means the message did not go out.

    The token is issued before sending and stays issued even if the message did
    not go out: the account's owner knows their email address, a resend is
    available, and rolling the token back would improve nothing.

    The sent mark is set after the message rather than together with the token:
    the pause before the next message is counted from it, and an issued token
    does not start a pause. Otherwise an unreachable mail server would lock the
    "send again" button for a minute over a message nobody sent.
    """
    link = verification_link(issue_token(db, user))
    sent = mail.send(
        to=user.email,
        template="verify_email",
        locale=user.locale,
        params={
            "name": user.name,
            "link": link,
            "hours": int(VERIFICATION_TTL.total_seconds() // 3600),
        },
    )
    if sent:
        note_sent(db, user)
    return sent


def note_sent(db: DbSession, user: User) -> None:
    """Marks that the message went out. The pause before the next one is counted from this minute.

    It updates the owner's rows rather than one specific row: exactly one of
    theirs is valid — issue_token removes the previous ones before issuing a new one.
    """
    db.execute(
        update(EmailVerification)
        .where(EmailVerification.user_id == user.id)
        .values(sent_at=datetime.now(timezone.utc))
    )
    db.flush()


def sent_recently(db: DbSession, user: User) -> bool:
    """Whether a message went out to this person just now.

    Counted from the send rather than from the issue of the token: a message
    stuck in an unreachable mail server does not start a pause — otherwise the
    very first press of the button would get a refusal over a message that never
    existed.
    """
    latest = db.scalar(
        select(func.max(EmailVerification.sent_at)).where(
            EmailVerification.user_id == user.id
        )
    )
    return latest is not None and latest > datetime.now(timezone.utc) - RESEND_COOLDOWN


def confirm_email(db: DbSession, raw_token: str) -> Confirmation:
    """Redeems the link and sets the confirmation mark.

    A redeemed link stays in the table until the end of its lifetime and answers
    a repeated opening with "the address is already confirmed": a link from an
    email is followed twice — first by a mail scanner or a preview, then by a
    person — and a deleted row would answer them "this link does not fit".
    """
    record = db.scalar(
        select(EmailVerification).where(EmailVerification.token_hash == hash_token(raw_token))
    )
    if record is None:
        raise VerificationError("invalid_token")

    user = db.get(User, record.user_id)

    # The redemption mark is checked before the expiry date: a link that has
    # already fired confirms nothing a second time, and a person with a confirmed
    # address has no reason to read about an expired deadline.
    if record.used_at is not None:
        return Confirmation(user, already_verified=True)

    if record.expires_at < datetime.now(timezone.utc):
        # An expired row is removed right away: it is good for nothing anymore,
        # and if left behind it accumulates and makes the table harder to read.
        db.delete(record)
        db.flush()
        raise VerificationError("token_expired")

    now = datetime.now(timezone.utc)
    user.email_verified_at = now
    record.used_at = now
    # The owner's other links are extinguished for good: the one that answers
    # "already confirmed" must be the one that was followed, not any of those
    # ever issued.
    db.execute(
        delete(EmailVerification).where(
            EmailVerification.user_id == user.id, EmailVerification.id != record.id
        )
    )
    # Expired rows of everyone else are swept along the way: a redeemed link has
    # no second reason to visit this table, and without a cleanup here confirmed
    # addresses would each leave a row in it forever.
    db.execute(delete(EmailVerification).where(EmailVerification.expires_at < now))
    db.flush()
    return Confirmation(user, already_verified=False)
