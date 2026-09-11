import type { Locale, Params } from "./index";

type Translate = (key: string, params?: Params) => string;

/**
 * The month and weekday names are taken from the dictionaries rather than from `Intl`.
 *
 * The reason is not principle but a live check: ICU in the browser knows the `az` locale but
 * contains no month names for it and silently falls back to the root locale —
 * `Intl.DateTimeFormat("az", { month: "long" })` gives "M09" instead of "sentyabr", and a narrow
 * weekday gives the Latin letter of the English name. For the language this product has by default
 * that is not a small cosmetic defect: half the scale stops being readable.
 *
 * As a bonus, the dependency on which ICU build a particular browser was compiled with disappears:
 * the same captions for everyone.
 */

/** The month number from an ISO string, from 1 to 12. */
function monthNumber(iso: string): number {
  return Number(iso.slice(5, 7));
}

/** "15 September" — the day with the month in the form the language requires. */
export function formatDate(t: Translate, iso: string): string {
  return t("calendar.date", {
    day: Number(iso.slice(8, 10)),
    month: t(`calendar.month_in.${monthNumber(iso)}`),
  });
}

/**
 * "15 Sep" — the same date in tight quarters.
 *
 * A separate form rather than a truncation of the full one: in the card and in the history feed a
 * date stands next to other words and in a narrow column, and "15 September" wraps onto a second
 * line there. The abbreviations are also from the dictionaries — for the same reason as the full
 * names.
 */
export function formatShortDate(t: Translate, iso: string): string {
  return t("calendar.date_short", {
    day: Number(iso.slice(8, 10)),
    month: t(`calendar.month_short.${monthNumber(iso)}`),
  });
}

/** "September 2026" — a month's caption in the strip's header. */
export function formatMonth(t: Translate, iso: string): string {
  return t("calendar.month_year", {
    month: t(`calendar.month.${monthNumber(iso)}`),
    year: Number(iso.slice(0, 4)),
  });
}

/**
 * "14:32" — the hour and the minute by the clock of whoever is looking.
 *
 * The only place in this file where `Intl` is asked, and that is not a contradiction of the above:
 * the gap in ICU's data for `az` concerns names — of months and weekdays — while here there are
 * only digits and a separator. The format is still decided by the language: an English reader
 * expects "2:32 PM" where a Russian and an Azerbaijani one expect "14:32".
 *
 * The time zone is the local one rather than the project's: "data as of 14:32" is checked by a
 * person against the clock on their own wall rather than against a project setting.
 */
export function formatTime(locale: Locale, at: number | Date): string {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(at);
}

/** A narrow weekday caption: 0 is Sunday, as with `getUTCDay`. */
export function weekdayNarrow(t: Translate, weekday: number): string {
  return t(`calendar.weekday.${weekday}`);
}
