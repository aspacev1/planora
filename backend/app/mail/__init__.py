"""Mail behind a single interface: send(to, template, params).

The same technique as with the LLM: a thin interface and several
implementations. The calling code does not know whether the message went out
over SMTP, through a delivery service's API or into the log — it names a
template and the data to substitute.

Messages are sent synchronously, within the same request: there is no queue in
the first version, and the whole application has two or three messages. A
failed send returns False and writes the reason to the log, but does not raise
upward — the invitation or the registration has already happened, and rolling
it back because of an unreachable mail server would be worse than honestly
saying "the message did not go out".
"""

import logging
from collections.abc import Mapping

from app.config import Settings, get_settings
from app.mail.templates import render, term
from app.mail.transports import (
    ApiTransport,
    Letter,
    LogTransport,
    MailError,
    SmtpTransport,
    Transport,
)

logger = logging.getLogger(__name__)

__all__ = [
    "ApiTransport",
    "Letter",
    "LogTransport",
    "MailError",
    "SmtpTransport",
    "Transport",
    "build_transport",
    "mail_enabled",
    "role_name",
    "send",
]


def mail_enabled() -> bool:
    """Whether mail is configured in this installation.

    More than sending depends on it: with `none` the interface does not show the
    send button at all, leaving only copying the link. An installation without a
    mail server must stay fully usable rather than showing a button that always
    answers with a refusal.
    """
    return get_settings().mail_enabled


def role_name(role: str, locale: str) -> str:
    """The role's name in the message's language. An unknown role is left as is."""
    try:
        return term("roles", role, locale)
    except MailError:
        return role


def build_transport(settings: Settings) -> Transport:
    """The transport per MAIL_TRANSPORT. The value has already been validated in Settings."""
    if settings.mail_transport == "smtp":
        return SmtpTransport(settings.smtp_url, sender=settings.mail_from)
    if settings.mail_transport == "api":
        return ApiTransport(
            url=settings.mail_api_url,
            key=settings.mail_api_key,
            sender=settings.mail_from,
        )
    # log — development mode: the log is the mailbox, tokens are visible.
    # none — production "there is no mail": the message text goes to the log, but
    # the tokens are masked.
    return LogTransport(
        sender=settings.mail_from, reveal_secrets=settings.mail_transport == "log"
    )


def send(*, to: str, template: str, params: Mapping[str, object], locale: str) -> bool:
    """Sends a message and says whether it reached the mail server.

    The transport is created per message rather than once at start-up: an SMTP
    connection is opened per message anyway (there are only a handful), while
    changing the settings then requires restarting nothing beyond the process,
    and no socket lingers in memory that the server closed from its side long
    ago.
    """
    settings = get_settings()
    try:
        letter = render(template, locale, params, to=to)
        build_transport(settings).deliver(letter)
    except MailError:
        # exception(), not error(): the reason for a refusal is almost always at
        # the very bottom of the chain (the socket, TLS, the service's answer),
        # and without a stack one is left guessing which of the three transports
        # stumbled and on what.
        logger.exception("письмо %r на %s не ушло", template, to)
        return False
    return True
