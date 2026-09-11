import { useId, useState } from "react";
import type { CSSProperties, HTMLAttributes, ReactNode, RefCallback } from "react";

import type { Calendar, Category, Task } from "../api/projects";
import { Avatar } from "../components/Avatar";
import { CommentIcon, EditableCell, PencilIcon, RowBadge, RowIcon } from "../components/rows";
import { useLocale } from "../i18n/LocaleProvider";
import { baselineOf, endShiftDays } from "../project/baseline";
import {
  deleteTask,
  patchProgress,
  patchTask,
  renameCategory,
  reorderCategory,
  reorderTask,
} from "../project/optimistic";
import { useProjectMutation } from "../project/useProjectMutation";
import { AssignMenu, PeopleIcon } from "./AssignMenu";
import { useBarTip } from "./BarTip";
import { Cell, rollUp, shownColumns } from "./Cells";
import type { ColumnKey, ColumnLayout } from "./columns";
import { dateOfProjectDay, projectDayNumber } from "./relative";
import { MenuAction, MenuBack, MenuSeparator, RowMenu } from "./RowMenu";
import { workingDaysBetween } from "./scale";
import { useBarMotion } from "./useBarMotion";
import { useDragCategory } from "./useDragCategory";
import { useDragDates } from "./useDragDates";
import type { LinkDrag } from "./useLinkDrag";
import { halfOf } from "./useReorder";
import type { Reorder } from "./useReorder";
import { useTruncatedTitle } from "./useTruncatedTitle";
import type { Scale } from "./timescale";

/**
 * How a row shows dates and how it accepts them back.
 *
 * It comes from the chart rather than being assembled here: a relative plan has no real
 * dates, and "14 August" on its scale is an invention. Input mirrors display — where a row
 * showed "Day 8", that is the eighth day it accepts rather than a date.
 */
export type DayFormat = {
  /** The date in the form it is read by eye. */
  label: (iso: string) => string;
  /** The axis is relative: editing the start goes by a project day number rather than by a date. */
  relative: boolean;
  /** The relative axis's beginning: the epoch or the assigned start. */
  anchor: string;
};

/**
 * The cell labels. Gathered once by the chart and passed down rather than taken from a
 * dictionary in every row: with a hundred tasks that is a hundred identical lookups for the
 * same six strings.
 */
export type CellLabels = {
  columns: Record<ColumnKey, string>;
  /** "Change {what} of {task}" — the label of a field opened in place. */
  edit: (column: string, name: string) => string;
};

/**
 * The cells of the pinned column for one row.
 *
 * The first column is given over to content — the chevron, the handle, the name and the
 * flags live in it; the rest are laid out identically and are therefore assembled here from
 * a list.
 */
function LabelCells({
  layout,
  task,
  cells,
}: {
  layout: ColumnLayout;
  /** The content of the name column: it differs for a category and a task. */
  task: ReactNode;
  /** The ready content of the other columns. An empty one becomes a dash. */
  cells: Partial<Record<ColumnKey, ReactNode>>;
}) {
  return (
    <>
      {shownColumns(layout).map((column) => (
        <Cell key={column} column={column} layout={layout}>
          {column === "task" ? task : (cells[column] ?? <span className="muted">—</span>)}
        </Cell>
      ))}
    </>
  );
}

/**
 * A category heading row: the chevron and the name.
 *
 * The bar is drawn from the extreme dates of its content rather than from separately stored
 * category bounds: the latter do not exist, and introducing them would mean keeping a value
 * that is obliged to match the tasks but will one day diverge.
 *
 * That same bar is also what a category is moved by: a whole stage riding a week is an
 * everyday thing, and before this it meant dragging every bar in turn (see useDragCategory).
 */
