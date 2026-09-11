import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { useEscape } from "../components/useEscape";

/**
 * A single place for a row's secondary actions — the "⋯" button and the panel under it.
 *
 * Before it a task's row had four independent signs surfacing on hover: the comment, the
 * assignees, the "plus" on the row boundary and the reordering handle itself. Each ate its
 * own room from the name, and a long title was truncated the sooner the more signs decided
 * to show at once. Here there is one button of constant width and one panel the secondary
 * actions moved into entirely; the row changes neither in width nor in height from the
 * panel being open — the panel stands on top of everything by window coordinates rather
 * than inside the row (the same device as AssignMenu's and the hover card's).
 */

const PANEL_WIDTH = 232;
// Not measured — estimated in advance, by the same device as the assignees panel's height
// (see AssignMenu.PANEL_HEIGHT). The panel is bounded by `max-height` in the styles, and
// the nested views (the assignee roll, the list of categories) unfold within the same
// bounds — the estimate stays correct for any of them.
const PANEL_ESTIMATED_HEIGHT = 300;
/** The gap between the button and the panel — and the minimum offset from the window's edge. */
const GAP = 6;

type Point = { left: number; top: number };

/**
 * The panel's place: by default down and to the right of the button, like a dropdown menu.
 * Opening in both directions is the only reason this is not a copy of AssignMenu's
 * `placeBelow`: there are no rows longer than the panel there that are cramped on the right,
 * and here there are — the list of categories under the "Move" item.
 */
function place(rect: DOMRect): Point {
  const spaceRight = window.innerWidth - rect.left;
  const left =
    spaceRight >= PANEL_WIDTH + GAP
      ? rect.left
      : Math.max(GAP, rect.right - PANEL_WIDTH);
  const clampedLeft = Math.max(GAP, Math.min(left, window.innerWidth - PANEL_WIDTH - GAP));

  const spaceBelow = window.innerHeight - rect.bottom;
  const top =
    spaceBelow >= PANEL_ESTIMATED_HEIGHT + GAP
      ? rect.bottom + GAP
      : Math.max(GAP, rect.top - GAP - PANEL_ESTIMATED_HEIGHT);

  return { left: clampedLeft, top };
}

export function RowMenu({
  label,
  children,
  onClose,
  describedBy,
  testId,
}: {
  /** The button's name for a screen reader — shared across all rows, see `describedBy`. */
  label: string;
  /** The panel's content. The function receives `close`, to close the menu after a choice. */
  children: (close: () => void) => ReactNode;
  /**
   * The menu closed — by any path: Esc, a click outside, choosing an item. A row that can
   * dive into a nested view (the assignee roll, the list of categories) returns itself to
   * the root right here — otherwise a menu opened anew would remember which view it was
   * caught on last time.
   */
  onClose?: () => void;
  /**
   * The node with the row's name — the same as with the assignees button (see AssignMenu):
   * the button's caption is one and the same on all tasks ("Task actions") or all categories
   * ("Category actions"), while which of them this button belongs to is said by the
   * description. The row's name is deliberately not part of the caption: were it there, the
   * button would coincide with the task's bar in any search by that name — both would then
   * read as "the "Logo" button".
   */
  describedBy?: string;
  testId?: string;
}) {
  const [at, setAt] = useState<Point | null>(null);
  const open = at !== null;
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const close = () => {
    setAt(null);
    onCloseRef.current?.();
  };

  useEscape(close, open);

  useEffect(() => {
    if (!open) return;
    // A local copy rather than the external `close`: the effect is only re-created on `open`,
    // and the external version (a new reference on every render) would make it follow every
    // unrelated update of the row.
    const dismiss = () => {
      setAt(null);
      onCloseRef.current?.();
    };
    function onPointerDown(event: globalThis.PointerEvent) {
      const target = event.target as Node;
      const inside =
        button.current?.contains(target) === true || panel.current?.contains(target) === true;
      if (!inside) dismiss();
    }
    document.addEventListener("pointerdown", onPointerDown);
    // Capture rather than bubbling — for the same reason as the assignees panel: what scrolls
    // is the strip, not the window, and its event otherwise never reaches the window.
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);

  return (
    <span className="gantt__row-actions">
      <button
        ref={button}
        type="button"
        className={`gantt__more${open ? " is-active" : ""}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={label}
        aria-describedby={describedBy}
        title={label}
        data-testid={testId ? `${testId}-button` : undefined}
        onClick={() => {
          if (open) {
            close();
            return;
          }
          const rect = button.current?.getBoundingClientRect();
          if (rect) setAt(place(rect));
        }}
      >
        <span aria-hidden="true">⋯</span>
      </button>

      {open &&
        createPortal(
          <div
            ref={panel}
            className="gantt__more-pop"
            style={{ left: at.left, top: at.top, width: PANEL_WIDTH }}
            role="group"
            aria-label={label}
            aria-describedby={describedBy}
            data-testid={testId}
          >
            {children(close)}
          </div>,
          document.body,
        )}
    </span>
  );
}

/** An ordinary menu item: a sign and a caption, an action on click. */
export function MenuAction({
  icon,
  tone = "quiet",
  disabled = false,
  /** A ticked item — for example, an already assigned person in the roll. */
  pressed,
  onClick,
  children,
}: {
  icon?: ReactNode;
  /** "danger" — an irreversible action: the colour names it before the caption does. */
  tone?: "quiet" | "danger";
  disabled?: boolean;
  /** `undefined` — the item is not toggleable, and `aria-pressed` is of no use to it. */
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`gantt__more-item${tone === "danger" ? " gantt__more-item--danger" : ""}${
        pressed ? " is-pressed" : ""
      }`}
      disabled={disabled}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {icon && (
        <span className="gantt__more-item-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="gantt__more-item-label">{children}</span>
    </button>
  );
}

/** A rule between meaningful groups of items. */
export function MenuSeparator() {
  return <span className="gantt__more-sep" role="separator" aria-hidden="true" />;
}

/** A nested view's heading: the view's name and the way back to the list of actions. */
export function MenuBack({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="gantt__more-back" onClick={onClick}>
      <span aria-hidden="true">←</span>
      {label}
    </button>
  );
}
