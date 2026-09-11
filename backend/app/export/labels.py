"""Labels inside an exported document — in the language of whoever ordered it.

Arranged the same way as the mail dictionaries (`app/mail/templates.py`): one
file per language, meaning-based keys, a missing key falls back to the default
language and writes a warning to the log rather than going out as an empty
string. Dictionary completeness is checked by a test, not by eye.

Why a dictionary on the server, when the client translates API errors. The rule
"the backend has no prose dictionary of its own" applies to refusals: the client
gets a code and decides for itself what words to name it with. A finished
document is filled with words by whoever writes it — and the server is what
writes it. The same argument is already recorded in `app/scorecard.py` next to
`_METRIC_LABELS` ("a task name lands in the database, and whoever writes it
translates it — the same principle as with mail").

Month names are here too rather than with `Intl`/`babel`: ICU does not know the
Azerbaijani months, and the frontend keeps them in a dictionary for the same
reason (`frontend/src/i18n/dates.ts`).
"""

import json
import logging
from functools import lru_cache
from pathlib import Path

from app.config import get_settings
from app.export.errors import ExportError

logger = logging.getLogger(__name__)

_LABELS_DIR = Path(__file__).parent / "labels"

# The last fallback step. It coincides with the DEFAULT_LOCALE default but is
# declared separately: a dictionary in this language must exist in the
# repository, which cannot be promised of an arbitrary environment variable.
LAST_RESORT_LOCALE = "az"


@lru_cache
def dictionary(locale: str) -> dict[str, dict[str, str]]:
    """The label dictionary of one language. A missing file means an empty dictionary."""
    path = _LABELS_DIR / f"{locale}.json"
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def available_locales() -> list[str]:
    return sorted(path.stem for path in _LABELS_DIR.glob("*.json"))


def term(group: str, key: str, locale: str) -> str:
    """A single label with a fallback across languages.

    The fallback order is from the orderer's language to the installation's and
    only then to Azerbaijani; `dict.fromkeys` rather than `set`, so that this
    order is preserved.
    """
    candidates = dict.fromkeys([locale, get_settings().default_locale, LAST_RESORT_LOCALE])
    for candidate in candidates:
        text = dictionary(candidate).get(group, {}).get(key)
        if text is None:
            continue
        if candidate != locale:
            logger.warning(
                "нет подписи %s.%s на языке %r, беру %r", group, key, locale, candidate
            )
        return text
    raise ExportError(
        "export_label_missing", f"нет подписи {group}.{key} ни на одном языке"
    )


def has_group_key(group: str, key: str, locale: str) -> bool:
    """Whether such a label exists — without catching an exception on every row.

    Needed where an unknown value comes from the database and is labelled with a
    generic word: the edit journal carries an operation's name, operations are
    added by code, and a new one must not bring the document down halfway.
    """
    for candidate in (locale, get_settings().default_locale, LAST_RESORT_LOCALE):
        if key in dictionary(candidate).get(group, {}):
            return True
    return False


class Labels:
    """One language's dictionary, bound to it once.

    The renderers ask for labels by the dozen, and dragging `locale` into every
    call would mean letting it drift between the header and the table on one
    page.
    """

    def __init__(self, locale: str) -> None:
        self.locale = locale

    def __call__(self, group: str, key: str, **params: object) -> str:
        text = term(group, key, self.locale)
        # Substitution goes through the template rather than the data: the
        # project's name and the version number land in the text as values and
        # cannot bring another substitution field along with them.
        return text.format(**params) if params else text

    def month(self, number: int, *, short: bool = False) -> str:
        return self("month_short" if short else "month", str(number))
