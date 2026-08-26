"""Три способа вручить письмо и общий для них тип письма.

Транспорт знает только «как доставить», но не «что написать» и не «кому
понадобилось»: текст собирается в app.mail.templates, а решение отправить
принимает вызывающий код. Поэтому здесь нет ни шаблонов, ни обращений к
базе — только сокет, HTTP-запрос и журнал.

Отказ доставки — это MailError, а не пятисотка: письмо в этом продукте
всегда сопутствует основному действию (регистрация, приглашение), и
невозможность его отправить не должна отменять само действие.
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

# Письмо уходит внутри HTTP-запроса пользователя (очереди в первой версии
# нет), поэтому потолок ожидания короткий: регистрация, зависшая на минуту
# из-за недоступного почтового сервера, выглядит как сломанное приложение.
DEFAULT_TIMEOUT = 10


@dataclass(frozen=True, slots=True)
class Letter:
    """Готовое к отправке письмо: адресат и уже собранный на его языке текст."""

    to: str
    subject: str
    body: str


class MailError(RuntimeError):
    """Письмо не удалось вручить. Отправитель решает, что с этим делать."""


class Transport(Protocol):
    def deliver(self, letter: Letter) -> None: ...


def _build_message(letter: Letter, sender: str) -> EmailMessage:
    message = EmailMessage()
    message["Subject"] = letter.subject
    message["From"] = sender
    message["To"] = letter.to
    # Date и Message-ID добавляются руками: smtplib их не проставляет, а
    # письмо без них уверенно собирает штрафные очки у спам-фильтров.
    # Домен для Message-ID берётся из адреса отправителя, а не из hostname
    # машины (умолчание make_msgid) — иначе внутреннее имя контейнера
    # уезжает в заголовках каждого письма наружу.
    message["Date"] = formatdate(localtime=True)
    _, address = parseaddr(sender)
    domain = address.rpartition("@")[2] or None
    message["Message-ID"] = make_msgid(domain=domain)
    message.set_content(letter.body)
    return message


class SmtpTransport:
    """Основной транспорт: любой SMTP-сервер, включая собственный.

    Адрес задаётся одной переменной SMTP_URL — так учётные данные, хост и
    порт не разъезжаются по четырём переменным, которые легко задать
    наполовину. Схема выбирает шифрование: `smtps://` — TLS с самого
    соединения (порт 465 по умолчанию), `smtp://` — обычное соединение с
    переходом на STARTTLS, если сервер его предлагает (порт 587).
    """

    def __init__(self, url: str, *, sender: str, timeout: int = DEFAULT_TIMEOUT) -> None:
        parsed = urlsplit(url)
        if parsed.scheme not in ("smtp", "smtps") or not parsed.hostname:
            raise MailError(
                "SMTP_URL должен выглядеть как smtp://user:pass@host:587 или smtps://host:465"
            )
        self._implicit_tls = parsed.scheme == "smtps"
        self._host = parsed.hostname
        self._port = parsed.port or (465 if self._implicit_tls else 587)
        # unquote: пароль в адресе закодирован процентами, иначе слэш или @
        # в нём разорвали бы разбор самого адреса.
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
                    # Второй ehlo обязателен: после STARTTLS сервер объявляет
                    # список возможностей заново, и до него AUTH в нём нет.
                    smtp.ehlo()
                self._hand_over(smtp, message, encrypted=encrypted)
        except (smtplib.SMTPException, OSError) as exc:
            raise MailError(f"SMTP-сервер {self._host}:{self._port} не принял письмо: {exc}") from exc

    def _hand_over(self, smtp: smtplib.SMTP, message: EmailMessage, *, encrypted: bool) -> None:
        if self._user:
            if not encrypted:
                # Пароль от почтового ящика по открытому каналу — это не
                # «менее надёжная доставка», а утечка учётных данных, поэтому
                # отказ, а не предупреждение в лог. Локальный релей без
                # пароля (mailhog, postfix на той же машине) при этом
                # продолжает работать.
                raise MailError(
                    "отказ передавать пароль SMTP по незашифрованному соединению: "
                    "нужен smtps:// или сервер с поддержкой STARTTLS"
                )
            smtp.login(self._user, self._password)
        smtp.send_message(message)


class ApiTransport:
    """Отправка через HTTP-API рассылочного сервиса.

    Тело запроса — `{from, to, subject, text}`: форма, которую принимают
    Resend и совместимые с ним; для сервиса с другим форматом меняется
    только этот метод. Взято на stdlib, потому что ради одного POST в
    зависимости приложения не стоит тянуть HTTP-клиент.
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
            # Тело ответа обрезается: сервисы охотно возвращают страницу на
            # килобайт, а в журнал нужен код и первая строка объяснения.
            detail = exc.read(200).decode("utf-8", "replace").strip()
            raise MailError(f"почтовый API ответил {exc.code}: {detail}") from exc
        except (URLError, OSError) as exc:
            raise MailError(f"почтовый API недоступен: {exc}") from exc


# Токены в письмах — это base64/hex-строки длиной от двадцати символов;
# обычные слова любого из языков установки до неё не дотягивают. Маскируется
# хвост, а не вся строка: по первым символам письмо в журнале можно сопоставить
# с записью в базе, не получив при этом рабочей ссылки.
_TOKEN_LIKE = re.compile(r"[A-Za-z0-9_\-]{20,}")


def _mask_secrets(text: str) -> str:
    return _TOKEN_LIKE.sub(lambda match: match.group(0)[:6] + "…", text)


class LogTransport:
    """MAIL_TRANSPORT=none и log: письмо уходит в журнал и больше никуда.

    Установка без почтового сервера должна оставаться полноценной, поэтому
    выключенная почта — это не ошибка. Разница между двумя значениями — в
    том, что попадает в журнал. Журнал боевой установки читают не только
    администраторы: он уезжает в агрегаторы и хранится дольше, чем живут
    токены, а ссылка подтверждения или приглашения в нём — это готовый вход
    в чужой аккаунт. Поэтому `none` маскирует токены, и полный текст письма
    печатает только `log` — явный выбор режима разработки, где журнал и есть
    почтовый ящик.
    """

    def __init__(self, *, sender: str = "", reveal_secrets: bool = False) -> None:
        self._sender = sender
        self._reveal_secrets = reveal_secrets

    def deliver(self, letter: Letter) -> None:
        body = letter.body if self._reveal_secrets else _mask_secrets(letter.body)
        logger.info(
            "почта в журнал (MAIL_TRANSPORT=%s), письмо осталось здесь:\n"
            "From: %s\nTo: %s\nSubject: %s\n\n%s",
            "log" if self._reveal_secrets else "none",
            self._sender or "—",
            letter.to,
            letter.subject,
            body,
        )
