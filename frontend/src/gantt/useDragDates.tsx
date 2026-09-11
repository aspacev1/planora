import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";

import { ApiError } from "../api/client";
import { errorKey } from "../api/errors";
import { projectQueryKey, undoLast } from "../api/projects";
import type { Calendar, Op, ProjectState, Task } from "../api/projects";
import { useToast } from "../components/toast";
import { formatShortDate } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";
import { patchProgress, patchTask } from "../project/optimistic";
import type { Optimistic } from "../project/useProjectMutation";
import { useAskShiftReason } from "../project/ShiftReason";
import { useProjectMutation } from "../project/useProjectMutation";
import { UndoMove } from "./UndoMove";
import { edgeScroll } from "./edgeScroll";
import { relativeDayLabel } from "./relative";
import { workingDaysBetween } from "./scale";
import { addDays, daysBetween } from "./timescale";
import type { BarMotion } from "./useBarMotion";
import type { Scale } from "./timescale";

/**
 * Gestures on the bar itself: moving it, its two edges and the progress fill.
 *
 * Pointer events rather than mouse events: pointer capture holds the gesture
 * even when the cursor leaves the edge of the strip — and it leaves constantly,
 * because people drag all the way to the end of the visible area and beyond.
 * Mouse events at that moment go to the element under the cursor, and the bar
 * freezes halfway. As a bonus, the same thing works with a finger on a tablet.
 *
 * The offset is converted into days through the scale rather than by dividing
 * by a day's width: the scale knows where a day ends, and it knows it in one
 * place.
 *
 * The gesture does not move the bar itself — it only names the offset, and
 * `useBarMotion` does the moving, writing it straight into the node. The offset
 * used to live in React state, and every pointer move repainted the whole row;
 * with a hundred tasks that is dozens of repaints per second for the sake of a
 * single number that never goes further than a style.
 *
 * A gesture in progress is aborted with Esc: changing your mind mid-drag is
 * ordinary, and the only way out otherwise would be to drag the bar back by
 * eye, i.e. to land exactly on the same day it was picked up from.
 *
 * ## Why four gestures in one place
 *
 * They have more in common than not: pointer capture, a couple-of-pixels
 * threshold, Esc to cancel, the strip scrolling at the edge, waiting for the
 * response where it was dropped, an undo toast. They differ in exactly two
 * things — what to compute from the offset and which operation to send — and
 * that is the only thing written separately for each of them here (see `PLAN`).
 */

/** What was grabbed: the bar's body, one of its edges or the fill boundary. */
export type BarGrip = "move" | "start" | "end" | "progress";

/** What the gesture computed from its offset: the operation and its optimistic guess. */
type Plan = {
  op: Op;
  optimistic: Optimistic;
  /** The toast's caption. Empty — no toast at all (the gesture changed nothing). */
  toast?: string;
};

/**
 * How differently the bar looks while it is being held.
 *
 * A move shifts it whole, the left edge moves the start and shortens it by the
 * same amount, the right edge changes only the width, the fill touches neither
 * — it has its own boundary (see `holdProgress`). One place instead of four
 * handlers with identical plumbing.
 */
function heldShape(grip: BarGrip, dx: number): { dx: number; dw: number } {
  if (grip === "move") return { dx, dw: 0 };
  if (grip === "start") return { dx, dw: -dx };
  if (grip === "end") return { dx: 0, dw: dx };
  return { dx: 0, dw: 0 };
}

/**
 * The progress boundary under the finger — as a property written straight into
 * the bar's node, just like the bar's own offset: the fill must follow the
 * finger without delay, and repainting the row for that means paying a render
 * for a single number.
 */
function holdProgress(bar: HTMLElement | undefined, dx: number) {
  bar?.style.setProperty("--progress-dx", `${dx}px`);
}

