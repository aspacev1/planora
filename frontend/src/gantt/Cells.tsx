import { useRef } from "react";
import type { PointerEvent, ReactNode } from "react";

import type { Task } from "../api/projects";
import type { ColumnKey, ColumnLayout } from "./columns";
import { COLUMN_KEYS, MIN_WIDTH, clampWidth } from "./columns";

/**
 * The cells of the pinned table — the strip's left part.
 *
 * One layout for three places: the header, a category row and a task row. The widths
 * come from it too, so a column dragged by its boundary in the header moves at once
 * in every row — there is no second list of widths that would one day diverge from
 * the first.
 *
 * Edited right here are only those fields the operations can already change one at a
 * time: the start, the duration, the percentage. The end date is display only: it is
 * computed by the server from the project's calendar, and a field for editing it
 * would promise an influence that does not exist (the same reason as in the task
 * card).
 *
 * The cell that is edited in place lives not here but in components/rows: a quote's
 * row is edited by the same motion, and with a second identical cell they would
 * diverge on the first edit of one of them.
 */

/**
 * The columns a row is drawing right now.
 *
 * A collapsed table has none at all: what is left of it is a strip a button wide (see
 * COLLAPSED_WIDTH), and the cells do not fit into it — they would spill over the
 * scale. The set of columns and their widths are intact at that and await the
 * expansion: collapsing is about room on screen, not about what the person chose to
 * see.
 *
 * One rule for all three places where the table's cells are drawn — the header, a
 * category row and a task row: three separate checks would diverge, and one of them
 * would draw the columns over the neighbouring strip.
 */
export function shownColumns(layout: ColumnLayout): readonly ColumnKey[] {
  return layout.collapsed ? [] : layout.shown;
}

/** One cell of a row: the width is set by the layout, the content by the caller. */
export function Cell({
  column,
  layout,
  children,
}: {
  column: ColumnKey;
  layout: ColumnLayout;
  children: ReactNode;
}) {
  return (
    <span
      className={`gantt__cell gantt__cell--${column}`}
      // The column's name goes in the markup: a move looks for its target by
      // hit-testing a point, and there is nothing else left to tell from the found
      // element which column it is.
      data-column={column}
      style={{ flex: `0 0 ${layout.widths[column]}px`, width: layout.widths[column] }}
    >
      {children}
    </span>
  );
}

/**
 * The table's header: the column captions and the boundaries they are dragged by.
 *
 * A boundary is a separate node on top of the seam rather than a `resize` on the
 * cell: a CSS resize is dragged only by the bottom right corner and leaves a notch in
 * it, which a table header has nowhere to get.
 */
export function HeadCells({
  layout,
  labels,
  onResize,
  onReorder,
  resizeLabel,
  reorderLabel,
  leading,
}: {
  layout: ColumnLayout;
  labels: Record<ColumnKey, string>;
  /**
   * What stands before the first column's heading — the "plus" for a new category.
   * Inside the cell rather than next to it: the name cell carries a margin on the
   * left (`--gantt-pad`), and a node outside it would stand either in that margin or
   * beyond it, shifting the heading relative to the task names below it.
   */
  leading?: ReactNode;
  /** `undefined` — the widths do not change (the strip has no memory, in a test for example). */
  onResize?: (column: ColumnKey, width: number) => void;
  /** `undefined` — the columns are not reordered. */
  onReorder?: (moved: ColumnKey, before: ColumnKey) => void;
  resizeLabel: (column: string) => string;
  reorderLabel?: (column: string) => string;
}) {
  const drag = useColumnDrag(onReorder);

  return (
    <>
      {shownColumns(layout).map((column) => (
        <Cell key={column} column={column} layout={layout}>
          {column === "task" && leading}
          <span
            className={`gantt__corner-label${
              onReorder && column !== "task" ? " gantt__corner-label--movable" : ""
            }`}
            // The column's name is both a caption and a drag handle: a separate handle
            // on a heading seventy pixels wide would take so much room from the caption
            // that an ellipsis would be all that was left of it.
            title={onReorder && column !== "task" ? reorderLabel?.(labels[column]) : undefined}
            {...(onReorder && column !== "task" ? drag.handleProps(column) : {})}
          >
            {labels[column]}
          </span>
          {onResize && (
            <ColumnGrip
              width={layout.widths[column]}
              label={resizeLabel(labels[column])}
              onResize={(width) => onResize(column, width)}
            />
          )}
        </Cell>
      ))}
    </>
  );
}

