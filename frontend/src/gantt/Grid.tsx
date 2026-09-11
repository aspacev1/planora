import type { Calendar } from "../api/projects";
import { isWorkingDay } from "./scale";
import type { Scale } from "./timescale";

/**
 * The strip's background: the day columns, the fill of the non-working ones, the deadline and today
 * verticals.
 *
 * The grid is built once for the whole chart and stretched by height rather than repeated in every row.
 * With a hundred tasks and a hundred days repeating it would give ten thousand nodes for a picture that
 * is identical in every row.
 *
 * For a screen reader it is invisible: this is background, and there is no point enumerating a hundred
 * dates in a row to someone listening to the page — they learn a task's dates from its bar.
 */
export function Grid({
  scale,
  calendar,
  deadline,
  today,
  deadlineLabel,
  todayLabel,
}: {
  scale: Scale;
  calendar: Calendar;
  deadline: string | null;
  today: string;
  deadlineLabel: string;
  todayLabel: string;
}) {
  const withinWindow = (date: string) => date >= scale.from && date <= scale.to;

  return (
    <div className="gantt__grid" style={{ width: scale.width }} aria-hidden="true">
      {scale.days.map((day) => (
        <div
          key={day.date}
          data-day={day.date}
          className={`gantt__grid-day${isWorkingDay(day.date, calendar, day.weekday) ? "" : " is-nonworking"}`}
          style={{ left: day.x, width: scale.dayWidth }}
        />
      ))}

      {deadline && withinWindow(deadline) && (
        <div
          className="gantt__deadline"
          style={{ left: scale.xOf(deadline) + scale.dayWidth }}
          title={deadlineLabel}
        />
      )}

      {withinWindow(today) && (
        // The line runs through the middle of a column rather than along its left edge: on the boundary
        // between yesterday and today it is unclear which of the two days it names, while in the middle
        // it points unambiguously at its own day — and comes exactly under the "today" caption in the
        // header.
        <div
          className="gantt__today"
          style={{ left: scale.xOf(today) + scale.dayWidth / 2 }}
          title={todayLabel}
        />
      )}
    </div>
  );
}
