import secrets
from collections.abc import Callable
from typing import TypeVar

from sqlalchemy.exc import DataError, IntegrityError
from sqlalchemy.orm import Session as DbSession

from app.text import SLUG_MAX_LEN, slugify

MAX_ATTEMPTS = 5

T = TypeVar("T")


def _with_suffix(base: str, suffix: str) -> str:
    """The base plus a suffix, together no longer than the column.

    The suffix is attached to an already truncated slug, so it is the base that
    gets trimmed, not the suffix: the suffix is the very guarantee of
    uniqueness, and its characters must not be lost.
    """
    trimmed = base[: SLUG_MAX_LEN - len(suffix)].rstrip("-")
    return f"{trimmed}{suffix}"


def _candidate(name: str, *, forced: bool, is_taken: Callable[[str], bool], fallback: str) -> str:
    base = slugify(name, fallback=fallback)
    if not forced and not is_taken(base):
        return base
    return _with_suffix(base, f"-{secrets.token_hex(3)}")


def suggest_free_slug(
    raw: str, *, is_taken: Callable[[str], bool], fallback: str = "project", limit: int = 20
) -> str:
    """A free slug resembling the desired one.

    Needed by the form, not by the insert: a taken slug must suggest a free
    variant right in the input field, before submission. That is why the suffix
    here is numeric and sequential — `redesign-2`, `redesign-3` — rather than
    random as on insert: a person reads the suggestion and dictates it aloud,
    and six hexadecimal digits in it are useless.

    A random suffix remains the last resort: if the first twenty numbers are
    taken too, enumerating further costs more than offering a name that is
    knowingly free.
    """
    base = slugify(raw, fallback=fallback)
    if not is_taken(base):
        return base
    for number in range(2, limit + 2):
        candidate = _with_suffix(base, f"-{number}")
        if not is_taken(candidate):
            return candidate
    return _with_suffix(base, f"-{secrets.token_hex(3)}")


def slug_check(raw: str, *, is_taken: Callable[[str], bool], fallback: str = "project") -> dict:
    """The input field's answer: what the entered text turns into, whether it is
    free, and what to offer instead.

    The normalized form is returned separately from the suggestion because those
    are different answers to different questions: the first is "this is what the
    address will be", the second is "and this one, if that is taken". Merged
    into one field, the interface could not tell "all good" from "we picked one
    for you".
    """
    normalized = slugify(raw, fallback=fallback)
    available = not is_taken(normalized)
    return {
        "normalized": normalized,
        "available": available,
        "suggestion": normalized
        if available
        else suggest_free_slug(raw, is_taken=is_taken, fallback=fallback),
    }


def insert_with_unique_slug(
    db: DbSession,
    build: Callable[[str], T],
    *,
    name: str,
    is_taken: Callable[[str], bool],
    fallback: str = "project",
) -> T:
    """Inserts an entity with a slug derived from its name.

    Checking availability and inserting are not one action: a concurrent request
    fits between the SELECT and the INSERT, and the unique index rejects the
    insert. So the check here exists only to avoid attaching a suffix
    needlessly, while the real protection is the database constraint: a
    collision is caught, rolled back to a SAVEPOINT (otherwise the session's
    whole transaction would be aborted) and the attempt is repeated with a new
    random suffix.

    A slug collision is not the fault of whoever arrived second: their
    organization or project simply has the same name as an existing one. Hence a
    loop rather than a refusal. The number of attempts is bounded so that an
    IntegrityError for another reason — a foreign key, say — does not turn into
    an endless loop: having exhausted the attempts, we raise the last error as
    is.

    DataError is caught alongside IntegrityError: the slug is truncated to the
    column back in slugify, but the entity has other string fields too, and
    without a rollback to the SAVEPOINT the session's whole transaction would be
    left aborted — together with changes that have nothing to do with the slug.
    """
    last_error: DataError | IntegrityError | None = None
    for attempt in range(MAX_ATTEMPTS):
        slug = _candidate(name, forced=attempt > 0, is_taken=is_taken, fallback=fallback)
        entity = build(slug)
        try:
            with db.begin_nested():
                db.add(entity)
                db.flush()
        except (DataError, IntegrityError) as exc:
            last_error = exc
            continue
        return entity
    raise last_error
