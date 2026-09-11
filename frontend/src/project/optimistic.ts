import type { ProjectState, Task, TaskStatus } from "../api/projects";
import { addDays } from "../gantt/timescale";

/**
 * State transformations of "how it will look" until the server answers.
 *
 * There is and must be no calendar arithmetic here: the end date is computed by the
 * server, and computed "by eye" here it would diverge from the real one on the very
 * first holiday. Before the answer a bar moves by its start and keeps its former
 * length — that is more honest than showing a wrong end confidently.
 */

export function patchTask(state: ProjectState, taskId: string, patch: Partial<Task>): ProjectState {
  return {
    ...state,
    tasks: state.tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task)),
  };
}

/**
 * The coupling of status and progress — the same as on the server, and only it.
 *
 * A guess must coincide with the future answer: a hundred percent of progress makes a
 * task done, a fall below a hundred returns a done one to work, and "done" by hand
 * brings the progress up to a hundred. The server derives nothing more — and neither
 * must the client, otherwise the bar will flash somebody else's value between the guess
 * and the answer.
 *
 * The rule is extracted as two pure functions, because it is asked for not only by the
 * guesses: the task creation form reconciles the same two fields before sending —
 * `create_task` stores the status and the progress as they were sent, and without this
 * coupling a task would be born "done" with zero percent.
 */
export function statusForProgress(status: TaskStatus, pct: number): TaskStatus {
  return pct >= 100 ? "done" : status === "done" ? "in_progress" : status;
}

export function progressForStatus(status: TaskStatus, pct: number): number {
  return status === "done" ? 100 : pct;
}

export function patchProgress(state: ProjectState, taskId: string, pct: number): ProjectState {
  return {
    ...state,
    tasks: state.tasks.map((task) =>
      task.id === taskId
        ? { ...task, progress_pct: pct, status: statusForProgress(task.status, pct) }
        : task,
    ),
  };
}

export function patchStatus(state: ProjectState, taskId: string, status: TaskStatus): ProjectState {
  return {
    ...state,
    tasks: state.tasks.map((task) =>
      task.id === taskId
        ? { ...task, status, progress_pct: progressForStatus(status, task.progress_pct) }
        : task,
    ),
  };
}

/**
 * A milestone collapses the duration into one day — the same coupling as on the server,
 * and only it. Clearing the flag does not touch the duration: a milestone never had a
 * real one, and there is nothing to invent one from on the way out.
 *
 * The guess does not compute the end date — that is computed by the server from the
 * project's calendar. Before the answer the bar stays its former width and only then
 * becomes a diamond; that is more honest than showing a wrong end confidently.
 */
export function patchMilestone(
  state: ProjectState,
  taskId: string,
  milestone: boolean,
): ProjectState {
  return {
    ...state,
    tasks: state.tasks.map((task) =>
      task.id === taskId
        ? { ...task, milestone, duration_days: milestone ? 1 : task.duration_days }
        : task,
    ),
  };
}

/**
 * Shifting a whole category by N calendar days.
 *
 * Counted in calendar days rather than working ones, because the operation is defined in
 * them: the band is dragged along the scale, and the scale's division is a calendar day.
 * The real end dates will be recomputed by the server from the project's calendar.
 */
export function shiftCategory(
  state: ProjectState,
  categoryId: string,
  days: number,
): ProjectState {
  return {
    ...state,
    tasks: state.tasks.map((task) =>
      task.category_id === categoryId
        ? { ...task, start_date: addDays(task.start_date, days) }
        : task,
    ),
  };
}

/**
 * A category's name changes in place — the same way a task's name is edited: the row
 * must not jerk about until the server answers.
 */
export function renameCategory(state: ProjectState, categoryId: string, name: string): ProjectState {
  return {
    ...state,
    categories: state.categories.map((category) =>
      category.id === categoryId ? { ...category, name } : category,
    ),
  };
}

