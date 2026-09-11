"""Slugs on insert: the column's length and the transaction's survival (wave 1.3).

Uniqueness through a SAVEPOINT is covered by the API tests; here is what used to end
in a 500: a slug longer than the column, and a DataError that left the session's
whole transaction aborted.
"""

import pytest
from sqlalchemy.exc import DataError

from app.models import Organization
from app.slugs import insert_with_unique_slug, suggest_free_slug
from app.text import SLUG_MAX_LEN


def _taken_none(_slug: str) -> bool:
    return False


def test_insert_with_a_long_name_fits_the_column(db):
    org = insert_with_unique_slug(
        db,
        lambda slug: Organization(name="Щ" * 100, slug=slug),
        name="Щ" * 100,
        is_taken=_taken_none,
        fallback="org",
    )
    assert len(org.slug) <= SLUG_MAX_LEN


def test_the_uniqueness_suffix_never_pushes_the_slug_past_the_column(db):
    long_name = "redizayn " * 20  # the base hits the ceiling before the suffix

    org = insert_with_unique_slug(
        db,
        lambda slug: Organization(name=long_name, slug=slug),
        name=long_name,
        is_taken=lambda _slug: True,  # the first attempt is "taken" -> a suffix is attached
        fallback="org",
    )
    assert len(org.slug) <= SLUG_MAX_LEN
    # The suffix is the guarantee of uniqueness; the base is trimmed, not it.
    assert org.slug[-7] == "-"


def test_suggested_slugs_fit_the_column_too():
    base = "a" * SLUG_MAX_LEN
    suggestion = suggest_free_slug(base, is_taken=lambda slug: slug == base)
    assert suggestion != base
    assert len(suggestion) <= SLUG_MAX_LEN


def test_a_data_error_rolls_back_to_the_savepoint_and_surfaces(db):
    """A DataError on another field does not turn into an aborted transaction.

    The slug is truncated, but the entity has other string columns too. Before the
    fix, a DataError escaped insert_with_unique_slug without a rollback to the
    SAVEPOINT, and any subsequent use of the session answered InFailedSqlTransaction
    — that is, one form error brought the whole request down.
    """
    with pytest.raises(DataError):
        insert_with_unique_slug(
            db,
            # a name longer than varchar(200) — a truncation, which the same SAVEPOINT
            # that catches a slug collision must catch.
            lambda slug: Organization(name="x" * 300, slug=slug),
            name="Acme",
            is_taken=_taken_none,
            fallback="org",
        )

    # The session is alive: the SAVEPOINT rolled back and the transaction is not aborted.
    survivor = insert_with_unique_slug(
        db,
        lambda slug: Organization(name="Acme", slug=slug),
        name="Acme",
        is_taken=_taken_none,
        fallback="org",
    )
    assert survivor.id is not None
