import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { Cell, shownColumns } from "./Cells";
import type { ColumnLayout } from "./columns";
import type { Scale } from "./timescale";

/**
 * Creating a task — as a row in the strip rather than a dialog with nine fields.
 *
 * Tasks are created in batches: a plan is written as a list, a row per item, and a dialog
 * between rows meant opening, filling in, closing — and so twenty times in a row. Here a new
 * task is only asked for its name: it already has everything else (the day is today, the
 * duration one day), and that can be corrected in the card, one click away on the row.
 *
 * Enter does not close the row but sends what was written and leaves the field empty and
 * focused: the next task is written straight away without touching the mouse. An empty Enter
 * means "no more needed" and closes the row — otherwise the only way out of the mode would be
 * the Esc key alone, which nobody guesses at.
 */

export function NewTaskRow({
  layout,
  scale,
  label,
  placeholder,
  onCreate,
  onClose,
}: {
  layout: ColumnLayout;
  scale: Scale;
  /** The field's name on a screen reader: "New task in “Design”". */
  label: string;
  placeholder: string;
  /**
   * Send what was written. The row stays open at that.
   *
   * The row does not compute the number the task will land at: "a", "b", "c" in a row must
   * land in the typed order, but how many of them the server has already accepted and moved
   * the neighbours for is known by the strip, not by the field (see `insertPosition` in Gantt).
   */
  onCreate: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const input = useRef<HTMLInputElement>(null);

  // The focus goes in at once: the "plus" is pressed in order to write, and a click on the
  // field after that would be a second press for the same thing.
  useEffect(() => {
    input.current?.focus();
  }, []);

  /** Sent or not: an empty field is not a task but the middle of typing. */
  const submit = (): boolean => {
    const trimmed = name.trim();
    if (trimmed === "") return false;
    onCreate(trimmed);
    setName("");
    return true;
  };

  return (
    <NameRow className="gantt__row--new" layout={layout} scale={scale}>
      <input
        ref={input}
        className="cell-input"
        type="text"
        value={name}
        placeholder={placeholder}
        aria-label={label}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (!submit()) onClose();
          }
          if (event.key === "Escape") {
            // Changing your mind mid-typing is an ordinary thing. The row is closed by
            // unmounting the field, and `onBlur` does not reach it: what was typed disappears,
            // as promised.
            event.preventDefault();
            onClose();
          }
        }}
        // Blur saves — the same as a date cell in this very table (see EditableCell). A typed
        // name that vanished from a click outside the field would be counted by a person as a
        // lost task rather than as a cancelled input.
        onBlur={() => {
          submit();
          onClose();
        }}
      />
    </NameRow>
  );
}

/**
 * A task row that has been sent while the server has not answered yet.
 *
 * There is deliberately no optimistic task here: the id and the end date are assigned by the
 * server — the first has nowhere to come from, the second is computed by the working
 * calendar. An invented row would be a button with nothing behind it: it could be opened,
 * dragged by an edge and linked to a neighbour, while the server would reject operations with
 * a non-existent id. So not a guess but a wait: the name is already visible, the bar is not
 * there yet.
 */
export function PendingRow({
  layout,
  scale,
  name,
  title,
}: {
  layout: ColumnLayout;
  scale: Scale;
  name: string;
  /** "Creating…" — a hint for the pointer; the row is also marked `aria-busy`. */
  title: string;
}) {
  return (
    <NameRow className="gantt__row--pending" layout={layout} scale={scale} busy>
      <span className="gantt__label-name" title={title}>
        {name}
      </span>
    </NameRow>
  );
}

/**
 * A strip row with one column occupied — the name.
 *
 * The rest are empty rather than filled with dashes: a dash means "there is no value", while
 * these rows' values are not assigned yet — they will appear together with the task.
 */
function NameRow({
  className,
  layout,
  scale,
  busy = false,
  children,
}: {
  className: string;
  layout: ColumnLayout;
  scale: Scale;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`gantt__row ${className}`} aria-busy={busy || undefined}>
      <div className="gantt__label">
        {shownColumns(layout).map((column) => (
          <Cell key={column} column={column} layout={layout}>
            {column === "task" ? children : null}
          </Cell>
        ))}
      </div>
      {/* The scale's band is empty but of its own width: without it the row would break off at
          the table's edge, and the strip under the draft would look torn. */}
      <div className="gantt__lane" style={{ width: scale.width }} />
    </div>
  );
}
