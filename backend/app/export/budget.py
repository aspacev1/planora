"""How much of the chart fits on a page — and which scale to pick so that it does.

The bars in an export are not compressed at any scale: instead the chart is cut
up by time and the name column repeats on every page. That means the price of
detail is measured not in readability but in the number of pages — and that is
exactly what has to be bounded.

Three callers ask this module: the PDF renderer (how many windows to cut), the
XLSX renderer (how many columns to lay out) and the route (whether to refuse
before starting work). That is why the rule lives here rather than inside one of
them.

The same computation is repeated on the client
(`frontend/src/export/pageBudget.ts`) — deliberately, not by oversight: the
dialog must write on the scale button the very number of pages the server will
return, and asking for it with a request on every press would mean flickering
buttons. Tests on both sides check against one table of expectations.
"""

from dataclasses import dataclass
from datetime import date, timedelta
from enum import StrEnum

from app.export.errors import ExportError

# Nothing from `app.models` / `app.schedule` is imported here on purpose: those
# drag `app.db` along, and it brings up the engine and demands a configured
# environment at import time (by design, see app/config.py). The module with the
# densest arithmetic in the whole export must be testable without Postgres.


class Zoom(StrEnum):
    """The unit of a scale column. The same three values as the chart on screen."""

    DAY = "day"
    WEEK = "week"
    MONTH = "month"


class Period(StrEnum):
    """A window onto the chart. The last three are anchored to "today"."""

    ALL = "all"
    NEXT_4W = "next_4w"
    NEXT_3M = "next_3m"
    FROM_TODAY = "from_today"


class Orientation(StrEnum):
    LANDSCAPE = "landscape"
    PORTRAIT = "portrait"


ZOOMS: tuple[Zoom, ...] = (Zoom.DAY, Zoom.WEEK, Zoom.MONTH)

#: Periods that make no sense without real dates: a relative plan's axis is
#: "Day N", and "today" is undefined on it.
DATED_PERIODS: frozenset[Period] = frozenset(
    {Period.NEXT_4W, Period.NEXT_3M, Period.FROM_TODAY}
)

#: Days per column unit. A "month" here is exactly 30 days rather than a calendar
#: one: a page's capacity is an estimate, not a layout, and calendar arithmetic
#: in it would yield a different page count for a project shifted by a week.
DAYS_PER_UNIT: dict[Zoom, int] = {Zoom.DAY: 1, Zoom.WEEK: 7, Zoom.MONTH: 30}

#: The column width in points — the minimum at which a scale label stays
#: readable. Any less and a day stops carrying a number, a month a name.
UNIT_WIDTH_PT: dict[Zoom, float] = {Zoom.DAY: 8.0, Zoom.WEEK: 20.0, Zoom.MONTH: 40.0}

#: The page width minus the margins, in points (A4, 14 mm margins on each side).
#: The values are hard-coded rather than computed from reportlab.lib.pagesizes so
#: that the module stays usable as a reference for the client.
PAGE_WIDTH_PT: dict[Orientation, float] = {
    Orientation.LANDSCAPE: 841.89,
    Orientation.PORTRAIT: 595.28,
}
MARGIN_PT = 39.69  # 14 mm
LABEL_COLUMN_PT = 168.0

#: How many chart pages count as a decent default. The most detailed scale that
#: fits into this number becomes the default choice.
COMFORTABLE_PAGES = 2

#: The ceiling. Beyond it a scale is neither offered nor accepted: nobody reads
#: a file with a dozen and a half pages of chart, and it takes long to assemble.
MAX_PAGES = 6

#: The ceiling of an Excel sheet, in columns. The chart sheet is not cut into
#: pages — it is one wide strip, and the limit is set by the number of columns:
#: beyond it there is no moving along it.
MAX_XLSX_COLUMNS = 400


