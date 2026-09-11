/**
 * The columns of the strip's pinned part — the table to the left of the scale.
 *
 * There used to be one column: the task's name. Everything else — the dates, the
 * duration, the percentage, the assignees — lived in the card, that is, opened
 * one task at a time. Comparing ten tasks' dates by eye that way is impossible,
 * and that is exactly what people do when looking at the chart.
 *
 * The set of columns and their widths are the screen's state, not the project's:
 * a colleague on the project must not get somebody else's layout. They live in
 * the browser, tied to the project, for the same reason as the scale (see
 * scalePreference.ts).
 */

export const COLUMN_KEYS = ["task", "start", "end", "duration", "progress", "assignee"] as const;

export type ColumnKey = (typeof COLUMN_KEYS)[number];

/**
 * The name column cannot be switched off: a row without the task's name is a row
 * you cannot tell anything about. So it is not part of the toggleable set and
 * always comes first.
 */
export const OPTIONAL_COLUMNS = COLUMN_KEYS.filter((key) => key !== "task");

/**
 * The default widths. The name gets the same number that stood in the styles
 * while there was one column: the strip must not be drawn differently just
 * because it gained the ability to show more.
 */
export const DEFAULT_WIDTH: Record<ColumnKey, number> = {
  task: 260,
  start: 104,
  end: 104,
  duration: 84,
  progress: 76,
  assignee: 132,
};

/** Below this a column stops being a column and becomes a strip of pixels. */
export const MIN_WIDTH = 56;
export const MAX_WIDTH = 480;

/**
 * What is visible on first opening: the name and both dates.
 *
 * Not everything at once: six columns eat half the screen, and the strip people
 * came here for ends up in the remaining crack. Three are what you look at when
 * asking "when is this being done", and exactly what is worth showing by
 * default. The rest are switched on in the "View" menu.
 */
export const DEFAULT_SHOWN: readonly ColumnKey[] = ["task", "start", "end"];

export type ColumnLayout = {
  /** The shown columns in drawing order. `task` is always first. */
  shown: ColumnKey[];
  widths: Record<ColumnKey, number>;
  /**
   * The table is collapsed: what is left of it is a narrow strip with a button,
   * and the scale takes all the freed space.
   *
   * A property of the layout rather than a separate state: this is the same
   * question of "how much room is given to the table" as the set of columns and
   * their widths, and it lives in the same place — in the browser, tied to the
   * project. A collapsed table survives going to the history and back: half a
   * year of a plan is expanded to see it whole, not to see it for one switch
   * between tabs.
   */
  collapsed: boolean;
};

/**
 * The collapsed table's width: a strip exactly the size of the button that will
 * bring it back.
 *
 * Not zero: there would be nothing to expand the table with — the button lives
 * inside it, and a second place for it (the toolbar) would mean looking for it
 * somewhere other than where it collapsed what it collapsed.
 */
export const COLLAPSED_WIDTH = 36;

/**
 * The window width below which the table opens as a single name column, and that
 * column's widths on narrow screens.
 *
 * The breakpoints are the ones the strip had in the styles, and for the same
 * reason: on a 520-pixel screen three default columns would eat more room than
 * the strip itself gets — the strip people came here for. They live in code
 * rather than in a media query, because the pinned column's width is no longer
 * set by a style at all: it equals the sum of the shown columns' widths, and a
 * media query would not silently override it.
 *
 * This is a default, not a ban: any column can be switched on and stretched on a
 * phone too, and the choice is remembered.
 */
const NARROW_PX = 900;
const VERY_NARROW_PX = 520;
const NARROW_TASK_WIDTH = 240;
const VERY_NARROW_TASK_WIDTH = 180;

export function defaultLayout(width = typeof window === "undefined" ? 0 : window.innerWidth): ColumnLayout {
  // Zero means there is no window at all (server rendering, a test without
  // jsdom): the layout is then the ordinary one rather than the tightest. A guess
  // about a phone where nothing is known about the width would be worse than no
  // guess.
  const narrow = width > 0 && width <= NARROW_PX;
  const cramped = width > 0 && width <= VERY_NARROW_PX;
  return {
    shown: narrow ? ["task"] : [...DEFAULT_SHOWN],
    widths: {
      ...DEFAULT_WIDTH,
      task: cramped
        ? VERY_NARROW_TASK_WIDTH
        : narrow
          ? NARROW_TASK_WIDTH
          : DEFAULT_WIDTH.task,
    },
    // Expanded: the strip opens with a table and a scale rather than a scale
    // alone — without task names there is no telling what the bars are about.
    collapsed: false,
  };
}