/**
 * Moving a column by its heading.
 *
 * A column is dropped onto a neighbour and stands before it. The target is found by
 * hit-testing a point rather than by the event's target, for the same reason as with
 * row reordering: with a finger, after the press the pointer is captured by the
 * heading the drag started on, and the neighbours never learn about the movement (see
 * `targetAt` in useReorder).
 *
 * The target highlight goes as a class straight into the DOM, past React state: the
 * target changes on every crossing of a boundary, and a repaint of the header drags
 * the whole strip along with it.
 */
function useColumnDrag(onReorder?: (moved: ColumnKey, before: ColumnKey) => void) {
  const from = useRef<{ pointerId: number; column: ColumnKey } | null>(null);
  const hovered = useRef<HTMLElement | null>(null);

  const markTarget = (element: HTMLElement | null) => {
    if (hovered.current === element) return;
    hovered.current?.classList.remove(COLUMN_TARGET_CLASS);
    element?.classList.add(COLUMN_TARGET_CLASS);
    hovered.current = element;
  };

  const cellAt = (clientX: number, clientY: number): HTMLElement | null => {
    const under = document.elementFromPoint?.(clientX, clientY) ?? null;
    const cell = under?.closest<HTMLElement>("[data-column]") ?? null;
    // A column's own self is not highlighted as a target: a drop onto yourself changes
    // nothing, and there is no point promising a reorder that will not happen. The
    // task's name is never a target at all — it is always first.
    const key = cell?.dataset.column;
    if (key === undefined || key === "task" || key === from.current?.column) return null;
    return cell;
  };

  const finish = () => {
    from.current = null;
    markTarget(null);
  };

  return {
    handleProps(column: ColumnKey) {
      return {
        onPointerDown(event: PointerEvent<HTMLElement>) {
          if (event.button !== 0) return;
          // Without this the press starts a text selection of the heading instead of a
          // move — the same as with a bar's edges.
          event.preventDefault();
          from.current = { pointerId: event.pointerId, column };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        },
        onPointerMove(event: PointerEvent<HTMLElement>) {
          if (from.current?.pointerId !== event.pointerId) return;
          markTarget(cellAt(event.clientX, event.clientY));
        },
        onPointerUp(event: PointerEvent<HTMLElement>) {
          const start = from.current;
          if (start?.pointerId !== event.pointerId) return;
          const target = cellAt(event.clientX, event.clientY)?.dataset.column;
          finish();
          if (isColumnKey(target)) onReorder?.(start.column, target);
        },
        onPointerCancel: finish,
      };
    },
  };
}

const COLUMN_TARGET_CLASS = "is-column-target";

function isColumnKey(value: string | undefined): value is ColumnKey {
  return value !== undefined && (COLUMN_KEYS as readonly string[]).includes(value);
}

/**
 * A column's boundary: dragged with the pointer, walked with the keyboard arrows.
 *
 * The arrows here are not a formality for the sake of accessibility: hitting a
 * four-pixel band with a pointer is hard even with a mouse, and the width is the only
 * property of the table that otherwise cannot be configured at all.
 */
function ColumnGrip({
  width,
  label,
  onResize,
}: {
  width: number;
  label: string;
  onResize: (width: number) => void;
}) {
  const from = useRef<{ pointerId: number; x: number; width: number } | null>(null);

  return (
    <span
      className="gantt__col-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={MIN_WIDTH}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        // The boundary lies in the same heading the column is moved by: without this one
        // press would start both gestures at once.
        event.stopPropagation();
        from.current = { pointerId: event.pointerId, x: event.clientX, width };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = from.current;
        if (start === null || start.pointerId !== event.pointerId) return;
        onResize(clampWidth(start.width + (event.clientX - start.x)));
      }}
      onPointerUp={() => {
        from.current = null;
      }}
      onPointerCancel={() => {
        from.current = null;
      }}
      onKeyDown={(event) => {
        const step = event.key === "ArrowRight" ? 8 : event.key === "ArrowLeft" ? -8 : 0;
        if (step === 0) return;
        event.preventDefault();
        onResize(clampWidth(width + step));
      }}
    />
  );
}

/** A summary over a group of rows — what a category row shows. */
export function rollUp(tasks: Task[]): { start: string; end: string; progress: number } | null {
  if (tasks.length === 0) return null;
  // A group's percentage is averaged by durations rather than by the number of rows: a
  // week done by half weighs more than a fully completed one-day call, and "50%" by
  // heads would say the opposite.
  const work = tasks.reduce((total, task) => total + task.duration_days, 0);
  const done = tasks.reduce((total, task) => total + task.duration_days * task.progress_pct, 0);
  return {
    start: tasks.reduce((a, t) => (t.start_date < a ? t.start_date : a), tasks[0].start_date),
    end: tasks.reduce((a, t) => (t.end_date > a ? t.end_date : a), tasks[0].end_date),
    progress: work === 0 ? 0 : Math.round(done / work),
  };
}
