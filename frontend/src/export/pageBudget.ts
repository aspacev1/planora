/**
 * How many pages the strip will take — the same computation as on the server.
 *
 * The repetition here is not an oversight: the dialog writes the number of pages right on the
 * scale button, and asking for it by request on every press would mean flickering buttons. The
 * reference is `backend/app/export/budget.py`; the tests on both sides check one table of
 * expectations, and they will not let them diverge silently.
 */

export type Zoom = "day" | "week" | "month";
export type Period = "all" | "next_4w" | "next_3m" | "from_today";
export type Orientation = "landscape" | "portrait";

export const ZOOMS: readonly Zoom[] = ["day", "week", "month"];
export const PERIODS: readonly Period[] = ["all", "next_4w", "next_3m", "from_today"];

/** The periods that make no sense without real dates: the "Day N" axis knows no "today". */
export const DATED_PERIODS: readonly Period[] = ["next_4w", "next_3m", "from_today"];

/**
 * Days in a column's unit. A "month" here is exactly thirty days rather than a calendar one: a
 * page's capacity is an estimate rather than a layout, and calendar arithmetic would give a
 * different number of pages for a project shifted by a week.
 */
const DAYS_PER_UNIT: Record<Zoom, number> = { day: 1, week: 7, month: 30 };

/** A column's width in points — the minimum at which the scale's caption is readable. */
const UNIT_WIDTH_PT: Record<Zoom, number> = { day: 8, week: 20, month: 40 };

/** The A4 page width in points. */
const PAGE_WIDTH_PT: Record<Orientation, number> = { landscape: 841.89, portrait: 595.28 };
const MARGIN_PT = 39.69; // 14 mm
const LABEL_COLUMN_PT = 168;

/** How many strip pages counts as a decent default. */
export const COMFORTABLE_PAGES = 2;

/** The ceiling: beyond it a scale is neither offered nor accepted by the server. */
export const MAX_PAGES = 6;

export function daysPerPage(zoom: Zoom, orientation: Orientation): number {
  const chart = PAGE_WIDTH_PT[orientation] - 2 * MARGIN_PT - LABEL_COLUMN_PT;
  return Math.max(1, Math.floor(chart / UNIT_WIDTH_PT[zoom])) * DAYS_PER_UNIT[zoom];
}

/** An empty project is one page with a header, not zero. */
export function pageCount(days: number, zoom: Zoom, orientation: Orientation): number {
  if (days <= 0) return 1;
  return Math.ceil(days / daysPerPage(zoom, orientation));
}

export type ZoomOption = { zoom: Zoom; pages: number; allowed: boolean };

/**
 * Whether a scale fits within the ceiling.
 *
 * The coarsest one is always allowed, however many pages it comes to: the ceiling exists so that a
 * person does not choose unnecessary detail, and a month has no less detailed neighbour. Refusing
 * on it would mean that a ten-year portfolio cannot be exported at all.
 */
export function zoomAllowed(zoom: Zoom, days: number, orientation: Orientation): boolean {
  if (zoom === ZOOMS[ZOOMS.length - 1]) return true;
  return pageCount(days, zoom, orientation) <= MAX_PAGES;
}

/**
 * The scales with their price — exactly what the dialog writes on the buttons.
 *
 * An unavailable scale stays in the list with its number of pages: a person must understand what
 * the detail costs rather than guess where the button went.
 */
export function zoomOptions(days: number, orientation: Orientation): ZoomOption[] {
  return ZOOMS.map((zoom) => ({
    zoom,
    pages: pageCount(days, zoom, orientation),
    allowed: zoomAllowed(zoom, days, orientation),
  }));
}

/**
 * The most detailed scale that fits within a decent number of pages.
 *
 * If none fits — the coarsest: a month on any conceivable project gives single-digit pages, and
 * giving a refusal instead of a file would be disrespectful to someone who simply pressed
 * "Download".
 */
export function defaultZoom(days: number, orientation: Orientation): Zoom {
  return (
    ZOOMS.find((zoom) => pageCount(days, zoom, orientation) <= COMFORTABLE_PAGES) ??
    ZOOMS[ZOOMS.length - 1]
  );
}

const DAY = 86_400_000;

function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY);
}

/** The window's length in days — by the same rules as `resolve_window` on the server. */
export function windowDays(
  period: Period,
  projectStart: string,
  projectEnd: string,
  today: string,
): number {
  const whole = dayDiff(projectStart, projectEnd) + 1;
  if (period === "all") return Math.max(whole, 1);

  const start = Date.parse(today) > Date.parse(projectStart) ? today : projectStart;
  const offset = dayDiff(start, projectEnd) + 1;
  if (offset <= 0) return 1; // the project is entirely in the past: we show its end

  if (period === "from_today") return offset;
  return Math.min(offset, period === "next_4w" ? 28 : 90);
}
