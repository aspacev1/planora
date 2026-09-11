import type { Zoom } from "./scale";

const STORAGE_PREFIX = "planora.gantt_scale.";

const ZOOMS: readonly Zoom[] = ["day", "week", "month"];

function isZoom(value: string | null): value is Zoom {
  return value !== null && (ZOOMS as readonly string[]).includes(value);
}

/**
 * The strip's last chosen scale for this project.
 *
 * The scale lives in the browser tied to the project rather than under one shared key: a person flips
 * through several projects in a row, and a yearly portfolio at a weekly scale must not stand in for a
 * sprint's daily scale. Switching to the "History" tab and back, leaving for another screen and
 * returning — all of that unmounts the strip, and without memory here it would open at "day" again, as
 * if there had been no choice.
 *
 * A browser's private mode can forbid localStorage — the scale then simply does not survive a move
 * between screens. That is no reason to crash (see LocaleProvider and guestName.ts, the same device).
 */
export function storedZoom(projectId: string): Zoom | null {
  try {
    const value = localStorage.getItem(STORAGE_PREFIX + projectId);
    return isZoom(value) ? value : null;
  } catch {
    return null;
  }
}

export function rememberZoom(projectId: string, zoom: Zoom): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + projectId, zoom);
  } catch {
    // see storedZoom()
  }
}
