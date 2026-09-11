import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";

import type { Category } from "../api/projects";
import { useToast } from "../components/toast";
import { useLocale } from "../i18n/LocaleProvider";
import { shiftCategory } from "../project/optimistic";
import { useProjectMutation } from "../project/useProjectMutation";
import { edgeScroll } from "./edgeScroll";
import { addDays } from "./timescale";
import type { Scale } from "./timescale";

/**
 * Moving a whole category by its summary band.
 *
 * A whole stage travelling a week is an ordinary thing, and before this gesture
 * it meant dragging every bar in turn, landing each on the same day. Ten motions
 * instead of one, ten history entries and ten undos if you changed your mind.
 *
 * Hence one operation (`move_category`) and one entry: the person made one
 * motion. The shift is measured in days rather than as a target date — a category
 * has no bounds of its own, the summary band is drawn from its tasks' outermost
 * dates.
 *
 * The motion layer (`useBarMotion`) is deliberately absent here. It drives a bar's
 * travel after the server's answer by comparing places on neighbouring renders;
 * the summary band has nothing to travel — it is not a task but an outline around
 * them, and its place is recomputed from the very dates that are travelling at
 * that moment.
 */
export function useDragCategory({
  projectId,
  category,
  scale,
  enabled,
  spanEnd = null,
  onReach,
}: {
  projectId: string;
  category: Category;
  scale: Scale;
  /** There is nothing to move an empty category with: the server will refuse, and there is no band on the strip anyway. */
  enabled: boolean;
  /**
   * The summary band's end — the last of the stage's tasks' dates. The gesture
   * measures from it how far the whole stage has been dragged when the band is
   * held beyond the window's edge (see `onReach`). `null` — there is no band, but
   * then the gesture itself is off too.
   */
  spanEnd?: string | null;
  /**
   * The band is held so that the stage's end landed on this date beyond the
   * window's right edge — the strip extends the window up to it (see reach in
   * Gantt). A drop passes the committed end, a cancelled gesture passes `null`; a
   * gesture that never left the window does not call at all.
   */
  onReach?: (endISO: string | null) => void;
}) {
  const { apply } = useProjectMutation(projectId);
  const { t } = useLocale();
  const showToast = useToast();

  const span = useRef<HTMLElement | null>(null);
  const from = useRef<{
    pointerId: number;
    x: number;
    scroll: ReturnType<typeof edgeScroll>;
  } | null>(null);
  const lastX = useRef(0);
  // Whether the pointer moved during the gesture. The band's offset also counts
  // the strip's own travel (see `edgeScroll.scrolled`), and it can move under a
  // motionless finger — by the inertia of a scroll started right before the press.
  // Without this flag a press on the band would move the whole stage by everything
  // that coasted.
  const pointerMoved = useRef(false);
  // Whether the gesture reached beyond the window's edge — as with a task's bar: a
  // drop inside the window must not touch the extension even with an empty reset.
  const reached = useRef(false);
  const [dragging, setDragging] = useState(false);

  /** The band's offset under the finger — as a property written straight into the node, past React state. */
  const hold = (dx: number) => span.current?.style.setProperty("--span-dx", `${dx}px`);

  const stop = useCallback(() => {
    from.current?.scroll.stop();
    from.current = null;
    setDragging(false);
  }, []);

  const cancel = useCallback(() => {
    hold(0);
    stop();
    // The window extension is dropped together with the cancelled gesture — the
    // band has returned, and so does the grid that grew under it.
    if (reached.current) {
      reached.current = false;
      onReach?.(null);
    }
  }, [onReach, stop]);

  // Esc aborts a started move — as with a task's bar. The listener is on the
  // window: pointer capture holds mouse events but not keyboard ones.
  useEffect(() => {
    if (!dragging) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancel, dragging]);

  // The band disappeared mid-gesture while the row stayed: a colleague deleted the
  // stage's last task, and the band has no handlers any more — the release will
  // not reach it. The gesture is cleared here, otherwise the scroll frame would
  // spin until Esc.
  useEffect(() => {
    if (!enabled && from.current !== null) cancel();
  }, [enabled, cancel]);

  // The row disappeared mid-gesture — both the strip's edge-scroller and the
  // window extension have to be cleared: without a gesture it would hold the strip
  // stretched forever.
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

  const track = (clientX: number) => {
    const start = from.current;
    if (start === null) return;
    const dx = clientX - start.x + start.scroll.scrolled();
    hold(dx);
    // The stage's end under the finger has gone beyond the window — the strip will
    // stretch the grid up to it. The reckoning is the same as the drop's (see
    // `move`): whole days from the summary band, so the extended window always
    // covers what the drop will commit. Only dates past the current edge — for the
    // same reason as with a bar: the grid under the gesture must not shrink back.
    if (onReach && spanEnd !== null) {
      const end = addDays(spanEnd, Math.round(dx / scale.dayWidth));
      if (end > scale.to) {
        reached.current = true;
        onReach(end);
      }
    }
  };

  const move = (dx: number) => {
    // Rounded to a day rather than to a half: the band has no day of its own to
    // measure from the edge of. A shift of less than half a division is a trembling
    // hand, and it must not turn into a change.
    const days = Math.round(dx / scale.dayWidth);
    // The gesture that was stretching the window has ended — the window rests on
    // what the drop will commit. Not `null`: a reset to zero would shrink the
    // canvas before the guess reaches the cache, and the scroll would jump under
    // the hand (see the effect at reach in Gantt — it is what releases the date the
    // guess covered).
    const extended = reached.current;
    if (extended) {
      reached.current = false;
      onReach?.(days === 0 || spanEnd === null ? null : addDays(spanEnd, days));
    }
    if (days === 0) {
      hold(0);
      return;
    }
    void apply(
      { type: "move_category", category_id: category.id, days },
      (state) => shiftCategory(state, category.id, days),
    )
      .then(() =>
        showToast({
          message: t(days > 0 ? "gantt.category_moved_late" : "gantt.category_moved_early", {
            name: category.name,
            days: t("common.days", { count: Math.abs(days) }),
          }),
        }),
      )
      .catch(() => {
        // The rollback has already been done inside `apply`: the tasks returned to
        // their dates, and the band, computed from them, went back on its own. The
        // window extended for a drop beyond the edge is dropped here: without an
        // offset there is nothing to hold it with.
        if (extended) onReach?.(null);
      })
      .finally(() => {
        // The offset is cleared after the answer rather than before it: cleared at
        // once, it would return the band to its former place before the reason
        // question — that is, answer "it did not work" before being asked.
        hold(0);
      });
  };

  return {
    /** Whether the band is being dragged right now. */
    dragging,
    /** A reference to the band's node: the offset is written into it directly. */
    spanRef: useCallback((element: HTMLElement | null) => {
      span.current = element;
    }, []),
    handlers: enabled
      ? {
          onPointerDown(event: PointerEvent<HTMLElement>) {
            if (event.button !== 0) return;
            // The category's row is the drop target for reordering, and without
            // this a press on the band would start that as well.
            event.stopPropagation();
            event.preventDefault();
            // A previous gesture, if it somehow did not finish, is cleared here:
            // otherwise a frame and a subscription to the strip's scroll would be
            // left behind it.
            from.current?.scroll.stop();
            from.current = {
              pointerId: event.pointerId,
              x: event.clientX,
              scroll: edgeScroll(event.currentTarget, () => track(lastX.current)),
            };
            lastX.current = event.clientX;
            pointerMoved.current = false;
            setDragging(true);
            event.currentTarget.setPointerCapture?.(event.pointerId);
          },

          onPointerMove(event: PointerEvent<HTMLElement>) {
            const start = from.current;
            if (start === null || start.pointerId !== event.pointerId) return;
            event.stopPropagation();
            lastX.current = event.clientX;
            pointerMoved.current = true;
            start.scroll.track(event.clientX);
            track(event.clientX);
          },

          onPointerUp(event: PointerEvent<HTMLElement>) {
            const start = from.current;
            if (start === null || start.pointerId !== event.pointerId) return;
            event.stopPropagation();
            // A press without a single pointer movement is a click on the band
            // rather than a move of the stage: the strip's travel is not part of
            // its offset (see above).
            const dx = pointerMoved.current ? event.clientX - start.x + start.scroll.scrolled() : 0;
            stop();
            move(dx);
          },

          onPointerCancel() {
            cancel();
          },
        }
      : undefined,
  };
}
