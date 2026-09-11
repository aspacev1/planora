import type { Calendar, ProjectState } from "../api/projects";
import { MS_PER_DAY, addDays, toISO, toUtc } from "./timescale";

/** The strip's scale: how much time falls on one division of the axis. */
export type Zoom = "day" | "week" | "month";

/**
 * A day's width in pixels for each scale. It lives in the browser rather than on
 * the server: this is the picture's scale, not a property of the plan. The numbers
 * are here rather than in the markup so that the strip and the tests call one and
 * the same number by one name.
 *
 * `day` is what the strip opens with: in it a day is read as a number and a weekday.
 * Further on the division shrinks, and at "month" all that is left of the caption is
 * the number.
 *
 * The numbers are whole and disproportionate deliberately. A proportion from the
 * daily 52 would give 33.43 and 17.33, and a fractional day width drives the grid —
 * which is drawn from this value — apart from the bars, which are computed through
 * `xOf`: the divergence accumulates towards the strip's right edge. The same three
 * whole numbers the mockup switches between are taken.
 */
export const DAY_WIDTH: Record<Zoom, number> = { day: 52, week: 30, month: 18 };

/**
 * A row's height in pixels.
 *
 * It lives here rather than only in CSS, because the vertical coordinates of the
 * link arrows are computed from it. Two numbers — one in the styles, the other in
 * the computation — diverge on the very first styling edit, and the arrows drift off
 * the rows. The markup sets this value as the `--gantt-row` variable, and CSS takes
 * it from there.
 */
export const ROW_HEIGHT = 40;

/** The first day of the month the date fell in. */
function firstOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/**
 * The last day of the month the date fell in.
 *
 * Exported: the strip extends the window under a gesture with this same rounding
 * when a bar is held beyond its edge (see reach in Gantt) — and a window under a
 * gesture must end exactly where it will end after the move.
 */
export function lastOfMonth(iso: string): string {
  const moment = new Date(toUtc(iso));
  // Day zero of the next month is the current month's last day. There is no point
  // counting "thirty days, except February" by hand.
  return toISO(Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth() + 1, 0));
}

/**
 * The strip's bounds.
 *
 * The window is stretched over everything the chart must show: the tasks, the
 * deadline and the project end computed by the server. The deadline is included
 * separately from the tasks because it is drawn as a vertical — beyond the strip's
 * edge it is simply invisible, and the person will decide there is no deadline.
 *
 * Today is not part of the window: a project planned for last spring would stretch
 * the strip over a year of emptiness. The today marker is drawn only if the day fell
 * into the window anyway.
 *
 * The edges are rounded to a month: a header with a truncated first month reads as a
 * layout error.
 */
export function projectWindow(state: ProjectState, today: string): { from: string; to: string } {
  const dates = [
    ...state.tasks.map((task) => task.start_date),
    ...state.tasks.map((task) => task.end_date),
    ...(state.deadline ? [state.deadline] : []),
    ...(state.project_end ? [state.project_end] : []),
  ];

  if (dates.length === 0) {
    // Not a single date — the window goes around today: an empty project must still
    // show a scale, otherwise the screen looks broken. Today arrives from outside,
    // computed in the reader's zone: our own, computed here in UTC, would diverge
    // from the today marker on the same strip.
    return { from: firstOfMonth(today), to: lastOfMonth(addDays(today, 30)) };
  }

  // ISO strings compare lexicographically exactly like dates: their fields have a
  // fixed width and the most significant one is on the left.
  const earliest = dates.reduce((a, b) => (a < b ? a : b));
  const latest = dates.reduce((a, b) => (a > b ? a : b));
  return { from: firstOfMonth(earliest), to: lastOfMonth(latest) };
}

/**
 * Whether this is a working day by the project's calendar.
 *
 * The order of application is the same as on the server: the weekday mask, then the
 * holidays remove days from it, then `extra_workdays` bring specific dates back. The
 * rule being repeated here is not a date computation: dates are computed by the
 * server. This is a background fill, and without it a person puts a task on a Sunday
 * without noticing.
 */
export function isWorkingDay(date: string, calendar: Calendar, weekday: number): boolean {
  if (calendar.extra_workdays.includes(date)) return true;
  if (calendar.holidays.includes(date)) return false;
  // The mask came from Python, where Monday is bit zero. `weekday` came from
  // `getUTCDay`, where zero is Sunday. Without this conversion the filled days turn
  // out to be Sunday and Monday instead of Saturday and Sunday.
  const mondayFirst = (weekday + 6) % 7;
  return (calendar.working_days & (1 << mondayFirst)) !== 0;
}

/**
 * How many working days are in a stretch, both ends included. Zero — there turned
 * out to be no working days in the stretch at all (a week of holidays) or the end is
 * earlier than the start.
 *
 * Needed by exactly one gesture — stretching a bar by its edge. The edge is dragged
 * along the scale, and the scale is marked out in calendar days; the duration,
 * meanwhile, is set in working ones, and without this reckoning there is nothing to
 * convert one into the other with.
 *
 * This is not moving the server's arithmetic to the client but a guess for the
 * duration of a gesture — the same contract as a bar's move: the client shows what
 * will come out, the server computes for real and sends the end date the bar will
 * stand by. These two reckonings can only diverge where the tab's calendar is stale
 * — and then the bar will stand by the server's answer rather than by the guess.
 *
 * The calendar is taken from the project's state rather than assembled here: the
 * mask, the holiday days and the declared working days arrive with the state
 * precisely so that the strip does not have to guess about them (see `isWorkingDay`).
 */
export function workingDaysBetween(fromISO: string, toISO: string, calendar: Calendar): number {
  if (toISO < fromISO) return 0;
  let count = 0;
  const last = toUtc(toISO);
  for (let moment = toUtc(fromISO); moment <= last; moment += MS_PER_DAY) {
    const day = new Date(moment);
    if (isWorkingDay(day.toISOString().slice(0, 10), calendar, day.getUTCDay())) count += 1;
  }
  return count;
}
