import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import "./rows.css";

/**
 * Table rows: the cell that is edited in place, and a row's action signs.
 *
 * One set for the Gantt strip and the quote. The quote is the same table of rows with
 * columns, and "as in the strip" here means literally the same thing: the same way to
 * open a cell, the same buttons under the cursor, the same speed of appearing. A set
 * of its own in each place would stay identical exactly until the first edit of one
 * of them.
 */

/**
 * A cell edited in place: a display before the click, a field after it.
 *
 * Deliberately not a button: there are six columns and a hundred rows, and six
 * hundred Tab steps would lead nowhere you cannot reach otherwise — the same fields
 * lie in the row's card, one step away from the keyboard (it is opened by the "edit"
 * sign on the row). The click stays available to the pointer and promises nothing it
 * does not deliver.
 */
export function EditableCell({
  value,
  display,
  type,
  step,
  disabled,
  label,
  min,
  max,
  allowEmpty = false,
  editTrigger,
  className,
  id,
  placeholder,
  onCommit,
}: {
  /** The value in the form the input field will accept. */
  value: string;
  /** The value in the form it is read with the eyes. */
  display: string;
  type: "text" | "date" | "number";
  /** A numeric field's step: "any" where the value can be fractional. */
  step?: string;
  disabled?: boolean;
  label: string;
  min?: number;
  max?: number;
  /**
   * Whether to treat an empty field as a value.
   *
   * By default no: for a number and a name emptiness is the middle of typing, and
   * sending it means asking the server to refuse something the person never asked
   * for. For a description emptiness is a real value: descriptions do get erased.
   */
  allowEmpty?: boolean;
  /**
   * Open the field by something other than a click on the cell — for example, the
   * "Rename" item in the row's menu. The cell does not know about this outside
   * occasion itself, so the occasion is passed as a value: every new one (by
   * reference or by value) opens the field, rather than the first coincidence with
   * whatever is already in the prop at mount time opening nothing.
   */
  editTrigger?: unknown;
  /** A class on top of "cell-value" — where the cell wears somebody else's styling
      (a category row's boldness, the same ellipsis truncation as a task's name) and
      not only its own. */
  className?: string;
  /** The node referred to by the description — for example, a row's "⋯" button. */
  id?: string;
  /**
   * What to show instead of a dash while there is no value: "role", "rate". A dash
   * says "empty", a hint says "this is what goes in here", and for a row that has
   * just been created the second is more useful.
   */
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  // The first render is no reason to open: without this marker a cell given an
  // undefined `editTrigger` straight away would fling itself open the moment it appeared.
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (editTrigger !== undefined) setEditing(true);
  }, [editTrigger]);

  // While the cell has not been opened, the draft must follow the truth: a colleague
  // on the project is editing the same row, and the cell next to it must not show
  // yesterday's value. An open cell is not touched by the truth — otherwise someone
  // else's edit would erase what the person is typing at that moment.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [editing, value]);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  if (!editing || disabled) {
    const hint = display === "" && placeholder !== undefined && !disabled;
    return (
      <span
        id={id}
        className={`cell-value${disabled ? "" : " cell-value--editable"}${hint ? " cell-value--hint" : ""}${className ? ` ${className}` : ""}`}
        title={display === "" ? undefined : display}
        onClick={disabled ? undefined : () => setEditing(true)}
      >
        {display === "" ? (hint ? placeholder : "—") : display}
      </span>
    );
  }

  const commit = () => {
    setEditing(false);
    if (draft === value) return;
    if (draft === "" && !allowEmpty) return;
    onCommit(draft);
  };

  return (
    <input
      ref={input}
      id={id}
      className="cell-input"
      type={type}
      value={draft}
      min={min}
      max={max}
      step={step}
      aria-label={label}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
        if (event.key === "Escape") {
          // Changing your mind mid-typing is an ordinary thing, and the way out
          // otherwise would be to remember the previous value and type it back.
          event.preventDefault();
          setDraft(value);
          setEditing(false);
        }
      }}
    />
  );
}

/**
 * A row's action sign: a button the size of an icon, silent until hovered.
 *
 * A button rather than an icon with a handler: deletion and editing are actions Tab
 * must reach and Enter must trigger. Visibility does not get in the accessibility
 * tree's way: a transparent button stays in it and surfaces on focus (see rows.css).
 */
export function RowIcon({
  label,
  tone = "quiet",
  disabled = false,
  onClick,
  children,
}: {
  /**
   * The caption includes the row's name: with a hundred rows, nameless crosses are
   * indistinguishable on a screen reader, and the right one cannot be picked except
   * by counting them in order.
   */
  label: string;
  /** "danger" — an irreversible action: by colour under the cursor. */
  tone?: "quiet" | "danger";
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`row-icon${tone === "danger" ? " row-icon--danger" : ""}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * An icon with a counter: the row's discussion.
 *
 * Not a button — unlike the action signs next to it: the same discussion is opened
 * from the keyboard by the row's card, and a second button on each of a hundred rows
 * would be a hundred extra Tab steps, not one of which leads anywhere you cannot
 * reach otherwise. The number does need a name at that: without it a bare figure is
 * read from the screen.
 */
export function RowBadge({
  label,
  set = false,
  onClick,
  children,
}: {
  label: string;
  /** Whether there is anything to show: the value is always visible, the invitation appears on hover. */
  set?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <span
      className={`row-badge${set ? " is-set" : ""}${onClick ? " is-clickable" : ""}`}
      role="img"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </span>
  );
}

/** The "discussion" sign. */
export function CommentIcon() {
  return (
    <svg className="glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M13.6 2.8H2.4a1 1 0 0 0-1 1v6.1a1 1 0 0 0 1 1h1.9v2.6l2.9-2.6h6.4a1 1 0 0 0 1-1V3.8a1 1 0 0 0-1-1Z" />
    </svg>
  );
}

/** The "edit" sign: a pencil. It opens the row's card. */
export function PencilIcon() {
  return (
    <svg className="glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M11.4 2.3a1.4 1.4 0 0 1 2 2l-7.2 7.2-2.7.7.7-2.7 7.2-7.2Z" />
      <path d="M2.6 14h10.8" />
    </svg>
  );
}
