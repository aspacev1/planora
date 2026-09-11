import { useEffect, useRef } from "react";

/**
 * The Esc that closes one layer — the top one.
 *
 * Listening for `keydown` on the document separately in every layer is the simplest thing, and
 * while there is one layer on screen the difference is invisible. The difference appears when
 * there are two: a date is being edited in a task's card, the "explain the shift" dialog pops
 * up on top, the person presses Esc to change their mind — and the card they were working in
 * closes along with the dialog, carrying away a filled-in form. There was one press, and it
 * cancelled two actions, the second of which nobody asked for.
 *
 * So there is one listener here for the whole application, and the layers lie in a stack. The
 * order of appearance is the stack's order: the layer opened last lies on top and is the first
 * to go. The next Esc goes to what was under it — that is, closing takes as many presses as
 * there are layers open, and that is exactly what a person expects.
 *
 * There is one agreement about the order: a layer popping up on top of another must appear
 * later than it. In React that holds by itself while the top layer is drawn from state ("it is
 * open — we draw it") rather than sitting in the markup always.
 */

/** A layer is a reference to its own handler; the reference's identity is what holds its place in the stack. */
type Layer = { current: () => void };

const layers: Layer[] = [];

function onKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  // An Esc already taken by someone closer to the place of the press is not for the stack. A
  // table cell returns what was typed by it, a new task row closes itself; they prevent the
  // default, and the layer above — the task card under that same cell — must not close from the
  // same press: one press, one action.
  if (event.defaultPrevented) return;
  layers[layers.length - 1]?.current();
}

/**
 * Register a layer in the stack while it is on screen.
 *
 * @param onEscape what to do when Esc goes to this layer
 * @param enabled the layer exists only while it is unfolded — that is how menus and inline
 *   confirmations live, which are absent most of the time
 */
export function useEscape(onEscape: () => void, enabled = true) {
  const layer = useRef(onEscape);

  // The handler is updated separately from the place in the stack. For most callers `onClose` is
  // an arrow created anew on every frame of the parent; were we to rewrite the layer by its
  // identity, a lower layer would surface to the top on every such repaint — exactly the trouble
  // the stack exists for.
  useEffect(() => {
    layer.current = onEscape;
  });

  useEffect(() => {
    if (!enabled) return;
    layers.push(layer);
    // The listener is created with the first layer and removed with the last: between Esc presses
    // there is no reason for the application to keep a handler on the document with nothing to
    // close.
    if (layers.length === 1) document.addEventListener("keydown", onKeyDown);

    return () => {
      const at = layers.indexOf(layer);
    // A search by identity rather than a `pop`: a layer below can perfectly well go before the one
    // above — a card is closed with the mouse too while a dialog on top of it is open.
      if (at !== -1) layers.splice(at, 1);
      if (layers.length === 0) document.removeEventListener("keydown", onKeyDown);
    };
  }, [enabled]);
}
