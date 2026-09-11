"""Three ways to deliver a message, and the message type common to them.

A transport knows only "how to deliver", not "what to write" and not "who
needed it": the text is assembled in app.mail.templates, and the decision to
send is made by the calling code. That is why there are no templates and no
database access here — only a socket, an HTTP request and the log.

A delivery failure is a MailError rather than a 500: in this product a message
always accompanies a main action (registration, an invitation), and being
unable to send it must not cancel the action itself.
"""

import json
import logging
import re
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formatdate, make_msgid, parseaddr
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlsplit
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)

# The message goes out inside the user's HTTP request (there is no queue in the
# first version), so the waiting ceiling is short: a registration hanging for a
# minute because of an unreachable mail server looks like a broken application.
DEFAULT_TIMEOUT = 10


@dataclass(frozen=True, slots=True)
class Letter:
    """A message ready to send: the recipient and the text already assembled in their language."""

    to: str
    subject: str
    body: str


class MailError(RuntimeError):
    """The message could not be delivered. The sender decides what to do about it."""


class Transport(Protocol):
    def deliver(self, letter: Letter) -> None: ...


def _build_message(letter: Letter, sender: str) -> EmailMessage:
    message = EmailMessage()
    message["Subject"] = letter.subject
    message["From"] = sender
    message["To"] = letter.to
    # Date and Message-ID are added by hand: smtplib does not set them, and a
    # message without them confidently racks up penalty points with spam filters.
    # The domain for Message-ID is taken from the sender's address rather than
    # from the machine's hostname (make_msgid's default) — otherwise the
    # container's internal name rides out in the headers of every message.
    message["Date"] = formatdate(localtime=True)
    _, address = parseaddr(sender)
    domain = address.rpartition("@")[2] or None
    message["Message-ID"] = make_msgid(domain=domain)
    message.set_content(letter.body)
    return message


class SmtpTransport:
    """The main transport: any SMTP server, including one's own.

    The address is given by the single SMTP_URL variable — that way the
    credentials, host and port do not scatter across four variables that are easy
    to set only halfway. The scheme picks the encryption: `smtps://` is TLS from
    the connection itself (port 465 by default), `smtp://` is a plain connection
    upgrading to STARTTLS if the server offers it (port 587).
    """

    def __init__(self, url: str, *, sender: str, timeout: int = DEFAULT_TIMEOUT) -> None:
        parsed = urlsplit(url)
        if parsed.scheme not in ("smtp", "smtps") or not parsed.hostname:
            raise MailError(
                "SMTP_URL must look like smtp://user:pass@host:587 or smtps://host:465"
            )
        self._implicit_tls = parsed.scheme == "smtps"
        self._host = parsed.hostname
        self._port = parsed.port or (465 if self._implicit_tls else 587)
        # unquote: the password in the URL is percent-encoded, otherwise a slash
        # or an @ in it would break the parsing of the URL itself.
        self._user = unquote(parsed.username) if parsed.username else ""
        self._password = unquote(parsed.password) if parsed.password else ""
        self._sender = sender
        self._timeout = timeout

    def deliver(self, letter: Letter) -> None:
        message = _build_message(letter, self._sender)
        try:
            if self._implicit_tls:
                with smtplib.SMTP_SSL(self._host, self._port, timeout=self._timeout) as smtp:
                    self._hand_over(smtp, message, encrypted=True)
                return

            with smtplib.SMTP(self._host, self._port, timeout=self._timeout) as smtp:
                smtp.ehlo()
                encrypted = smtp.has_extn("starttls")
                if encrypted:
                    smtp.starttls()
                    # The second ehlo is mandatory: after STARTTLS the server
                    # announces its capability list anew, and before that AUTH is
                    # not in it.
                    smtp.ehlo()
                self._hand_over(smtp, message, encrypted=encrypted)
        except (smtplib.SMTPException, OSError) as exc:
            raise MailError(f"the SMTP server {self._host}:{self._port} did not accept the message: {exc}") from exc

    def _hand_over(self, smtp: smtplib.SMTP, message: EmailMessage, *, encrypted: bool) -> None:
        if self._user:
            if not encrypted:
                # A mailbox password over an open channel is not "less reliable
                # delivery" but a credential leak, hence a refusal rather than a
                # warning in the log. A local relay with no password (mailhog,
                # postfix on the same machine) keeps working regardless.
                raise MailError(
                    "refusing to send the SMTP password over an unencrypted connection: "
                    "smtps:// or a server supporting STARTTLS is required"
                )
            smtp.login(self._user, self._password)
        smtp.send_message(message)


class ApiTransport:
    """Sending through a delivery service's HTTP API.

    The request body is `{from, to, subject, text}`: the shape accepted by Resend
    and services compatible with it; for a service with a different format only
    this method changes. Built on the stdlib, because pulling an HTTP client into
    the application's dependencies for the sake of one POST is not worth it.
    """

    def __init__(self, *, url: str, key: str, sender: str, timeout: int = DEFAULT_TIMEOUT) -> None:
        self._url = url
        self._key = key
        self._sender = sender
        self._timeout = timeout

    def deliver(self, letter: Letter) -> None:
        payload = json.dumps(
            {
                "from": self._sender,
                "to": [letter.to],
                "subject": letter.subject,
                "text": letter.body,
            }
        ).encode()
        request = Request(
            self._url,
            data=payload,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._key}",
            },
        )
        try:
            with urlopen(request, timeout=self._timeout):
                return
        except HTTPError as exc:
            # The response body is truncated: services readily return a
            # kilobyte-long page, while the log needs the code and the first line
            # of the explanation.
            detail = exc.read(200).decode("utf-8", "replace").strip()
            raise MailError(f"the mail API answered {exc.code}: {detail}") from exc
        except (URLError, OSError) as exc:
            raise MailError(f"the mail API is unreachable: {exc}") from exc


# Tokens in messages are base64/hex strings of twenty characters or more;
# ordinary words in any of the installation's languages do not reach that.
# The tail is masked rather than the whole string: the first characters let a
# message in the log be matched against a database row without yielding a
# working link.
_TOKEN_LIKE = re.compile(r"[A-Za-z0-9_\-]{20,}")


def _mask_secrets(text: str) -> str:
    return _TOKEN_LIKE.sub(lambda match: match.group(0)[:6] + "…", text)


class LogTransport:
    """MAIL_TRANSPORT=none and log: the message goes to the log and nowhere else.

    An installation without a mail server must stay fully usable, so disabled
    mail is not an error. The difference between the two values is in what lands
    in the log. The log of a production installation is read by more than
    administrators: it rides out to aggregators and is kept longer than the
    tokens live, and a confirmation or invitation link in it is a ready-made way
    into someone else's account. So `none` masks the tokens, and only `log`
    prints the full text of the message — an explicit choice of a development
    mode where the log is the mailbox.
    """

    def __init__(self, *, sender: str = "", reveal_secrets: bool = False) -> None:
        self._sender = sender
        self._reveal_secrets = reveal_secrets

    def deliver(self, letter: Letter) -> None:
        body = letter.body if self._reveal_secrets else _mask_secrets(letter.body)
        logger.info(
            "mail goes to the log (MAIL_TRANSPORT=%s), the message stayed here:\n"
            "From: %s\nTo: %s\nSubject: %s\n\n%s",
            "log" if self._reveal_secrets else "none",
            self._sender or "—",
            letter.to,
            letter.subject,
            body,
        )
