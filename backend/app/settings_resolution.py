import logging
from datetime import date

from app.calendar import Calendar
from app.models import Organization, Project

logger = logging.getLogger(__name__)


def _dates(raw: list[str] | None) -> frozenset[date]:
    """Dates from a JSON list; unusable entries are skipped.

    The list comes from the database rather than from a request body, and what
    ended up there could be anything — from a hand edit to an old version of the
    format. date.fromisoformat raised on one such string, and the project became
    permanently unreadable, with no way to fix it through the application.
    Losing one calendar day is the lesser evil compared to losing the project;
    it is visible in the log.
    """
    parsed: set[date] = set()
    for item in raw or []:
        try:
            parsed.add(date.fromisoformat(item))
        except (TypeError, ValueError):
            logger.warning("an unusable date in the calendar was skipped: %r", item)
    return frozenset(parsed)


def resolve_working_days(project: Project, org: Organization) -> int:
    return project.working_days if project.working_days is not None else org.working_days


def resolve_timezone(project: Project, org: Organization) -> str:
    return project.timezone if project.timezone is not None else org.default_timezone


def resolve_shift_threshold(project: Project, org: Organization) -> int:
    if project.shift_threshold_days is not None:
        return project.shift_threshold_days
    return org.default_shift_threshold_days


def project_calendar(project: Project, org: Organization) -> Calendar:
    """The project's calendar: the week mask, minus the organization's and the
    project's holidays, plus the project's explicitly declared working days."""
    holidays = _dates(org.holiday_calendar) | _dates(project.holidays_extra)
    return Calendar(
        working_days=resolve_working_days(project, org),
        holidays=holidays,
        extra_workdays=_dates(project.workdays_extra),
    )
