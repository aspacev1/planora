import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { RefCallback } from "react";

import { MOTION_MS, prefersReducedMotion } from "./motion";

/**
 * A task bar's motion.
 *
 * A bar's place on the strip is set by `left` and `width`. Both are set at
 * render time and never touched again: they are layout properties, and every
 * edit of them makes the browser recompute the position of a whole layer of
 * rows. Animating them does that every frame. With a dozen tasks the difference
 * is invisible, with hundreds the strip starts to stutter — and precisely when
 * it is most noticeable: the server recomputed a dependency chain, and all the
 * bars travel at once.
 *
 * So a bar moves only through `transform`, which does not touch layout at all
 * and lives on the compositing layer. There are two ways, and both write into
 * one and the same `--bar-dx`:
 *
 * - under a finger — writing into the node's style directly, past React state.
 *   The pointer sends events dozens of times a second, and repainting a whole
 *   row for each means paying a render for what one property write does;
 * - the travel after the server's answer — a short animation from the old place
 *   to the new one. The old place is known as a number from the previous render,
 *   so the node is not measured: `getBoundingClientRect` is a forced layout
 *   recalculation, the very thing being avoided here.
 *
 * There is deliberately no frame of its own (`requestAnimationFrame`) for a
 * gesture here: the browser already delivers `pointermove` no more often than
 * once a frame, and deferring the write to the next one would add a frame of lag
 * to a gesture that must follow the finger without delay.
 */
export type BarMotion = {
  /** A reference to the bar's node: without it there is nowhere to write. */
  ref: RefCallback<HTMLElement>;
  /**
   * The bar under a finger: the offset in pixels from the place its dates give it.
   *
   * @param dw how much wider than due the bar currently looks. It is non-zero
   *   only when stretching by an edge, and there the width must change — a bar
   *   cannot be stretched without changing its width. The exception to the rule
   *   from the file's header ("the width is set at render time and not touched")
   *   is limited to exactly this: under the finger at that moment there is one
   *   bar rather than the whole layer of rows, and the layout recalculation costs
   *   one row.
   */
  hold: (dx: number, dw?: number) => void;
  /**
   * The finger was released.
   *
   * @param pending the move is still being decided — the bar waits where it was
   *   dropped, and `settle` will clear the offset. Otherwise it returns to its
   *   place on its own.
   */
  release: (pending?: boolean) => void;
  /** The move is decided: the offset is cleared, and the bar stands by its dates. */
  settle: () => void;
};

