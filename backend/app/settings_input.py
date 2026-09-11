"""Parsing and validating the settings that arrive from the interface.

Separate from the routes, because the same values are configured at two levels:
working days, the timezone and the shift threshold exist both on an
organization and on a project — with the difference that on a project they
allow `null` ("inherit"). Validation written separately in two routes will
drift apart on the first edit, and it will drift silently: a value that slipped
through simply lands in the database.
"""

from datetime import date
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, field_validator

from app.config import get_settings
from app.text import slugify

# The working-day mask is seven bits. Zero is forbidden: a calendar without a
# single working day makes it impossible to compute any finish date, and the
# project stops being readable altogether. Refusing at input is more honest than
# showing a 500 later.
MIN_WORKING_DAYS = 1
MAX_WORKING_DAYS = 0b1111111


class SettingsInput(BaseModel):
    """What is common to settings at every level.

    `extra="forbid"`: a typo in a field name must be a refusal rather than a
    silently ignored line after which a person wonders why the setting did not
    save.
    """

    model_config = ConfigDict(extra="forbid")


def check_timezone(value: str) -> str:
    """The timezone — by a name from the IANA database, not as a free string.

    It is stored so that one day dates can be shown in the project's timezone;
    an unvalidated name would surface on that day rather than on the day it was
    entered.
    """
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        raise ValueError("неизвестный часовой пояс")
    return value


def check_locale(value: str) -> str:
    supported = get_settings().locales
    if value not in supported:
        raise ValueError(f"язык вне списка поддерживаемых: {', '.join(supported)}")
    return value


def check_dates(value: list) -> list[str]:
    """A list of non-working (or, conversely, working) dates.

    It is reduced to a sorted set with no repeats: a calendar is a set of dates,
    not a log of the order in which they were entered. That also removes the
    case of "the same date twice", on which the list grows silently.
    """
    parsed: set[date] = set()
    for item in value:
        if not isinstance(item, str):
            raise ValueError("дата должна быть строкой в формате ГГГГ-ММ-ДД")
        try:
            parsed.add(date.fromisoformat(item))
        except ValueError:
            raise ValueError(f"непригодная дата: {item!r}")
    return [day.isoformat() for day in sorted(parsed)]


def check_working_days(value: int) -> int:
    if not MIN_WORKING_DAYS <= value <= MAX_WORKING_DAYS:
        raise ValueError("маска рабочих дней вне диапазона или пуста")
    return value


class OrganizationSettingsIn(SettingsInput):
    """Level 2: the organization's defaults, inherited by all of its projects."""

    name: str | None = None
    slug: str | None = None
    default_locale: str | None = None
    default_timezone: str | None = None
    working_days: int | None = None
    week_start: int | None = None
    holiday_calendar: list | None = None
    default_shift_threshold_days: int | None = None
    public_sharing_enabled: bool | None = None
    default_comments_enabled: bool | None = None

    @field_validator("default_timezone")
    @classmethod
    def _timezone(cls, value: str | None) -> str | None:
        return None if value is None else check_timezone(value)

    @field_validator("default_locale")
    @classmethod
    def _locale(cls, value: str | None) -> str | None:
        return None if value is None else check_locale(value)

    @field_validator("working_days")
    @classmethod
    def _working_days(cls, value: int | None) -> int | None:
        return None if value is None else check_working_days(value)

    @field_validator("week_start")
    @classmethod
    def _week_start(cls, value: int | None) -> int | None:
        if value is not None and not 0 <= value <= 6:
            raise ValueError("первый день недели вне 0..6")
        return value

    @field_validator("default_shift_threshold_days")
    @classmethod
    def _threshold(cls, value: int | None) -> int | None:
        if value is not None and value < 0:
            raise ValueError("порог не может быть отрицательным")
        return value

    @field_validator("holiday_calendar")
    @classmethod
    def _holidays(cls, value: list | None) -> list | None:
        return None if value is None else check_dates(value)

    @field_validator("slug")
    @classmethod
    def _slug(cls, value: str | None) -> str | None:
        """The slug is reduced to its own form here rather than at the caller.

        Otherwise `slug-check` and saving diverge: the input field shows
        `redizayn-2026` while "Редизайн 2026" lands in the database — and the
        public address turns out not to be the one just shown to the person. An
        empty form ("...", nothing but spaces) is replaced with a fallback word:
        an address without a slug does not open at all.
        """
        return None if value is None else slugify(value, fallback="org")


    @field_validator("name", "slug")
    @classmethod
    def _not_blank(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            raise ValueError("значение не может быть пустым")
        return stripped


class ProjectSettingsIn(SettingsInput):
    """Level 3: the project's settings.

    Three values here allow `null`, and `null` means "inherit from the
    organization" rather than "empty". Telling "null was sent" from "nothing was
    sent at all" is made possible by `model_fields_set`: without it, clearing an
    override would be inexpressible — any request without the field would erase
    it.
    """

    name: str | None = None
    slug: str | None = None
    deadline: date | None = None
    timezone: str | None = None
    working_days: int | None = None
    shift_threshold_days: int | None = None
    holidays_extra: list | None = None
    workdays_extra: list | None = None
    # Automatic shifting along dependencies. `null` does not mean "inherit" for
    # it: an organization has no such setting at all, and it is not in
    # NULLABLE_PROJECT_FIELDS — a `null` that is sent is simply ignored, as it is
    # for every field outside that list.
    auto_schedule: bool | None = None

    @field_validator("timezone")
    @classmethod
    def _timezone(cls, value: str | None) -> str | None:
        return None if value is None else check_timezone(value)

    @field_validator("working_days")
    @classmethod
    def _working_days(cls, value: int | None) -> int | None:
        return None if value is None else check_working_days(value)

    @field_validator("shift_threshold_days")
    @classmethod
    def _threshold(cls, value: int | None) -> int | None:
        if value is not None and value < 0:
            raise ValueError("порог не может быть отрицательным")
        return value

    @field_validator("slug")
    @classmethod
    def _slug(cls, value: str | None) -> str | None:
        """The slug is reduced to its own form here rather than at the caller.

        Otherwise `slug-check` and saving diverge: the input field shows
        `redizayn-2026` while "Редизайн 2026" lands in the database — and the
        public address turns out not to be the one just shown to the person. An
        empty form ("...", nothing but spaces) is replaced with a fallback word:
        an address without a slug does not open at all.
        """
        return None if value is None else slugify(value, fallback="project")

    @field_validator("holidays_extra", "workdays_extra")
    @classmethod
    def _dates(cls, value: list | None) -> list | None:
        return None if value is None else check_dates(value)

    @field_validator("name", "slug")
    @classmethod
    def _not_blank(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            raise ValueError("значение не может быть пустым")
        return stripped


# The fields for which `null` is allowed as a value ("inherit from the
# organization"). For everything else a `null` only marks it as "do not change".
NULLABLE_PROJECT_FIELDS = frozenset({"deadline", "timezone", "working_days", "shift_threshold_days"})


def changes(payload: SettingsInput, *, nullable: frozenset[str] = frozenset()) -> dict:
    """The fields that were sent -> the set of changes.

    A field that was absent from the request body is not changed at all. A field
    with a `null` value is either reset to "inherit" (if it is one of the
    `nullable` ones) or ignored — because for the rest `null` is not a value but
    the absence of an answer.
    """
    sent = payload.model_dump(exclude_unset=True)
    return {
        field: value
        for field, value in sent.items()
        if value is not None or field in nullable
    }
