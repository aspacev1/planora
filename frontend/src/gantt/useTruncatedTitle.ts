import { useLayoutEffect, useRef, useState } from "react";

/**
 * A native tooltip with the full text — but only when the text is truncated with an ellipsis.
 *
 * Text that is not truncated gets no tooltip of its own: a hint repeating what has already been read by
 * eye is an extra layer between the cursor and the answer.
 *
 * @param text the text that may be truncated
 * @param watch what else besides the text changes the available width and therefore must restart the
 *   check — on the strip that is the name column's width: it is dragged by its boundary, and a name
 *   that fitted a second ago can become truncated without a single edit of the text itself.
 */
export function useTruncatedTitle<T extends HTMLElement>(text: string, watch?: unknown) {
  const ref = useRef<T>(null);
  const [truncated, setTruncated] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    // A one-pixel margin — rounding the width at a fractional screen scale would otherwise count a name
    // that fits exactly as truncated.
    setTruncated(el !== null && el.scrollWidth > el.clientWidth + 1);
  }, [text, watch]);

  return { ref, title: truncated ? text : undefined };
}
