import { createContext, useCallback, useContext, useState } from "react";
import type { ReactNode } from "react";

import type { ProjectState, Task } from "../api/projects";
import { addDays, daysBetween } from "../gantt/timescale";
import { useLocale } from "../i18n/LocaleProvider";
import { patchTask } from "./optimistic";
import { isShiftCancelled } from "./ShiftReason";
import { useProjectMutation } from "./useProjectMutation";

/**
 * What the system does with links when auto-shifting is off.
 *
 * Then the dates are not recomputed along links: a link is an arrow in a picture, not a
 * calculation rule. But staying silent when a task has travelled onto its predecessor will
 * not do either: the arrow will be drawn askew, and the person will only learn about it if
 * they look in exactly that spot.
 *
 * Hence a nudge rather than an action. A refusal breaks nothing — the arrow is simply drawn
 * askew, as it would have been.
 *
 * With auto-shifting on (`auto_schedule`) there is no nudge at all: the server has already
 * moved the successors, and offering to do what is done would mean showing a button that
 * changes nothing.
 */

type Notice = (taskId: string) => void;

const MovedTaskContext = createContext<{ moved: string | null; note: Notice } | null>(null);

export function DependencyNudgeProvider({ children }: { children: ReactNode }) {
  const [moved, setMoved] = useState<string | null>(null);
  // One and the same call on every shift: the nudge is shown about the last moved task rather
  // than accumulating as a list. An accumulating list of nudges is already notifications,
  // which have to be worked through.
  const note = useCallback<Notice>((taskId) => setMoved(taskId), []);
  const dismiss = useCallback(() => setMoved(null), []);

  return (
    <MovedTaskContext.Provider value={{ moved, note }}>
      <DismissContext.Provider value={dismiss}>{children}</DismissContext.Provider>
    </MovedTaskContext.Provider>
  );
}

const DismissContext = createContext<() => void>(() => {});

/**
 * The "this task was just moved" marker.
 *
 * Outside the provider it returns `null`: the chart is also drawn where there is nothing to
 * move — on the public page, for example.
 */
export function useNoteMovedTask(): Notice | null {
  return useContext(MovedTaskContext)?.note ?? null;
}

/**
 * How far to move a successor so that it starts after its predecessor. Greater than zero —
 * the link is violated; zero and less — slack.
 *
 * One rule for everyone who looks at links: the nudge here, the sign on the strip's arrow
 * (see Arrows) and the marker in the task's card. Written anew in each place, it would
 * diverge on the stretch's inclusive end — coinciding dates are an overlap too, and the "+1"
 * here is about exactly that.
 */
export function overlapDays(predecessor: Task, successor: Task): number {
  // It starts earlier than the predecessor's end — which means the work would begin before
  // what it depends on has finished. Exactly the day after the end is already fine.
  return daysBetween(successor.start_date, predecessor.end_date) + 1;
}

export function DependencyNudge({
  projectId,
  state,
}: {
  projectId: string;
  state: ProjectState;
}) {
  const { t } = useLocale();
  const { apply } = useProjectMutation(projectId);
  const moved = useContext(MovedTaskContext)?.moved ?? null;
  const dismiss = useContext(DismissContext);

  // With auto-shifting on there is nothing to offer: the successors have already travelled,
  // and offering to do what is done reads as a glitch — the person presses "Move", nothing
  // happens, and the button is the one that looks guilty.
  if (state.auto_schedule === true) return null;

  const shifted = state.tasks.find((task) => task.id === moved);
  if (!shifted) return null;

  // On both sides of the moved task's links. It is a predecessor — it may have run into its
  // successors, and it is they who are offered to be moved. It is a successor — it was itself
  // put before its predecessor's end, and the nudge concerns the task itself: this half used
  // to stay silent, and a person would put a task across a link and learn about it only from
  // a slanted arrow.
  const followers = state.dependencies
    .filter((edge) => edge.from_task_id === shifted.id)
    .map((edge) => state.tasks.find((task) => task.id === edge.to_task_id))
    .filter((task): task is Task => task !== undefined)
    .map((task) => ({ task, days: overlapDays(shifted, task) }))
    .filter((item) => item.days > 0);

  // The largest of the overlaps: there can be several predecessors while there is one button
  // — a shift after which the task clears all of them at once.
  const behind = state.dependencies
    .filter((edge) => edge.to_task_id === shifted.id)
    .map((edge) => state.tasks.find((task) => task.id === edge.from_task_id))
    .filter((task): task is Task => task !== undefined)
    .reduce((worst, pred) => Math.max(worst, overlapDays(pred, shifted)), 0);

  const affected = behind > 0 ? [...followers, { task: shifted, days: behind }] : followers;

  if (affected.length === 0) return null;

  const move = (task: Task, days: number) => {
    const start_date = addDays(task.start_date, days);
    apply({ type: "move_task", task_id: task.id, start_date }, (current) =>
      patchTask(current, task.id, { start_date }),
    )
      .then(dismiss)
      .catch((refusal: unknown) => {
        // Refusing to explain a shift is not an error: the nudge simply stays where it is, and
        // the person is free to accept it later or not at all.
        if (!isShiftCancelled(refusal)) dismiss();
      });
  };

  return (
    <div className="nudge" role="status">
      {affected.map(({ task, days }) => (
        <button key={task.id} type="button" className="button--quiet" onClick={() => move(task, days)}>
          {/* The task's name is user content: it is not translated. */}
          {t("gantt.nudge", { name: task.name, days: t("common.days", { count: days }) })}
        </button>
      ))}
      <button
        type="button"
        className="button--quiet nudge__dismiss"
        aria-label={t("gantt.nudge_dismiss")}
        title={t("gantt.nudge_dismiss")}
        onClick={dismiss}
      >
        ×
      </button>
    </div>
  );
}
