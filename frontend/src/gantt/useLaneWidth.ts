import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import type { RefObject } from "react";

/**
 * The width of the strip's visible part — as a number rather than as a style.
 *
 * Needed by exactly one computation: a relative plan's window. A plan without dates has nothing to
 * derive the scale's right edge from — the window is built from a constant, and without this measure
 * it is always the same width however much room there is on screen (see `weeksAcross` in relative.ts).
 * A calendar window is derived from the tasks' dates and needs no measure.
 *
 * It is measured by the same device as the strip's height (see `useViewportFit`): a layout effect on
 * every render plus `resize`, without a `ResizeObserver` — that would cost a polyfill for the sake of
 * jsdom, while the strip is repainted on every plan edit and every change of the column layout anyway.
 *
 * The returned number itself causes a repaint — hence state rather than a ref: the scale is built from
 * it. No cycle comes of that: the window's width does not depend on the scale's width — beyond the
 * visible part the strip scrolls rather than stretching its parent.
 */
export function useLaneWidth(box: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);

  const measure = useCallback(() => {
    const node = box.current;
    if (node === null) return;
    // `clientWidth` rather than the rectangle's width: a scrollbar gives the strip no room, and a
    // scale built together with it would come out a dozen pixels wider than the window — with a
    // horizontal scroll on an empty project.
    const next = node.clientWidth;
    setWidth((current) => (current === next ? current : next));
  }, [box]);

  useLayoutEffect(measure);

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  return width;
}
