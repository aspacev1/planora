import { useRef, useState } from "react";

import { errorKey } from "../api/errors";
import type { ProjectState } from "../api/projects";
import { useToast } from "../components/toast";
import { useLocale } from "../i18n/LocaleProvider";
import { useProjectMutation } from "../project/useProjectMutation";
import { RELATIVE_EPOCH } from "./relative";
import { useToday } from "../time/useToday";

/**
 * A task created from a name alone.
 *
 * It already has everything else: a day, a duration of one working day and the "planned"
 * status. This is not a shortened set of fields but a separation of questions: "what needs
 * doing" is asked when a plan is written as a list, while "when and by whom" is asked when it
 * is laid out in time, and the second is done in the task's card and by dragging the bar.
 *
 * Sent tasks are held in a pending list until the server answers. Creation cannot have an
 * optimistic row — why is said at `PendingRow`.
 */

export type PendingTask = { id: number; categoryId: string; name: string };

/**
 * The day a new task lands on: today — or its own stage's start, if the stage is still ahead.
 *
 * Not simply "today". Plans are written in advance: a stage that will begin in October is
 * filled in in August, and every created task would travel two months to the left of its own
 * stage, stretching the strip with emptiness up to today — that is, it would land outside the
 * visible window and demand moving immediately. Both bounds are lower ones, so the greater is
 * taken: for a stage under way today wins (a task created today did not start yesterday), for
 * a future one its start.
 *
 * A plan without dates has no today at all, and the lower bound there is the project's first
 * day: there are no real dates on this axis, while a coordinate is needed. An empty stage
 * leads nowhere: it has no start, and one bound is left.
 */
export function startDayFor(state: ProjectState, categoryId: string, today: string): string {
  const floor = state.schedule_mode === "relative" ? RELATIVE_EPOCH : today;
  const phase = state.tasks
    .filter((task) => task.category_id === categoryId)
    .reduce<string | null>(
      (earliest, task) =>
        earliest === null || task.start_date < earliest ? task.start_date : earliest,
      null,
    );
  return phase !== null && phase > floor ? phase : floor;
}

export function useQuickTask({ projectId, state }: { projectId: string; state: ProjectState }) {
  const { apply } = useProjectMutation(projectId);
  const { t } = useLocale();
  const showToast = useToast();
  const today = useToday(state.settings?.timezone);
  const [pending, setPending] = useState<PendingTask[]>([]);
  // The submission's number. The number specifically, not the name: two tasks with the same
  // name in one category are an ordinary thing ("call", "call"), and the answer to the first
  // would remove both from the pending list.
  const sent = useRef(0);

  /**
   * `position` is the row number it is put at. Not named — the task goes to the end of the
   * category, as before; named — to its own place, and the neighbours below move by one (see
   * `_make_room` on the server).
   */
  const create = (categoryId: string, name: string, position?: number) => {
    sent.current += 1;
    const id = sent.current;
    setPending((rows) => [...rows, { id, categoryId, name }]);

    void apply(
      {
        type: "create_task",
        category_id: categoryId,
        name,
        start_date: startDayFor(state, categoryId, today),
        duration_days: 1,
        // There is no key at all when no place was named: the server tells "to the end" from a
        // named number, and the former is the absence of a key rather than a key with a value.
        ...(position === undefined ? {} : { position }),
      },
      // There is no guess — there is a pending row next to it. `apply` is still the only road
      // for a change: it is what locks editing on a dropped connection and it is what refetches
      // the state the task is already in.
      (current) => current,
    )
      .catch((error: unknown) => {
        // The pending row will disappear while the task never appears: without these words the
        // disappearance would read as "it was saved somewhere".
        showToast({ message: t(errorKey(error)), tone: "error" });
      })
      .finally(() => {
        // Only after the answer: `apply` waits for the state refetch, and by that moment the
        // real row is already on screen. A pending row removed earlier would flash emptiness in
        // the task's place.
        setPending((rows) => rows.filter((row) => row.id !== id));
      });
  };

  return {
    create,
    /** This category's tasks that have been sent but not yet confirmed. */
    pendingIn: (categoryId: string): PendingTask[] =>
      pending.filter((row) => row.categoryId === categoryId),
  };
}
