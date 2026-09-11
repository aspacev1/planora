import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent, RefCallback } from "react";

import { errorKey } from "../api/errors";
import type { ProjectState } from "../api/projects";
import { useToast } from "../components/toast";
import { useLocale } from "../i18n/LocaleProvider";
import { addDependency } from "../project/optimistic";
import { useProjectMutation } from "../project/useProjectMutation";
import { edgeScroll } from "./edgeScroll";

/**
 * A link dragged from bar to bar.
 *
 * Before this, links were created only as a list in a task's card: open the card,
 * find the right task in a dropdown of fifty, pick it. The list stays — from the
 * keyboard and on a narrow screen it is the only way — but the main gesture is now
 * the same one links are drawn with on paper: from one bar's end to another's start.
 *
 * Which circle was grabbed decides the direction: the right one (`end`) means the
 * grabbed task blocks the one it was dropped on; the left one (`start`) means the
 * opposite, the one it was dropped on blocks the grabbed one. Otherwise a link could
 * only be dragged in one direction, and half the dependencies would have to be
 * created starting from the end.
 *
 * ## Why all of this bypasses React state
 *
 * The line under the finger and the target highlight change on every pointer
 * movement. React state would repaint the whole strip for them — a hundred rows per
 * event. So the line is written straight into its node's attributes and the
 * highlight is a class on the found row; what goes into state is one "a gesture is
 * running" flag, and it changes twice per gesture.
 */

/** Which circle was grabbed: the bar's end or its start. */
export type LinkSide = "start" | "end";

/** The class of the row a link will be dropped on. Set and removed by hand. */
const TARGET_CLASS = "is-link-target";

