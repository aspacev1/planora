/**
 * The relative axis: "Month 1 / Week 1 / Day 1" instead of real dates.
 *
 * The server stores a relative plan's tasks as coordinates on this axis: project day N =
 * RELATIVE_EPOCH + (N − 1) calendar days. The module converts coordinates into day and
 * week numbers — linear arithmetic, not calendar arithmetic: working days and end dates
 * are still computed by the server.
 *
 * The epoch is a Monday, so "Week 1" starts on a Monday and the working-week mask lands
 * on the grid's columns with no corrections. A "month" here is not a calendar month but a
 * visual group of four weeks: a plan without dates has no real months.
 */

import type { ProjectState } from "../api/projects";
import type { Params } from "../i18n";
import { addDays, daysBetween } from "./timescale";
import type { Scale } from "./timescale";

/** The relative axis's start. The same value as RELATIVE_EPOCH on the server. */
export const RELATIVE_EPOCH = "2001-01-01";

/** Days in a "week" and a "month" of the relative scale. */
export const WEEK_DAYS = 7;
export const MONTH_WEEKS = 4;

/**
 * The project day number at a coordinate, starting from one.
 *
 * `anchor` is the axis's start: the epoch for a relative plan, the assigned start date
 * for a calendar one shown in the relative view.
 */
export function projectDayNumber(iso: string, anchor: string = RELATIVE_EPOCH): number {
  return daysBetween(anchor, iso) + 1;
}

/** A project day's coordinate: projectDayNumber in reverse, for input forms. */
export function dateOfProjectDay(day: number, anchor: string = RELATIVE_EPOCH): string {
  return addDays(anchor, day - 1);
}

/**
 * The end of the week a coordinate fell in.
 *
 * The relative strip's window stretches its right edge with this rounding — both when
 * built from the last task (see relativeWindow) and when the strip is extended under a
 * gesture: a bar is held beyond the window's edge, and the grid must grow to its week by
 * the same rule it would have grown by after the move (see reach in Gantt). A second
 * rounding written anew there would diverge from this one on the first edit — and the
 * window under a gesture would end somewhere other than where it ends after it.
 */
export function relativeWeekEnd(iso: string, anchor: string = RELATIVE_EPOCH): string {
  return addDays(anchor, Math.ceil(projectDayNumber(iso, anchor) / WEEK_DAYS) * WEEK_DAYS - 1);
}

/**
 * How many whole weeks fit into the width allotted to the scale.
 *
 * The lower bound of the strip's window rather than its real edge: the window still
 * stretches to the last occupied week if the tasks go further (see `relativeWindow`).
 * Needed because a relative plan's window is not derived from dates — it has no real
 * dates — and without this correction it is always exactly four weeks: 504 pixels at the
 * "Month" scale, however much room there is on screen. The remainder on the right stayed
 * white at that, and the strip's right edge read as a layout break rather than as the
 * plan's end.
 *
 * The weeks are whole: the header is cut by weeks (see `spansOf`), and half a week at its
 * end would read as the same break this is written to avoid. A remainder shorter than a
 * week is covered by the "beyond the plan" band (see `.gantt__beyond`).
 *
 * Not less than a "month": a narrow window is no reason to show an empty project less of
 * the scale than the whole of "Month 1".
 */
export function weeksAcross(laneWidth: number, dayWidth: number): number {
  const weekWidth = WEEK_DAYS * dayWidth;
  // There is no width yet (the first render, jsdom) — the scale is built by default.
  if (!(laneWidth > 0) || !(weekWidth > 0)) return MONTH_WEEKS;
  return Math.max(MONTH_WEEKS, Math.floor(laneWidth / weekWidth));
}

/**
 * The relative strip's window.
 *
 * From the anchor to the end of the last occupied week — and no shorter than `minWeeks`
 * weeks: an empty project still shows the "Month 1" scale, and on a wide screen — as many
 * whole weeks as fit (see `weeksAcross`). The deadline and today are deliberately not part
 * of the window: both dates are real, and this axis has no real dates.
 */
export function relativeWindow(
  state: ProjectState,
  anchor: string = RELATIVE_EPOCH,
  minWeeks: number = MONTH_WEEKS,
): { from: string; to: string } {
  const dates = [
    ...state.tasks.map((task) => task.start_date),
    ...state.tasks.map((task) => task.end_date),
    ...(state.project_end ? [state.project_end] : []),
  ].filter((date) => date >= anchor);

  const latest = dates.length === 0 ? anchor : dates.reduce((a, b) => (a > b ? a : b));
  const floorEnd = addDays(anchor, Math.max(MONTH_WEEKS, minWeeks) * WEEK_DAYS - 1);
  const weekEnd = relativeWeekEnd(latest, anchor);
  return { from: anchor, to: weekEnd > floorEnd ? weekEnd : floorEnd };
}

export type RelativeSpan = {
  /** A month's or a week's number, from one. */
  number: number;
  x: number;
  width: number;
};

/** Cuts the scale's days into stretches of `size` days — the header's weeks and "months". */
function spansOf(scale: Scale, size: number): RelativeSpan[] {
  const spans: RelativeSpan[] = [];
  const total = scale.days.length;
  for (let start = 0; start < total; start += size) {
    const days = Math.min(size, total - start);
    spans.push({
      number: Math.floor(start / size) + 1,
      x: start * scale.dayWidth,
      width: days * scale.dayWidth,
    });
  }
  return spans;
}

export function relativeWeeks(scale: Scale): RelativeSpan[] {
  return spansOf(scale, WEEK_DAYS);
}

type Translate = (key: string, params?: Params) => string;

/** "Day 12" — the caption for a coordinate where a calendar project would show a date. */
export function relativeDayLabel(
  t: Translate,
  iso: string,
  anchor: string = RELATIVE_EPOCH,
): string {
  return t("gantt.relative.day", { number: projectDayNumber(iso, anchor) });
}

export function relativeMonths(scale: Scale): RelativeSpan[] {
  return spansOf(scale, WEEK_DAYS * MONTH_WEEKS);
}
