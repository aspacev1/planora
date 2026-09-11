import { useCallback, useEffect, useLayoutEffect } from "react";
import type { RefObject } from "react";

/**
 * The height of the strip's scrollable part — by what is left of the window below its top
 * edge.
 *
 * The scale's header is declared `position: sticky; top: 0` (see `.gantt__head-row`), but
 * it had nowhere to stick to. `.gantt__scroll` only sets `overflow-x`, its height is
 * bounded by nothing — the container grows to the full height of its content and never
 * scrolls vertically. What travels vertically is the page, and the header travels with it:
 * the months, weeks and dates disappear exactly when they are being checked against —
 * when there are more tasks than fit in the window. On a project of a dozen rows this is
 * invisible (the strip is shorter than the window anyway), and that is why it lasted so long.
 *
 * The fix is not in the header's markup but in the strip's height: `sticky` sticks inside
 * the nearest scrollable ancestor, and the ancestor must scroll itself. The same fixes the
 * second half of `gantt.css`'s promise ("the strip scrolls, not the page") — horizontally
 * it was always kept, vertically it was not kept at all.
 *
 * As a number rather than a `max-height: 100dvh` in the styles: the project's header with
 * its tabs and the toolbar stand above the strip, and the styles cannot subtract their
 * height — it differs both across screens and as work goes on (the header line and the
 * toolbar wrap their content in a narrow window, the offer to move a linked task appears
 * above the strip, the relative-plan hint is closed).
 *
 * No separate subscription to these changes is needed: everything that changes the height
 * above the strip is a repaint of the project screen, and the strip is repainted with it
 * (see the useLayoutEffect below — it has no dependency list). A `transitionend`
 * subscription stood here for the sake of a folding header that no longer exists.
 */

/**
 * Below this the strip stops being a strip. The stop is needed for a window where no room
 * is left for the strip at all (a phone in landscape, a long project header): better to
 * give the page the scroll and show at least a few rows than to collapse the strip into a
 * band.
 */
const MIN_HEIGHT = 240;

export function useViewportFit(box: RefObject<HTMLElement | null>): void {
  const fit = useCallback(() => {
    const node = box.current;
    if (node === null) return;

    const bounds = node.getBoundingClientRect();
    // The strip's place on the page rather than in the window: measuring from the current
    // scroll position would mean changing the height on every turn of the wheel.
    const top = bounds.top + window.scrollY;
    // Everything in the strip below the scrollable part is the footnote under the scale.
    // Without this correction the page would get a scroll of its own by that height, and the
    // pinned header would travel with the page — the very thing being avoided here, only by
    // a dozen pixels.
    const root = node.closest<HTMLElement>(".gantt");
    const below = root === null ? 0 : root.getBoundingClientRect().bottom - bounds.bottom;

    const height = Math.max(MIN_HEIGHT, Math.round(window.innerHeight - top - below));
    const next = `${height}px`;
    // Only on a change: a write into the style is a layout recalculation, while measuring
    // has to happen on every repaint of the strip.
    if (node.style.maxHeight !== next) node.style.maxHeight = next;
  }, [box]);

  // With no dependency list — on every repaint of the strip: the height of what is above it
  // changes not only with the window's size (the toolbar wraps the buttons, the offer to
  // move a linked task appears above the strip), and the strip is repainted on every plan
  // edit anyway. Both measurements are one forced layout recalculation: the second reads
  // what has already been recalculated. A size subscription (`ResizeObserver`) would cost a
  // polyfill for the sake of jsdom and still would not see the strip's neighbours — they
  // live above it, in the project screen.
  //
  // As a layout effect rather than an ordinary one: a frame with the height unset would be
  // visible — the strip is stretched across the whole page in it.
  useLayoutEffect(fit);

  useEffect(() => {
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [fit]);
}