export function useDragDates({
  projectId,
  task,
  scale,
  calendar,
  enabled,
  motion,
  onReach,
}: {
  projectId: string;
  task: Task;
  scale: Scale;
  /**
   * The project's working calendar — the right edge uses it to convert the day
   * it was dragged to into a duration (see `workingDaysBetween`). As a prop and
   * not a query from the inside: the screen has already asked for the state,
   * and a second trip to the server just for the working-day mask would mean a
   * gesture that does not start until the network answers.
   */
  calendar: Calendar;
  /** A guest does not move the bar. */
  enabled: boolean;
  motion: BarMotion;
  /**
   * The gesture is holding the bar so that its end landed on this date beyond
   * the right edge of the window — the strip responds by extending the window
   * up to that date (see reach in Gantt). A drop passes the committed end here,
   * a cancelled gesture passes `null`; a gesture that never left the window
   * does not call at all.
   */
  onReach?: (endISO: string | null) => void;
}) {
  const { apply } = useProjectMutation(projectId);
  const { t } = useLocale();
  const showToast = useToast();
  const askReason = useAskShiftReason();
  const queryClient = useQueryClient();
  // The project's axis — from the cache, without a request: the screen holding
  // this strip has already asked for the state. A move toast must speak the
  // scale's language: "to Day 8", not a real date, which a relative plan has
  // none of.
  const relativeAxis =
    queryClient.getQueryData<ProjectState>(projectQueryKey(projectId))?.schedule_mode ===
    "relative";

  const from = useRef<{
    pointerId: number;
    x: number;
    bar: HTMLElement;
    grip: BarGrip;
    scroll: ReturnType<typeof edgeScroll>;
  } | null>(null);
  // The pointer's last point: the strip's edge-scroller recomputes the gesture
  // without new events — the finger is still, the strip moves — and it has
  // nowhere else to take the point from.
  const lastX = useRef(0);
  // Whether there was any movement. Lives in a ref, not in state: the value is
  // read in the click handler right after release, and no repaint is needed.
  const dragged = useRef(false);
  // Whether the pointer moved at all during this gesture — separately from the
  // couple-of-pixels threshold above.
  //
  // The gesture's offset also counts the strip's own travel (see
  // `edgeScroll.scrolled`), and the strip can move under a motionless finger:
  // the inertia of a scroll started right before the press keeps coasting after
  // it. Without this flag such a press would turn into a date move by the whole
  // coasted distance — instead of opening the card, which is what the bar was
  // pressed for.
  const pointerMoved = useRef(false);
  // Whether this gesture ever reached beyond the edge of the window. An
  // ordinary drop inside the window must not touch the extension at all — not
  // even with an empty reset: that is state foreign to it, and every extra
  // touch of it is an extra repaint of the strip.
  const reached = useRef(false);
  // Two states, because there are two questions, and they are answered at
  // different times.
  //
  // `started` — a finger is on the bar: from this moment the gesture can be
  // reconsidered, and the Esc listener is set up here. A ref will not do for it
  // — the listener is installed in an effect, and a ref would not wake it.
  //
  // `dragging` — the bar is actually being dragged: it rises above its
  // neighbours and changes the cursor. This is already past the
  // couple-of-pixels threshold, otherwise the bar's appearance would flicker
  // every time a card is opened. It stores exactly what was grabbed: the row
  // needs to show which gesture is running.
  //
  // The offset itself never reaches state in any form: the motion layer writes
  // it straight into the node.
  const [started, setStarted] = useState(false);
  const [dragging, setDragging] = useState<BarGrip | null>(null);

  /**
   * How far an edge can be dragged without collapsing the bar.
   *
   * A task is never shorter than one day, and an edge taken past the opposite
   * one would mean a negative duration. The stop is placed here and not at
   * submit time: the bar must stop shrinking under the finger exactly where
   * what will go to the server stops changing.
   */
  const clampGrip = (grip: BarGrip, dx: number): number => {
    const width = scale.widthOf(task.start_date, task.end_date);
    const limit = width - scale.dayWidth;
    if (grip === "start") return Math.min(dx, limit);
    if (grip === "end") return Math.max(dx, -limit);
    return dx;
  };

  /**
   * The day a strip coordinate landed in.
   *
   * Not `scale.dateAt`: that one clamps the coordinate to the window's right
   * edge, but the bar under the finger is not bounded by the right edge — the
   * window stretches after it (see `onReach`). A clamped drop would commit the
   * window's last day instead of the day the person saw under the bar: the
   * window ends right after the last task, and the toast would name an end of
   * week nobody was aiming at. The left edge is still clamped — there are no
   * days to the left of the axis's start.
   */
  const dayAt = (x: number): string =>
    addDays(scale.from, Math.max(0, Math.floor(x / scale.dayWidth)));

  /**
   * The bar's end at offset `dx` — with the same rounding as the future drop,
   * so a window extended to this date always covers the day the drop will
   * commit. `null` — this grip has no end: the left edge is pinned to the
   * task's end (see `clampGrip`), and the fill never leaves the bar.
   */
  const heldEndOf = (grip: BarGrip, dx: number): string | null => {
    if (grip === "move")
      return addDays(
        dayAt(scale.xOf(task.start_date) + dx + scale.dayWidth / 2),
        daysBetween(task.start_date, task.end_date),
      );
    if (grip === "end") return dayAt(scale.xOf(task.end_date) + dx + scale.dayWidth / 2);
    return null;
  };

  /**
   * What will go to the server if the gesture ends here.
   *
   * `null` — the gesture changed nothing: the bar was returned to the same day,
   * the edge to the same date, the fill to the same percentage. That is not
   * sent at all: a history entry would promise a change that never happened.
   */
  const planFor = (grip: BarGrip, dx: number): Plan | null => {
    if (grip === "progress") {
      const width = scale.widthOf(task.start_date, task.end_date);
      const filled = (width * task.progress_pct) / 100 + dx;
      const pct = progressStep(width === 0 ? 0 : (filled / width) * 100);
      if (pct === task.progress_pct) return null;
      return {
        op: { type: "set_progress", task_id: task.id, progress_pct: pct },
        optimistic: (state) => patchProgress(state, task.id, pct),
        toast: t("gantt.progress_set", { name: task.name, percent: pct }),
      };
    }

    if (grip === "move") {
      // Half a day is added so that the day changes in the middle of the cell
      // rather than at its edge: otherwise the bar jumps to a new day from a
      // one-pixel tremble of the hand.
      const start = dayAt(scale.xOf(task.start_date) + dx + scale.dayWidth / 2);
      if (start === task.start_date) return null;
      return {
        op: { type: "move_task", task_id: task.id, start_date: start },
        optimistic: (state) => patchTask(state, task.id, { start_date: start }),
        toast: t("gantt.moved", {
          date: relativeAxis ? relativeDayLabel(t, start) : formatShortDate(t, start),
        }),
      };
    }

    if (grip === "start") {
      const start = dayAt(scale.xOf(task.start_date) + dx + scale.dayWidth / 2);
      if (start === task.start_date) return null;
      // The end stays put — that is the whole point of the left edge — so the
      // duration is measured up to it. In working days, because that is how it
      // is defined; the guess is checked against the server's answer (see
      // `workingDaysBetween`).
      const duration = Math.max(1, workingDaysBetween(start, task.end_date, calendar));
      return {
        op: { type: "resize_task", task_id: task.id, start_date: start, duration_days: duration },
        optimistic: (state) =>
          patchTask(state, task.id, { start_date: start, duration_days: duration }),
        toast: t("gantt.resized", { name: task.name, days: t("common.days", { count: duration }) }),
      };
    }

    const end = dayAt(scale.xOf(task.end_date) + dx + scale.dayWidth / 2);
    if (end === task.end_date) return null;
    const duration = Math.max(1, workingDaysBetween(task.start_date, end, calendar));
    if (duration === task.duration_days) return null;
    return {
      op: { type: "set_duration", task_id: task.id, duration_days: duration },
      optimistic: (state) => patchTask(state, task.id, { duration_days: duration }),
      toast: t("gantt.resized", { name: task.name, days: t("common.days", { count: duration }) }),
    };
  };

  /**
   * Undo from the toast. What gets undone is exactly the change the toast talks
   * about: the server named its number while applying the operation, and the
   * same number goes back in `expected_seq`. "The project's last change" will
   * not do here — within the six seconds the toast hangs around, someone else's
   * change can become the last one.
   *
   * The path itself is the same as the "Undo" button in the history feed: undo
   * obeys the same explanation threshold as any other shift.
   */
  const undoChange = async (seq: number) => {
    try {
      try {
        await undoLast(projectId, { seq });
      } catch (refusal) {
        if (!(refusal instanceof ApiError) || refusal.code !== "reason_required" || !askReason) {
          throw refusal;
        }
        // The numbers come from the server's hints: the tab does not know which
        // dates the inverse operation will lead to.
        const reason = await askReason({
          taskName: task.name,
          deviationDays: refusal.hints.deviationDays ?? 0,
          thresholdDays: refusal.hints.thresholdDays ?? 0,
        });
        if (reason === null) return;
        await undoLast(projectId, { seq, reason });
      }
      await queryClient.invalidateQueries({ queryKey: projectQueryKey(projectId) });
    } catch (error) {
      // A refused undo is shown in the same place the offer to undo was: the
      // person is looking at the toast, not at the project header.
      showToast({ message: t(errorKey(error)), tone: "error" });
    }
  };

  /**
   * Abort a started gesture without sending anything.
   *
   * The bar returns where it was dragged from: while the gesture runs it has
   * not changed any dates — only the release changes them. The return is
   * instant rather than animated: Esc cancels the gesture instead of carrying
   * it through, and the bar has nowhere to travel from — its place by dates has
   * not changed this whole time, only the offset has.
   */
  const cancel = useCallback(() => {
    const start = from.current;
    from.current = null;
    start?.scroll.stop();
    holdProgress(start?.bar, 0);
    motion.hold(0, 0);
    motion.release();
    setStarted(false);
    setDragging(null);
    // The window extension is dropped together with the gesture: Esc returns
    // both the bar and the grid that grew under it. The return is instant for
    // the same reason as the bar's above.
    if (reached.current) {
      reached.current = false;
      onReach?.(null);
    }
    // The capture is released by hand: otherwise the bar keeps receiving
    // pointer events until the end of the gesture, and the release would arrive
    // at a drag that has already been aborted.
    if (start && start.bar.hasPointerCapture?.(start.pointerId)) {
      start.bar.releasePointerCapture?.(start.pointerId);
    }
    // The click the browser will send right after the release is swallowed by
    // the same flag as after an ordinary drag: Esc means "do nothing", not
    // "open the card". But the click only arrives when the button was released
    // over the same bar; released to the side, it sends no click, and the flag
    // would outlive the gesture — and would eat the next Enter on the bar. So
    // it is cleared right after release: the click, if there is to be one, has
    // arrived and been swallowed by then.
    dragged.current = true;
    window.addEventListener(
      "pointerup",
      () => {
        setTimeout(() => {
          dragged.current = false;
        }, 0);
      },
      { once: true },
    );
    // Apart from the motion layer and `onReach` there are no live dependencies:
    // inside there are only refs and state functions. Both references are
    // constant (the motion layer never changes its own, `onReach` is memoized
    // in Gantt), and that matters to the effect below — otherwise it would
    // resubscribe on every render.
  }, [motion, onReach]);

  // Esc aborts a started drag — as everywhere a gesture can be begun and
  // reconsidered. The listener is on the window rather than on the bar: pointer
  // capture holds mouse events but not keyboard ones, and the focus during a
  // gesture can end up anywhere — on the bar, if the browser gave it to the
  // press, and on the document body if it did not.
  useEffect(() => {
    if (!started) return;
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancel, started]);

  // The strip's edge-scroller lives exactly as long as the gesture, but it also
  // has to be stopped when the row disappears in the middle of one: a colleague
  // deleted the task, the strip collapsed the category. A frame left without a
  // node would spin forever — and a window extension left without a gesture
  // would hold the strip stretched forever.
  useEffect(
    () => () => {
      if (from.current === null) return;
      from.current.scroll.stop();
      if (reached.current) onReach?.(null);
    },
    // `onReach` is memoized in Gantt — the effect stays an effect of a single
    // unmount rather than of resubscription.
    [onReach],
  );

  /**
   * @param hold Whether to hold the bar where it was dropped while the change
   *   is in flight. That is what dragging does: the bar was released under the
   *   finger, and until the decision its place is there. The keyboard holds
   *   nothing — there the bar never moved, and one that travelled before the
   *   reason question was answered would mean a shift that has not happened
   *   yet.
   *
   *   The motion layer does the holding itself: the offset is already written
   *   into the node, and "wait" here means not clearing it until the answer.
   *   A second state with the same date would count that offset a second time —
   *   and for one frame the bar would travel twice as far.
   */
  const commit = (plan: Plan | null, hold = false, onRefused?: () => void) => {
    // A gesture that returned the bar to its place is not a change and must not
    // leave a history entry.
    if (plan === null) {
      if (hold) motion.settle();
      onRefused?.();
      return;
    }
    apply(plan.op, plan.optimistic)
      .then(
        (revision) => {
          // The undo toast comes after the server's confirmation, as in the
          // mockup: the change applies immediately, and an easy way back lies
          // close at hand. The revision number comes from the server's
          // response: it is what makes the button a promise to revert exactly
          // this step, and not "whatever is on top of the journal right now".
          if (plan.toast === undefined) return;
          showToast({
            message: plan.toast,
            action: (
              <UndoMove
                projectId={projectId}
                seq={revision.seq}
                onUndo={() => void undoChange(revision.seq)}
              />
            ),
          });
        },
        () => {
          // The rollback has already been done inside `apply`, and the bar
          // returns where it was dragged from when the capture is released
          // below. That is the refusal message: there is no other place for it
          // on the strip, and a modal on top of the chart would interrupt work
          // where the person has already seen everything. The refusal, at that,
          // always arrives after the person's decision rather than before it —
          // and the movement back reads as an answer to their gesture rather
          // than as a refusal of a question not yet asked.
          //
          // The strip's window returns along with the bar: the grid extended
          // for a drop beyond the edge rests on nothing without it (see
          // onPointerUp).
          onRefused?.();
        },
      )
      .finally(() => {
        // The change is decided — the offset can be cleared. A confirmed one
        // has already been cleared by the layout layer: the new `left` and
        // `width` arrived with the dates, and `settle` will see zero. A refused
        // one is cleared here, and the bar travels back — after the answer, not
        // before it.
        if (hold) motion.settle();
      });
  };

  /** Shared handling of pointer movement: both by hand and from the strip moving on its own. */
  const track = (clientX: number) => {
    const start = from.current;
    if (start === null) return;
    // The addition for the strip's travel: under a motionless finger the day
    // changes precisely because the strip is moving, and without this term the
    // bar would lag behind it by exactly the distance covered.
    const dx = clampGrip(start.grip, clientX - start.x + start.scroll.scrolled());
    // A couple-of-pixels threshold: a trembling hand during a click must not
    // turn the click into a drag and close the card the person was just
    // opening.
    if (Math.abs(dx) > 2 && !dragged.current) {
      dragged.current = true;
      setDragging(start.grip);
    }
    if (start.grip === "progress") {
      holdProgress(start.bar, dx);
      return;
    }
    const shape = heldShape(start.grip, dx);
    motion.hold(shape.dx, shape.dw);
    // The bar's end under the finger has gone beyond the window — the strip
    // will stretch the grid up to it. It is computed with the same rounding as
    // the future drop, so the extended window always covers the day the drop
    // will commit. Only the body and the right edge can move beyond the window:
    // the left one is pinned to the end (see clampGrip), and the fill never
    // leaves the bar at all.
    if (onReach) {
      const end = heldEndOf(start.grip, dx);
      // Only dates past the current edge: reporting a day inside the window
      // would extend nothing, while reporting a day beyond the edge always
      // grows the window — which is why the grid under the gesture does not
      // shrink back while the bar is dragged to and fro.
      if (end !== null && end > scale.to) {
        reached.current = true;
        onReach(end);
      }
    }
  };

  /** Handlers for any of the grips: the bar's body, its edges and the fill. */
  const gripHandlers = (grip: BarGrip) => ({
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (!enabled || event.button !== 0) return;
      if (grip !== "move") {
        // The edge is inside the bar, and without this a press on it would
        // reach the bar too: the gesture would start twice, and the second
        // would overwrite the first.
        event.stopPropagation();
        // A grip is not a button but a `span` inside the bar, and the browser
        // treats a press on it as the start of a text selection: live testing
        // showed a gesture that highlighted neighbouring task names instead of
        // stretching the bar. The bar itself (`move`) neither needs this nor
        // benefits from it — it is a button, and preventing the default would
        // rob it of focus on click.
        event.preventDefault();
      }
      const bar = event.currentTarget.closest<HTMLElement>(".gantt__bar") ?? event.currentTarget;
      // A previous gesture, if it somehow did not finish (a second finger on a
      // tablet, a release that never reached the bar), is cleared here:
      // otherwise a frame and a subscription to the strip's scroll would be
      // left behind it.
      from.current?.scroll.stop();
      from.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        bar,
        grip,
        scroll: edgeScroll(bar, () => track(lastX.current)),
      };
      lastX.current = event.clientX;
      dragged.current = false;
      pointerMoved.current = false;
      reached.current = false;
      // The gesture has begun — from this moment it can be reconsidered with
      // Esc. The bar's appearance does not change: a click starts exactly the
      // same way, and the rise above its neighbours would flicker every time a
      // card is opened.
      setStarted(true);
      // jsdom does not know this method, and a browser will refuse it on a
      // stale pointer too. Capture is an improvement on the gesture, not a
      // condition of it.
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },

    onPointerMove(event: PointerEvent<HTMLElement>) {
      const start = from.current;
      if (start === null || start.pointerId !== event.pointerId) return;
      lastX.current = event.clientX;
      pointerMoved.current = true;
      start.scroll.track(event.clientX);
      track(event.clientX);
    },

    onPointerUp(event: PointerEvent<HTMLElement>) {
      const start = from.current;
      if (start === null || start.pointerId !== event.pointerId) return;
      from.current = null;
      start.scroll.stop();
      setStarted(false);
      setDragging(null);
      // A press during which the pointer never moved is a click on the bar, and
      // it has no offset at all. It cannot be computed by the general formula:
      // that one includes the strip's travel, and the strip travels without the
      // finger's help too (see `pointerMoved`).
      const dx = pointerMoved.current
        ? clampGrip(start.grip, event.clientX - start.x + start.scroll.scrolled())
        : 0;

      if (start.grip === "progress") {
        // The fill does not wait for an answer: the guess about the percentage
        // is the whole future answer, without the calendar arithmetic the
        // server does. The boundary is cleared before sending, because the
        // optimistic truth lands in the cache synchronously inside `commit`,
        // and holding a pixel offset on top of it would count it twice.
        holdProgress(start.bar, 0);
        commit(planFor(start.grip, dx));
        return;
      }

      // The bar waits exactly where it was released — `settle` will clear the
      // offset once the change is decided, and it will travel to its day with
      // the answer in hand. Cleared right now, it would return the bar to its
      // place before the reason question — that is, answer "it did not work"
      // before being asked.
      motion.release(true);
      const plan = planFor(start.grip, dx);
      // The gesture that was stretching the window has ended — now the window
      // rests exactly on what the drop committed. Not `null`: a reset to zero
      // would shrink the canvas a moment before the guess reaches the cache
      // (React Query sends its notification as a microtask), and the scroll
      // would jump under the hand. The date the guess covered is released by
      // the strip itself (see the effect at reach in Gantt); a gesture that
      // brought the bar back inside the window releases the extension itself.
      const extended = reached.current;
      if (extended) {
        reached.current = false;
        onReach?.(heldEndOf(start.grip, dx) ?? null);
      }
      // A server refusal or a closed reason dialog returns the bar — and the
      // window extended for it is dropped by the same answer: otherwise the
      // strip would stay stretched over a month of empty grid nobody asked for.
      commit(plan, true, extended ? () => onReach?.(null) : undefined);
    },

    onPointerCancel() {
      cancel();
    },

    onClickCapture(event: MouseEvent<HTMLElement>) {
      // After the button is released the browser sends a click on the same bar.
      // Without this interception every drag would end with a card being opened
      // — and a person who moved ten tasks would be closing ten cards.
      if (!dragged.current) return;
      dragged.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  });

  return {
    /** Which gesture is running right now; `null` — none. */
    dragging,
    /** The bar's body: moving both dates at once. */
    handlers: {
      ...gripHandlers("move"),

      onKeyDown(event: KeyboardEvent<HTMLElement>) {
        // The bar is declared a button, and a person working from the keyboard
        // must have a way to do everything the pointer can. The arrows are
        // under modifiers, and the bare ones are left to the strip's scroll:
        // without that you could not simply look at what is to the right
        // without shifting dates in the process.
        //
        //   Shift        — move the task (both dates)
        //   Alt          — stretch the end (duration)
        //   Shift + Alt  — move the start, the end stays put
        //
        // Three combinations instead of one — because the bar now has three
        // gestures, and "the same thing is in the card" stops being an answer
        // when the pointer does it in one motion while the keyboard needs
        // opening the card, finding the field and coming back.
        //
        // The combinations are spelled out in two places — in the bar's
        // `aria-keyshortcuts` and in the hint line of the hover card (Row,
        // BarTip): a capability only the source knows about might as well not
        // exist.
        if (!enabled) return;
        const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (step === 0) return;

        if (!event.shiftKey && !event.altKey) return;
        // Alt + arrow is taken by the browser for history navigation.
        // Preventing the default here is mandatory, otherwise the combination
        // takes you off the page — and that goes for a milestone too: Alt+← on
        // it stretches nothing, but it must not take the person to the previous
        // page either.
        event.preventDefault();
        // A milestone has no duration: its edges are not draggable, by pointer
        // or by keyboard. Moving it is still allowed.
        const resizes = event.altKey && !task.milestone;
        if (!event.shiftKey && !resizes) return;

        if (resizes && event.shiftKey) {
          // The left edge: the start travels, the end stays put, so the
          // duration grows by exactly as much as the start moved.
          const start = addDays(task.start_date, step);
          const duration = Math.max(1, workingDaysBetween(start, task.end_date, calendar));
          commit({
            op: {
              type: "resize_task",
              task_id: task.id,
              start_date: start,
              duration_days: duration,
            },
            optimistic: (state) =>
              patchTask(state, task.id, { start_date: start, duration_days: duration }),
            toast: t("gantt.resized", {
              name: task.name,
              days: t("common.days", { count: duration }),
            }),
          });
          return;
        }

        if (resizes) {
          // The right edge: the step here is counted directly in working days —
          // that is the unit of duration, and there is no point converting it
          // through a date.
          const duration = task.duration_days + step;
          if (duration < 1) return;
          commit({
            op: { type: "set_duration", task_id: task.id, duration_days: duration },
            optimistic: (state) => patchTask(state, task.id, { duration_days: duration }),
            toast: t("gantt.resized", {
              name: task.name,
              days: t("common.days", { count: duration }),
            }),
          });
          return;
        }

        const start = addDays(task.start_date, step);
        commit({
          op: { type: "move_task", task_id: task.id, start_date: start },
          optimistic: (state) => patchTask(state, task.id, { start_date: start }),
          toast: t("gantt.moved", {
            date: relativeAxis ? relativeDayLabel(t, start) : formatShortDate(t, start),
          }),
        });
      },
    },
    /**
     * An edge or fill grip. As separate nodes on top of the bar rather than
     * zones inside a single handler: each has its own cursor and its own
     * tooltip, and with zones that would have to be resolved at press time,
     * when the cursor has already shown one thing.
     */
    gripHandlers,
  };
}

/**
 * The percentage the fill was dragged to — rounded to the nearest five.
 *
 * Not to the nearest one: at the month scale a day takes eighteen pixels, and
 * hitting 37% there is impossible even on purpose — it comes out as a lottery
 * between neighbouring values. Five is the step a person names out loud ("about
 * seventy percent"), and it is also the one that lands on the bar's tick marks
 * by eye. A round 0 and 100 are reachable by an ordinary motion to the edge
 * rather than only by a precise hit.
 */
function progressStep(pct: number): number {
  return Math.min(100, Math.max(0, Math.round(pct / 5) * 5));
}
