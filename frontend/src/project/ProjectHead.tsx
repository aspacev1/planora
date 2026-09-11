import type { ReactNode } from "react";

import type { ProjectState } from "../api/projects";
import { relativeDayLabel } from "../gantt/relative";
import { formatDate } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";
import { planChanges } from "./planChanges";
import { projectMetrics, projectPeriod } from "./summary";

/**
 * The project's header: the name, the summary, the actions on the right.
 *
 * It has stayed with the public page (`/p/...`), where nothing else stands above the
 * strip and the tiers' height is shared with nobody. The project's working screen
 * wears a single-line `ProjectBar` instead: there a row of tabs and a toolbar also
 * stood above the strip, and four tiers together left the tasks a third of the window.
 *
 * The name is large — it is where you have landed; the summary under it answers "how
 * much is this and when" before a person starts counting bars by eye; the actions
 * stand apart on the right — what people come back here for.
 */
export function ProjectHead({
  state,
  actions,
}: {
  state: ProjectState;
  /** The buttons above the name. Not handed to a guest at all — they have none. */
  actions?: ReactNode;
}) {
  const period = projectPeriod(state);

  return (
    <header className="project-head">
      <div className="project-head__main">
        {/* The name and the summary are one pair, as in the Planora mockup: the
            project's name on the left, the key actions on the right, the service data on the line below. */}
        <div className="project-head__titles">
          {/* The project's name is user content: it arrives from the server as is and
              is not translated whatever the interface language. */}
          <div className="project-head__title-row">
            <h1 className="project-head__title">{state.name}</h1>
          </div>

          {/* The work's dates and nothing more. The count of categories and tasks is
              gone: the metrics bar below names the same number of tasks in large type
              and in the row with the rest, while the count of categories answered none
              of the questions asked on opening a project. A project with no tasks has
              no dates — and no line either. */}
          {period && (
            <p className="project-head__meta">
              <ProjectPeriod state={state} />
            </p>
          )}
        </div>

        {actions && <div className="project-head__actions">{actions}</div>}
      </div>

      <ProjectMetrics state={state} />
    </header>
  );
}

/**
 * The plan's state: the version and the divergence marker.
 *
 * One piece of markup for the full header and for the working screen's line —
 * otherwise the two kinds of header would one day name different numbers for one
 * project. The divergence from the approved plan is read together with the project's
 * name: it is what state it is in, not how many tasks it has.
 */
export function PlanState({
  state,
  onShowChanges,
}: {
  state: ProjectState;
  onShowChanges?: () => void;
}) {
  const { t } = useLocale();
  // How many tasks have diverged from the approved plan. The same count the open panel
  // shows: the marker in the header and the list in it must know one and the same thing.
  const changed = planChanges(state).taskCount;
  const note = t("plan.changed_count", { count: changed, version: state.plan_version });

  return (
    <>
      {/* A draft and an approved plan are one badge in two colours rather than two
          different signs: `data-state` names the state, the theme gives it the colour. */}
      <span
        className="project-head__plan-label"
        data-state={state.plan_approved_at ? "approved" : "draft"}
      >
        {/* The text is a separate node: on a phone all that is left of the chip is a
            dot, and the words go into a caption invisible to the eye but read aloud
            (see `.project-head__plan-text` in the theme). */}
        <span className="project-head__plan-text">
          {state.plan_approved_at
            ? t("plan.line", { version: state.plan_version })
            : t("plan.line_draft")}
        </span>
      </span>
      {/* The divergence from the plan names itself with the number of tasks rather than
          with the mere fact: "3 tasks changed" answers "how serious is this" before the
          list is opened, while the former "changed after approval" made you open it
          every time. Tasks are counted, not edits: a number growing from repeated
          movements of one bar would speak of fuss rather than of the plan.

          A button rather than a set: there is now somewhere to go behind the marker.
          Where there is nowhere to go (the public page) it stays text — a control that
          does nothing when pressed is worse than its absence. */}
      {changed > 0 &&
        (onShowChanges ? (
          <button type="button" className="project-head__plan-note" onClick={onShowChanges}>
            {note}
            {/* The chevron is the same sign the application marks the unfoldable with:
                it promises a continuation and tells a pressable chip from the neighbour
                that merely reports. */}
            <span className="project-head__plan-chevron" aria-hidden="true">
              ▾
            </span>
          </button>
        ) : (
          <span className="project-head__plan-note">{note}</span>
        ))}
    </>
  );
}

/**
 * The work's dates in the words of the interface language.
 *
 * A relative plan has project days instead of dates: "Day 1 — Day 45". It has no real
 * dates yet, and substituting the axis's coordinates here would mean naming an
 * invented date.
 */
export function ProjectPeriod({ state }: { state: ProjectState }) {
  const { t } = useLocale();
  const period = projectPeriod(state);
  if (period === null) return null;

  return (
    <>
      {state.schedule_mode === "relative"
        ? t("project.period", {
            from: relativeDayLabel(t, period.from),
            to: relativeDayLabel(t, period.to),
          })
        : t("project.period", {
            from: formatDate(t, period.from),
            to: formatDate(t, period.to),
          })}
    </>
  );
}

/**
 * The metrics bar under the project's name.
 *
 * It answers "how much work is here and what is wrong with it" with figures rather
 * than with the bars' colour: the summary above names the volume, the bar names the
 * state. The four statuses do not overlap and add up to "Total", while "Past the
 * project's deadline" and "Beyond the plan" are flags on top of a status and are not
 * part of the sum.
 *
 * Hence a consequence worth keeping in mind when reading the figures: a finished task
 * also falls into the overdue ones if it ended after the deadline. "Finished" and
 * "Past the project's deadline" overlap deliberately — they are answers to different
 * questions: "is it done" and "was it on time".
 */
function ProjectMetrics({ state }: { state: ProjectState }) {
  const { t } = useLocale();
  // The plan line and the "beyond the plan" count are internal kitchen: the plan's
  // version and the divergence from it are not promised to a client following a link,
  // and the public header does not show them. The working screen computes them in
  // `PlanSummary`.
  const metrics = projectMetrics(state, false);

  return (
    <ul className="project-head__metrics" aria-label={t("project.metrics.label")}>
      {metrics.map((metric) => (
        <li
          key={metric.key}
          className={`project-head__metric${metric.warn ? " is-warn" : ""}`}
        >
          <strong className="project-head__metric-value">{metric.value}</strong>
          <span className="project-head__metric-label">
            {t(`project.metrics.${metric.key}`)}
          </span>
        </li>
      ))}
    </ul>
  );
}