export function useLinkDrag({
  projectId,
  state,
  canWrite,
}: {
  projectId: string;
  state: ProjectState;
  canWrite: boolean;
}) {
  const { apply } = useProjectMutation(projectId);
  const { t } = useLocale();
  const showToast = useToast();

  const layer = useRef<SVGSVGElement | null>(null);
  const line = useRef<SVGLineElement | null>(null);
  const hovered = useRef<HTMLElement | null>(null);
  const from = useRef<{
    pointerId: number;
    taskId: string;
    side: LinkSide;
    scroll: ReturnType<typeof edgeScroll>;
  } | null>(null);
  const lastPoint = useRef({ x: 0, y: 0 });
  const [active, setActive] = useState(false);

  /** A point in the link layer's coordinates: the line lives inside it, the pointer in the window. */
  const localPoint = (clientX: number, clientY: number) => {
    const box = layer.current?.getBoundingClientRect();
    return box ? { x: clientX - box.left, y: clientY - box.top } : { x: 0, y: 0 };
  };

  const markTarget = (element: HTMLElement | null) => {
    if (hovered.current === element) return;
    hovered.current?.classList.remove(TARGET_CLASS);
    element?.classList.add(TARGET_CLASS);
    hovered.current = element;
  };

  /**
   * The row under the pointer — by the point's coordinates, not by the event's target.
   *
   * The reason is the same as with row reordering: with a finger, after the press the
   * pointer is captured by the circle the gesture started on, and the rows under the
   * finger get no events at all (see `targetAt` in useReorder).
   */
  const rowAt = (clientX: number, clientY: number): HTMLElement | null => {
    const under = document.elementFromPoint?.(clientX, clientY) ?? null;
    const row = under?.closest<HTMLElement>('[data-drop-kind="task"]') ?? null;
    // Its own row is not highlighted as a target: the server will refuse a task's link
    // to itself, and there is no point promising it with a circle.
    return row?.dataset.dropId === from.current?.taskId ? null : row;
  };

  const track = (clientX: number, clientY: number) => {
    if (from.current === null) return;
    lastPoint.current = { x: clientX, y: clientY };
    const point = localPoint(clientX, clientY);
    line.current?.setAttribute("x2", String(point.x));
    line.current?.setAttribute("y2", String(point.y));
    markTarget(rowAt(clientX, clientY));
  };

  // A constant reference is needed by the effect below: otherwise it would resubscribe
  // on every render. Everything `finish` touches lives in refs and in a state function
  // — things whose reference does not change between renders — which is why the
  // dependency list is empty.
  const finish = useCallback(() => {
    from.current?.scroll.stop();
    from.current = null;
    hovered.current?.classList.remove(TARGET_CLASS);
    hovered.current = null;
    setActive(false);
  }, []);

  // The button can be released away from the rows too — beyond the strip's edge, over
  // the header, outside the window entirely. Without this listener the link would stay
  // "in hand" forever, and the line would trail after the cursor with nothing pressed.
  useEffect(() => {
    if (!active) return;
    const abandon = () => finish();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      // Esc aborts the gesture — as everywhere it can be begun and reconsidered.
      if (event.key !== "Escape") return;
      event.preventDefault();
      finish();
    };
    // The release is listened for on the window too, not only on the circle: the circle
    // holds the pointer capture, but the node with the capture can disappear mid-gesture
    // — a colleague deleted the task, and the row went with the circle. The release then
    // goes to the window, and without this listener the link would stay "in hand": the
    // line on screen, and the scroll frame spinning until the next press. On the circle
    // its own release fires earlier and clears the gesture — there is then nothing left
    // to do here.
    window.addEventListener("pointerup", abandon);
    window.addEventListener("pointercancel", abandon);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerup", abandon);
      window.removeEventListener("pointercancel", abandon);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [active, finish]);

  // The strip left mid-gesture — the scroll frame and the target highlight have to be
  // cleared by hand: an unmounted node sends nothing to the circle's handlers.
  useEffect(
    () => () => {
      from.current?.scroll.stop();
      from.current = null;
      hovered.current?.classList.remove(TARGET_CLASS);
      hovered.current = null;
    },
    [],
  );

  const link = (sourceId: string, side: LinkSide, targetId: string) => {
    // The right circle is dragged as "this task blocks that one", the left one as "this
    // one is blocked by that". The direction is decided by the circle, not by the click order.
    const fromId = side === "end" ? sourceId : targetId;
    const toId = side === "end" ? targetId : sourceId;
    if (fromId === toId) return;
    // A duplicate link is suppressed by the caller rather than by the server: a refusal
    // would be honest, but a person who dragged the same arrow twice has made no mistake
    // — there is simply nothing to show them.
    const exists = state.dependencies.some(
      (dep) => dep.from_task_id === fromId && dep.to_task_id === toId,
    );
    if (exists) return;

    void apply({ type: "add_dependency", from_task_id: fromId, to_task_id: toId }, (current) =>
      addDependency(current, fromId, toId),
    ).catch((error) => {
      // A cycle is the only refusal a person could not foresee: they see two bars rather
      // than the whole graph. The rollback has already been done inside `apply`, the
      // arrow has disappeared, and without these words the disappearance would read as a
      // glitch.
      showToast({ message: t(errorKey(error)), tone: "error" });
    });
  };

  return {
    /** Whether to show the link circles. A guest has none at all. */
    enabled: canWrite,
    /** Whether a link is being dragged right now: the strip raises the circles on every bar. */
    active,

    /**
     * A reference to the line's layer. Handed to the markup, while the line itself lives
     * on past React: its ends change on every pointer movement.
     */
    layerRef: useCallback<RefCallback<SVGSVGElement>>((element) => {
      layer.current = element;
    }, []),
    lineRef: useCallback<RefCallback<SVGLineElement>>((element) => {
      line.current = element;
    }, []),

    /** The circle at a bar's edge. The gesture is both started and led with it — like a row's handle. */
    handleProps(taskId: string, side: LinkSide) {
      return {
        onPointerDown(event: PointerEvent<SVGElement | HTMLElement>) {
          if (!canWrite || event.button !== 0) return;
          // Otherwise the press reaches the bar under the circle and starts a date move.
          event.preventDefault();
          event.stopPropagation();
          const node = event.currentTarget as unknown as HTMLElement;
          // A previous gesture, if it somehow did not finish, is cleared here: otherwise a
          // frame and a subscription to the strip's scroll would be left behind it.
          from.current?.scroll.stop();
          from.current = {
            pointerId: event.pointerId,
            taskId,
            side,
            scroll: edgeScroll(node, () => track(lastPoint.current.x, lastPoint.current.y)),
          };
          setActive(true);
          const point = localPoint(event.clientX, event.clientY);
          for (const [name, value] of [
            ["x1", point.x],
            ["y1", point.y],
            ["x2", point.x],
            ["y2", point.y],
          ] as const) {
            line.current?.setAttribute(name, String(value));
          }
          node.setPointerCapture?.(event.pointerId);
        },

        onPointerMove(event: PointerEvent<SVGElement | HTMLElement>) {
          const start = from.current;
          if (start === null || start.pointerId !== event.pointerId) return;
          event.stopPropagation();
          start.scroll.track(event.clientX);
          track(event.clientX, event.clientY);
        },

        onPointerUp(event: PointerEvent<SVGElement | HTMLElement>) {
          const start = from.current;
          if (start === null || start.pointerId !== event.pointerId) return;
          event.stopPropagation();
          const target = rowAt(event.clientX, event.clientY)?.dataset.dropId;
          finish();
          if (target !== undefined) link(start.taskId, start.side, target);
        },
      };
    },
  };
}

export type LinkDrag = ReturnType<typeof useLinkDrag>;
