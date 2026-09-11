import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties } from "react";

import { TASK_STATUSES } from "../api/projects";
import type { Category, ProjectState, Task } from "../api/projects";
import { endShiftDays, isBeyondPlan } from "../project/baseline";
import { formatDate, formatMonth, weekdayNarrow } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";
import { BarTipProvider } from "./BarTip";
import { AddCategoryRow, AddTaskRow, NewCategoryRow, PendingCategoryRow } from "./BottomActions";
import { HeadCells } from "./Cells";
import { Grid } from "./Grid";
import { Header, RelativeHeader } from "./Header";
import {
  RELATIVE_EPOCH,
  relativeDayLabel,
  relativeWeekEnd,
  relativeWindow,
  weeksAcross,
} from "./relative";
import { Arrows } from "./Arrows";
import { NewTaskRow, PendingRow } from "./NewTaskRow";
import { CategoryRow, TaskRow } from "./Row";
import type { CellLabels, DayFormat } from "./Row";
import { MOTION_MS, usePrefersReducedMotion } from "./motion";
import { useLinkDrag } from "./useLinkDrag";
import { useQuickCategory } from "./useQuickCategory";
import { useQuickTask } from "./useQuickTask";
import { useReorder } from "./useReorder";
import { useLaneWidth } from "./useLaneWidth";
import { useViewportFit } from "./useViewportFit";
import { COLUMN_KEYS, layoutWidth } from "./columns";
import type { ColumnKey } from "./columns";
import { DAY_WIDTH, ROW_HEIGHT, lastOfMonth, projectWindow } from "./scale";
import { addDays, buildScale, daysBetween } from "./timescale";
import { useGanttView } from "./useGanttView";
import type { GanttView } from "./useGanttView";
import { GanttViewControls } from "./ViewControls";
import { useToday } from "../time/useToday";

import "./gantt.css";

/**
 * The point the chart holds on to while the scale is rebuilt.
 *
 * A date rather than a pixel: a pixel offset is meaningful only within the scale it was
 * measured in. One and the same `scrollLeft` shows March at day scale and August at month
 * scale, so what is remembered is the day at the centre of the visible area. The fraction
 * of a day is stored beside it so that returning does not pull the chart to a day boundary
 * on every rebuild of the scale: without it every state update would shift the chart by
 * half a division.
 */
type Focus = { date: string; fraction: number };

/**
 * The order of rows is by position, and by identifier when positions are equal.
 *
 * The second key is not over-caution: positions coincide in one real case — a row restored
 * by an undo to a place a neighbour has taken since. Without it the order between two
 * renders is unstable, and rows swap places by themselves.
 */
