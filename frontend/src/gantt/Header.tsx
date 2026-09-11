import type { Calendar } from "../api/projects";
import { relativeMonths, relativeWeeks } from "./relative";
import { isWorkingDay } from "./scale";
import type { Scale } from "./timescale";

/**
 * The strip's header: the months on top, the days below.
 *
 * The non-working days are filled here too rather than only in the body: a filled column that
 * breaks off under the header reads as a rendering defect rather than as a day off.
 */
export function Header({
  scale,
  calendar,
  today,
  todayLabel,
  monthLabel,
  weekdayLabel,
}: {
  scale: Scale;
  calendar: Calendar;
  /** Today by ISO: its column in the header is highlighted. */
  today: string;
  /** The caption under today's date, "Today" for example. */
  todayLabel: string;
  monthLabel: (iso: string) => string;
  weekdayLabel: (weekday: number) => string;
}) {
  return (
    <div className="gantt__head" style={{ width: scale.width }}>
      <div className="gantt__months">
        {scale.months.map((month) => (
          <div
            key={month.key}
            className="gantt__month"
            style={{ left: month.x, width: month.width }}
          >
            {/* A month is captioned by its own first day: a truncated outermost month is still
                called by its own name. */}
            <span className="gantt__month-label">{monthLabel(`${month.key}-01`)}</span>
          </div>
        ))}
      </div>

      <div className="gantt__days">
        {scale.days.map((day) => (
          <div
            key={day.date}
            data-day={day.date}
            className={`gantt__day${isWorkingDay(day.date, calendar, day.weekday) ? "" : " is-nonworking"}${
              day.date === today ? " is-today" : ""
            }`}
            style={{ left: day.x, width: scale.dayWidth }}
          >
            {/* The weekday above the date, as in the mockup: a small line on top, the date below it
                larger — and in a circle if the day is today. */}
            <span className="gantt__day-weekday">{weekdayLabel(day.weekday)}</span>
            <span className="gantt__day-number">{day.dayOfMonth}</span>
            {/* The "today" caption stands under the date rather than on the line in the strip's
                body: in the header a chip bothers nobody, while on the line it would cover the bars
                of the very tasks on the day it is drawn for. */}
            {day.date === today && <span className="gantt__day-today">{todayLabel}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The relative scale's header: "Month 1" above the weeks, "Week 1" above the days, and in the day
 * columns the day's number within the week, 1–7.
 *
 * There are deliberately no real dates in this header: no month names, no weekdays, no "today"
 * marker — the plan is not tied to a calendar yet, and any real date here would be a promise nobody
 * made. A "month" is a visual group of four weeks, and the computations run in days (see
 * relative.ts).
 *
 * The fill of the non-working days stays: the week's mask is part of the plan without real dates
 * too, and a person must see that "Day 6" of their week is a day off.
 */
export function RelativeHeader({
  scale,
  calendar,
  monthLabel,
  weekLabel,
}: {
  scale: Scale;
  calendar: Calendar;
  monthLabel: (number: number) => string;
  weekLabel: (number: number) => string;
}) {
  return (
    <div className="gantt__head gantt__head--relative" style={{ width: scale.width }}>
      <div className="gantt__months">
        {relativeMonths(scale).map((month) => (
          <div
            key={month.number}
            className="gantt__month"
            style={{ left: month.x, width: month.width }}
          >
            <span className="gantt__month-label">{monthLabel(month.number)}</span>
          </div>
        ))}
      </div>

      <div className="gantt__weeks">
        {relativeWeeks(scale).map((week) => (
          <div
            key={week.number}
            className="gantt__week"
            style={{ left: week.x, width: week.width }}
          >
            <span className="gantt__week-label">{weekLabel(week.number)}</span>
          </div>
        ))}
      </div>

      <div className="gantt__days">
        {scale.days.map((day, index) => (
          <div
            key={day.date}
            data-day={day.date}
            className={`gantt__day${isWorkingDay(day.date, calendar, day.weekday) ? "" : " is-nonworking"}`}
            style={{ left: day.x, width: scale.dayWidth }}
          >
            {/* The day's number within the week rather than from the project's start: a column of
                18–52 pixels holds one or two digits, and a count into the hundreds is unreadable in
                it. The week is named on the line above. */}
            <span className="gantt__day-number">{(index % 7) + 1}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
