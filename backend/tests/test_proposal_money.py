from decimal import Decimal

from app.export.proposal_pdf import _money


def test_proposal_money_rounds_half_up_like_the_screen():
    """The budget screen rounds cents half up (frontend/src/proposal/money.ts); the
    document must show the same figures rather than the default ROUND_HALF_EVEN."""
    assert _money(Decimal("0.5") * Decimal("2.25")) == "1.13"
    assert _money(Decimal("0.5") * Decimal("2.01")) == "1.01"
    assert _money(Decimal("1.125")) == "1.13"
    assert _money(Decimal("2.5")) == "2.50"


def test_proposal_money_keeps_whole_amounts_short():
    assert _money(Decimal("12000")) == "12 000"
    assert _money(Decimal("12000.50")) == "12 000.50"
    assert _money(Decimal("12000.005")) == "12 000.01"