function byPosition<T extends { position: number; id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Where the new-task row is open.
 *
 * `before` is the task the new one will stand above; `null` means the category's end. The
 * place is named by a row rather than by a number: a task's number changes with someone
 * else's reorder, while "before this one" stays the same place after it.
 */
export type NewTaskAt = { categoryId: string; before: string | null };

export function Gantt({
  projectId,
  state,
  canWrite = false,
  onAddTask,
  newTaskAt = null,
  onCloseNewTask,
  onAddCategory,
  onDeleteCategory,
  baselineShown,
  onBaselineToggle,
  selectedTaskId = null,
  onSelectTask,
  onOpenComments,
  commentCounts,
  viewState,
  assigneeNames,
}: {
  projectId: string;
  state: ProjectState;
  /** Whether this person can change the project. A guest only looks. */
  canWrite?: boolean;
  /**
   * Create a task: with the plus on a category row (at its end) or with the plus on a row
   * boundary (before the named one). Without it the chart stays read-only.
   */
  onAddTask?: (at: NewTaskAt) => void;
  /**
   * Where the new-task row is open. `null` means closed.
   *
   * As state from outside rather than inside the chart: the row is also closed by the
   * screen — when it opens a card or a dialog over the chart — and it would have nothing to
   * reach the chart's state with.
   */
  newTaskAt?: NewTaskAt | null;
  onCloseNewTask?: () => void;
  /**
   * Create a category: with the "plus" in the table's corner, by the "Task" heading, and
   * with the button in the middle of an empty chart.
   *
   * The plus stands on whatever it adds a child to: the table's corner is the list's root,
   * and its plus creates a category; the plus on a category row creates a task in it. The
   * former toolbar button "New task" did not know this rule — it put a task into the first
   * category, because it did not know where else.
   */
  onAddCategory?: () => void;
  /**
   * The cross on a category row. Without it categories cannot be deleted.
   *
   * It is called by a click but does not delete immediately: asking whether the stage really
   * goes away together with its tasks is the screen's job — it is also what applies the
   * operation. The chart does not ask this question: it has neither a dialog nor a count of
   * what will actually go with the category (comments, assignments) — and a question asked
   * half-heartedly is worse than one not asked.
   */
  onDeleteCategory?: (categoryId: string) => void;
  /** The task whose card is open. */
  selectedTaskId?: string | null;
  onSelectTask?: (taskId: string) => void;
  /**
   * Open a task's discussion — through the remark counter on the row.
   *
   * Separate from `onSelectTask` rather than as a second argument to it: the chart does not
   * know what the task card consists of, and naming its tabs to the chart would mean
   * introducing a second place where the card's sections are listed.
   */
  onOpenComments?: (taskId: string) => void;
  /**
   * How many remarks each task has. As a prop, like the organization's membership: the
   * screen asks, the chart receives the ready answer (see `assigneeNames`).
   */
  commentCounts?: ReadonlyMap<string, number>;
  /**
   * Whether to show the ghost of the agreed plan — from outside.
   *
   * Not passed — the chart decides for itself with its own "View" checkbox. Passed — the
   * screen decides, and the same toggle stands in the changes panel.
   */
  baselineShown?: boolean;
  onBaselineToggle?: () => void;
  /**
   * How to look at the chart — the scale, the columns, the layers (see useGanttView).
   *
   * Passed — the controls stand with the screen (in the project's header), and the chart
   * does not draw a row of its own above itself. Not passed — the chart creates the state
   * itself and puts a row with the scale and "View" above itself: that is how the public
   * page lives, where there is no project header.
   */
  viewState?: GanttView;
  /**
   * The organization's membership: names by identifier. The assignees in the hover card and
   * in the column are labelled with them — and new ones are chosen from them right from the
   * row.
   *
   * As a prop rather than a query from inside: the screen asks, the chart receives the ready
   * answer. The chart has no "this is the public page" flag and there is no reason to
   * introduce one, while a gate on `canWrite` would be wrong twice — for a reader inside the
   * organization, who does see the membership, and offline, where the permission exists but
   * the connection does not.
   */
  assigneeNames?: ReadonlyMap<string, string>;
}) {
  const { t } = useLocale();
  const scroller = useRef<HTMLDivElement>(null);
  // The chart scrolls itself — vertically too. Without this the pinned scale header rides
  // away with the page (see `useViewportFit`).
  useViewportFit(scroller);
  const reorder = useReorder({ projectId, state, canWrite });
  const link = useLinkDrag({ projectId, state, canWrite });
  const quick = useQuickTask({ projectId, state });
  const quickCategory = useQuickCategory({ projectId, state });
  const reducedMotion = usePrefersReducedMotion();
  // The scale, the columns and the layers. State of its own is always created — the rules of
  // hooks do not allow creating it conditionally — but it is only used when the screen has
  // not supplied its own: on the working screen the controls stand in its header, and the
  // chart merely reads what was chosen there (see `viewState`).
  const ownView = useGanttView(projectId, { baselineShown, onBaselineToggle });
  const ganttView = viewState ?? ownView;
  const { zoom, layout, setLayout, toggleTable, resizeColumn, moveColumn } = ganttView;
  const baselineOn = ganttView.flag("baseline");
  const view = {
    legend: ganttView.flag("legend"),
    summary: ganttView.flag("summary"),
    caption: ganttView.flag("caption"),
    critical: ganttView.flag("critical"),
  };

  // Collapsed categories. State of the screen rather than of the project: a colleague on the
  // project must not receive someone else's collapses, so it does not go to the server.
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const toggleCategory = (id: string) =>
    setClosed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // A task is created in a collapsed category too: the "plus" on its row does not go
  // anywhere, and the toolbar button aims at the first one in order, collapsed or not. A row
  // opened inside a collapsed one is not visible at all — and a field that cannot be seen
  // reads as inaction. The same set is returned unchanged when there is nothing to expand: a
  // new object here would drag a re-render of the chart on every answer from the server.
  const newTaskIn = newTaskAt?.categoryId ?? null;
  useEffect(() => {
    if (newTaskIn === null) return;
    setClosed((current) => {
      if (!current.has(newTaskIn)) return current;
      const next = new Set(current);
      next.delete(newTaskIn);
      return next;
    });
  }, [newTaskIn]);

  // For the same reason a collapsed table is expanded too: a new task's name is typed in its
  // column, and a collapsed one has no such column — the "New task" button would open a
  // field that cannot be seen.
  useEffect(() => {
    if (newTaskIn === null || !layout.collapsed) return;
    setLayout({ ...layout, collapsed: false });
  }, [newTaskIn, layout, setLayout]);

  // The new-category input row comes from the very bottom of the chart (see "+ New category"
  // below). State of the screen, like the category collapses: a colleague on the project has
  // no use for someone else's open field, and it does not go to the server.
  const [composingCategory, setComposingCategory] = useState(false);

  // For the same reason as with a task just above: a category's name is typed in the column,
  // which a collapsed table does not have.
  useEffect(() => {
    if (!composingCategory || !layout.collapsed) return;
    setLayout({ ...layout, collapsed: false });
  }, [composingCategory, layout, setLayout]);

  // The relative axis: the plan is not anchored to dates yet, and the scale counts the
  // project's weeks from the epoch. A property of the project rather than of the screen — it
  // comes from the server. A calendar project no longer pretends to be a relative view: as
  // soon as a start date is assigned, the chart shows real dates only.
  const relativeAxis = state.schedule_mode === "relative";
  // The relative axis's anchor is always the epoch: a plan with no dates has no other
  // coordinates.
  const anchor = RELATIVE_EPOCH;

  // Today is in the project's timezone rather than in UTC: the today line must stand where
  // the reader's today is, and in a timezone east of Greenwich it stood on yesterday's date
  // by UTC every night until morning.
  const today = useToday(state.settings?.timezone);
  // How far a gesture in progress has reached: a task bar or a category bar is being held
  // past the window's right edge. While the gesture runs, the window stretches to that date
  // — with the same rounding the chart builds it with itself — and the grid exists
  // everywhere the bar has travelled. Without this the last task cannot be dragged further
  // than a couple of days: the window ends almost right after it, the bar rides out into
  // white emptiness with not a single date, and the chart lets it be scrolled there — a bar
  // carried out by a translate expands the scrollable area.
  //
  // While the gesture runs, the window does not shrink: the gesture only asks here for dates
  // past the current edge (see track in useDragDates), so the grid grown behind the bar does
  // not grow back on the way back — otherwise it would tug the scroll under the hand. A drop
  // passes the committed end, a cancelled gesture passes `null`. The price of the extension
  // is one recomputation of the scale per day crossed rather than per pixel: an identical
  // date does not wake a re-render.
  const [reach, setReach] = useState<string | null>(null);
  const onReach = useCallback((endISO: string | null) => setReach(endISO), []);

  const dayWidth = DAY_WIDTH[zoom];
  // How much room is left to the scale to the right of the table. Only the relative window
  // knows about this: a plan with no dates has a right edge derived from nothing, and without
  // a correction for the screen's width it is always the same — four weeks, after which a
  // white field ran to the edge (see `weeksAcross`).
  const laneSpace = useLaneWidth(scroller) - layoutWidth(layout);

  // The dependency is the window's bounds rather than the state itself: after every change
  // the server sends a new state object, and a scale tied to its identity would be rebuilt
  // every time — together with all the divisions and months, which an edit to one task did
  // not change.
  const base = relativeAxis
    ? relativeWindow(state, anchor, weeksAcross(laneSpace, dayWidth))
    : projectWindow(state, today);
  const from = base.from;
  // The extension changes only the right edge: `from` and the day's width stay put, so
  // `Scale.key` does not change and every bar's coordinates stay the same — a gesture in the
  // middle of an extension is not thrown off (see `Scale.key`).
  const to =
    reach === null || reach <= base.to
      ? base.to
      : relativeAxis
        ? relativeWeekEnd(reach, anchor)
        : lastOfMonth(reach);
  const scale = useMemo(() => buildScale({ from, to, dayWidth }), [dayWidth, from, to]);

  // A confirmed move has covered the extension with its own window — it can be dropped
  // without changing the chart's geometry. It must not be dropped right at the drop: the
  // guess lands in the cache, but React Query sends its notification as a microtask, and
  // between the reset and the guess the canvas would shrink for an instant to the previous
  // window. The height layer measures the chart at that same moment (see useViewportFit) and
  // thereby forces the browser to recompute layout — a scroll standing in the extended part
  // would be pressed to the previous edge, and the view would jump under the hand at the very
  // moment of the drop.
  useEffect(() => {
    if (reach !== null && reach <= base.to) setReach(null);
  }, [reach, base.to]);

  // In the relative view there are project days instead of dates: a plan with no assigned
  // start has no real date yet.
  const formatDay = (iso: string) =>
    relativeAxis ? relativeDayLabel(t, iso, anchor) : formatDate(t, iso);

  // How rows show dates and how they accept them back. Input mirrors display: where a row
  // showed "Day 8", that is the eighth day it accepts.
  const format: DayFormat = { label: formatDay, relative: relativeAxis, anchor };

  // The cell labels — once per chart rather than through a dictionary in every row: with a
  // hundred tasks that is a hundred identical lookups for the same six strings.
  const cellLabels: CellLabels = {
    columns: Object.fromEntries(
      COLUMN_KEYS.map((key) => [key, t(`gantt.col.${key}`)]),
    ) as Record<ColumnKey, string>,
    edit: (column, name) => t("gantt.col.edit", { column, name }),
  };

  // Where the chart is looking now and for which project it has already been shown.
  //
  // Scrolling to today is a greeting when a project is opened rather than an answer to every
  // rebuild of the scale. The scale is rebuilt both by a change of scale and by an edit to a
  // task that widened the project's window, and a scroll tied to it would take away the March
  // a person was looking at every time they touch the chart.
  const shownFor = useRef<string | null>(null);
  const focus = useRef<Focus | null>(null);

  /**
   * Remember the day at the centre of the visible area — in the current scale's units.
   *
   * Wrapped so as not to be recreated on every render: otherwise the scroll below, which
   * needs this function, would fire on any change made by anyone else — from hovering over a
   * bar to collapsing a category.
   */
  const rememberFocus = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const center = (element.scrollLeft + element.clientWidth / 2) / scale.dayWidth;
    const index = Math.floor(center);
    focus.current = { date: addDays(scale.from, index), fraction: center - index };
  }, [scale]);

  // The layer below is the only place where the chart scrolls itself.
  //
  // Layout has already been computed but the frame has not been painted: a `useEffect` here
  // would give a visible jump from the previous place to the new one.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;

    // The project's first showing: a project a quarter long would otherwise open at its own
    // beginning, that is, at what has already been done. After that — only a return to the
    // remembered day.
    if (shownFor.current !== projectId) {
      shownFor.current = projectId;
      // Today may not be in the window at all — for a project planned entirely for last
      // spring. Then the chart stays at its beginning: there is nowhere to scroll it to.
      if (today >= scale.from && today <= scale.to) {
        element.scrollLeft = Math.max(0, scale.xOf(today) - scale.dayWidth * 3);
      }
      // Changing the project also restores its scale (the effect above), and the scale will
      // be rebuilt once more. Without this mark the chart would stay at a pixel measured
      // against the previous scale.
      rememberFocus();
      return;
    }

    const held = focus.current;
    if (!held) return;
    element.scrollLeft = Math.max(
      0,
      scale.xOf(held.date) + held.fraction * scale.dayWidth - element.clientWidth / 2,
    );
  }, [projectId, rememberFocus, scale, today]);

  const categories = byPosition(state.categories);
  const tasksByCategory = new Map<string, Task[]>();
  for (const task of byPosition(state.tasks)) {
    tasksByCategory.set(task.category_id, [...(tasksByCategory.get(task.category_id) ?? []), task]);
  }
  // How many tasks are already in each category — the "Move" item in the row menu knows
  // this: a moved task goes to the end, and the end is exactly the current number of rows
  // where it is being put.
  const taskCountByCategory = new Map<string, number>(
    categories.map((category) => [category.id, tasksByCategory.get(category.id)?.length ?? 0]),
  );

  /**
   * The category whose empty lane will explain what to do with it — the topmost of the empty
   * ones, and only that one.
   *
   * Categories exist but there are no tasks: an ordinary state of a project just created,
   * and until now nothing explained it — an empty screen is explained by the chart only while
   * there is not a single category (see `gantt.empty` below), and after that an empty grid is
   * what is left. A hint in every empty lane would be three identical lines in a row: a
   * technique understood on the first works on the rest too — all the more so since with this
   * same edit the "plus" on the row of an empty category stopped hiding until hover.
   *
   * A category with an awaiting row or with an open input field does not count as empty: a
   * task is already on its way into it, and "no tasks yet" would contradict the name typed in,
   * standing a row below.
   */
  const hintedCategoryId =
    categories.find(
      (category) =>
        (tasksByCategory.get(category.id)?.length ?? 0) === 0 &&
        quick.pendingIn(category.id).length === 0 &&
        newTaskAt?.categoryId !== category.id,
    )?.id ?? null;

  const isLate = (task: Task) => state.deadline !== null && task.end_date > state.deadline;

  /** The deviation badge's label. Zero days gets no badge: it says nothing.
      The unit is the short one ("d"), as in the mockup: the label stands flush against the
      bar, and the full word would push its neighbour. */
  const deviationLabel = (task: Task) => {
    const shift = endShiftDays(task);
    if (shift === null || shift === 0) return undefined;
    const days = t("common.days_short", { count: Math.abs(shift) });
    return shift > 0 ? t("gantt.deviation_late", { days }) : t("gantt.deviation_early", { days });
  };

  const baselineLabel = (task: Task) =>
    task.baseline_start && task.baseline_end
      ? t("gantt.baseline", {
          from: formatDay(task.baseline_start),
          to: formatDay(task.baseline_end),
        })
      : undefined;

  // Only whoever can write can create tasks: an input row for a reader would promise a
  // refusal from the server. The flag is computed once — the row is both drawn by it and
  // counted by it in the row count below.
  const newTaskShown = canWrite && newTaskAt !== null;

  /**
   * The task in this category above which the input row is open. `null` means input goes to
   * the category's end or not into it at all.
   *
   * The named task may no longer exist: it was deleted in a neighbouring tab while the field
   * was open. Then the input row does not vanish with it but slides to the category's end —
   * what is typed in the field is worth more than the precision of the place.
   */
  const draftBefore = (category: Category): string | null => {
    if (!newTaskShown || newTaskAt.categoryId !== category.id || newTaskAt.before === null) {
      return null;
    }
    const target = newTaskAt.before;
    return (tasksByCategory.get(category.id) ?? []).some((task) => task.id === target)
      ? target
      : null;
  };

  // The row numbers in the same order they are drawn in below: the category row, then its
  // tasks. The arrows need them — they have nowhere else to learn at what height a task
  // ended up.
  const rowOf = new Map<string, number>();
  let rowCount = 0;
  for (const category of categories) {
    rowCount += 1;
    const open = !closed.has(category.id);
    const draftIn = newTaskShown && newTaskAt.categoryId === category.id;
    // Awaiting rows are rows too: they stand in the middle of the chart, and the arrows to
    // the tasks of every category below would ride a row up if they were not counted here.
    // They are counted together with the input row: they are drawn together with it — where
    // the insertion happens.
    const draftRows =
      (open ? quick.pendingIn(category.id).length : 0) + (draftIn ? 1 : 0);
    const before = draftBefore(category);
    // The tasks of a collapsed category occupy no rows, and an arrow to them is not drawn —
    // it simply has nothing to line up with (see Arrows).
    if (open) {
      for (const task of tasksByCategory.get(category.id) ?? []) {
        if (task.id === before) rowCount += draftRows;
        rowOf.set(task.id, rowCount);
        rowCount += 1;
      }
    }
    // The input row is visible in a collapsed category too — which is why it is counted
    // outside the condition: a category is collapsed mid-typing as well, and a field that
    // vanished from under the cursor would carry away what had been typed. In a collapsed
    // category this also applies to insertion before a named task: the row to stand before is
    // not on screen, and the field goes to the heading's end.
    if (before === null || !open) rowCount += draftRows;
  }

  /**
   * The number a new task will land on — or `undefined` for the end of the list.
   *
   * To the named row's number are added the tasks this same input row has already submitted
   * but which are not in the state yet: "a", "b", "c" in a row must land in the order they
   * were typed, and each previous one shifts the named row down by one. What is counted is
   * precisely the unconfirmed ones (see useQuickTask) rather than every submitted one: the
   * answer for "a" already arrives with the named row shifted by one, and adding "a" a second
   * time would mean putting "b" after it rather than before it.
   */
  const insertPosition = (categoryId: string, before: string | null): number | undefined => {
    if (before === null) return undefined;
    const target = state.tasks.find((task) => task.id === before);
    return target === undefined
      ? undefined
      : target.position + quick.pendingIn(categoryId).length;
  };

  return (
    // The hover card lives beside the chart rather than inside it: it stands in window
    // coordinates, and the chart's scrollbar must not clip it.
    <BarTipProvider
      names={assigneeNames}
      formatDay={relativeAxis ? (iso) => relativeDayLabel(t, iso, anchor) : undefined}
    >
    <div
      // `can-reorder` is not cosmetic: the name column holds padding for the stage's reorder
      // handle, and holding it for someone who reorders nothing would mean pushing the names
      // away from the edge for an invisible button.
      className={`gantt gantt--${zoom}${reorder.enabled ? " can-reorder" : ""}${
        reorder.active ? " is-reordering" : ""
      }${link.active ? " is-linking" : ""}${view.critical ? " show-critical" : ""}${
        reducedMotion ? " motion-off" : ""
      }`}
      // The row height, the pinned column's width and the transition durations are set from
      // here for one and the same reason: all three values are known to more than CSS. The
      // arrows compute vertical coordinates from the row height, the grid and the arrow layer
      // stand by the column's width, and the code drives a bar's travel by the duration. A
      // second set of the same numbers in the styles would one day diverge from them.
      style={
        {
          "--gantt-row": `${ROW_HEIGHT}px`,
          "--gantt-label": `${layoutWidth(layout)}px`,
          // The scale's width goes to the styles: the "beyond the plan" strip stands by it,
          // and it is drawn as two nodes across the whole chart rather than one per row.
          "--gantt-lane": `${scale.width}px`,
          "--motion": `${MOTION_MS}ms`,
        } as CSSProperties
      }
    >
      {/* The row above the chart appears only when the controls have not been given to the
          screen (the public page). On the working screen they stand in the project's header
          to the right of the tabs, and there is no second tier above the chart: every 46
          pixels above it is a row of the plan that is not visible. The row is seen by a
          reader too: the scale and the set of layers are ways of looking rather than of
          changing. */}
      {viewState === undefined && (
        <div className="project-toolbar" aria-label={t("gantt.toolbar.label")}>
          <span className="project-toolbar__spacer" />

          {/* The mode indicator: while the plan is relative that is said in words rather than
              only by a scale with no months. Once a start date is assigned the indicator goes
              out together with relative mode: a calendar project no longer has a switch back
              to "Month 1 / Week 1", and the assigned start date is final. The detail goes
              into the badge's own tooltip rather than into a line above the chart: that one
              cost the chart fifty pixels of height every time a project was opened. */}
          {relativeAxis && (
            <span className="project-toolbar__mode" title={t("gantt.relative.hint")}>
              {t("gantt.relative.badge")}
            </span>
          )}

          <GanttViewControls view={ganttView} />
        </div>
      )}

      {/* The summary compares the project's end with the deadline — two real dates; a
          relative axis never has one. */}
      {view.summary && !relativeAxis && <Summary state={state} formatDay={formatDay} />}

      {view.legend && categories.length > 0 && <Legend />}

      {categories.length === 0 ? (
        /* An empty chart offers the only thing that can be done here at all — create the
           first category: without one a task has nowhere to land. It offers it as a button
           rather than as a picture: the drawn plus from `.empty` promised an action without
           performing it, and a person was left hunting for "New category" in the toolbar.
           The button is named the same as that one — one action, one name. Without write
           access one line is left: there is no reason to promise a guest an action they do
           not have. */
        <div className={`empty gantt__empty${onAddCategory ? " gantt__empty--action" : ""}`}>
          {onAddCategory && (
            <button
              type="button"
              className="button--primary gantt__empty-add"
              onClick={onAddCategory}
            >
              <span className="gantt__empty-plus" aria-hidden="true">
                +
              </span>
              {t("category.create")}
            </button>
          )}
          <p>{t("gantt.empty")}</p>
        </div>
      ) : (
        <>
        <div className="gantt__scroll" ref={scroller} onScroll={rememberFocus}>
          <div className="gantt__canvas">
            <div className="gantt__head-row">
              <div className="gantt__label gantt__corner">
                <HeadCells
                  layout={layout}
                  labels={cellLabels.columns}
                  onResize={resizeColumn}
                  onReorder={moveColumn}
                  resizeLabel={(column) => t("gantt.col.resize", { column })}
                  reorderLabel={(column) => t("gantt.col.reorder", { column })}
                  leading={
                    /* The "plus" by the list's heading creates a category — the one thing
                       that can be added to the plan's root without choosing a parent. An
                       icon with no label: the word "Task" stands beside it, and a "New
                       category" label under it would read as the heading of a second
                       column. The button's name stays for the screen reader and the
                       tooltip. A guest and a reader get no button — as with the chart's
                       other "pluses". */
                    onAddCategory && (
                      <button
                        type="button"
                        className="gantt__corner-add"
                        aria-label={t("category.create")}
                        title={t("category.create")}
                        onClick={onAddCategory}
                      >
                        <span aria-hidden="true">+</span>
                      </button>
                    )
                  }
                />
                {/* The collapse button is in the table's corner, on the boundary with the
                    scale: it moves that boundary and must stand right there. In the
                    project's header, where it might seem to belong, it would end up in the
                    row of display settings — among "Scale" and "View", that is, in the list
                    of things opened in order to configure something. Here it is seen at once
                    and needs no aiming. */}
                <button
                  type="button"
                  className="gantt__fold"
                  aria-expanded={!layout.collapsed}
                  aria-label={t(layout.collapsed ? "gantt.table.expand" : "gantt.table.collapse")}
                  title={t(layout.collapsed ? "gantt.table.expand" : "gantt.table.collapse")}
                  onClick={toggleTable}
                >
                  <FoldIcon open={!layout.collapsed} />
                </button>
              </div>
              {relativeAxis ? (
                <RelativeHeader
                  scale={scale}
                  calendar={state.calendar}
                  monthLabel={(number) => t("gantt.relative.month", { number })}
                  weekLabel={(number) => t("gantt.relative.week", { number })}
                />
              ) : (
                <Header
                  scale={scale}
                  calendar={state.calendar}
                  today={today}
                  todayLabel={t("gantt.today")}
                  monthLabel={(iso) => formatMonth(t, iso)}
                  weekdayLabel={(weekday) => weekdayNarrow(t, weekday)}
                />
              )}
              {/* The empty field past the scale's right edge. The chart runs the screen's
                  full width while the plan runs only to its own end, and without this strip
                  the difference between "nothing is planned here" and "the layout broke off
                  here" was invisible: the grid simply ended in a white seam. As two nodes
                  across the whole chart rather than one per row: the field is identical in
                  every row — the same argument by which the grid itself is shared (see Grid). */}
              <div className="gantt__beyond gantt__beyond--head" aria-hidden="true" />
            </div>

            <div className="gantt__body">
              <div className="gantt__beyond" aria-hidden="true" />
              <Grid
                scale={scale}
                calendar={state.calendar}
                deadline={state.deadline}
                // An empty line instead of a date: there is no "today" line in the relative
                // view — real dates are not drawn on that scale.
                today={relativeAxis ? "" : today}
                deadlineLabel={
                  state.deadline ? t("gantt.deadline", { date: formatDay(state.deadline) }) : ""
                }
                todayLabel={t("gantt.today")}
              />

              <Arrows
                scale={scale}
                tasks={state.tasks}
                dependencies={state.dependencies}
                rowOf={rowOf}
                rows={rowCount}
              />

              {link.enabled && (
                // The link line under the finger. The layer stands permanently rather than
                // only for the gesture's duration: its coordinates are needed the moment the
                // press happens — that is where the line begins — while a node created in
                // that same frame is not mounted yet. Visibility is removed by CSS through a
                // flag on the chart's root.
                <svg
                  className="gantt__link-layer"
                  ref={link.layerRef}
                  width={scale.width}
                  height={rowCount * ROW_HEIGHT}
                  aria-hidden="true"
                >
                  <line ref={link.lineRef} className="gantt__link-line" />
                </svg>
              )}

              <div className="gantt__rows">
                {categories.map((category: Category, categoryIndex: number) => {
                  const tasks = tasksByCategory.get(category.id) ?? [];
                  const open = !closed.has(category.id);
                  const before = draftBefore(category);
                  // The awaiting rows and the input field go as one piece: they stand where
                  // the insertion happens rather than always at the category's end.
                  // Otherwise a name just submitted would flash at the bottom of the list
                  // only to end up in the middle a moment later.
                  const draft = (
                    <>
                      {open &&
                        quick.pendingIn(category.id).map((row) => (
                          <PendingRow
                            key={row.id}
                            layout={layout}
                            scale={scale}
                            name={row.name}
                            title={t("task.new.creating")}
                          />
                        ))}
                      {newTaskShown && newTaskAt.categoryId === category.id && (
                        <NewTaskRow
                          layout={layout}
                          scale={scale}
                          label={t("task.new.aria", { category: category.name })}
                          placeholder={t("task.new.placeholder")}
                          onCreate={(name) =>
                            quick.create(category.id, name, insertPosition(category.id, before))
                          }
                          onClose={() => onCloseNewTask?.()}
                        />
                      )}
                    </>
                  );
                  // A stage held in hand dims as a whole — together with its tasks: it moves
                  // in its entirety, and one dimmed heading would promise that the tasks will
                  // stay here.
                  const held =
                    reorder.dragging?.kind === "category" &&
                    reorder.dragging.id === category.id;
                  return (
                    <div
                      key={category.id}
                      className={`gantt__group${held ? " is-dragged" : ""}`}
                    >
                      <CategoryRow
                        projectId={projectId}
                        category={category}
                        tasks={tasks}
                        scale={scale}
                        onReach={onReach}
                        layout={layout}
                        format={format}
                        canWrite={canWrite}
                        moveLabel={t("gantt.move_category", { name: category.name })}
                        reorderLabel={t("gantt.reorder_category", { name: category.name })}
                        addLabel={t("task.add_to", { category: category.name })}
                        // The hint in an empty lane goes to one category only and only to
                        // whoever can write (see hintedCategoryId above).
                        emptyHint={
                          onAddTask && category.id === hintedCategoryId
                            ? t("gantt.category_empty")
                            : undefined
                        }
                        // The plus on a category row puts a task at its end: a place in the
                        // middle is chosen with the plus on a row boundary.
                        onAddTask={
                          onAddTask && ((categoryId) => onAddTask({ categoryId, before: null }))
                        }
                        deleteLabel={t("category.delete", { name: category.name })}
                        // Every category has a cross, not only an empty one: a stage is
                        // cancelled as a whole, and taking it apart task by task in order to
                        // get rid of the heading is as many deletions as it has rows. What
                        // will go away with the category is said aloud by the screen, which
                        // waits for confirmation (see onDeleteCategory).
                        onDelete={onDeleteCategory}
                        reorder={reorder}
                        open={open}
                        onToggle={() => toggleCategory(category.id)}
                        toggleLabel={t("gantt.toggle_category", { name: category.name })}
                        index={categoryIndex}
                        categoriesCount={categories.length}
                      />
                      {open &&
                        tasks.map((task) => (
                          <Fragment key={task.id}>
                            {/* The input field stands above the row the insertion happens
                                before rather than at the category's end. */}
                            {task.id === before && draft}
                            <TaskRow
                              projectId={projectId}
                              task={task}
                              scale={scale}
                              onReach={onReach}
                              calendar={state.calendar}
                              layout={layout}
                              cellLabels={cellLabels}
                              format={format}
                              canWrite={canWrite}
                              late={isLate(task)}
                              lateLabel={t("gantt.late")}
                              title={
                                task.milestone
                                  ? `${t("gantt.milestone.short")}, ${formatDay(task.start_date)}`
                                  : `${formatDay(task.start_date)} — ${formatDay(task.end_date)}`
                              }
                              selected={task.id === selectedTaskId}
                              onSelect={onSelectTask}
                              onOpenComments={onOpenComments}
                              commentCount={commentCounts?.get(task.id) ?? 0}
                              // The plus on a row boundary creates a task before this one.
                              // Only for whoever can write: for a reader it would promise a
                              // refusal from the server.
                              onInsertBefore={
                                canWrite && onAddTask
                                  ? () => onAddTask({ categoryId: category.id, before: task.id })
                                  : undefined
                              }
                              reorder={reorder}
                              link={link}
                              assigneeNames={assigneeNames}
                              categories={categories}
                              taskCountByCategory={taskCountByCategory}
                              handleLabel={t("gantt.reorder", { name: task.name })}
                              beyondPlan={isBeyondPlan(state, task)}
                              beyondPlanLabel={t("gantt.beyond_plan")}
                              // The same phrase as on the task card: one explanation for both
                              // places where it is asked about.
                              beyondPlanHint={t("plan.beyond_plan_explained")}
                              baselineLabel={baselineLabel(task)}
                              deviationLabel={deviationLabel(task)}
                              statusLabel={t(`task.status.${task.status}`)}
                              showBaseline={baselineOn}
                            />
                          </Fragment>
                        ))}

                      {/* At the category's end goes whatever did not stand in the middle: the
                          awaiting rows and the input field, if the insertion is not before a
                          named task but simply into this category — or if the category is
                          collapsed and that task is not on screen. */}
                      {(before === null || !open) && draft}
                    </div>
                  );
                })}

                {/* The chart's bottom is a continuation of the list rather than its edge: the
                    rows below stand once, after the very last category, and travel down with
                    new content by themselves — because they stand after it in the same markup
                    flow (see BottomActions.tsx and Grid.tsx on why the Gantt grid on the right
                    stretches along with them). */}
                {onAddTask && (
                  <AddTaskRow
                    scale={scale}
                    // One label for the eye and for the ear: the same string as on the "plus"
                    // of this category's row — one action, one name. The visible text used to
                    // name the action while only the screen reader knew the category's name
                    // (see AddTaskRow).
                    label={t("task.add_to", {
                      category: categories[categories.length - 1].name,
                    })}
                    onClick={() =>
                      onAddTask({
                        categoryId: categories[categories.length - 1].id,
                        before: null,
                      })
                    }
                  />
                )}
                {canWrite && (
                  <>
                    {quickCategory.pending.map((row) => (
                      <PendingCategoryRow
                        key={row.id}
                        scale={scale}
                        name={row.name}
                        title={t("category.quick.creating")}
                      />
                    ))}
                    {composingCategory && (
                      <NewCategoryRow
                        scale={scale}
                        label={t("category.quick.aria")}
                        placeholder={t("category.quick.placeholder")}
                        onCreate={(name) => quickCategory.create(name)}
                        onClose={() => setComposingCategory(false)}
                      />
                    )}
                    {/* The button stays in place even when the field above it is already
                        open: it is used to create the next category once this one is saved —
                        by the same technique as the task "plus" on a category row. */}
                    <AddCategoryRow
                      scale={scale}
                      label={t("category.create")}
                      onClick={() => setComposingCategory(true)}
                    />
                  </>
                )}

                {/* Air after the last row: the end of the list reads as the place where the
                    project is continued rather than as the table breaking off at the screen's
                    bottom edge. */}
                <div className="gantt__bottom-space" aria-hidden="true" />
              </div>
            </div>
          </div>
        </div>
        {/* The footnote under the chart: the meaning of the tick and the arrow — two signs
            not explained by the legend of swatches. Switched on in "View". */}
        {view.caption && <p className="gantt__caption">{t("gantt.caption")}</p>}
        </>
      )}

      {/* The ghost of the row being moved — what is in hand right now.

          Without it a move was reported by a single insertion line: the row itself stayed
          where it was, and in a long list, where the row taken had already ridden off the
          screen's edge, a person led the cursor without remembering what exactly they were
          leading. So the name travels after the cursor while the source row dims:
          semi-transparency in both places means "this has not happened yet".

          It stands in window coordinates and catches no events (`pointer-events: none` in
          the styles): the drop target is found by hit-testing a point, and a ghost under the
          cursor would cover the very row being aimed at. */}
      {reorder.ghost && (
        <div className="gantt__drag-ghost" ref={reorder.ghostRef} aria-hidden="true">
          <span className="gantt__drag-ghost-grip">⠿</span>
          {reorder.ghost.color && (
            <i className="gantt__drag-ghost-dot" style={{ background: reorder.ghost.color }} />
          )}
          <span className="gantt__drag-ghost-name">{reorder.ghost.name}</span>
        </div>
      )}
    </div>
    </BarTipProvider>
  );
}

