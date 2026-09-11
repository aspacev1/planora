import type { ProjectState, Task } from "../api/projects";
import { daysBetween } from "../gantt/timescale";

/**
 * A project's overdueness: two different quantities with a similar name.
 *
 * "A task is overdue" — the work is not finished while its date has already passed; "the project
 * does not fit into the deadline" — the project's overall date is broken, counted in days rather
 * than in tasks. In Russian both are called "просрочено", but they answer different questions and
 * before this module were computed in several places each in its own way — here they get one place
 * between them.
 */

/**
 * Whether a task is overdue: the work is not finished while its date has already passed.
 *
 * Only for a calendar plan. In a relative one the tasks' dates are coordinates on an axis from
 * RELATIVE_EPOCH (2001-01-01) rather than real dates: a comparison with today would mark every row
 * of such a project overdue.
 */
export function isTaskOverdue(state: ProjectState, task: Task, today: string): boolean {
  if (state.schedule_mode !== "calendar") return false;
  return task.status !== "done" && task.end_date < today;
}

/** A project's overdue tasks. Counted in tasks: they are opened by name. */
export function overdueTasks(state: ProjectState, today: string): Task[] {
  return state.tasks.filter((task) => isTaskOverdue(state, task, today));
}

/**
 * The tasks ending later than the project's deadline.
 *
 * Not the same as the overdueness above, although in Russian both are called "просрочено". That one
 * answers "the work has stopped and the time is up", this one answers "was it on time". Hence the
 * overlap with the finished ones: something done after the deadline was not done on time, and it
 * does not leave this count.
 *
 * A relative plan is in no danger even without a mode check: its coordinates lie in 2001 and do not
 * step over a deadline.
 */
export function pastDeadlineTasks(state: ProjectState): Task[] {
  const { deadline } = state;
  if (deadline === null) return [];
  return state.tasks.filter((task) => task.end_date > deadline);
}

/**
 * By how many days the project does not fit into the deadline. `null` — it fits, or there is nothing
 * to compare with.
 *
 * In days rather than in tasks: "six tasks past the deadline" does not answer whether the delay is a
 * day or a month, while "+14 days" answers at once.
 */
export function deadlineOverrunDays(state: ProjectState): number | null {
  if (state.schedule_mode !== "calendar") return null;
  if (state.deadline === null || state.project_end === null) return null;
  const overrun = daysBetween(state.deadline, state.project_end);
  return overrun > 0 ? overrun : null;
}