export function CategoryRow({
  projectId,
  category,
  tasks,
  scale,
  onReach,
  layout,
  format,
  addLabel,
  emptyHint,
  onAddTask,
  deleteLabel,
  onDelete,
  reorder,
  canWrite = false,
  moveLabel,
  reorderLabel,
  open = true,
  onToggle,
  toggleLabel,
  index = 0,
  categoriesCount = 1,
}: {
  projectId: string;
  category: Category;
  tasks: Task[];
  scale: Scale;
  /** The bar is held past the window's edge — the chart extends it (see reach in Gantt). */
  onReach?: (endISO: string | null) => void;
  layout: ColumnLayout;
  /** A category row is a summary rather than an edit: its cells only display. */
  format: DayFormat;
  addLabel: string;
  /**
   * What to write in a category's empty lane instead of emptiness. Not passed — the lane
   * stays empty.
   *
   * The chart decides rather than the row: the hint is shown for one category per screen,
   * while a row knows only about itself (see `hintedCategoryId` in Gantt).
   */
  emptyHint?: string;
  onAddTask?: (categoryId: string) => void;
  deleteLabel?: string;
  /** The delete cross. Confirmation is asked not by it but by the screen: a category's tasks
      go away with it, and the row cannot name their number — it knows only its own (see
      onDeleteCategory in Gantt). */
  onDelete?: (categoryId: string) => void;
  reorder?: Reorder;
  /** Whether this person can move the whole category. */
  canWrite?: boolean;
  moveLabel?: string;
  /** The label of the stage reorder handle. */
  reorderLabel?: string;
  /** Whether the category is expanded: a collapsed one hides its task rows. */
  open?: boolean;
  onToggle?: () => void;
  toggleLabel?: string;
  /** The category's place in the list of stages — the "Move" item in the menu knows it. */
  index?: number;
  categoriesCount?: number;
}) {
  const { t } = useLocale();
  const { apply } = useProjectMutation(projectId);
  // The node with the category's name: the "⋯" button is described by it — the same way as
  // on a task row (see nameId in TaskRow and describedBy in RowMenu).
  const categoryNameId = useId();
  const span = rollUp(tasks);
  // An empty category reports itself through the markup: by that flag the "plus" on the row
  // stops hiding until hover (see .gantt__row--category.is-empty in gantt.css). While a
  // category has tasks, the row's signs behave as everywhere — they stay silent until the row
  // is hovered.
  const empty = tasks.length === 0;
  const drag = useDragCategory({
    projectId,
    category,
    scale,
    // The end of the summary bar: the gesture counts from it how far the whole stage has
    // been dragged when the bar is held past the window's edge (see `onReach`).
    spanEnd: span?.end ?? null,
    onReach,
    // An empty category has nothing to move: the server would refuse, and there is no bar on
    // the chart anyway.
    enabled: canWrite && tasks.length > 0,
  });

  // The name field is opened not by a click on it but by the "Rename category" item in the
  // "⋯" menu. A number rather than a flag: choosing the same item twice in a row (changed
  // one's mind, cancelled, chose again) must open the field anew, and an unchanged `true` is
  // no reason for an effect.
  const [renameToken, setRenameToken] = useState(0);
  // The menu's nested view — the list of stages under the "Move" item. It lives here rather
  // than inside RowMenu: the panel does not remember its content, and `onClose` below returns
  // the view to the root however it is closed.
  const [menuView, setMenuView] = useState<"root" | "move">("root");

  const duplicate = () => {
    void apply(
      { type: "create_category", name: `${category.name} ${t("gantt.row_menu.copy_suffix")}`, color: category.color },
      (state) => state,
    ).catch(() => {});
  };

  const moveBy = (delta: number) => {
    const position = index + delta;
    void apply(
      { type: "reorder_category", category_id: category.id, position },
      (state) => reorderCategory(state, category.id, position),
    ).catch(() => {});
  };

  return (
    <div
      className={`gantt__row gantt__row--category${empty ? " is-empty" : ""} ${
        reorder?.markFor("category", category.id) ?? ""
      }`.trimEnd()}
      // A category heading is a drop target too: otherwise moving a task into another
      // category would only be possible through the list on the card.
      //
      // What the row is to the drop is stated directly in the markup: with a finger, events
      // do not reach it at all, and the handle finds it by hit-testing a point — there is
      // nothing else to learn the row from the found element by (see `targetAt` in
      // useReorder).
      data-drop-kind="category"
      data-drop-id={category.id}
      // The half of the row named is the real one rather than always the lower one: a task
      // does not need it at all (a drop on a heading puts it at the stage's end), but a
      // category uses precisely it to choose whether to stand before this stage or after it.
      onPointerMove={(event) =>
        reorder?.over({
          kind: "category",
          id: category.id,
          half: halfOf(event.currentTarget, event.clientY),
        })
      }
      onPointerUp={() => reorder?.drop()}
    >
      <div className="gantt__label">
        <LabelCells
          layout={layout}
          cells={{
            start: span && <span className="cell-value">{format.label(span.start)}</span>,
            end: span && <span className="cell-value">{format.label(span.end)}</span>,
            progress: span && <span className="cell-value">{span.progress}%</span>,
          }}
          task={
            <>
              {reorder?.enabled && (
                // Stages are reordered with the same gesture as tasks: a handle that behaved
                // differently on a heading and on a row beneath it would be two things looking
                // like one.
                //
                // It stands to the left of the chevron — in the padding the column holds for
                // handles (see --gantt-pad in gantt.css): on a task the handle occupies the
                // chevron column, while on a category that column is taken by the chevron
                // itself, and the only place where they do not run over each other is one step
                // to the left. That also reads as nesting: a stage is taken by its edge, a task
                // from inside it.
                //
                // Not a button and hidden from screen reading — as with a task, and for the
                // same reason: reordering rows from the keyboard is not part of this plan (see
                // TaskRow below).
                <span
                  className="gantt__handle gantt__handle--category"
                  aria-hidden="true"
                  title={reorderLabel}
                  {...reorder.handleProps("category", category.id)}
                >
                  ⠿
                </span>
              )}
              {onToggle && (
                // The chevron is the collapse button, as in the mockup: a collapsed category
                // stays a row with its span bar, and its tasks are hidden.
                <button
                  type="button"
                  className="row-chevron"
                  aria-expanded={open}
                  aria-label={toggleLabel}
                  title={toggleLabel}
                  onClick={onToggle}
                >
                  {open ? "▾" : "▸"}
                </button>
              )}
              <EditableCell
                type="text"
                value={category.name}
                display={category.name}
                disabled={!canWrite}
                className="gantt__label-name"
                id={categoryNameId}
                editTrigger={renameToken}
                label={t("category.rename", { name: category.name })}
                onCommit={(value) => {
                  const name = value.trim();
                  if (name === "" || name === category.name) return;
                  void apply(
                    { type: "rename_category", category_id: category.id, name },
                    (state) => renameCategory(state, category.id, name),
                  ).catch(() => {});
                }}
              />
              {/* Quick task adding keeps a sign of its own next to the name — a category
                  creates tasks more often than anything else in the "⋯" menu, and asking for
                  two clicks where one was enough would be a step backwards. The other actions
                  are in the menu. */}
              {onAddTask && (
                <span className="row-icons">
                  <RowIcon label={addLabel} onClick={() => onAddTask(category.id)}>
                    +
                  </RowIcon>
                </span>
              )}
              {(onAddTask || onDelete || canWrite) && (
                <RowMenu
                  label={t("gantt.row_menu.category_label")}
                  describedBy={categoryNameId}
                  onClose={() => setMenuView("root")}
                  testId={`category-menu-${category.id}`}
                >
                  {(close) =>
                    menuView === "move" ? (
                      <>
                        <MenuBack label={t("gantt.row_menu.move")} onClick={() => setMenuView("root")} />
                        <MenuAction
                          icon={<span aria-hidden="true">↑</span>}
                          disabled={index <= 0}
                          onClick={() => {
                            moveBy(-1);
                            close();
                          }}
                        >
                          {t("gantt.row_menu.move_up")}
                        </MenuAction>
                        <MenuAction
                          icon={<span aria-hidden="true">↓</span>}
                          disabled={index >= categoriesCount - 1}
                          onClick={() => {
                            moveBy(1);
                            close();
                          }}
                        >
                          {t("gantt.row_menu.move_down")}
                        </MenuAction>
                      </>
                    ) : (
                      <>
                        {onAddTask && (
                          <MenuAction
                            icon={<span aria-hidden="true">+</span>}
                            onClick={() => {
                              onAddTask(category.id);
                              close();
                            }}
                          >
                            {t("gantt.row_menu.add_task")}
                          </MenuAction>
                        )}
                        {canWrite && (
                          <MenuAction
                            icon={<PencilIcon />}
                            onClick={() => {
                              setRenameToken((current) => current + 1);
                              close();
                            }}
                          >
                            {t("gantt.row_menu.rename_category")}
                          </MenuAction>
                        )}
                        {canWrite && (
                          <MenuAction
                            icon={<span aria-hidden="true">⧉</span>}
                            onClick={() => {
                              duplicate();
                              close();
                            }}
                          >
                            {t("gantt.row_menu.duplicate")}
                          </MenuAction>
                        )}
                        {canWrite && categoriesCount > 1 && (
                          <MenuAction
                            icon={<span aria-hidden="true">↔</span>}
                            onClick={() => setMenuView("move")}
                          >
                            {t("gantt.row_menu.move")}
                          </MenuAction>
                        )}
                        {onDelete && deleteLabel !== undefined && (
                          <>
                            <MenuSeparator />
                            <MenuAction
                              icon={<span aria-hidden="true">×</span>}
                              tone="danger"
                              onClick={() => {
                                // The item itself deletes nothing: it opens the question
                                // "together with these tasks?", which is asked by the screen
                                // (see onDeleteCategory in Gantt).
                                onDelete(category.id);
                                close();
                              }}
                            >
                              {t("gantt.row_menu.delete_category")}
                            </MenuAction>
                          </>
                        )}
                      </>
                    )
                  }
                </RowMenu>
              )}
            </>
          }
        />
      </div>

      <div className="gantt__lane" style={{ width: scale.width }}>
        {span && (
          <div
            ref={drag.spanRef}
            className={`gantt__span${drag.handlers ? " is-draggable" : ""}${
              drag.dragging ? " is-dragging" : ""
            }`}
            style={{
              left: scale.xOf(span.start),
              width: scale.widthOf(span.start, span.end),
              background: category.color,
              // The arrow ticks at the bar's ends are painted the same colour: they are drawn
              // as a border on pseudo-elements and take it through `currentColor` — no second
              // place with the category's colour is introduced.
              color: category.color,
            }}
            title={drag.handlers ? moveLabel : undefined}
            // The bar is not a control even while it is being dragged: moving a stage with
            // the mouse is an acceleration rather than the only path, and from the keyboard
            // the same tasks are moved each by its own bar. A button here would promise an
            // action on Enter that does not exist.
            aria-hidden="true"
            {...drag.handlers}
          />
        )}
        {empty && emptyHint !== undefined && onAddTask && (
          // The hint stands in the lane rather than in a row of its own: an empty category's
          // lane is unoccupied anyway, and an explanation placed in it moves not a single
          // chart row down and disappears with the first task by itself.
          //
          // A button rather than a caption: it offers an action and must perform it — a drawn
          // invitation that cannot be pressed would send a person hunting for the "plus" with
          // their eyes (the same argument as with the button in the middle of an empty chart,
          // see gantt__empty-add).
          //
          // The category's name goes as a description rather than as a label: the visible
          // text is the same on any category, and substituting it for what is spoken would
          // mean telling the screen reader something other than what is written (see
          // describedBy on "⋯").
          <button
            type="button"
            className="gantt__lane-hint"
            aria-describedby={categoryNameId}
            onClick={() => onAddTask(category.id)}
          >
            <span className="gantt__lane-hint-plus" aria-hidden="true">
              +
            </span>
            {emptyHint}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * A task row.
 *
 * The bar is a button rather than a `div` with a handler everywhere it is clicked or walked
 * to from the keyboard: a button brings focus, a role and a reaction to Enter for free, while
 * a `div` would have to be brought to the same state by hand, and half of it would be
 * forgotten. Where it does neither — on the public page — it is declared a picture; see `Bar`
 * below.
 */
export function TaskRow({
  projectId,
  task,
  scale,
  onReach,
  calendar,
  layout,
  cellLabels,
  format,
  late,
  lateLabel,
  title,
  canWrite = false,
  selected = false,
  onSelect,
  reorder,
  link,
  handleLabel,
  beyondPlan = false,
  beyondPlanLabel,
  beyondPlanHint,
  baselineLabel,
  deviationLabel,
  statusLabel,
  showBaseline = true,
  assigneeNames,
  commentCount = 0,
  onOpenComments,
  onInsertBefore,
  categories,
  taskCountByCategory,
}: {
  projectId: string;
  task: Task;
  scale: Scale;
  /** The bar is held past the window's edge — the chart extends it (see reach in Gantt). */
  onReach?: (endISO: string | null) => void;
  /** The working calendar: the right edge converts a day into a duration with it. */
  calendar: Calendar;
  layout: ColumnLayout;
  cellLabels: CellLabels;
  format: DayFormat;
  late: boolean;
  lateLabel: string;
  title: string;
  canWrite?: boolean;
  /** Whether this task's card is open. */
  selected?: boolean;
  onSelect?: (taskId: string) => void;
  reorder?: Reorder;
  /** Dragging a link from the dot at the bar's edge. A guest does not have it. */
  link?: LinkDrag;
  handleLabel?: string;
  /** The task was added after the plan was agreed — see isBeyondPlan. */
  beyondPlan?: boolean;
  /** The short label of the marker by the bar: "Beyond the plan". */
  beyondPlanLabel?: string;
  /** The marker's tooltip: why the task has no baseline plan ghost. */
  beyondPlanHint?: string;
  /** The ghost's label: the dates of the approved plan. */
  baselineLabel?: string;
  /** The ready label of the deviation badge, for example "+7 days". */
  deviationLabel?: string;
  /** The status chip's label — needed only by a "blocked" bar. */
  statusLabel?: string;
  /** Whether to draw the baseline plan's ghost and tick — a "View" menu checkbox. */
  showBaseline?: boolean;
  /**
   * The organization's membership: names by identifier. The task's assignees are labelled
   * with them — and new ones are chosen from them (see AssignMenu). `undefined` means the
   * membership is not known at all (the public page, a role with no right to the list), and
   * then the assignee column stays silent and there is nobody to assign.
   */
  assigneeNames?: ReadonlyMap<string, string>;
  /** How many remarks the task has. Zero shows no number — there is nothing to show. */
  commentCount?: number;
  /** Open the task's discussion. `undefined` means there is no card (a guest). */
  onOpenComments?: (taskId: string) => void;
  /** Create a task right above this row. `undefined` for a reader. */
  onInsertBefore?: () => void;
  /** Every category of the project — the "Move" item in the row menu knows them. */
  categories?: Category[];
  /** How many tasks are already in each category — a task goes to the end of wherever it is
      moved, and the end is exactly the current number of rows. */
  taskCountByCategory?: ReadonlyMap<string, number>;
}) {
  const { t } = useLocale();
  const { apply } = useProjectMutation(projectId);
  // The node with the task's name: the assignees button is labelled by it — it calls itself
  // "Assignees" and states which task through a description (see AssignMenu).
  const nameId = useId();
  // The full name as a tooltip — but only when it really is truncated with an ellipsis (see
  // useTruncatedTitle). The column's width is the second parameter: it is dragged by its
  // boundary, and the truncation changes with no edit to the name itself.
  const nameTitle = useTruncatedTitle<HTMLSpanElement>(task.name, layout.widths.task);
  // The bar's place by dates. It is computed here rather than in the markup below because two
  // things need to know it: the markup itself and the motion layer — the latter compares it
  // with the place on the previous render and shows the travel from the difference.
  const left = scale.xOf(task.start_date);
  // A milestone occupies one day regardless of what lies in its duration: the diamond stands
  // on its day rather than stretching along it.
  const width = task.milestone
    ? scale.dayWidth
    : scale.widthOf(task.start_date, task.end_date);
  const motion = useBarMotion({ left, scaleKey: scale.key });
  const { dragging, handlers, gripHandlers } = useDragDates({
    projectId,
    task,
    scale,
    calendar,
    enabled: canWrite,
    motion,
    onReach,
  });
  const tip = useBarTip(task, canWrite);
  const baseline = baselineOf(task);
  const shift = endShiftDays(task);

  // Edits right in the table. Each is the same operation as on the task card: a cell does not
  // introduce a way of its own to change a date, it calls the one that already exists. A
  // refusal rolls `apply` back, and the cell returns to the truth by itself — it has no
  // "did not save" state of its own.
  // A project day is counted from the first: zero and negative are not a date but the middle
  // of typing or a typo, and turning them into a date before the axis's start (see
  // RELATIVE_EPOCH) would mean taking the bar past the chart's left edge.
  const projectDay = (value: string): string | null => {
    const day = Number(value);
    return Number.isInteger(day) && day >= 1 ? dateOfProjectDay(day, format.anchor) : null;
  };
  const edit = {
    start: (value: string) => {
      const start = format.relative ? projectDay(value) : value;
      if (start === null || start === task.start_date) return;
      void apply({ type: "move_task", task_id: task.id, start_date: start }, (state) =>
        patchTask(state, task.id, { start_date: start }),
      ).catch(() => {});
    },
    end: (value: string) => {
      const finish = format.relative ? projectDay(value) : value;
      if (finish === null || finish < task.start_date) return;
      const duration_days = Math.max(1, workingDaysBetween(task.start_date, finish, calendar));
      if (duration_days === task.duration_days) return;
      void apply({ type: "set_duration", task_id: task.id, duration_days }, (state) =>
        patchTask(state, task.id, { duration_days }),
      ).catch(() => {});
    },
    duration: (value: string) => {
      const duration_days = Number(value);
      if (!Number.isInteger(duration_days) || duration_days < 1) return;
      void apply({ type: "set_duration", task_id: task.id, duration_days }, (state) =>
        patchTask(state, task.id, { duration_days }),
      ).catch(() => {});
    },
    progress: (value: string) => {
      const pct = Math.min(100, Math.max(0, Math.round(Number(value))));
      if (!Number.isFinite(pct) || pct === task.progress_pct) return;
      void apply({ type: "set_progress", task_id: task.id, progress_pct: pct }, (state) =>
        patchProgress(state, task.id, pct),
      ).catch(() => {});
    },
  };

  const assignees = task.assignee_ids
    .map((id) => assigneeNames?.get(id))
    .filter((name): name is string => name !== undefined);

  // Assignees are handed out by their own column when it is shown (its button does not change
  // there — see AssignMenu) and by the "⋯" menu when it is absent or for someone who has not
  // looked into it. The availability flag is one for both places: there is nobody to assign if
  // the organization's membership did not arrive at all or is empty.
  const assignAvailable = canWrite && assigneeNames !== undefined && assigneeNames.size > 0;
  const assignInColumn = assignAvailable && layout.shown.includes("assignee");
  // Next to the name, when there is no column, it is a marker rather than a button: who is
  // already assigned rather than an invitation to assign. The invitation and the handing out
  // itself are in the "⋯" menu (see below), and what is left here is what was never an action:
  // a state.
  const assignIndicator =
    !assignInColumn && assignees.length > 0 ? (
      <span className="gantt__row-indicator" title={assignees.join(", ")}>
        <Avatar name={assignees[0]} size={18} />
        {assignees.length > 1 && <span>+{assignees.length - 1}</span>}
      </span>
    ) : null;

  // The discussion counter appears only when there is something to count: on a task with no
  // remarks it is not an invitation to start a conversation (that is now in the "⋯" menu) but
  // a state — and zero has nothing to show.
  const commentsLabel = t("comments.aria", { name: task.name, count: commentCount });
  const comments =
    commentCount === 0 ? null : (
      <RowBadge
        label={commentsLabel}
        set
        onClick={onOpenComments ? () => onOpenComments(task.id) : undefined}
      >
        <CommentIcon />
        {commentCount}
      </RowBadge>
    );

  // Every assignee is an operation of its own, as in the column's panel: they are removed one
  // by one, and in the history they read as separate events.
  const toggleAssignee = (userId: string) => {
    const assigned = task.assignee_ids.includes(userId);
    void apply(
      { type: assigned ? "unassign_user" : "assign_user", task_id: task.id, user_id: userId },
      (state) =>
        patchTask(state, task.id, {
          assignee_ids: assigned
            ? task.assignee_ids.filter((id) => id !== userId)
            : [...task.assignee_ids, userId],
        }),
    ).catch(() => {});
  };

  const duplicateTask = () => {
    void apply(
      {
        type: "create_task",
        category_id: task.category_id,
        name: `${task.name} ${t("gantt.row_menu.copy_suffix")}`,
        start_date: task.start_date,
        duration_days: task.duration_days,
        description: task.description ?? "",
        criticality: task.criticality,
        status: task.status,
        progress_pct: task.progress_pct,
        milestone: task.milestone,
      },
      (state) => state,
    ).catch(() => {});
  };

  const moveToCategory = (categoryId: string) => {
    const position = taskCountByCategory?.get(categoryId) ?? 0;
    void apply(
      { type: "reorder_task", task_id: task.id, category_id: categoryId, position },
      (state) => reorderTask(state, task.id, categoryId, position),
    ).catch(() => {});
  };

  const removeTask = () => {
    void apply({ type: "delete_task", task_id: task.id }, (state) => deleteTask(state, task.id)).catch(
      () => {},
    );
  };

  const otherCategories = (categories ?? []).filter((category) => category.id !== task.category_id);

  // The "⋯" menu's nested view: the roster by assignee, the list of categories under "Move",
  // the delete confirmation. It lives here rather than inside RowMenu — the panel has no state
  // of its own, and `onClose` below returns the view to the root however it is closed (Esc, a
  // click outside, losing the scroll).
  const [menuView, setMenuView] = useState<"root" | "assign" | "move" | "delete">("root");
  // The "⋯" button appears only if it has at least one action in it: on the public page, with
  // no card and no discussion, the menu would be an empty frame.
  const showMenu = canWrite || Boolean(onSelect) || Boolean(onOpenComments);

  return (
    <div
      className={`gantt__row${selected ? " is-selected" : ""} ${
        reorder?.markFor("task", task.id) ?? ""
      }`.trimEnd()}
      data-drop-kind="task"
      data-drop-id={task.id}
      onPointerMove={(event) =>
        reorder?.over({
          kind: "task",
          id: task.id,
          half: halfOf(event.currentTarget, event.clientY),
        })
      }
      onPointerUp={() => reorder?.drop()}
    >
      <div className="gantt__label">
        <LabelCells
          layout={layout}
          cells={{
            start: (
              <EditableCell
                type={format.relative ? "number" : "date"}
                value={
                  format.relative
                    ? String(projectDayNumber(task.start_date, format.anchor))
                    : task.start_date
                }
                display={format.label(task.start_date)}
                disabled={!canWrite}
                min={format.relative ? 1 : undefined}
                label={cellLabels.edit(cellLabels.columns.start, task.name)}
                onCommit={edit.start}
              />
            ),
            // The finish date is edited not by itself but through the duration: the server
            // computes it against the working calendar, and it cannot be written directly —
            // but "this task ends on such a date" is exactly how a person says it. The cell
            // converts the named day into a number of working days by exactly the same count
            // the bar's right edge uses, and sends the same operation. The server will
            // recompute the end itself and send its own — if the tab's calendar is stale, the
            // cell will stand by its answer rather than by the guess.
            end: (
              <EditableCell
                type={format.relative ? "number" : "date"}
                value={
                  format.relative
                    ? String(projectDayNumber(task.end_date, format.anchor))
                    : task.end_date
                }
                display={format.label(task.end_date)}
                disabled={!canWrite || task.milestone}
                min={format.relative ? 1 : undefined}
                label={cellLabels.edit(cellLabels.columns.end, task.name)}
                onCommit={edit.end}
              />
            ),
            duration: (
              <EditableCell
                type="number"
                value={String(task.duration_days)}
                display={
                  // A milestone has no duration — it has the day on which it happens. Showing
                  // "1 d" would mean calling what is drawn as a point a segment.
                  task.milestone
                    ? t("gantt.milestone.short")
                    : t("common.days_short", { count: task.duration_days })
                }
                disabled={!canWrite || task.milestone}
                min={1}
                label={cellLabels.edit(cellLabels.columns.duration, task.name)}
                onCommit={edit.duration}
              />
            ),
            progress: (
              <EditableCell
                type="number"
                value={String(task.progress_pct)}
                display={`${task.progress_pct}%`}
                disabled={!canWrite}
                min={0}
                max={100}
                label={cellLabels.edit(cellLabels.columns.progress, task.name)}
                onCommit={edit.progress}
              />
            ),
            // A ternary rather than `&&`: an empty list must reach the cell as "nothing to
            // show" (a dash), while `false` is indistinguishable from deliberately empty
            // content and would erase the dash.
            // The selection button occupies this cell entirely when assigning is possible: it
            // also shows who is assigned — through avatars. The `!` is not a guess:
            // `assignInColumn` by itself means that the organization's membership arrived and
            // is not empty (see `assignAvailable` above).
            assignee: assignInColumn
              ? (
                  <AssignMenu
                    projectId={projectId}
                    task={task}
                    roster={assigneeNames!}
                    describedBy={nameId}
                  />
                )
              : assignees.length > 0
                ? (
                    <span className="cell-value" title={assignees.join(", ")}>
                      {assignees.join(", ")}
                    </span>
                  )
                : undefined,
          }}
          task={
            <>
              {reorder?.enabled && (
                // The handle is separate from the bar: the order is changed by it, the dates
                // by the bar.
                //
                // Deliberately not a button and hidden from screen reading. A button would
                // promise keyboard operation, while reordering rows from the keyboard is not
                // part of this plan: declaring ten buttons, none of which fires on Enter, is
                // worse than not declaring them at all. The task's bar meanwhile stays a
                // button and is still moved with the arrow keys.
                <span
                  className="gantt__handle"
                  aria-hidden="true"
                  title={handleLabel}
                  // The whole gesture is on the handle rather than only its start: with a
                  // finger the pointer is captured by it until the very drop, and the rows
                  // under the finger receive no events (see useReorder).
                  {...reorder.handleProps("task", task.id)}
                >
                  ⠿
                </span>
              )}
              {/* The name opens the card too, not only the bar: it is read before the bar and
                  clicked first, especially when the bar is cut off by the chart's edge. The
                  name does not become a button — the bar already gives the same action from
                  the keyboard and for screen reading, and a second button with the same name
                  on a row would be an extra, indistinguishable Tab stop for them. The click
                  stays available to the pointer and promises nothing it does not perform. */}
              <span
                id={nameId}
                ref={nameTitle.ref}
                title={nameTitle.title}
                className={`gantt__label-name${onSelect ? " gantt__label-name--clickable" : ""}`}
                onClick={onSelect ? () => onSelect(task.id) : undefined}
              >
                {task.name}
              </span>
              {late && (
                <span className="gantt__flag" title={lateLabel} role="img" aria-label={lateLabel}>
                  !
                </span>
              )}

              {/* The tail of the name column: what a task already has rather than what can be
                  done with it. The number of remarks and the assignee marker are a state, and
                  it does not stay silent until hover: staying silent until the row is hovered
                  is proper to controls rather than to values (the same argument as with an
                  assigned person in the column). The action itself — assign, discuss, insert,
                  delete — is now one and the same place: the "⋯" menu on the right. */}
              {(comments !== null || assignIndicator !== null) && (
                <span className="row-icons">
                  {comments}
                  {assignIndicator}
                </span>
              )}
              {showMenu && (
                <RowMenu
                  label={t("gantt.row_menu.task_label")}
                  describedBy={nameId}
                  onClose={() => setMenuView("root")}
                  testId={`row-menu-${task.id}`}
                >
                  {(close) => {
                    if (menuView === "assign") {
                      return (
                        <>
                          <MenuBack label={t("gantt.assign.label")} onClick={() => setMenuView("root")} />
                          {[...(assigneeNames ?? [])].map(([id, name]) => (
                            <MenuAction
                              key={id}
                              icon={<Avatar name={name} size={18} />}
                              pressed={task.assignee_ids.includes(id)}
                              onClick={() => toggleAssignee(id)}
                            >
                              {name}
                            </MenuAction>
                          ))}
                        </>
                      );
                    }
                    if (menuView === "move") {
                      return (
                        <>
                          <MenuBack label={t("gantt.row_menu.move")} onClick={() => setMenuView("root")} />
                          {otherCategories.map((category) => (
                            <MenuAction
                              key={category.id}
                              onClick={() => {
                                moveToCategory(category.id);
                                close();
                              }}
                            >
                              {category.name}
                            </MenuAction>
                          ))}
                        </>
                      );
                    }
                    if (menuView === "delete") {
                      return (
                        <div className="gantt__more-confirm">
                          <p>{t("task.panel.delete_warning")}</p>
                          <div className="gantt__more-confirm-actions">
                            <button
                              type="button"
                              className="button--quiet"
                              onClick={() => setMenuView("root")}
                            >
                              {t("common.cancel")}
                            </button>
                            <button
                              type="button"
                              className="button--danger"
                              onClick={() => {
                                removeTask();
                                close();
                              }}
                            >
                              {t("task.panel.delete_confirm")}
                            </button>
                          </div>
                        </div>
                      );
                    }
                    return (
                      <>
                        {onSelect && (
                          <MenuAction
                            icon={<span aria-hidden="true">↗</span>}
                            onClick={() => {
                              onSelect(task.id);
                              close();
                            }}
                          >
                            {t("gantt.row_menu.open")}
                          </MenuAction>
                        )}
                        {onInsertBefore && (
                          <MenuAction
                            icon={<span aria-hidden="true">+</span>}
                            onClick={() => {
                              onInsertBefore();
                              close();
                            }}
                          >
                            {t("gantt.row_menu.add_task")}
                          </MenuAction>
                        )}
                        {assignAvailable && (
                          <MenuAction icon={<PeopleIcon />} onClick={() => setMenuView("assign")}>
                            {t("gantt.row_menu.assign")}
                          </MenuAction>
                        )}
                        {onOpenComments && (
                          <MenuAction
                            icon={<CommentIcon />}
                            onClick={() => {
                              onOpenComments(task.id);
                              close();
                            }}
                          >
                            {t("gantt.row_menu.comment")}
                          </MenuAction>
                        )}
                        {canWrite && (
                          <>
                            <MenuSeparator />
                            <MenuAction
                              icon={<span aria-hidden="true">⧉</span>}
                              onClick={() => {
                                duplicateTask();
                                close();
                              }}
                            >
                              {t("gantt.row_menu.duplicate")}
                            </MenuAction>
                            {otherCategories.length > 0 && (
                              <MenuAction
                                icon={<span aria-hidden="true">↔</span>}
                                onClick={() => setMenuView("move")}
                              >
                                {t("gantt.row_menu.move")}
                              </MenuAction>
                            )}
                            <MenuSeparator />
                            <MenuAction
                              icon={<span aria-hidden="true">×</span>}
                              tone="danger"
                              onClick={() => setMenuView("delete")}
                            >
                              {t("gantt.row_menu.delete")}
                            </MenuAction>
                          </>
                        )}
                      </>
                    );
                  }}
                </RowMenu>
              )}
            </>
          }
        />
      </div>

      <div className="gantt__lane" style={{ width: scale.width }}>
        {showBaseline && baseline && (
          // The ghost of the baseline plan is a thin grey bar beneath the current one.
          //
          // Beneath specifically rather than as an extension of the current one: filling
          // the gap between the planned and the actual finish right inside the bar looks
          // more vivid, but then its start means the planned date and its end the actual
          // one, and the bar stops meaning the task's real dates.
          <div
            className="gantt__ghost"
            style={{
              left: scale.xOf(baseline.start),
              width: scale.widthOf(baseline.start, baseline.end),
            }}
            title={baselineLabel}
            data-testid={`ghost-${task.id}`}
            aria-hidden="true"
          />
        )}

        {showBaseline && baseline && shift !== null && shift > 0 && (
          // The tick of the original deadline, as in the mockup: a vertical red rule where
          // the task was supposed to end under the plan.
          <i
            className="gantt__mark"
            style={{ left: scale.xOf(baseline.end) + scale.dayWidth }}
            title={baselineLabel}
            data-testid={`mark-${task.id}`}
            aria-hidden="true"
          />
        )}

        {shift !== null && shift !== 0 && deviationLabel && (
          // The deviation badge to the right of the bar. It is counted from the finish: that
          // alone answers the question "when will this be ready" and absorbs both a shift of
          // the start and a stretch of the duration.
          <span
            className={`gantt__deviation${shift > 0 ? " is-late" : " is-early"}`}
            style={{ left: scale.xOf(task.end_date) + scale.dayWidth }}
            data-testid={`deviation-${task.id}`}
          >
            {deviationLabel}
          </span>
        )}

        {beyondPlan && beyondPlanLabel && (
          // "Beyond the plan": the task was added after agreement and has no baseline plan.
          // The marker is not decoration — without it the absence of a ghost under the bar
          // reads as "the task has not moved anywhere", while in fact there is simply
          // nothing to compare it with.
          //
          // To the right of the bar, in the deviation badge's place: both markers answer one
          // question — how the task relates to the agreed plan — and a task with no baseline
          // plan cannot have a deviation, so the place is free. This used to be a "plus" in
          // the name column, flush against the "⋯" menu, and it was taken for a button: "+"
          // across the whole chart means "add", and this sign was not pressable.
          <span
            className="gantt__beyond-plan"
            style={{ left: scale.xOf(task.end_date) + scale.dayWidth }}
            title={beyondPlanHint}
            data-testid={`beyond-${task.id}`}
          >
            {beyondPlanLabel}
          </span>
        )}

        {/* A button only when the bar really does something: opens a card or moves. On the
            public page it does neither, and a button there would promise an action that does
            not exist — it would take keyboard focus and be read from the screen as
            pressable. In that case it is a picture with a caption rather than a control. */}
        <Bar
          interactive={Boolean(onSelect) || canWrite}
          barRef={motion.ref}
          className={`gantt__bar${task.milestone ? " gantt__bar--milestone" : ""}${
            late ? " is-late" : ""
          }${canWrite ? " is-draggable" : ""}${dragging !== null ? " is-dragging" : ""}`}
          data-criticality={task.criticality}
          data-status={task.status}
          // The risk dot appears only for yellow and red and only on a live task: on "done"
          // the flag is history rather than a signal.
          data-risk={task.status !== "done" && task.risk !== "green" ? task.risk : undefined}
          // An attribute rather than a class: criticality is a property of a computation, and
          // it is drawn only when the layer is on (see `.gantt.show-critical`).
          data-critical={task.critical ? "" : undefined}
          data-testid={`bar-${task.id}`}
          style={
            {
              // The place by dates, and only by them: `left` and `width` are set on render
              // and are not changed by anyone afterwards. The shift under the finger, the
              // wait for an answer at the drop point and the travel after the server's answer
              // all go through `transform` and `--bar-dw` — see useBarMotion, which also
              // explains why not through those two.
              left,
              "--bar-w": `${width}px`,
              "--progress": `${task.progress_pct}%`,
            } as CSSProperties
          }
          {...handlers}
          // Hover and the gesture live on the same events, so the handlers are composed by
          // hand rather than applied with a spread: a spread would leave only the last of
          // each pair.
          onPointerEnter={tip.onPointerEnter}
          onPointerMove={(event) => {
            handlers.onPointerMove(event);
            tip.onPointerMove(event);
          }}
          onPointerDown={(event) => {
            handlers.onPointerDown(event);
            tip.onPointerDown();
          }}
          onPointerUp={(event) => {
            handlers.onPointerUp(event);
            tip.onPointerUp();
          }}
          onPointerCancel={() => {
            handlers.onPointerCancel();
            tip.onPointerCancel();
          }}
          onPointerLeave={tip.onPointerLeave}
          onFocus={tip.onFocus}
          onBlur={tip.onBlur}
          // The name is stated explicitly together with the dates rather than left to the
          // button's content: the bar has text truncated by width, and browsers differ on
          // what of that becomes the accessible name. A live check showed a bar that reads
          // from the screen as "14 August — 20 August" — with no task name at all.
          //
          // The bar deliberately has no native `title`: over the hover card a second,
          // browser one would crawl out a second later, and two different windows would speak
          // about the same thing.
          aria-label={`${task.name}, ${title}`}
          // The shortcuts are named aloud: moving a task from the keyboard was possible before
          // too, but learning about it was only possible from the sources. For a reader it is
          // empty here: the arrows move nothing for them, and promising them would mean
          // sending them to press keys that stay silent.
          aria-keyshortcuts={
            canWrite
              ? task.milestone
                // A milestone has no edges: there is nothing to drag, and promising a shortcut
                // that stays silent would mean sending a person to press keys for nothing.
                ? "Shift+ArrowLeft Shift+ArrowRight"
                : "Shift+ArrowLeft Shift+ArrowRight Alt+ArrowLeft Alt+ArrowRight Shift+Alt+ArrowLeft Shift+Alt+ArrowRight"
              : undefined
          }
          aria-expanded={onSelect ? selected : undefined}
          onClick={() => onSelect?.(task.id)}
        >
          {task.milestone ? (
            // A milestone is a diamond on its day. A rotated square inside the bar rather
            // than the bar itself: its `transform` is taken up by movement, and a second
            // rotation on the same node would erase the shift under the finger.
            <span className="gantt__diamond" aria-hidden="true" />
          ) : (
            <>
              {/* A fill inside the bar rather than a separate bar beside it: progress is part
                  of the task rather than a second task beneath it. */}
              <span className="gantt__progress" aria-hidden="true" />
              {/* A completed task's checkmark, as in the mockup: the "done" sign is visible at
                  a distance at which the status chip can no longer be read. */}
              {task.status === "done" && (
                <span className="gantt__check" aria-hidden="true">
                  ✓
                </span>
              )}
              {/* A blocked one names its state right on the bar: this is a rare state that
                  calls for action, and one colour is not enough for it. */}
              {task.status === "blocked" && statusLabel && (
                <span className="gantt__bar-blocked" aria-hidden="true">
                  <span>⚠</span>
                  {statusLabel}
                </span>
              )}

              {canWrite && (
                // The bar's edges: the left one moves the start without touching the end, the
                // right one stretches the duration. As separate nodes rather than zones inside
                // a shared handler: each has its own cursor, and with zones that would have to
                // be decided at the moment of the press — when the cursor has already shown
                // one thing or the other.
                //
                // They are hidden from screen reading: the same thing they do is available
                // from the keyboard through the "Start" and "Duration" fields — both in the
                // table on the left and on the task card. Two handles, neither of which works
                // on Enter, would be extra Tab stops on each of a hundred rows.
                <>
                  <span
                    className="gantt__grip gantt__grip--start"
                    aria-hidden="true"
                    {...gripHandlers("start")}
                  />
                  <span
                    className="gantt__grip gantt__grip--end"
                    aria-hidden="true"
                    {...gripHandlers("end")}
                  />
                </>
              )}

              {canWrite && task.status === "in_progress" && (
                // The completion handle appears only where the fill is visible at all. A
                // planned task does not have one: the percentage would land in the field
                // without showing on the bar, and the gesture would look as if it had failed.
                <span
                  className="gantt__grip gantt__grip--progress"
                  aria-hidden="true"
                  {...gripHandlers("progress")}
                />
              )}
            </>
          )}
        </Bar>

        {link?.enabled && dragging === null && (
          // The link dots go outside the bar rather than inside: the bar clips its content
          // (otherwise the label would spill past its edges), and a dot on the boundary would
          // be cut in half.
          //
          // While a bar is being dragged there are no dots: they stand by the task's dates,
          // and at that moment the bar is following the finger, so the dots would lag behind
          // it, showing a link from somewhere other than where it is being dragged.
          <>
            <LinkDot
              side="start"
              task={task}
              link={link}
              x={left}
              label={t("gantt.link.from", { name: task.name })}
            />
            <LinkDot
              side="end"
              task={task}
              link={link}
              x={left + width}
              label={t("gantt.link.to", { name: task.name })}
            />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The dot a link is dragged from.
 *
 * Not a button: a link is created by dragging, and pressing Enter on it means nothing. The
 * same path from the keyboard is given by the list of dependencies on the task card — which
 * is why the dot is hidden from screen reading too, while the label stays as a tooltip for
 * the pointer.
 */
function LinkDot({
  side,
  task,
  link,
  x,
  label,
}: {
  side: "start" | "end";
  task: Task;
  link: LinkDrag;
  x: number;
  label: string;
}) {
  return (
    <span
      className={`gantt__link-dot gantt__link-dot--${side}`}
      style={{ left: x }}
      title={label}
      aria-hidden="true"
      {...link.handleProps(task.id, side)}
    />
  );
}

/**
 * A task's bar: a control or a picture with a caption.
 *
 * The distinction is not cosmetic. A button takes keyboard focus and is read from the screen
 * as pressable; on the public page, where there is no task card and the dates do not move,
 * that is a promise of an action that does not exist. In that case the bar is declared a
 * picture — `role="img"` with the same name: it still names the task and its dates, but does
 * not pretend to be a button.
 */
function Bar({
  interactive,
  children,
  barRef,
  ...rest
}: {
  interactive: boolean;
  children: ReactNode;
  /**
   * The reference to the bar's node for the motion layer.
   *
   * As a separate prop rather than a `ref`: `Bar` renders either a button or a `div`, and a
   * `ref` would have to be declared for both — while it is needed not by `Bar` itself but by
   * whoever writes into that node.
   */
  barRef?: RefCallback<HTMLElement>;
} & HTMLAttributes<HTMLElement>) {
  if (interactive) {
    return (
      <button type="button" ref={barRef} {...rest}>
        {children}
      </button>
    );
  }
  // aria-expanded and onClick do not reach here: without onSelect they are empty, and an
  // empty handler on a non-interactive element is a trace that reads as a forgotten
  // capability.
  const { onClick, "aria-expanded": expanded, ...plain } = rest;
  void onClick;
  void expanded;
  return (
    <div role="img" ref={barRef} {...plain}>
      {children}
    </div>
  );
}
