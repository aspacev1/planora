import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";

import type { ProjectState } from "../api/projects";
import { reorderCategory, reorderTask } from "../project/optimistic";
import { useProjectMutation } from "../project/useProjectMutation";

/**
 * Reordering rows by dragging them by the left column.
 *
 * There are two gestures, and they are kept apart on purpose: a bar is dragged
 * horizontally and changes dates, a row is dragged by its handle and changes
 * order. One motion — one consequence. Mixing them would mean knocking
 * everybody's dates about whenever they tried to reorder a row and missed by a
 * pixel downwards.
 *
 * There are two breeds of row, and both are dragged the same way: a task
 * changes its place inside its own stage or moves to a neighbouring one, a
 * category changes its place in the list of stages. One gesture for both rather
 * than two similar ones: a handle that behaves differently on a heading and on
 * the row below it is two things that look like one.
 *
 * The client sends only the target position (and the category, for a task):
 * pushing the neighbours apart and writing their shifts into the journal is the
 * server's job, and a second implementation of the same computation here would
 * diverge from it on the very first move between categories.
 */

export type RowKind = "task" | "category";
export type DropTarget = { kind: RowKind; id: string; half: "top" | "bottom" };
/** What is in hand right now. */
export type DraggedRow = { kind: RowKind; id: string };

/** The upper half of a row or the lower one — from real bounds, not from an index. */
export function halfOf(row: Element, clientY: number): "top" | "bottom" {
  const box = row.getBoundingClientRect();
  return clientY < box.top + box.height / 2 ? "top" : "bottom";
}

/**
 * The row under the pointer — by the point's coordinates, not by the event's
 * target.
 *
 * With a finger, after the press the pointer is implicitly captured by the
 * handle the gesture started on: until the gesture ends all events go to it
 * alone, and the row the finger is being led over never learns about the
 * movement. Relying on who received the event means supporting reordering with
 * a mouse only — and `touch-action` on the handle promises the opposite.
 */
function targetAt(clientX: number, clientY: number): DropTarget | null {
  // jsdom does not have the method, and a browser returns `null` beyond the
  // window's edge: there may be no hit, and that is not an error but "the
  // finger is not over a row".
  const under = document.elementFromPoint?.(clientX, clientY) ?? null;
  const row = under?.closest<HTMLElement>("[data-drop-id]") ?? null;
  const id = row?.dataset.dropId;
  if (row === null || id === undefined) return null;
  return {
    kind: row.dataset.dropKind === "category" ? "category" : "task",
    id,
    half: halfOf(row, clientY),
  };
}

/** The ghost's position — as properties written straight into the node, past React state. */
function moveGhost(node: HTMLElement, at: { x: number; y: number }): void {
  node.style.setProperty("--drag-x", `${at.x}px`);
  node.style.setProperty("--drag-y", `${at.y}px`);
}

function byOrder<T extends { position: number; id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
}

/** Where the task will land if it is released here. */
function placeForTask(
  state: ProjectState,
  taskId: string,
  target: DropTarget,
): { categoryId: string; position: number } | null {
  if (target.kind === "category") {
    // A drop on a heading means "put it in this category", not a choice of
    // place inside it: the place is chosen by aiming between rows.
    return {
      categoryId: target.id,
      position: state.tasks.filter((row) => row.category_id === target.id && row.id !== taskId)
        .length,
    };
  }

  const over = state.tasks.find((row) => row.id === target.id);
  if (!over) return null;

  const siblings = byOrder(
    state.tasks.filter((row) => row.category_id === over.category_id && row.id !== taskId),
  );
  const index = siblings.findIndex((row) => row.id === over.id);
  if (index === -1) return null;

  return { categoryId: over.category_id, position: target.half === "top" ? index : index + 1 };
}

/**
 * Where the category will land if it is released here.
 *
 * The number is counted among the remaining stages, without the one being
 * moved: the same as for a task, and for the same reason — a row taken out of
 * the list does not number its own neighbours.
 */
function placeForCategory(
  state: ProjectState,
  categoryId: string,
  target: DropTarget,
): number | null {
  if (target.kind !== "category") return null;
  const others = byOrder(state.categories.filter((row) => row.id !== categoryId));
  const index = others.findIndex((row) => row.id === target.id);
  if (index === -1) return null;
  return target.half === "top" ? index : index + 1;
}

