import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import type { Scale } from "./timescale";

/**
 * The strip's bottom is not the table's edge but the place where the list is
 * continued.
 *
 * Both rows below stand once, after the very last category — rather than once per
 * category, like the "plus" on its own row (see CategoryRow). The invitation to
 * continue the project is shown where it actually ends right now, and it travels
 * downwards with new content on its own — because it stands after it in the same
 * markup flow rather than on top of it as a separate layer.
 *
 * Both are strip rows in shape: the same `.gantt__label` / `.gantt__lane` grid as an
 * ordinary row. Without an empty band of the scale on the right, the strip under them
 * would break off at the table's edge, and the screen's right part would read as
 * shorter than its left (see `Lane` below and the Gantt grid requirement in the
 * mockup).
 */

/**
 * An empty band of the scale — of its own width, with no content: there is no bar
 * here and never will be, but the strip must not break off at the table's edge.
 *
 * On rows that are pressable it is pressed along with them. The hover highlight
 * covers the whole row — the band too (see `.gantt__row:hover` in gantt.css) — while
 * up to now only the names column was pressable: two thirds of a highlighted row did
 * not respond to a press at all. The band is empty, there will be no bar in it, and
 * there is nothing to give it — except the same action the caption on the left has.
 *
 * As a second button rather than a stretched first one: the names column is pinned by
 * the scroll (`position: sticky`), and one button for both halves would carry the
 * caption beyond the left edge on a strip scrolled to the right. A screen reader does
 * not need this half and it is hidden from it — the row has one action, and it is
 * named by the button in the names column.
 */
function Lane({ scale, onClick }: { scale: Scale; onClick?: () => void }) {
  if (onClick === undefined) {
    return <div className="gantt__lane" style={{ width: scale.width }} />;
  }
  return (
    <button
      type="button"
      className="gantt__lane gantt__lane--add"
      style={{ width: scale.width }}
      tabIndex={-1}
      aria-hidden="true"
      onClick={onClick}
    />
  );
}

/**
 * "+ Add task" — at a task's indent, at the very end of the last category.
 *
 * Not a toolbar button and not a second "plus" on a category's row — both already
 * exist and have gone nowhere. This is a third one, the closest to the place it puts
 * the task: on the row below the last task of the last category, rather than at the
 * top of the screen, which you have to scroll back to.
 */
export function AddTaskRow({
  scale,
  label,
  onClick,
}: {
  scale: Scale;
  /**
   * A caption with the name of the category the row puts the task into — the same one
   * the screen reader says.
   *
   * The visible caption used to say simply "Add task", and only the screen reader
   * knew the category's name: a sighted person saw less than a blind one heard. While
   * there are three categories and all are on screen, the surroundings answered for
   * the caption on their own; with a list of fifty rows the heading travels upwards
   * and the row reads as "add somewhere". A long name gives way to an ellipsis — see
   * `.gantt__add-label`.
   */
  label: string;
  onClick: () => void;
}) {
  return (
    <div className="gantt__row gantt__row--add gantt__row--add-task">
      <div className="gantt__label">
        <button type="button" className="gantt__add" title={label} onClick={onClick}>
          <span className="gantt__add-plus" aria-hidden="true">
            +
          </span>
          <span className="gantt__add-label">{label}</span>
        </button>
      </div>
      <Lane scale={scale} onClick={onClick} />
    </div>
  );
}

/**
 * "+ New category" — at a category heading's indent, as the strip's very last row. It
 * neighbours "+ Add task" but is not confused with it: denser in font weight and a
 * step higher — by the same device a category's heading differs from the task below
 * it, rather than by the button's size.
 */
export function AddCategoryRow({
  scale,
  label,
  onClick,
}: {
  scale: Scale;
  label: string;
  onClick: () => void;
}) {
  return (
    <div className="gantt__row gantt__row--add gantt__row--add-category">
      <div className="gantt__label">
        <button type="button" className="gantt__add" title={label} onClick={onClick}>
          <span className="gantt__add-plus" aria-hidden="true">
            +
          </span>
          <span className="gantt__add-label">{label}</span>
        </button>
      </div>
      <Lane scale={scale} onClick={onClick} />
    </div>
  );
}

/**
 * The new category's name field — by the same device as `NewTaskRow`: Enter sends
 * what was written and leaves the field empty and focused, so categories can be
 * created in a row without touching the mouse; an empty Enter or Esc closes the row;
 * leaving the field saves what was typed rather than cancelling it.
 *
 * The row stands above "+ New category" rather than in its place: the button itself
 * goes nowhere at that — it is used to create the next one once this one is saved.
 */
export function NewCategoryRow({
  scale,
  label,
  placeholder,
  onCreate,
  onClose,
}: {
  scale: Scale;
  label: string;
  placeholder: string;
  onCreate: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const submit = (): boolean => {
    const trimmed = name.trim();
    if (trimmed === "") return false;
    onCreate(trimmed);
    setName("");
    return true;
  };

  return (
    <div className="gantt__row gantt__row--new">
      <div className="gantt__label">
        <div className="gantt__add-field">
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
                // Changing your mind mid-typing is an ordinary thing. The row is
                // closed by unmounting the field, and `onBlur` does not reach it: what
                // was typed disappears, as promised.
                event.preventDefault();
                onClose();
              }
            }}
            onBlur={() => {
              submit();
              onClose();
            }}
          />
        </div>
      </div>
      <Lane scale={scale} />
    </div>
  );
}

/**
 * A category row that has been sent while the server has not answered yet — by the
 * same device as a task's `PendingRow`: an optimistic row is impossible (the server
 * assigns the id and the position), so instead of a guess there is the name, already
 * visible, and the coverage band, which does not exist yet.
 */
export function PendingCategoryRow({
  scale,
  name,
  title,
}: {
  scale: Scale;
  name: string;
  /** "Creating…" — a hint for the pointer; the row is also marked `aria-busy`. */
  title: string;
}) {
  return (
    <div className="gantt__row gantt__row--pending" aria-busy>
      <div className="gantt__label">
        <div className="gantt__add-field">
          <span className="gantt__label-name" title={title}>
            {name}
          </span>
        </div>
      </div>
      <Lane scale={scale} />
    </div>
  );
}
