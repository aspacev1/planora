import type { Task, TaskStatus } from "../api/projects";

/**
 * A set of tasks' readiness, weighted by duration.
 *
 * The weighting was chosen explicitly (see the mockup analysis, §9.3): an unweighted average would count
 * a day and a month as equal contributions, and a category with a finished one-day item and an untouched
 * month would show "50%". The share of a day's work is what a person means by "two thirds done".
 *
 * One function for a category, a project and a report: three reductions in three places would diverge on
 * the very first disputable percentage.
 */
export function progressOf(tasks: Task[]): number | null {
  if (tasks.length === 0) return null;
  const total = tasks.reduce((sum, task) => sum + task.duration_days, 0);
  if (total === 0) return null;
  const done = tasks.reduce((sum, task) => sum + task.duration_days * task.progress_pct, 0);
  return Math.round(done / total);
}

/** How many tasks are in each status. The zeros stay: a report needs every column. */
export function statusCounts(tasks: Task[]): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = { planned: 0, in_progress: 0, done: 0, blocked: 0 };
  for (const task of tasks) counts[task.status] += 1;
  return counts;
}