/**
 * The sign on the button that moves the table's boundary: a rule and an arrow towards it.
 *
 * The arrow shows where the boundary will go rather than where it is now: with the table
 * expanded it points left — "remove the table" — and with it collapsed, right — "bring it
 * back". The sign is a glyph rather than "«" and "»": typographic quotes are read from the
 * screen as punctuation, and in a row of the table's thin lines they look like a typo.
 */
function FoldIcon({ open }: { open: boolean }) {
  return (
    <svg className="glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {open ? (
        <>
          <path d="M11.5 3v10" />
          <path d="M9 8H3.5M6 5 3 8l3 3" />
        </>
      ) : (
        <>
          <path d="M4.5 3v10" />
          <path d="M7 8h5.5M10 5l3 3-3 3" />
        </>
      )}
    </svg>
  );
}

/**
 * The legend — the row of conventional signs above the chart.
 *
 * It lists not one set but two, because a bar speaks in two ways too. The fill means the
 * status, and there are exactly four statuses — they are mutually exclusive. Being overdue
 * and being critical are never a fill: they are flags over any status, and in the legend
 * they are shown by the same thing they are drawn with on the chart — an outline and a left
 * edge on a neutral fill. In a solid colour they would promise a fifth and a sixth status,
 * which do not exist.
 */
