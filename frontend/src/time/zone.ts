/**
 * Today by the reader's clock.
 *
 * "Today" in this product is not a moment in time but a calendar day: the today line on
 * the strip stands by it, a task's expected readiness is computed by it, and whether it
 * is overdue is decided by it. Taken by truncating `toISOString()`, it was computed in
 * UTC — and for a reader in UTC+3 "today" was yesterday's date from midnight until three
 * in the morning: the line stood in the wrong place, and a day's mark went into the day
 * before.
 *
 * So the day here is assembled from calendar fields in the required zone rather than by
 * truncating an ISO string. The zone arrives from outside — from the profile, the project
 * or the browser (see useToday.ts): this module deliberately knows nothing about React or
 * about whose zone it is.
 *
 * Date arithmetic lives in gantt/timescale.ts and stays UTC-midnight: there the dates are
 * strings from the server, which have neither an hour nor a zone. The only place the zone
 * is needed at all is the "moment in time → day" transition, and it is here.
 */

/** The time zone of the machine the page is open on. */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    // The zone is the only thing `Intl` may turn out not to have; the rest of the
    // application rests on it anyway. Emptiness here is more honest than an invented
    // "UTC": it means "ask the machine itself" (see machineDay).
    return undefined;
  }
}

/**
 * The formatters are cached: `dateAt` during a drag and the strip's repaint ask for the
 * day dozens of times a second, while building an `Intl.DateTimeFormat` is the most
 * expensive part of this conversion.
 *
 * A `null` in the cache is a memory that the zone name is unusable: there is no point
 * raising an exception on it a second time.
 */
const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) return cached;

  let formatter: Intl.DateTimeFormat | null = null;
  try {
    // The calendar and the digits are set in the locale itself: without them a reader with
    // a Persian or Arabic calendar in their system settings would get "۱۴۰۵-۰۵-۲۴" — a
    // string the server does not understand and which does not compare with the tasks' dates.
    formatter = new Intl.DateTimeFormat("en-CA-u-ca-gregory-nu-latn", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    // The zone name arrives from the profile and the project settings, where the server
    // checked it against the IANA database. But a browser can be older than that database,
    // and crashing the whole page on a zone it does not know will not do: the day is simply
    // computed by the machine's clock.
    formatter = null;
  }
  formatters.set(timeZone, formatter);
  return formatter;
}

/** The day by the machine's own clock — the same as what its clock shows. */
function machineDay(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * Which calendar day it is in this zone at the given moment.
 *
 * Without a zone — by the machine's clock: that is exactly what a person sees on their
 * own wall, and the best approximation while the zone is unknown.
 */
export function dayIn(
  timeZone: string | null | undefined,
  at: number | Date = Date.now(),
): string {
  const moment = typeof at === "number" ? new Date(at) : at;
  const formatter = timeZone ? formatterFor(timeZone) : null;
  if (formatter === null) return machineDay(moment);

  // formatToParts rather than format: `en-CA` writes the date as "2026-03-04", but parsing
  // somebody else's format as a string means one day getting "2026-03-04 A.D." and not
  // noticing it.
  const parts = formatter.formatToParts(moment);
  const field = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const year = field("year");
  const month = field("month");
  const day = field("day");
  if (year === "" || month === "" || day === "") return machineDay(moment);
  return `${year}-${month}-${day}`;
}

/**
 * Zone names for the settings' choice.
 *
 * The list is supplied by the browser itself: keeping our own copy of the IANA database
 * would mean ageing along with it, and the server checks the chosen name against its own
 * anyway. `include` holds the values that must be in the list even if the browser does not
 * know them: the person's already saved choice and their machine's zone. Otherwise the
 * select would silently show something other than what is recorded in the profile.
 */
export function timeZoneNames(...include: (string | null | undefined)[]): string[] {
  let known: readonly string[] = [];
  try {
    known = Intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    known = [];
  }
  const names = new Set(known);
  for (const name of include) {
    if (name) names.add(name);
  }
  return [...names].sort();
}
