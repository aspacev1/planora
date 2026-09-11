/**
 * Converting dates into pixels and back.
 *
 * The module deliberately knows nothing about React: dragging will ask `dateAt(x)` dozens of
 * times a second, and checking this conversion through a DOM render would mean checking it
 * slowly and imprecisely.
 *
 * The dates inside are ISO strings rather than `Date` objects. `new Date("2026-03-01")` is
 * parsed as UTC midnight, while `getDate()` gives the day in the machine's zone: west of
 * Greenwich that is already 28 February. All the arithmetic here runs on UTC midnight, and
 * what goes out are the same strings that came from the server.
 */

export const MS_PER_DAY = 86_400_000;

export type Day = {
  /** The date in ISO, exactly in the form the server understands. */
  date: string;
  /** The weekday number by the calendar: 0 is Sunday, as with `getUTCDay`. */
  weekday: number;
  /** The day of the month, for the caption in the header. */
  dayOfMonth: number;
  /** The offset from the strip's start in pixels. */
  x: number;
};

export type Month = {
  /** `YYYY-MM` — a key for React and for comparison in tests. */
  key: string;
  /** How many days of this month fell into the strip. The outermost months can be truncated. */
  days: number;
  x: number;
  width: number;
};

export type Scale = {
  from: string;
  to: string;
  dayWidth: number;
  /**
   * The coordinate system's marker: the strip's start and a day's width.
   *
   * A task's travel is told from a change of picture by it. A bar whose `left` has changed may
   * have travelled — or may have stayed on its own day while the strip changed its scale or
   * widened its window. In the first case the movement has to be shown, in the second it does
   * not: it is not the task that travelled, it is the strip that became different, and all the
   * bars "travelling" at once would read as the plan collapsing.
   */
  key: string;
  days: Day[];
  months: Month[];
  width: number;
  /** A day's left edge in pixels. */
  xOf: (date: string) => number;
  /** The stretch's width, both ends included: a one-day task takes one day. */
  widthOf: (startISO: string, endISO: string) => number;
  /** The date a coordinate fell inside. Beyond the strip's edges — its edges. */
  dateAt: (x: number) => string;
};

/** An ISO string → milliseconds of UTC midnight. */
export function toUtc(iso: string): number {
  const [year, month, day] = iso.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/** Milliseconds of UTC midnight → an ISO string. */
export function toISO(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** How many calendar days from one date to another. Negative if the second is earlier. */
export function daysBetween(fromISO: string, toISO_: string): number {
  return Math.round((toUtc(toISO_) - toUtc(fromISO)) / MS_PER_DAY);
}

/** A date shifted by the given number of calendar days. */
export function addDays(iso: string, days: number): string {
  return toISO(toUtc(iso) + days * MS_PER_DAY);
}

export function buildScale({
  from,
  to,
  dayWidth,
}: {
  from: string;
  to: string;
  dayWidth: number;
}): Scale {
  const start = toUtc(from);
  // Both bounds inclusive: a strip of one day is one day, not zero.
  const count = Math.max(1, Math.round((toUtc(to) - start) / MS_PER_DAY) + 1);

  const days: Day[] = [];
  const months: Month[] = [];

  for (let index = 0; index < count; index += 1) {
    const moment = new Date(start + index * MS_PER_DAY);
    const date = moment.toISOString().slice(0, 10);
    days.push({
      date,
      // By the calendar rather than by the remainder of dividing the index: the index knows only
      // the distance from the strip's start, and when the window's boundary moves such a
      // computation diverges from the real weekday.
      weekday: moment.getUTCDay(),
      dayOfMonth: moment.getUTCDate(),
      x: index * dayWidth,
    });

    const key = date.slice(0, 7);
    const last = months.at(-1);
    if (last && last.key === key) {
      last.days += 1;
      last.width += dayWidth;
    } else {
      months.push({ key, days: 1, x: index * dayWidth, width: dayWidth });
    }
  }

  const width = count * dayWidth;

  return {
    from,
    to,
    dayWidth,
    key: `${from}:${dayWidth}`,
    days,
    months,
    width,
    xOf: (date) => daysBetween(from, date) * dayWidth,
    widthOf: (startISO, endISO) => (daysBetween(startISO, endISO) + 1) * dayWidth,
    dateAt: (x) => {
      // We clamp to the edges rather than give back undefined: during a drag the cursor regularly
      // travels beyond the strip, and dealing with that separately in every caller means
      // forgetting it one day.
      const index = Math.min(count - 1, Math.max(0, Math.floor(x / dayWidth)));
      return days[index].date;
    },
  };
}
