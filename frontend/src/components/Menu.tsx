import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useEscape } from "./useEscape";

/**
 * A button with a dropdown panel — "Filter", "View", "⋯" in the header.
 *
 * A panel rather than a `role="menu"`: inside live not only action items but checkboxes and lists too,
 * while a menu by ARIA obliges every child to be a `menuitem` and to be walked with the arrows.
 * Promising that semantics and not delivering it is worse than an honest button unfolding an area with
 * ordinary controls — so here there are `aria-expanded` and `aria-controls`, and that is all.
 *
 * It closes in three ways: Esc, a click outside and a repeat click on the button. A choice inside does
 * not close the panel — in a filter several checkboxes are ticked in a row, and a panel snapping shut
 * after the first would make you open it again for each.
 */
export function Menu({
  label,
  children,
  buttonClass = "button--quiet",
  showCaret = true,
  active = false,
  buttonLabel,
}: {
  label: ReactNode;
  children: ReactNode;
  buttonClass?: string;
/** The "it will unfold downwards" hint arrow. "⋯" does not need it. */
  showCaret?: boolean;
/** A dot on the button: a non-empty filter is selected inside. */
  active?: boolean;
/** A name for a screen reader, when the visible caption is a sign such as "⋯". */
  buttonLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const id = useId();

  // An unfolded panel is the top layer: it was opened last, and Esc must remove it first rather than
  // the card or the dialog it hangs over.
  useEscape(() => setOpen(false), open);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: globalThis.PointerEvent) {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <span className="menu" ref={root}>
      <button
        type="button"
        className={`${buttonClass} menu__button${active ? " is-active" : ""}`}
        aria-expanded={open}
        aria-controls={id}
        aria-label={buttonLabel}
        title={buttonLabel}
        onClick={() => setOpen((current) => !current)}
      >
        {label}
        {showCaret && (
          <span className="menu__caret" aria-hidden="true">
            ▾
          </span>
        )}
        {active && <span className="menu__dot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="menu__pop" id={id}>
          {children}
        </div>
      )}
    </span>
  );
}
