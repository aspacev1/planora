"""The text of a message in the recipient's language.

Arranged the same way as the interface dictionaries (specification §9): one
file per language, meaning-based keys, a missing key falls back to the default
language and writes a warning to the log rather than going out as an empty
string. Dictionary completeness is checked by a test, not by eye.

Substitution goes through `format_map` over the template, not over the data:
a user's name and a link land in the text as values and cannot bring another
substitution field along with them.
"""

import json
import logging
from collections.abc import Mapping
from functools import lru_cache
from pathlib import Path

from app.config import get_settings
from app.mail.transports import Letter, MailError

logger = logging.getLogger(__name__)

_TEMPLATES_DIR = Path(__file__).parent / "templates"

# The last fallback step. It coincides with the DEFAULT_LOCALE default but is
# declared separately: a dictionary in this language must exist in the
# repository, which cannot be promised of an arbitrary environment variable.
LAST_RESORT_LOCALE = "az"


@lru_cache
def dictionary(locale: str) -> dict[str, dict[str, str]]:
    """The mail dictionary of one language. A missing file means an empty dictionary."""
    path = _TEMPLATES_DIR / f"{locale}.json"
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def available_locales() -> list[str]:
    return sorted(path.stem for path in _TEMPLATES_DIR.glob("*.json"))


def _lookup(template: str, field: str, locale: str) -> str:
    # dict.fromkeys rather than a set: the fallback order is from the
    # recipient's language to the installation's and only then to Azerbaijani,
    # and it has to be preserved.
    candidates = dict.fromkeys([locale, get_settings().default_locale, LAST_RESORT_LOCALE])
    for candidate in candidates:
        text = dictionary(candidate).get(template, {}).get(field)
        if text is None:
            continue
        if candidate != locale:
            logger.warning(
                "нет шаблона письма %s.%s на языке %r, отправляю на %r",
                template,
                field,
                locale,
                candidate,
            )
        return text
    raise MailError(f"нет шаблона письма {template}.{field} ни на одном языке")


def term(group: str, key: str, locale: str) -> str:
    """A single word from the mail dictionary — with the same fallback as the text.

    Needed where what goes into a substitution is not a value from outside but
    one of our own enumerations: the role in an invitation is stored in the
    database as the string `editor`, while the message must say "editor" in the
    recipient's language. Translating it on the caller's side would mean a
    second mail dictionary next to this one.
    """
    return _lookup(group, key, locale)


def render(template: str, locale: str, params: Mapping[str, object], *, to: str) -> Letter:
    subject = _lookup(template, "subject", locale)
    body = _lookup(template, "body", locale)
    return Letter(to=to, subject=_fill(subject, params), body=_fill(body, params))


def _fill(text: str, params: Mapping[str, object]) -> str:
    try:
        return text.format_map(params)
    except (KeyError, IndexError) as exc:
        raise MailError(f"в шаблоне письма нет данных для подстановки {exc}") from exc
