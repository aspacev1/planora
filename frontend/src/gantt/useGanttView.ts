import { useCallback, useEffect, useState } from "react";

import type { ColumnKey, ColumnLayout } from "./columns";
import {
  defaultLayout,
  rememberLayout,
  reorderColumns,
  storedLayout,
  toggleColumn,
} from "./columns";
import type { Zoom } from "./scale";
import { rememberZoom, storedZoom } from "./scalePreference";

/** Which of the optional layers to show. The screen's state, not the project's. */
export type ViewFlags = {
  baseline: boolean;
  legend: boolean;
  summary: boolean;
  caption: boolean;
  critical: boolean;
};

/**
 * How to look at the strip: the scale, the table's columns, the layers.
 *
 * As one thing rather than three apart: the controls for this state stand not in the strip
 * but in the project screen's header (see ProjectBar), and the strip gets it ready-made —
 * by the same path as on the public page, where it creates it itself. Two owners of one
 * state would diverge on the very first scale switch: the header would show "Month" while
 * the strip drew days.
 */
export type GanttView = {
  zoom: Zoom;
  setZoom: (next: Zoom) => void;
  layout: ColumnLayout;
  setLayout: (next: ColumnLayout) => void;
  switchColumn: (column: ColumnKey) => void;
  toggleTable: () => void;
  resizeColumn: (column: ColumnKey, width: number) => void;
  moveColumn: (moved: ColumnKey, before: ColumnKey) => void;
  /** Whether the layer is on. The baseline plan can be decided from outside (see options). */
  flag: (flag: keyof ViewFlags) => boolean;
  toggle: (flag: keyof ViewFlags) => void;
};

export function useGanttView(
  projectId: string,
  {
    baselineShown,
    onBaselineToggle,
  }: {
    /**
     * Whether to show the ghost of the approved plan — from outside.
     *
     * Not passed — the strip decides itself with its "View" checkbox. Passed — the screen
     * decides, and the same toggle stands in the changes panel.
     */
    baselineShown?: boolean;
    onBaselineToggle?: () => void;
  } = {},
): GanttView {
  // By default the strip opens at the day scale — the largest: at it a division has room
  // for the weekday above the date, and the first thing a person sees is the coming days
  // rather than a quarter squeezed beyond recognition. But if a scale has already been
  // chosen for this project, the strip opens at it: switching tabs and going to another
  // screen must not ask again every time what has already been decided (see scalePreference.ts).
  const [zoom, setZoomState] = useState<Zoom>(() => storedZoom(projectId) ?? "day");

  // The project screen does not unmount the strip on an address change — the same
  // components simply get a different `projectId`. Without this effect the strip would drag
  // the previous project's scale along when moving between projects instead of remembering
  // the one last chosen here.
  useEffect(() => {
    setZoomState(storedZoom(projectId) ?? "day");
  }, [projectId]);

  const setZoom = useCallback(
    (next: Zoom) => {
      setZoomState(next);
      rememberZoom(projectId, next);
    },
    [projectId],
  );

  // The pinned table's columns — the set and the widths. They live in the same place as the
  // scale and for the same reason: the layout is the screen's state, tied to the project,
  // rather than a property of the plan, and a colleague on the project must not get
  // somebody else's.
  const [layout, setLayoutState] = useState<ColumnLayout>(
    () => storedLayout(projectId) ?? defaultLayout(),
  );
  useEffect(() => {
    setLayoutState(storedLayout(projectId) ?? defaultLayout());
  }, [projectId]);

  // A stable reference: the strip unfolds a collapsed table with an effect when an input row
  // is opened in it, and the effect depends on this function — a new reference on every
  // render would keep firing it for nothing.
  const setLayout = useCallback(
    (next: ColumnLayout) => {
      setLayoutState(next);
      rememberLayout(projectId, next);
    },
    [projectId],
  );
  const switchColumn = (column: ColumnKey) =>
    setLayout({ ...layout, shown: toggleColumn(layout.shown, column) });
  // The whole table: a collapsed one gives all its room to the scale. Half a year of a plan
  // is otherwise visible only in pieces — the table takes a third of the screen, and the
  // project's shape cannot be made out behind it without scrolling away from the task names.
  const toggleTable = () => setLayout({ ...layout, collapsed: !layout.collapsed });
  const resizeColumn = (column: ColumnKey, width: number) =>
    setLayout({ ...layout, widths: { ...layout.widths, [column]: width } });
  const moveColumn = (moved: ColumnKey, before: ColumnKey) =>
    setLayout({ ...layout, shown: reorderColumns(layout.shown, moved, before) });

  // The optional layers. The baseline plan and the deadline summary are visible right away:
  // the first is the language of deviations, the second is the only figure that genuinely
  // interests the customer. The legend and the footnote wait until they are asked for
  // through "View" — as in the mockup, where they are absent entirely.
  const [flags, setFlags] = useState<ViewFlags>({
    baseline: true,
    legend: false,
    summary: true,
    caption: false,
    // The critical path waits until it is asked for: it colours the bars a third way on top
    // of the status and being overdue, and switched on always it would turn the strip into a
    // map of chains where all that is being asked is "what is when".
    critical: false,
  });
  const toggleFlag = (flag: keyof ViewFlags) =>
    setFlags((current) => ({ ...current, [flag]: !current[flag] }));

  // The baseline plan's ghost is the only layer also driven from outside: the changes panel
  // shows the same divergences as a list and switches the very same ones on in the strip.
  // The "View" checkbox and the panel's switch must be one toggle rather than two identical
  // ones — otherwise one says "on" where the other has already switched off. Its own state
  // stays in reserve: the public page has no changes panel, and there is nowhere for it to
  // lift the flag to.
  const baselineOn = baselineShown ?? flags.baseline;
  const flag = (name: keyof ViewFlags) => (name === "baseline" ? baselineOn : flags[name]);
  const toggle = (name: keyof ViewFlags) =>
    name === "baseline" && onBaselineToggle ? onBaselineToggle() : toggleFlag(name);

  return {
    zoom,
    setZoom,
    layout,
    setLayout,
    switchColumn,
    toggleTable,
    resizeColumn,
    moveColumn,
    flag,
    toggle,
  };
}
