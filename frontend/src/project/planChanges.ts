import type { PlanApproval, ProjectState, Task } from "../api/projects";
import { daysBetween } from "../gantt/timescale";
import { baselineOf, isBeyondPlan } from "./baseline";

/**
 * How the current plan differs from the approved one.
 *
 * States are compared rather than actions enumerated: a task that travelled three days and
 * came back is not a change — the history journal remembers it, while the plan agrees with it.
 * So the source here is the same as the deviation badge's on a bar — the baseline plan on the
 * task itself, not the revision feed.
 *
 * Nothing is requested: the baseline values arrive with the project's state, and the whole
 * list is computed from what is already on screen.
 */

/** One divergence from the approved plan. */
export type PlanChange =
  | {
      kind: "shift";
      task: Task;
      /** The start by the approved plan and the start now. */
      from: string;
      to: string;
      /** The sign is preserved: a minus means the task was brought closer. */
      days: number;
      /** The duration, if it was changed in the same motion. `null` — it was not. */
      stretch: { from: number; to: number } | null;
    }
  | { kind: "duration"; task: Task; from: number; to: number; days: number }
  | { kind: "added"; task: Task }
  /**
   * A task from a version's snapshot that no longer exists.
   *
   * It has no task of its own left — only a name from the snapshot: the project's state does
   * not keep the deleted, and such a divergence cannot be computed from it at all.
   */
  | { kind: "removed"; taskId: string; name: string };

export type PlanChanges = {
  shifts: Extract<PlanChange, { kind: "shift" }>[];
  durations: Extract<PlanChange, { kind: "duration" }>[];
  added: Extract<PlanChange, { kind: "added" }>[];
  /**
   * How many tasks have diverged from the plan.
   *
   * Tasks are counted, not divergences: a number growing with how many times a task was
   * touched would speak of fuss rather than of the plan.
   *
   * So the groups divide the tasks rather than overlapping: a task that was moved and
   * stretched in one motion stands in "shifts", while the stretch is named in its own line.
   * Otherwise the sum of the groups would diverge from this number, and a person adding up the
   * tags' captions would get something other than what is written on the chip.
   *
   * The deleted are not included here: only a version's snapshot knows them, and it is loaded
   * separately and only when the panel is opened (see removedTasks).
   */
  taskCount: number;
};

/** Empty — the plan agrees with the approved one, or there is nothing to approve yet. */
const NOTHING: PlanChanges = { shifts: [], durations: [], added: [], taskCount: 0 };

export function planChanges(state: ProjectState): PlanChanges {
  if (!state.plan_approved_at) return NOTHING;

  const changes: PlanChanges = { shifts: [], durations: [], added: [], taskCount: 0 };
  for (const task of state.tasks) {
    if (isBeyondPlan(state, task)) {
      changes.added.push({ kind: "added", task });
      changes.taskCount += 1;
      continue;
    }

    const baseline = baselineOf(task);
    if (baseline === null) continue;

    const shift = daysBetween(baseline.start, task.start_date);
    const stretch = task.duration_days - baseline.duration;
    if (shift === 0 && stretch === 0) continue;

    // A moved start outranks a stretched duration: "when do we start" is the first thing asked
    // of a plan, and a task where both have travelled reads above all as a moved one.
    if (shift !== 0) {
      changes.shifts.push({
        kind: "shift",
        task,
        from: baseline.start,
        to: task.start_date,
        days: shift,
        stretch:
          stretch === 0 ? null : { from: baseline.duration, to: task.duration_days },
      });
    } else {
      changes.durations.push({
        kind: "duration",
        task,
        from: baseline.duration,
        to: task.duration_days,
        days: stretch,
      });
    }

    changes.taskCount += 1;
  }

  return changes;
}

/**
 * The tasks that were in the approved plan and have disappeared.
 *
 * Computed from a version's snapshot rather than from the state: a deleted task is not in the
 * state by definition, and its disappearance is the only divergence from the plan that cannot
 * be seen from a state at all. The snapshot keeps the name for exactly this case.
 *
 * The snapshot taken is the latest version's — the one the plan is compared with. The list of
 * versions arrives newest first (see plans.plan_versions), so the one needed is the first; the
 * order is still not assumed here but checked by number: the server's answer is data, not a
 * promise.
 */
export function removedTasks(
  state: ProjectState,
  approvals: PlanApproval[],
): Extract<PlanChange, { kind: "removed" }>[] {
  if (!state.plan_approved_at || approvals.length === 0) return [];

  const latest = approvals.reduce((a, b) => (b.version > a.version ? b : a));
  const alive = new Set(state.tasks.map((task) => task.id));
  return Object.entries(latest.snapshot)
    .filter(([taskId]) => !alive.has(taskId))
    .map(([taskId, planned]) => ({ kind: "removed" as const, taskId, name: planned.name }));
}