/**
 * The pinned column's total width — the header, the rows and the scroll stand by it.
 *
 * For a collapsed table that is the width of the strip with the button rather
 * than the sum of the columns: the columns have not gone anywhere — their set and
 * widths await the expansion — but at that moment they take up no room on the strip.
 */
export function layoutWidth(layout: ColumnLayout): number {
  if (layout.collapsed) return COLLAPSED_WIDTH;
  return layout.shown.reduce((total, key) => total + layout.widths[key], 0);
}

const STORAGE_PREFIX = "planora.gantt_columns.";

function isColumnKey(value: unknown): value is ColumnKey {
  return typeof value === "string" && (COLUMN_KEYS as readonly string[]).includes(value);
}

/**
 * This project's column layout, as it was left last time.
 *
 * What is read is checked field by field rather than taken on faith: the storage
 * holds what a previous version of the strip put there, and it may have had a
 * different set of columns. A malformed record is a `null`, that is, "show the
 * default", rather than a strip with a ghost column.
 *
 * A browser's private mode can forbid localStorage — the layout then simply does
 * not survive a move between screens. That is no reason to crash.
 */
export function storedLayout(projectId: string): ColumnLayout | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + projectId);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;

    const { shown, widths, collapsed } = parsed as {
      shown?: unknown;
      widths?: unknown;
      collapsed?: unknown;
    };
    if (!Array.isArray(shown)) return null;

    // The order is read from storage: columns are reordered by their heading, and
    // the order is as much the person's choice as their set is. It still has to
    // be validated: a record from a future version may hold an unfamiliar name, a
    // duplicate or a missing column name.
    const seen = new Set<ColumnKey>();
    const visible = shown.filter((key): key is ColumnKey => {
      if (!isColumnKey(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // The task's name is always first and always present: a row without it is a
    // row you cannot tell anything about.
    const ordered: ColumnKey[] = ["task", ...visible.filter((key) => key !== "task")];
    const sizes = { ...DEFAULT_WIDTH };
    if (typeof widths === "object" && widths !== null) {
      for (const [key, value] of Object.entries(widths)) {
        if (isColumnKey(key) && typeof value === "number" && Number.isFinite(value)) {
          sizes[key] = clampWidth(value);
        }
      }
    }
    // The collapsed flag is read as a flag rather than as "anything truthy": a
    // record from a future version may hold a string in this place, and
    // `Boolean("no")` would open the strip collapsed without explaining anything
    // to anyone.
    return { shown: ordered, widths: sizes, collapsed: collapsed === true };
  } catch {
    return null;
  }
}

export function rememberLayout(projectId: string, layout: ColumnLayout): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + projectId, JSON.stringify(layout));
  } catch {
    // see storedLayout()
  }
}

export function clampWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
}

/**
 * A column switched on or off.
 *
 * A switched-on one goes not to the end but to its own place by the declared
 * order — but only among those the person has not reordered: the order belongs to
 * them, and a column switched off by accident and back on again must not reshuffle
 * what they arranged. So the insertion looks for the first shown column that comes
 * after the one being switched on in the declared order, and stands before it.
 */
export function toggleColumn(shown: ColumnKey[], column: ColumnKey): ColumnKey[] {
  if (column === "task") return shown;
  if (shown.includes(column)) return shown.filter((key) => key !== column);

  const natural = COLUMN_KEYS.indexOf(column);
  const at = shown.findIndex((key) => COLUMN_KEYS.indexOf(key) > natural);
  return at === -1
    ? [...shown, column]
    : [...shown.slice(0, at), column, ...shown.slice(at)];
}

/**
 * A column moved into another's place.
 *
 * The task's name never leaves the first place and lets nobody into it: it is the
 * only column a row is recognized by, and a second one after it would read as the
 * row's heading. So both a drop onto it and a drop of it simply change nothing —
 * silently, without explanation: there is nothing to explain, the person dragged a
 * column and saw that it does not drag.
 */
export function reorderColumns(
  shown: ColumnKey[],
  moved: ColumnKey,
  before: ColumnKey,
): ColumnKey[] {
  if (moved === "task" || before === "task" || moved === before) return shown;
  const rest = shown.filter((key) => key !== moved);
  const at = rest.indexOf(before);
  if (at === -1) return shown;
  return [...rest.slice(0, at), moved, ...rest.slice(at)];
}
