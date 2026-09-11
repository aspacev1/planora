import type { TaskStatus } from "../api/projects";

/**
 * A status chip. The caption arrives ready: the callers' dictionaries differ (`task.status.*` against
 * "3 blocked" on a card), while the colour is shared, and it lives in one place — in the styles by
 * `data-status`.
 */
export function StatusChip({ status, label }: { status: TaskStatus; label: string }) {
  return (
    <span className="status-chip" data-status={status}>
      {label}
    </span>
  );
}
