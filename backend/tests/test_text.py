from app.text import normalize_email, slugify


def test_email_is_trimmed_and_lowercased():
    assert normalize_email("  User@Example.COM ") == "user@example.com"


def test_email_normalization_is_stable_for_dotted_capital_i():
    # The Azerbaijani İ must not give a different result on a repeated run
    once = normalize_email("İSTANBUL@example.com")
    assert normalize_email(once) == once


def test_dotless_and_dotted_i_do_not_collapse_into_the_same_email():
    # different letters mean different addresses; there must be no silent merging of accounts
    assert normalize_email("Ismail@x.com") != normalize_email("İsmail@x.com")


def test_slug_transliterates_azerbaijani_letters():
    assert slugify("Şəhər Layihəsi") == "seher-layihesi"
    assert slugify("Çağrı Mərkəzi") == "cagri-merkezi"


def test_slug_handles_dotted_and_dotless_i():
    assert slugify("İstanbul") == "istanbul"
    assert slugify("Işıq") == "isiq"


def test_slug_transliterates_cyrillic():
    assert slugify("Редизайн сайта") == "redizayn-sayta"


def test_slug_collapses_separators_and_trims_dashes():
    assert slugify("  Acme   //  Redesign 2026!! ") == "acme-redesign-2026"


def test_slug_falls_back_when_nothing_survives():
    assert slugify("!!! ???", fallback="project") == "project"


def test_slugify_fits_the_slug_column():
    """Wave 1.3: transliteration lengthens text, slugify truncates to the column.

    "щ" unfolds into "sch" — a hundred of them would give three hundred characters,
    which the database met with a DataError 500 on truncating a varchar(100).
    """
    from app.text import SLUG_MAX_LEN

    slug = slugify("щ" * 100)
    assert len(slug) <= SLUG_MAX_LEN
    assert not slug.endswith("-")


def test_slugify_respects_a_custom_max_length():
    assert slugify("redizayn sayta", max_length=8) == "redizayn"