function Legend() {
  const { t } = useLocale();
  return (
    <p className="gantt__legend">
      {TASK_STATUSES.map((status) => (
        <span key={status} className="gantt__legend-item">
          <i className="gantt__swatch" data-status={status} aria-hidden="true" />
          {t(`task.status.${status}`)}
        </span>
      ))}
      <span className="gantt__legend-item">
        <i className="gantt__swatch" data-overlay="late" aria-hidden="true" />
        {t("gantt.late")}
      </span>
      <span className="gantt__legend-item">
        <i className="gantt__swatch" data-overlay="critical" aria-hidden="true" />
        {t("gantt.legend.blocker")}
      </span>
      <span className="gantt__legend-item">
        <i className="gantt__swatch gantt__swatch--critical" aria-hidden="true" />
        {t("gantt.legend.critical")}
      </span>
      <span className="gantt__legend-item">
        <i className="gantt__swatch gantt__swatch--line gantt__swatch--deadline" aria-hidden="true" />
        {t("gantt.legend.late")}
      </span>
      <span className="gantt__legend-item">
        <i className="gantt__swatch gantt__swatch--line gantt__swatch--today" aria-hidden="true" />
        {t("gantt.today")}
      </span>
    </p>
  );
}

/**
 * The chip with the deadline summary.
 *
 * The one figure that genuinely interests the client, which is why it hangs there
 * permanently rather than appearing on hover. With no deadline there is no chip: writing
 * "on schedule" where there is nothing to be on schedule for means inventing a meaning.
 */
function Summary({
  state,
  formatDay,
}: {
  state: ProjectState;
  formatDay: (iso: string) => string;
}) {
  const { t } = useLocale();
  if (state.deadline === null || state.project_end === null) return null;

  const overrun = daysBetween(state.deadline, state.project_end);
  const params = {
    end: formatDay(state.project_end),
    deadline: formatDay(state.deadline),
    days: t("common.days", { count: Math.abs(overrun) }),
  };

  return (
    <p className={`gantt__summary${overrun > 0 ? " is-late" : " is-fine"}`}>
      {overrun > 0 ? t("gantt.summary.late", params) : t("gantt.summary.fits", params)}
    </p>
  );
}
