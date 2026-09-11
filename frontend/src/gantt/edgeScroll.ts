/**
 * Scrolling the strip when a gesture runs into its edge.
 *
 * Without it a drag is limited to what is visible: a task cannot be moved from
 * March to June in one motion — the bar is dragged to the edge, released, the strip
 * is scrolled, the bar is found, it is dragged again. Three actions instead of one,
 * and all three for the sake of something the person has already decided.
 *
 * The scrolling is done not by the gesture but by this layer, for one reason: there
 * are four gestures on the strip (a move, two edges, a link), the edge is common to
 * them, and written anew in each it would diverge in each on the small things — on
 * the width of the band at the edge, on the speed, on whether the scrolling stops
 * when released outside the window.
 *
 * The speed grows towards the very edge rather than being constant: at the band's
 * outer boundary the strip barely crawls (you can land precisely on the day you
 * need), at the inner one it goes fast (you can travel a quarter). A constant speed
 * suits neither — it is either agonizingly slow or uncontrollable.
 *
 * It is also responsible for any other travel of the strip during a gesture — see `scrolled`.
 */

/** The width of the band at the edge within which the strip starts to move. */
const EDGE_PX = 48;

/** Pixels per frame at the very edge. At 60 frames that is roughly a screen per second. */
const MAX_SPEED_PX = 18;

export type EdgeScroll = {
  /** The pointer moved. The point is remembered: the scrolling runs without new events too. */
  track: (clientX: number) => void;
  /** How far the strip has travelled since the gesture began. A gesture must add this to its own offset. */
  scrolled: () => number;
  stop: () => void;
};

/**
 * A do-nothing scroller — for a gesture that found no scrollable ancestor (a public
 * page in a narrow window, tests in jsdom). Returning `null` would mean giving every
 * gesture an "and what if there is nothing to scroll" branch.
 */
const IDLE: EdgeScroll = { track: () => {}, scrolled: () => 0, stop: () => {} };

/**
 * @param node Any node inside the strip: the layer finds the scrollable ancestor
 *   itself. A reference to it is deliberately not asked for as a prop — otherwise it
 *   would have to be dragged through three components for the sake of a gesture that
 *   is already inside.
 * @param onScroll The strip travelled on its own. The gesture must recompute itself:
 *   there are no pointer events at that moment — the finger is still, the strip is
 *   moving — and without this call the bar would lag behind it.
 */
export function edgeScroll(node: HTMLElement | null, onScroll: () => void): EdgeScroll {
  const box = node?.closest<HTMLElement>(".gantt__scroll") ?? null;
  // jsdom does have `requestAnimationFrame`, but there is nothing to scroll there:
  // elements' heights and widths are zero, and the band at the edge would cover the
  // whole strip.
  if (box === null || box.clientWidth === 0) return IDLE;

  let pointerX: number | null = null;
  let frame = 0;
  // The pinned table to the left of the scale. Looked up once per gesture: the node
  // does not change during a gesture, only its width can — and that is read on every
  // frame.
  const label = box.querySelector<HTMLElement>(".gantt__label");

  /**
   * The scroll position at the gesture's start: the `scrolled()` answer is measured
   * from it.
   *
   * The difference from the current one, not the sum of what this layer pumped. The
   * strip is moved not only by it: it is driven by the wheel, the trackpad, the
   * scrollbar and the arrows, and the day under a motionless finger changes from them
   * in exactly the same way. Not entering the offset, such travel would take the bar
   * away from the finger by everything scrolled — and the task would land not on the
   * day the person saw under their hand.
   *
   * The difference also accounts for hitting the end of the strip: the eighteen
   * pixels ordered where only three were travelled will not enter it.
   */
  const from = box.scrollLeft;

  /**
   * The strip travelled — the gesture recomputes itself.
   *
   * Before the pointer's first movement it recomputes nothing: a press under which
   * the strip is still coasting is a click on the bar rather than a move, and a
   * coasted strip must not turn it into a move. Such a gesture's offset is suppressed
   * by the gestures themselves (see `pointerMoved` in `useDragDates`); what is
   * removed here is the redundant recomputation.
   */
  const onBoxScroll = () => {
    if (pointerX === null) return;
    onScroll();
  };
  box.addEventListener("scroll", onBoxScroll, { passive: true });

  const step = () => {
    frame = 0;
    if (pointerX === null) return;

    const bounds = box.getBoundingClientRect();
    // The strip's left edge is not the scrollable node's left edge: its first part is
    // taken by the pinned table (`.gantt__label`, sticky), and the scale is not
    // visible under it. So the band at the left edge is measured from the table's
    // right edge — otherwise, to travel back, a bar would have to be dragged across
    // the whole table, to an edge the scale does not have.
    const inset = label?.getBoundingClientRect().width ?? 0;
    // The depth of entry into the band at the edge: 0 at its outer boundary, 1 at the
    // very edge of the strip. Beyond the window's edge it is one rather than more: a
    // finger taken away to a neighbouring monitor must not accelerate the strip to
    // something meaningless.
    const before = (bounds.left + inset + EDGE_PX - pointerX) / EDGE_PX;
    const after = (pointerX - (bounds.right - EDGE_PX)) / EDGE_PX;
    const depth = before > 0 ? -Math.min(1, before) : after > 0 ? Math.min(1, after) : 0;

    if (depth !== 0) {
      const was = box.scrollLeft;
      box.scrollLeft = was + depth * MAX_SPEED_PX;
    // The recomputation happens right here rather than only on the `scroll` event: it
    // will arrive as a separate task, and the bar would lag behind the strip by a
    // frame — exactly where it is being watched. A repeat call from the listener
    // spoils nothing: the gesture recomputes itself from the same two numbers.
      if (box.scrollLeft !== was) onScroll();
    }

    frame = requestAnimationFrame(step);
  };

  return {
    track(clientX: number) {
      pointerX = clientX;
      if (frame === 0) frame = requestAnimationFrame(step);
    },
    scrolled: () => box.scrollLeft - from,
    stop() {
      pointerX = null;
      cancelAnimationFrame(frame);
      frame = 0;
    // The listener is removed here rather than on unmount: there are many gestures in
    // a row's lifetime, and each would leave a subscription to the strip behind it.
      box.removeEventListener("scroll", onBoxScroll);
    },
  };
}
