import re
import unicodedata

# Azerbaijani. Both forms of every letter are spelled out explicitly: relying on
# "strip the diacritics" is not an option — İ and I are different letters, not
# decorations.
_AZ = {
    "ə": "e", "Ə": "e",
    "ğ": "g", "Ğ": "g",
    "ı": "i", "I": "i",
    "i": "i", "İ": "i",
    "ö": "o", "Ö": "o",
    "ş": "s", "Ş": "s",
    "ü": "u", "Ü": "u",
    "ç": "c", "Ç": "c",
}

_RU = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}
_RU.update({k.upper(): v for k, v in _RU.items() if k})

_TRANSLIT = {**_AZ, **_RU}


def normalize_email(raw: str) -> str:
    """The form of an address used for comparison and uniqueness.

    NFKC folds compatible forms into one, and casefold does not depend on the
    process locale — unlike case conversion in the user's locale, where I turns
    into ı and breaks lookups.
    """
    return unicodedata.normalize("NFKC", raw.strip()).casefold()


# The width of the slug columns in organizations and projects (models.py). A
# longer slug would go into the database as-is and come back as a DataError on
# truncation — that is, as a 500 rather than an address. Transliteration can
# lengthen text ("щ" -> "sch"), so a limit on the form's input is not enough:
# slugify shortens it itself.
SLUG_MAX_LEN = 100


def slugify(raw: str, fallback: str = "project", *, max_length: int = SLUG_MAX_LEN) -> str:
    transliterated = "".join(_TRANSLIT.get(ch, ch) for ch in raw)
    lowered = transliterated.lower()
    stripped = unicodedata.normalize("NFKD", lowered)
    ascii_only = "".join(ch for ch in stripped if not unicodedata.combining(ch))
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_only).strip("-")
    slug = slug[:max_length].rstrip("-")
    return slug or fallback
