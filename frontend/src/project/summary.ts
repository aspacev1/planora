import type { ProjectState } from "../api/projects";
import { isBeyondPlan } from "./baseline";
import { statusCounts } from "./progress";
import { pastDeadlineTasks } from "./verdict";

/**
 * A project's summary in figures: the work's dates and the metrics bar.
 *
 * Computed outside the markup, because it is now shown in three places — the public page's
 * full header, the summary line above the strip and (later on) the project card — and these
 * three have no right to diverge: two kinds of header could once already name different
 * numbers for one project. The cells' captions do not live here: the module gives a key,
 * and the interface language picks the word for it.
 */

/** One cell of the bar. `warn` — a red figure: a state that demands a decision. */
export type Metric = { key: string; value: number; warn?: boolean };

/**
 * Up to seven figures in the bar — up to six on the public page; zero ones are excluded
 * except for "Total" and "Blocked", which always stand.
 *
 * "Beyond the plan" is computed from the baseline plan, and it is absent where the plan line
 * itself is absent: the plan's version and the divergences from it are not shown by link
 * (`showPlan`), and one figure must not go round that rule by the back door.
 *
 * Being overdue is measured by the project's deadline rather than by a task's own dates —
 * the same reckoning the strip puts a notch on a bar with. In the model the deadline is one
 * per project; a task's deviation from its baseline plan is a different quantity, and it is
 * shown by the "+N d." badge next to the bar. The cell's caption names the project's
 * deadline outright, so that the two are not read as one.
 */
export function projectMetrics(state: ProjectState, showPlan: boolean): Metric[] {
  const counts = statusCounts(state.tasks);
  // Computed by the shared module: the same quantity under the same name lives on the
  // project card and in the reports, and three reckonings of it would diverge on the very
  // first disputable day.
  const overdue = pastDeadlineTasks(state).length;

  const metrics: Metric[] = [
    { key: "total", value: state.tasks.length },
    { key: "in_progress", value: counts.in_progress },
    // Red only for a non-zero count: a permanent cell with a red zero would keep an alarm on
    // a screen with nothing to be alarmed about.
    { key: "blocked", value: counts.blocked, warn: counts.blocked > 0 },
    { key: "overdue", value: overdue, warn: true },
    { key: "not_started", value: counts.planned },
    // Work beyond the plan is not set in the alarm colour: adding it is normal — what is
    // alarming is a hidden shift of dates, and the deviation badge speaks about that.
    ...(showPlan
      ? [
          {
            key: "not_planned",
            value: state.tasks.filter((task) => isBeyondPlan(state, task)).length,
          },
        ]
      : []),
    { key: "completed", value: counts.done },
  ];

  // The bar does not show zero cells: seven cells, half of them zeros, hide the ones the bar
  // exists for. There are two exceptions — the cells whose disappearance reads as a broken
  // count rather than as "everything is fine": "Total" is the bottom line, the only figure an
  // empty project has; "Blocked" is the only status a person assigns, and its count is looked
  // for by eye in its usual place even at zero — a vanished cell has already been taken for a
  // vanished counter. A zero in it is set in black: only a non-zero value turns the alarm on.
  return metrics.filter(
    (metric) => metric.value > 0 || metric.key === "total" || metric.key === "blocked",
  );
}

/**
 * The project's dates: from the earliest start to the latest end.
 *
 * Not the strip's window: that one is rounded to whole months so that the chart's header does
 * not start with a truncated month, and "27 July — 6 September" would turn in it into "1 July
 * — 30 September". What is needed here is the work's dates specifically.
 *
 * The project end computed by the server is taken into account on a par with the tasks: it can
 * be later than the last of them, and a summary that forgot about it would promise a shorter
 * span than the real one. A project with no tasks has no dates — and no line about them either.
 */
export function projectPeriod(state: ProjectState): { from: string; to: string } | null {
  if (state.tasks.length === 0) return null;
  // ISO strings compare lexicographically exactly like dates: their fields have a fixed width
  // and the most significant one is on the left.
  const from = state.tasks.map((task) => task.start_date).reduce((a, b) => (a < b ? a : b));
  const to = [
    ...state.tasks.map((task) => task.end_date),
    ...(state.project_end ? [state.project_end] : []),
  ].reduce((a, b) => (a > b ? a : b));
  return { from, to };
}
