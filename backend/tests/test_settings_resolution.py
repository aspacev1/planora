from datetime import date

from app.calendar import WEEKDAYS_MON_FRI
from app.models import Organization, Project
from app.settings_resolution import (
    project_calendar,
    resolve_shift_threshold,
    resolve_timezone,
    resolve_working_days,
)

SUN_TO_THU = (1 << 6) | (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3)


def _org(**kwargs) -> Organization:
    org = Organization(name="Acme", slug="acme", **kwargs)
    org.default_locale = kwargs.get("default_locale", "az")
    org.default_timezone = kwargs.get("default_timezone", "Asia/Baku")
    org.working_days = kwargs.get("working_days", WEEKDAYS_MON_FRI)
    org.default_shift_threshold_days = kwargs.get("default_shift_threshold_days", 2)
    org.holiday_calendar = kwargs.get("holiday_calendar", [])
    return org


def _project(**kwargs) -> Project:
    project = Project(name="Redesign", slug="redesign")
    project.timezone = kwargs.get("timezone")
    project.working_days = kwargs.get("working_days")
    project.shift_threshold_days = kwargs.get("shift_threshold_days")
    project.holidays_extra = kwargs.get("holidays_extra", [])
    project.workdays_extra = kwargs.get("workdays_extra", [])
    return project


def test_null_on_the_project_means_inherit():
    org = _org(working_days=SUN_TO_THU, default_shift_threshold_days=5)
    project = _project()

    assert resolve_working_days(project, org) == SUN_TO_THU
    assert resolve_shift_threshold(project, org) == 5


def test_explicit_value_on_the_project_wins():
    org = _org(working_days=SUN_TO_THU, default_shift_threshold_days=5)
    project = _project(working_days=WEEKDAYS_MON_FRI, shift_threshold_days=1)

    assert resolve_working_days(project, org) == WEEKDAYS_MON_FRI
    assert resolve_shift_threshold(project, org) == 1


def test_changing_the_org_default_reaches_inheriting_projects_only():
    org = _org(default_shift_threshold_days=2)
    inheriting = _project()
    overriding = _project(shift_threshold_days=7)

    org.default_shift_threshold_days = 10

    assert resolve_shift_threshold(inheriting, org) == 10
    assert resolve_shift_threshold(overriding, org) == 7


def test_calendar_layers_org_holidays_then_project_extras():
    org = _org(holiday_calendar=["2026-03-20"])
    project = _project(holidays_extra=["2026-03-21"], workdays_extra=["2026-03-07"])

    cal = project_calendar(project, org)

    assert cal.is_working(date(2026, 3, 20)) is False  # the organization's holiday
    assert cal.is_working(date(2026, 3, 21)) is False  # the project's extra day off
    assert cal.is_working(date(2026, 3, 7)) is True    # the project's working Saturday
    assert cal.is_working(date(2026, 3, 19)) is True   # an ordinary Thursday


def test_timezone_is_inherited_unless_the_project_names_its_own():
    org = _org(default_timezone="Asia/Baku")

    assert resolve_timezone(_project(), org) == "Asia/Baku"
    assert resolve_timezone(_project(timezone="Europe/Berlin"), org) == "Europe/Berlin"


def test_a_working_days_mask_of_zero_is_a_value_and_not_inheritance():
    """Zero means "there are no working weekdays at all" rather than "not set".

    A truthiness check instead of `is not None` would silently turn this into
    inheritance, and a project where the whole week is off would get the
    organization's weekdays.
    """
    org = _org(working_days=WEEKDAYS_MON_FRI)
    project = _project(working_days=0)

    assert resolve_working_days(project, org) == 0
    assert project_calendar(project, org).is_working(date(2026, 3, 19)) is False


def test_a_shift_threshold_of_zero_is_a_value_and_not_inheritance():
    # A threshold of 0 means "ask about any shift", a meaningful setting.
    org = _org(default_shift_threshold_days=5)

    assert resolve_shift_threshold(_project(shift_threshold_days=0), org) == 0


def test_a_project_workday_wins_over_an_organization_holiday():
    """The order of application is pinned: the week mask, holidays trim it, and the
    project's explicit working days bring a particular date back."""
    org = _org(holiday_calendar=["2026-03-20"])
    project = _project(workdays_extra=["2026-03-20"])

    assert project_calendar(project, org).is_working(date(2026, 3, 20)) is True


def test_a_malformed_date_in_the_stored_calendar_is_skipped_not_fatal():
    # The list comes from the database: one corrupted entry must not make a project
    # unreadable forever.
    org = _org(holiday_calendar=["2026-03-20", "не дата", None])
    project = _project(holidays_extra=["", "2026-03-21"])

    cal = project_calendar(project, org)

    assert cal.is_working(date(2026, 3, 20)) is False
    assert cal.is_working(date(2026, 3, 21)) is False
    assert cal.is_working(date(2026, 3, 19)) is True