/**
 * A task disappears together with its links — exactly as the cascade will do on the
 * server. Leaving the links would not be caution but a mistake: there is nowhere to draw
 * arrows to a non-existent row, and until the server's answer the strip would flash with
 * them.
 */
export function deleteTask(state: ProjectState, taskId: string): ProjectState {
  return {
    ...state,
    tasks: state.tasks.filter((task) => task.id !== taskId),
    dependencies: state.dependencies.filter(
      (link) => link.from_task_id !== taskId && link.to_task_id !== taskId,
    ),
  };
}

/**
 * A category disappears together with its contents — exactly as the server will do: a
 * stage is cancelled whole, and a heading with no tasks under it would be a state that
 * does not occur. The deleted tasks' links go with them for the same reason as with a
 * single deletion: there is nowhere to draw arrows to a non-existent row.
 */
export function deleteCategory(state: ProjectState, categoryId: string): ProjectState {
  const gone = new Set(
    state.tasks.filter((task) => task.category_id === categoryId).map((task) => task.id),
  );
  return {
    ...state,
    categories: state.categories.filter((category) => category.id !== categoryId),
    tasks: state.tasks.filter((task) => task.category_id !== categoryId),
    dependencies: state.dependencies.filter(
      (link) => !gone.has(link.from_task_id) && !gone.has(link.to_task_id),
    ),
  };
}

/**
 * Links — without a cycle check: those are caught by the server, and a refusal will roll
 * the guess back. A duplicate link must be suppressed by the caller — the same caller
 * hides it from the list of candidates.
 */
export function addDependency(state: ProjectState, from: string, to: string): ProjectState {
  return {
    ...state,
    dependencies: [...state.dependencies, { from_task_id: from, to_task_id: to }],
  };
}

export function removeDependency(state: ProjectState, from: string, to: string): ProjectState {
  return {
    ...state,
    dependencies: state.dependencies.filter(
      (link) => !(link.from_task_id === from && link.to_task_id === to),
    ),
  };
}

/**
 * A row takes a new place — and the neighbours step aside.
 *
 * The positions are recomputed in full across both affected categories rather than only
 * for the row being moved: the server does exactly this, and an optimistic order
 * differing from the future answer would give a noticeable jump of rows on refresh.
 */
export function reorderTask(
  state: ProjectState,
  taskId: string,
  categoryId: string,
  position: number,
): ProjectState {
  const moved = state.tasks.find((task) => task.id === taskId);
  if (!moved) return state;

  const siblings = state.tasks
    .filter((task) => task.category_id === categoryId && task.id !== taskId)
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));

  // A position past the end of the list is not an error: a drop at the very bottom sends
  // an index equal to the length.
  const index = Math.min(position, siblings.length);
  const ordered = [...siblings.slice(0, index), moved, ...siblings.slice(index)];

  const places = new Map(ordered.map((task, slot) => [task.id, slot]));
  return {
    ...state,
    tasks: state.tasks.map((task) =>
      places.has(task.id)
        ? { ...task, category_id: categoryId, position: places.get(task.id)! }
        : task,
    ),
  };
}

/**
 * A category takes another place in the list of stages — and the neighbours step aside.
 *
 * The positions are recomputed in sequence across the whole list, as with tasks: the
 * server does exactly this, and an order differing from the future answer would give a
 * noticeable jump of stages on refresh. The tasks are not touched at all at that — they
 * have their own numbering inside their own category, and reordering the stages does not
 * affect it.
 */
export function reorderCategory(
  state: ProjectState,
  categoryId: string,
  position: number,
): ProjectState {
  const moved = state.categories.find((category) => category.id === categoryId);
  if (!moved) return state;

  const others = state.categories
    .filter((category) => category.id !== categoryId)
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));

  const index = Math.min(position, others.length);
  const ordered = [...others.slice(0, index), moved, ...others.slice(index)];

  const places = new Map(ordered.map((category, slot) => [category.id, slot]));
  return {
    ...state,
    categories: state.categories.map((category) => ({
      ...category,
      position: places.get(category.id) ?? category.position,
    })),
  };
}