export function useBarMotion({
  left,
  scaleKey,
}: {
  left: number;
  /** The strip's coordinate-system marker — see `Scale.key`. */
  scaleKey: string;
}): BarMotion {
  const node = useRef<HTMLElement | null>(null);
  // The offset under the finger and the marker of the gesture itself. In refs
  // rather than in state: they are read in the pointer handlers and in the
  // layout layer, and there is no need to repaint the row for them — that is the
  // whole point (see the file's header).
  const held = useRef(0);
  // The width addition under the finger — stretching by an edge. Separate from
  // the offset, because it is cleared differently: the offset travels to its
  // place with an animation, while the width snaps at once. There is nothing to
  // animate it with and no reason to — the bar's end is already where it was
  // released.
  const heldWidth = useRef(0);
  const holding = useRef(false);
  const settling = useRef<Animation | null>(null);
  const frame = useRef(0);
  // Where the bar stood on the previous render. The difference from its current
  // place is the travel distance. The width is not part of this: a task's
  // duration is not a place, and it changes on its own without any movement
  // along the strip.
  const was = useRef<{ left: number; scaleKey: string } | null>(null);

  useLayoutEffect(() => {
    const before = was.current;
    was.current = { left, scaleKey };

    // The bar is still being held. Its place is set by the finger rather than by
    // the dates: someone else's edit arriving at this moment changes `left`
    // underneath it but does not interrupt the gesture.
    if (holding.current) return;
    // The first render: the bar has nowhere to travel from.
    if (before === null) return;

    // The bar travels from the place it was last seen at. Under a finger that is
    // not the previous `left` but the previous `left` plus the gesture's offset:
    // otherwise a released bar would first jump back to its previous dates and
    // only travel to the new day from there.
    const from = before.left + held.current;
    held.current = 0;
    heldWidth.current = 0;
    write(node.current, 0, 0);

    const dx = from - left;
    if (dx === 0) return;
    // The strip changed its scale or widened its window — the bar did not travel,
    // it is the strip that has different coordinates (see `Scale.key`).
    if (before.scaleKey !== scaleKey) return;

    settling.current?.cancel();
    settling.current = slide(node.current, dx);
  }, [left, scaleKey]);

  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      settling.current?.cancel();
    },
    [],
  );

  const ref = useCallback<RefCallback<HTMLElement>>((element) => {
    node.current = element;
  }, []);

  const hold = useCallback((dx: number, dw = 0) => {
    holding.current = true;
    held.current = dx;
    heldWidth.current = dw;
    // A started travel is cancelled: the animation and the finger would fight
    // over the same transform, and the bar would tremble between them.
    settling.current?.cancel();
    settling.current = null;
    write(node.current, dx, dw);
  }, []);

  // The offset is cleared not at once but on the next frame. If the gesture moved
  // the task, a render with the new `left` will arrive before that frame, and it
  // is what decides where the bar travels from: an offset cleared right now would
  // be a jerk back to the previous dates and only then a travel forward. And if
  // the gesture changed nothing — there is nobody but this frame to return the
  // bar to its place.
  const settle = useCallback(() => {
    if (held.current === 0 && heldWidth.current === 0) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      // Zero means the layout layer has already dealt with this offset itself.
      const dx = held.current;
      const dw = heldWidth.current;
      if (dx === 0 && dw === 0) return;
      held.current = 0;
      heldWidth.current = 0;
      write(node.current, 0, 0);
      if (dx === 0) return;
      settling.current?.cancel();
      settling.current = slide(node.current, dx);
    });
  }, []);

  const release = useCallback(
    (pending = false) => {
      holding.current = false;
      // The move is still being decided: the bar stays where it was dropped until
      // the answer arrives. Otherwise it would manage to return to its place
      // before the reason question — and the movement back would read as "it did
      // not work" where nothing has been decided yet.
      if (pending) return;
      settle();
    },
    [settle],
  );

  // One object for the whole lifetime: the gesture effects take it as a
  // dependency (see `cancel` in useDragDates), and a new object on every render
  // would resubscribe the Esc listener on every frame of a drag.
  return useMemo(() => ({ ref, hold, release, settle }), [ref, hold, release, settle]);
}

/** The bar's horizontal offset and the width addition. Written as properties so
    as not to fight with hovering: the lift under the cursor is a term of the same transform. */
function write(node: HTMLElement | null, dx: number, dw: number) {
  node?.style.setProperty("--bar-dx", `${dx}px`);
  node?.style.setProperty("--bar-dw", `${dw}px`);
}

/**
 * The bar's travel from its old place to its current one.
 *
 * The frames write `transform` whole rather than through `--bar-dx`: the browser
 * interpolates a custom property on the main thread, while a ready `translate3d`
 * it can hand to the compositing layer.
 */
function slide(node: HTMLElement | null, dx: number): Animation | null {
  // The person asked for less motion — the bar simply snaps to its new place.
  // The general rule from styles.css does not reach here: that one suppresses CSS
  // transitions, while this is an animation started from code.
  if (prefersReducedMotion()) return null;
  // `animate` may not be there — jsdom does not have it. The animation here is an
  // improvement, not a condition: without it the bar snaps into place instantly
  // and does not lie in the process.
  if (!node?.animate) return null;
  return node.animate(
    [{ transform: `translate3d(${dx}px, 0, 0)` }, { transform: "translate3d(0px, 0, 0)" }],
    { duration: MOTION_MS, easing: "ease" },
  );
}
