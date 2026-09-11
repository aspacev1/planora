import { useEffect, useState } from "react";

const REDUCED = "(prefers-reduced-motion: reduce)";

/**
 * The duration of the strip's transitions in milliseconds.
 *
 * It lives here rather than only in CSS, for the same reason as `ROW_HEIGHT`: a bar's travel is
 * animated from code (see `useBarMotion`), and a second identical number in the styles would diverge
 * from this one on the first edit. The markup sets this value as the `--motion` variable, and CSS
 * takes it from there.
 */
export const MOTION_MS = 180;

/**
 * Whether the person asked for less motion — a one-off answer, without a subscription.
 *
 * Needed where the value is read at the moment of an action rather than held in state: a bar's
 * animation is started by code, and the general `transition: none` rule from styles.css does not see
 * it — that one suppresses CSS transitions rather than something started through `Element.animate`.
 * There is nothing to subscribe for the sake of a single read: there are hundreds of bars on the
 * strip, and that would be hundreds of listeners on one and the same setting.
 */
export function prefersReducedMotion(): boolean {
  return ask();
}

/**
 * Whether the person asked for less motion.
 *
 * The setting is a system one, and respecting it is mandatory: for some people motion on a screen is
 * not "less pleasant" but nausea and a headache. So with it the transitions are switched off
 * entirely rather than sped up: fast motion is still motion.
 *
 * The watching is live rather than one-off: the setting gets changed without reloading the tab.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => ask());

  useEffect(() => {
    // Neither matchMedia nor a subscription may be there — jsdom lacks the first, older engines the
    // second. The absence of an answer means "did not ask": that is the same behaviour as today's,
    // and it is no worse.
    const list = typeof matchMedia === "function" ? matchMedia(REDUCED) : null;
    if (!list?.addEventListener) return;

    const listen = (event: MediaQueryListEvent) => setReduced(event.matches);
    list.addEventListener("change", listen);
    return () => list.removeEventListener("change", listen);
  }, []);

  return reduced;
}

function ask(): boolean {
  return typeof matchMedia === "function" && matchMedia(REDUCED).matches;
}
