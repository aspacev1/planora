import type { Op, ProjectState, Task } from "../api/projects";
import { addDays, daysBetween } from "../gantt/timescale";

/**
 * The deviation from the baseline plan — the same rule as on the server.
 *
 * Repeating it here does not replace the server's check and does not argue with it: the
 * server decides either way, and this exists so that the reason dialog appears right when
 * the mouse is released rather than after a refusal over the network. These two
 * reckonings cannot diverge: both compute exactly one thing — the distance to the
 * baseline plan — and both figures are taken from one and the same state.
 */

/** The default threshold if the server sent no permitted settings. */
const FALLBACK_THRESHOLD_DAYS = 2;

export function thresholdOf(state: ProjectState): number {
  return state.settings?.shift_threshold_days ?? FALLBACK_THRESHOLD_DAYS;
}

/**
 * A task's baseline plan, if it has one.
 *
 * One place where "has one or not" is decided — and one place where a missing field is
 * equated to an empty one. The second matters: the state arrives both from the server and
 * from optimistic edits, and a role without some of the fields would one day come out
 * "with a baseline plan made of undefined". A zero duration falls into the condition as a
 * bonus and harmlessly: the server does not accept less than one day.
 */
export function baselineOf(
  task: Task,
): { start: string; duration: number; end: string } | null {
  const { baseline_start: start, baseline_duration: duration, baseline_end: end } = task;
  if (!start || !duration || !end) return null;
  return { start, duration, end };
}

/**
 * A task added after the plan was approved.
 *
 * It has no baseline plan and will not have one until re-approval: adding work is normal
 * and requires no explanation — what requires explanation is a hidden shift of dates.
 */
export function isBeyondPlan(state: ProjectState, task: Task): boolean {
  return Boolean(state.plan_approved_at) && baselineOf(task) === null;
}

/**
 * How far a task has diverged from the baseline plan, in days.
 *
 * `null` — there is nothing to compare with. The `start_date` and `duration_days` values
 * can be substituted: that is exactly how an edit not yet sent is checked.
 */
export function deviationDays(
  task: Task,
  next: { start_date?: string; duration_days?: number } = {},
): number | null {
  const baseline = baselineOf(task);
  if (baseline === null) return null;
  const start = next.start_date ?? task.start_date;
  const duration = next.duration_days ?? task.duration_days;
  const startShift = Math.abs(daysBetween(baseline.start, start));
  const durationShift = Math.abs(duration - baseline.duration);
  // The dimensions are not mixed — exactly as in `deviation_days` on the server: the named
  // dimension is the one measured. Otherwise a task whose start has already travelled past
  // the threshold with an explanation would demand a reason for every one-day edit of the
  // duration — and the dialog would name a number from a different dimension. Without a
  // substitution the greater of the two is returned: the answer to "how far has the task gone".
  if (next.start_date !== undefined && next.duration_days === undefined) return startShift;
  if (next.duration_days !== undefined && next.start_date === undefined) return durationShift;
  return Math.max(startShift, durationShift);
}

/**
 * The end's shift relative to the baseline plan — what the badge shows.
 *
 * The end specifically, not the start: it alone answers the question "when will this be
 * ready" and absorbs both a move of the start and a stretch of the duration. `null` —
 * there is no baseline plan, and no badge either.
 */
export function endShiftDays(task: Task): number | null {
  const baseline = baselineOf(task);
  if (baseline === null) return null;
  return daysBetween(baseline.end, task.end_date);
}

/**
 * Whether the plan has diverged from what was approved lives in `planChanges.ts`: the list
 * of the divergences themselves, which the changes panel shows, is computed there too. The
 * flag and the list must know one and the same thing — otherwise the marker in the header
 * will one day appear above an empty panel.
 */

export type ShiftRequest = {
  taskName: string;
  deviationDays: number;
  thresholdDays: number;
};

/**
 * Whether this operation requires a reason — and which numbers to show in the dialog.
 *
 * `null` means "does not require": either the operation is not about dates at all, or
 * there is no plan yet, or the deviation fits within the threshold.
 */
export function shiftNeedingReason(state: ProjectState, op: Op): ShiftRequest | null {
  const worst = worstDeviation(state, op);
  if (worst === null) return null;

  const threshold = thresholdOf(state);
  if (worst.deviationDays <= threshold) return null;
  return { ...worst, thresholdDays: threshold };
}

/**
 * The operation's most travelled task and its deviation — or `null` if the operation is
 * not about dates or there is nothing to compare with.
 *
 * "Most" here is not an exaggeration: a category shift moves many tasks in one motion,
 * while the movement has one explanation. Asking for a reason per row would mean asking
 * one and the same question as many times as there are rows in the category.
 */
function worstDeviation(
  state: ProjectState,
  op: Op,
): { taskName: string; deviationDays: number } | null {
  if (op.type === "move_category") {
    const moved = state.tasks
      .filter((task) => task.category_id === op.category_id)
      .map((task) => ({
        taskName: task.name,
        deviationDays: deviationDays(task, { start_date: addDays(task.start_date, op.days) }),
      }))
      .filter((row): row is { taskName: string; deviationDays: number } => row.deviationDays !== null);
    if (moved.length === 0) return null;
    return moved.reduce((a, b) => (b.deviationDays > a.deviationDays ? b : a));
  }

  if (op.type !== "move_task" && op.type !== "set_duration" && op.type !== "resize_task") {
    return null;
  }

  const task = state.tasks.find((row) => row.id === op.task_id);
  if (!task) return null;

  // The change is substituted in the dimension the operation names. `resize_task` names
  // both: the left edge moves the start and changes the duration in one motion.
  const deviation = deviationDays(
    task,
    op.type === "move_task"
      ? { start_date: op.start_date }
      : op.type === "set_duration"
        ? { duration_days: op.duration_days }
        : { start_date: op.start_date, duration_days: op.duration_days },
  );
  if (deviation === null) return null;
  return { taskName: task.name, deviationDays: deviation };
}