export function useReorder({
  projectId,
  state,
  canWrite,
}: {
  projectId: string;
  state: ProjectState;
  canWrite: boolean;
}) {
  const { apply } = useProjectMutation(projectId);
  const [dragged, setDragged] = useState<DraggedRow | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);

  // The ghost is a copy of the row being moved, under the cursor. Its position
  // is written straight into the node as properties, past React state: the
  // point changes on every movement of the hand, and repainting the strip for
  // it would mean rebuilding a hundred rows ten times a second (the category
  // band is led the same way, see useDragCategory).
  const ghost = useRef<HTMLElement | null>(null);
  const point = useRef({ x: 0, y: 0 });

  /**
   * The ghost's node. The position is written as soon as it appears: there is
   * no node at press time, and without this the ghost would stand in the corner
   * of the window for the gesture's first frame and jump from there under the
   * cursor on the very first movement.
   */
  const ghostRef = useCallback((element: HTMLElement | null) => {
    ghost.current = element;
    if (element !== null) moveGhost(element, point.current);
  }, []);

  // The gesture's point is listened for on the window rather than on the handle
  // or the rows: with a mouse the events go to the row under the cursor, with a
  // finger to the handle that captured the pointer, and a ghost subscribed to
  // one of the two would lag in exactly the other case.
  useEffect(() => {
    if (dragged === null) return;
    const follow = (event: globalThis.PointerEvent) => {
      point.current = { x: event.clientX, y: event.clientY };
      const node = ghost.current;
      if (node !== null) moveGhost(node, point.current);
      // With a mouse the rows report the target themselves (see handleProps):
      // over the header or the toolbar there is nobody to report it, and the
      // insertion line would stay on a row the cursor left long ago, even
      // though a drop there no longer does anything. With a finger the pointer
      // is captured by the handle and the event always comes from its own row —
      // that case is driven by `targetAt` rather than by the rows.
      const target = event.target instanceof Element ? event.target : null;
      if (target !== null && target.closest("[data-drop-id]") === null) setTarget(null);
    };
    window.addEventListener("pointermove", follow);
    return () => window.removeEventListener("pointermove", follow);
  }, [dragged]);

  // The button can be released away from the rows too — beyond the strip's
  // edge, over the header, outside the window entirely. Without this listener
  // the row would stay "in hand" forever, and the next mouse movement would
  // reorder it with no press at all.
  useEffect(() => {
    if (dragged === null) return;
    const finish = () => {
      setDragged(null);
      setTarget(null);
    };
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [dragged]);

  const start = (row: DraggedRow, at: { x: number; y: number }) => {
    if (!canWrite) return;
    point.current = at;
    setDragged(row);
    setTarget(null);
  };

  /**
   * The row under the pointer → a target that can be accepted.
   *
   * A task aims between rows and at headings: both are places for it. A
   * category aims only at headings, so a task's row means its stage: otherwise
   * you would have to land precisely on the narrow strip of a heading standing
   * ten rows above. A stage does not go inside itself — "somewhere around here"
   * means "after this stage" for it.
   */
  const aimAt = (raw: DropTarget | null): DropTarget | null => {
    if (raw === null || dragged === null) return null;

    if (dragged.kind === "task") {
      // No insertion line is drawn over the row itself: it would promise a move
      // to where the row already stands.
      return raw.kind === "task" && raw.id === dragged.id ? null : raw;
    }

    if (raw.kind === "task") {
      const task = state.tasks.find((row) => row.id === raw.id);
      if (task === undefined) return null;
      return task.category_id === dragged.id
        ? null
        : { kind: "category", id: task.category_id, half: "bottom" };
    }
    return raw.id === dragged.id ? null : raw;
  };

  /** `null` — the finger was led away from the rows: the insertion line goes out, the drop does nothing. */
  const over = (next: DropTarget | null) => {
    if (dragged === null) return;
    setTarget(aimAt(next));
  };

  const dropTask = (taskId: string, spot: DropTarget) => {
    const place = placeForTask(state, taskId, spot);
    if (place === null) return;

    // A row returned to its own place is not a change: we compare not the
    // indices but the whole order after the reorder. The indices cannot be
    // compared, because one and the same position is counted differently
    // depending on where the row came from.
    const next = reorderTask(state, taskId, place.categoryId, place.position);
    const unchanged = next.tasks.every((row) => {
      const before = state.tasks.find((old) => old.id === row.id);
      return (
        before !== undefined &&
        before.position === row.position &&
        before.category_id === row.category_id
      );
    });
    if (unchanged) return;

    void apply(
      {
        type: "reorder_task",
        task_id: taskId,
        category_id: place.categoryId,
        position: place.position,
      },
      (current) => reorderTask(current, taskId, place.categoryId, place.position),
    ).catch(() => {
      // The rollback has already been done inside `apply`: the row returned
      // where it was taken from, and that is the answer to the refusal.
    });
  };

  const dropCategory = (categoryId: string, spot: DropTarget) => {
    const position = placeForCategory(state, categoryId, spot);
    if (position === null) return;

    // The same "did anything change" reckoning as for a task, and for the same
    // reason: a stage dropped below its own upper neighbour arrives at its own
    // number, and there is nothing to write into history for that.
    const next = reorderCategory(state, categoryId, position);
    const unchanged = next.categories.every((row) => {
      const before = state.categories.find((old) => old.id === row.id);
      return before !== undefined && before.position === row.position;
    });
    if (unchanged) return;

    void apply({ type: "reorder_category", category_id: categoryId, position }, (current) =>
      reorderCategory(current, categoryId, position),
    ).catch(() => {
      // The rollback has already been done inside `apply`.
    });
  };

  const drop = () => {
    if (dragged === null) return;
    const row = dragged;
    const spot = target;
    setDragged(null);
    setTarget(null);
    if (spot === null) return;
    if (row.kind === "category") dropCategory(row.id, spot);
    else dropTask(row.id, spot);
  };

  /**
   * What to show in the ghost: the name of the row being moved and its stage's
   * colour.
   *
   * The name, not the whole row: under the cursor you need to recognize what
   * exactly is in hand — dates and percentages are not being asked about at
   * that moment, and a half-screen copy of the row would cover the very place
   * being aimed at.
   */
  const ghostRow = (() => {
    if (dragged === null) return null;
    if (dragged.kind === "category") {
      const category = state.categories.find((row) => row.id === dragged.id);
      return category === undefined
        ? null
        : { kind: dragged.kind, name: category.name, color: category.color };
    }
    const task = state.tasks.find((row) => row.id === dragged.id);
    if (task === undefined) return null;
    const category = state.categories.find((row) => row.id === task.category_id);
    return { kind: dragged.kind, name: task.name, color: category?.color };
  })();

  return {
    /** Whether to show the drag handles. A guest has none at all. */
    enabled: canWrite,
    /** Whether a reorder is running right now. */
    active: dragged !== null,
    /** What exactly is in hand: the row goes dim and its name travels with the cursor. */
    dragging: dragged,
    /** The contents of the ghost under the cursor. `null` — nothing is being dragged. */
    ghost: ghostRow,
    ghostRef,

    start,
    over,
    drop,

    /**
     * A row's handle. It is not only what the gesture is started with — it is
     * also what leads it.
     *
     * With a finger the pointer is captured by the handle (see `targetAt`), and
     * events never reach other rows: the handle finds the drop target itself,
     * by hit-testing the point. With a mouse the events go to the rows, and
     * their handlers lead the gesture; here the handle repeats the same
     * computation for the row under the cursor and therefore stops the event —
     * otherwise its own row, which the event would bubble up to, would erase
     * the found target as a "drop onto itself".
     */
    handleProps(kind: RowKind, id: string) {
      return {
        onPointerDown(event: PointerEvent<HTMLElement>) {
          // The primary button only — as with every gesture on the strip: the
          // right one calls up the context menu, and that eats the release,
          // leaving the row's ghost travelling with the cursor with nothing
          // pressed.
          if (event.button !== 0) return;
          // Without this the press takes the focus away and starts a text
          // selection instead of a drag.
          event.preventDefault();
          start({ kind, id }, { x: event.clientX, y: event.clientY });
        },
        onPointerMove(event: PointerEvent<HTMLElement>) {
          if (dragged === null) return;
          event.stopPropagation();
          over(targetAt(event.clientX, event.clientY));
        },
        onPointerUp(event: PointerEvent<HTMLElement>) {
          if (dragged === null) return;
          event.stopPropagation();
          drop();
        },
      };
    },

    /**
     * A row's class for the duration of the gesture: the one in hand is dimmed,
     * the one under the cursor carries the insertion line.
     *
     * A stage heading answers a drop in two different ways, and the difference
     * is not cosmetic: a task is put inside it (a fill across the whole row),
     * while a category stands before or after it (a line along the edge). One
     * and the same sign for two different outcomes would promise something
     * other than what will happen.
     */
    markFor(kind: RowKind, id: string): string {
      if (dragged !== null && dragged.kind === kind && dragged.id === id) return "is-dragged";
      if (target === null || target.kind !== kind || target.id !== id) return "";
      if (kind === "category" && dragged?.kind === "task") return "drop-into";
      return target.half === "top" ? "drop-before" : "drop-after";
    },
  };
}

export type Reorder = ReturnType<typeof useReorder>;