def units_per_page(zoom: Zoom, orientation: Orientation) -> int:
    """How many scale columns fit on a page."""
    chart = PAGE_WIDTH_PT[orientation] - 2 * MARGIN_PT - LABEL_COLUMN_PT
    return max(1, int(chart // UNIT_WIDTH_PT[zoom]))


def days_per_page(zoom: Zoom, orientation: Orientation) -> int:
    return units_per_page(zoom, orientation) * DAYS_PER_UNIT[zoom]


def page_count(days: int, zoom: Zoom, orientation: Orientation) -> int:
    """The number of chart pages for a window of this length. An empty project is
    one page with a header rather than zero: the page has to be filled with
    something anyway."""
    if days <= 0:
        return 1
    per_page = days_per_page(zoom, orientation)
    return -(-days // per_page)  # division rounding up


def columns_for(days: int, zoom: Zoom) -> int:
    """The same for a workbook, for a window of this length."""
    if days <= 0:
        return 1
    return -(-days // DAYS_PER_UNIT[zoom])


def allowed(zoom: Zoom, days: int, orientation: Orientation) -> bool:
    """Whether the scale fits under the ceiling.

    The coarsest scale is always allowed, however many pages it comes to: the
    ceiling exists so that a person does not choose detail they do not need, and
    the month has no less detailed neighbour. Refusing on it would mean that a
    ten-year portfolio cannot be exported at all — and that is no longer
    protection from an unmanageable file but the absence of a capability.
    """
    if zoom is ZOOMS[-1]:
        return True
    return page_count(days, zoom, orientation) <= MAX_PAGES


def default_zoom(days: int, orientation: Orientation) -> Zoom:
    """The most detailed scale that fits into a decent number of pages.

    If none fits — the coarsest one: a month yields a handful of pages on any
    conceivable project, and returning a refusal instead of a file would be
    disrespectful to someone who merely pressed "Download".
    """
    for zoom in ZOOMS:
        if page_count(days, zoom, orientation) <= COMFORTABLE_PAGES:
            return zoom
    return ZOOMS[-1]


def default_zoom_for_xlsx(days: int) -> Zoom:
    """The same for a workbook, where the limit is columns rather than pages."""
    for zoom in ZOOMS:
        if columns_for(days, zoom) <= MAX_XLSX_COLUMNS:
            return zoom
    return ZOOMS[-1]


@dataclass(frozen=True)
class Window:
    """A window onto the chart: the bounds and how many days are in it."""

    start: date
    end: date

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1


def project_window(starts: list[date], ends: list[date], *, fallback: date) -> Window:
    """The bounds of the whole project.

    `fallback` is the start of the axis for a project with no tasks: there is
    nothing to draw, but a scale must exist, otherwise there will be nothing to
    divide by. The value is passed by the caller (`RELATIVE_EPOCH` or the
    assigned start) rather than taken by this module: taking it would drag
    `app.schedule` and the whole database in here.
    """
    if not starts or not ends:
        return Window(fallback, fallback)
    return Window(min(starts), max(ends))


def resolve_window(period: Period, whole: Window, today: date, *, dated: bool) -> Window:
    """A window for the chosen period.

    `dated=False` means a relative plan: "today" does not exist on its axis, and
    the three periods anchored to today are refused here not out of taste but
    because the quantity they would be counted from is absent.
    """
    if period in DATED_PERIODS and not dated:
        raise ExportError(
            "export_period_undated",
            f"the {period} period needs dates, but the project plan is relative",
        )

    if period is Period.ALL:
        return whole

    start = max(today, whole.start)
    if period is Period.FROM_TODAY:
        end = whole.end
    elif period is Period.NEXT_4W:
        end = start + timedelta(days=27)
    else:
        end = start + timedelta(days=89)

    # The window does not extend beyond the project: an empty tail of the scale
    # past the last task is a page with nothing on it.
    end = min(end, whole.end)
    if end < start:
        # The project is entirely in the past: show its end rather than emptiness.
        return Window(whole.end, whole.end)
    return Window(start, end)


def slice_window(window: Window, zoom: Zoom, orientation: Orientation) -> list[Window]:
    """Splitting the window into pages by time."""
    step = days_per_page(zoom, orientation)
    out: list[Window] = []
    cursor = window.start
    while cursor <= window.end:
        last = min(cursor + timedelta(days=step - 1), window.end)
        out.append(Window(cursor, last))
        cursor = last + timedelta(days=1)
    return out or [window]


def require_within_budget(window: Window, zoom: Zoom, orientation: Orientation) -> None:
    """A refusal before the work starts, rather than a forty-page file after it.

    The check repeats the one the dialog makes. The repetition here is not
    redundancy: the route is also called from outside the dialog — by a bookmark,
    a script, a public link.
    """
    if not allowed(zoom, window.days, orientation):
        pages = page_count(window.days, zoom, orientation)
        raise ExportError(
            "export_scale_too_wide",
            f"the {zoom} scale over a window of {window.days} d. gives {pages} timeline pages",
        )


def require_within_xlsx_budget(window: Window, zoom: Zoom) -> None:
    columns = columns_for(window.days, zoom)
    if columns > MAX_XLSX_COLUMNS:
        raise ExportError(
            "export_scale_too_wide",
            f"the {zoom} scale over a window of {window.days} d. gives {columns} columns",
        )
