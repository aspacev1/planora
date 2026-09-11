from dataclasses import dataclass, field
from datetime import date, timedelta

MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY, SATURDAY, SUNDAY = (1 << i for i in range(7))
WEEKDAYS_MON_FRI = MONDAY | TUESDAY | WEDNESDAY | THURSDAY | FRIDAY

_MAX_SEARCH_DAYS = 3650


class CalendarError(ValueError):
    """The calendar is configured so that a date cannot be computed.

    A separate class rather than a bare ValueError: the working-day mask is set
    by a person, so a degenerate configuration is a refusal that has to be
    spoken about, not a server crash. The code is machine-readable, by the same
    rules as mutation refusals: the client assembles the prose for the reader in
    their own language.

    It inherits ValueError so that existing handlers for ValueError keep working.
    """

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Calendar:
    """The project's working calendar.

    The order of application: the weekday mask, then holidays remove days from
    it, then extra_workdays put specific dates back.
    """

    working_days: int = WEEKDAYS_MON_FRI
    holidays: frozenset[date] = field(default_factory=frozenset)
    extra_workdays: frozenset[date] = field(default_factory=frozenset)

    def is_working(self, d: date) -> bool:
        if d in self.extra_workdays:
            return True
        if d in self.holidays:
            return False
        return bool(self.working_days & (1 << d.weekday()))


def _next_day(d: date) -> date:
    """The next day, or a CalendarError at the edge of supported dates.

    date.max + a day is an OverflowError — that is, a server crash over a task
    placed at the end of the year 9999. The edge of the calendar is the same
    degeneracy as "there are no working days": a date beyond it simply does not
    exist, and that has to be said with a refusal rather than a 500.
    """
    try:
        return d + timedelta(days=1)
    except OverflowError:
        raise CalendarError(
            "calendar_date_out_of_range",
            "the date fell outside the supported calendar",
        ) from None


def _first_working_on_or_after(start: date, cal: Calendar) -> date:
    d = start
    for _ in range(_MAX_SEARCH_DAYS):
        if cal.is_working(d):
            return d
        d = _next_day(d)
    raise CalendarError(
        "calendar_has_no_working_days", "the calendar contains no working days at all"
    )


def first_working_on_or_after(start: date, cal: Calendar) -> date:
    """The first working day starting from the given one. A public name for an
    internal helper: laying out the parts of a split looks for the next part's start."""
    return _first_working_on_or_after(start, cal)


def _week_workday_count(mask: int) -> int:
    return bin(mask & 0b1111111).count("1")


def _mask_days_between(start: date, end: date, mask: int) -> int:
    """Working days by the weekly mask alone, both bounds included.

    Whole weeks are counted by multiplication, and only the remainder — up to
    seven days — by enumeration. That is what makes the count arithmetic: before
    wave 4 every GET of a project stepped in a loop over every day of every task.
    """
    days = (end - start).days + 1
    weeks, remainder = divmod(days, 7)
    total = weeks * _week_workday_count(mask)
    for offset in range(remainder):
        day = start + timedelta(days=weeks * 7 + offset)
        if mask & (1 << day.weekday()):
            total += 1
    return total


def count_working_days(start: date, end: date, cal: Calendar) -> int:
    """How many working days are in a range, both bounds included.

    The mask by arithmetic, the exceptions one by one: holidays and declared
    working days are finite in number, and the correction for them does not
    depend on the length of the range.
    """
    if end < start:
        raise ValueError("the end of the span is earlier than its start")

    total = _mask_days_between(start, end, cal.working_days)
    for holiday in cal.holidays:
        if (
            start <= holiday <= end
            and cal.working_days & (1 << holiday.weekday())
            and holiday not in cal.extra_workdays
        ):
            total -= 1
    for extra in cal.extra_workdays:
        if start <= extra <= end and not (cal.working_days & (1 << extra.weekday())):
            total += 1
    return total


def end_date(start: date, duration_days: int, cal: Calendar) -> date:
    """A task's finish date. The starting working day counts towards the duration.

    A binary search over count_working_days instead of stepping by days: every
    probe is mask arithmetic plus the individual exceptions, and the cost does
    not grow with the duration. The previous loop made up to 3650 steps per task
    — on every GET of a project with a hundred tasks that is hundreds of
    thousands of iterations.
    """
    if duration_days < 1:
        raise ValueError("the duration must be at least one day")

    first = _first_working_on_or_after(start, cal)

    if _week_workday_count(cal.working_days) == 0:
        # A degenerate calendar: the only working days are the explicitly declared ones.
        ahead = sorted(day for day in cal.extra_workdays if day >= first)
        if len(ahead) < duration_days:
            raise CalendarError(
                "calendar_too_few_working_days",
                "the calendar does not contain enough working days for such a duration",
            )
        return ahead[duration_days - 1]

    # The search's upper bound: the weeks allow ample room for every holiday
    # ahead; if that was not enough, widen it until we hit the edge of dates or
    # the search ceiling (the same limits the step-by-step loop had).
    weeks = duration_days // _week_workday_count(cal.working_days) + 2
    try:
        high = first + timedelta(weeks=weeks)
    except OverflowError:
        high = date.max
    while count_working_days(first, high, cal) < duration_days:
        if (high - first).days > _MAX_SEARCH_DAYS:
            raise CalendarError(
                "calendar_too_few_working_days",
                "the calendar does not contain enough working days for such a duration",
            )
        if high == date.max:
            raise CalendarError(
                "calendar_date_out_of_range",
                "the date fell outside the supported calendar",
            )
        try:
            high = high + timedelta(weeks=8)
        except OverflowError:
            high = date.max

    low = first
    while low < high:
        middle = low + (high - low) // 2
        if count_working_days(first, middle, cal) >= duration_days:
            high = middle
        else:
            low = middle + timedelta(days=1)

    if (low - first).days > _MAX_SEARCH_DAYS:
        raise CalendarError(
            "calendar_too_few_working_days",
            "the calendar does not contain enough working days for such a duration",
        )
    return low
