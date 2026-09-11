from datetime import date

import pytest

from app.calendar import WEEKDAYS_MON_FRI, Calendar, count_working_days, end_date

DEFAULT = Calendar()


def test_default_calendar_is_monday_to_friday():
    assert DEFAULT.working_days == WEEKDAYS_MON_FRI
    assert DEFAULT.is_working(date(2026, 3, 6)) is True   # Friday
    assert DEFAULT.is_working(date(2026, 3, 7)) is False  # Saturday
    assert DEFAULT.is_working(date(2026, 3, 8)) is False  # Sunday


def test_single_day_task_ends_on_its_start():
    assert end_date(date(2026, 3, 4), 1, DEFAULT) == date(2026, 3, 4)


def test_task_started_on_friday_skips_the_weekend():
    # Fri 6 March + 3 working days = Fri, Mon, Tue
    assert end_date(date(2026, 3, 6), 3, DEFAULT) == date(2026, 3, 10)


def test_start_on_a_non_working_day_shifts_to_the_next_working_day():
    # Saturday 7 March, duration 1 -> Monday 9 March
    assert end_date(date(2026, 3, 7), 1, DEFAULT) == date(2026, 3, 9)


def test_holiday_is_skipped():
    cal = Calendar(holidays=frozenset({date(2026, 3, 9)}))
    # Fri 6 March + 3 days: Fri, Tue (Mon is off for a holiday), Wed
    assert end_date(date(2026, 3, 6), 3, cal) == date(2026, 3, 11)


def test_extra_workday_beats_the_weekend_and_the_holiday():
    cal = Calendar(
        holidays=frozenset({date(2026, 3, 9)}),
        extra_workdays=frozenset({date(2026, 3, 7), date(2026, 3, 9)}),
    )
    assert cal.is_working(date(2026, 3, 7)) is True
    assert cal.is_working(date(2026, 3, 9)) is True


def test_non_standard_working_week():
    # a working week of Sunday to Thursday: bits 6,0,1,2,3
    mask = (1 << 6) | (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3)
    cal = Calendar(working_days=mask)
    assert cal.is_working(date(2026, 3, 8)) is True   # Sunday
    assert cal.is_working(date(2026, 3, 6)) is False  # Friday


def test_count_working_days_is_inclusive_on_both_ends():
    assert count_working_days(date(2026, 3, 2), date(2026, 3, 6), DEFAULT) == 5
    assert count_working_days(date(2026, 3, 2), date(2026, 3, 8), DEFAULT) == 5
    assert count_working_days(date(2026, 3, 4), date(2026, 3, 4), DEFAULT) == 1


def test_count_working_days_rejects_reversed_range():
    with pytest.raises(ValueError):
        count_working_days(date(2026, 3, 6), date(2026, 3, 2), DEFAULT)


def test_duration_must_be_at_least_one_day():
    with pytest.raises(ValueError):
        end_date(date(2026, 3, 4), 0, DEFAULT)


def test_end_date_rejects_insufficient_working_days():
    """A calendar without enough working days must raise an error rather than hang."""
    cal = Calendar(working_days=0, extra_workdays=frozenset({date(2026, 3, 6)}))
    # Only one working date (6 March), but we require 2 days
    with pytest.raises(ValueError, match="enough working days"):
        end_date(date(2026, 3, 6), 2, cal)


def test_end_date_respects_extra_workdays_priority_in_duration():
    """Days from extra_workdays count towards the duration even if they are in holidays."""
    # Fri 6 March; Sun 8 March is in holidays, but Sunday is in extra_workdays
    # Fri 6 + Sun 8 (extra) = 2 working days, so it must be Sun 8
    cal = Calendar(
        holidays=frozenset({date(2026, 3, 8)}),
        extra_workdays=frozenset({date(2026, 3, 8)}),
    )
    assert end_date(date(2026, 3, 6), 2, cal) == date(2026, 3, 8)


def test_a_calendar_failure_carries_a_machine_code():
    """A calendar refusal is not a bare ValueError.

    A route must tell it from any other error and answer 422 with a code; on a bare
    ValueError it would have to parse the message text.
    """
    from app.calendar import CalendarError

    empty = Calendar(working_days=0)
    with pytest.raises(CalendarError) as error:
        end_date(date(2026, 3, 4), 1, empty)
    assert error.value.code == "calendar_has_no_working_days"

    narrow = Calendar(working_days=0, extra_workdays=frozenset({date(2026, 3, 6)}))
    with pytest.raises(CalendarError) as error:
        end_date(date(2026, 3, 6), 2, narrow)
    assert error.value.code == "calendar_too_few_working_days"


def test_calendar_error_is_still_a_value_error():
    """A ValueError subclass: existing handlers for ValueError keep working."""
    from app.calendar import CalendarError

    assert issubclass(CalendarError, ValueError)


def test_the_far_edge_of_dates_is_a_calendar_error_not_a_crash():
    """Wave 1.2: a task at the edge of the year 9999 is a coded refusal rather than an OverflowError.

    A step past date.max while searching for working days is a crash of the date
    arithmetic, and before the fix it came out as a 500 on any GET of a project with
    such a task.
    """
    from app.calendar import CalendarError

    with pytest.raises(CalendarError) as error:
        end_date(date(9999, 12, 27), 30, Calendar())
    assert error.value.code == "calendar_date_out_of_range"


def test_counting_working_days_up_to_date_max_does_not_overflow():
    # A range ending on the last representable day is lawful.
    assert count_working_days(date(9999, 12, 27), date.max, Calendar()) >= 1
