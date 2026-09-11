import type { ProjectState } from "../api/projects";
import { useLocale } from "../i18n/LocaleProvider";
import { ProjectPeriod } from "./ProjectHead";
import { projectMetrics } from "./summary";

/**
 * The project's summary: the work's dates and all the metrics — in an unfolding panel by the name.
 *
 * It came in place of a 52-pixel card bar that stood above every project screen. It has no permanent
 * place any more, and not out of greed for pixels: seven figures do not fit on the line with the name,
 * the tabs and the actions on any laptop — the line wraps, and back comes the same tier that was left
 * behind. It is opened when "how much work is here" is asked, and that is not asked with every glance
 * at the plan.
 *
 * It is computed by the shared module — the same reckoning as the public page's full header: two kinds
 * of summary have no right to name different numbers for one project.
 */
export function PlanSummary({ state }: { state: ProjectState }) {
  const { t } = useLocale();
  const metrics = projectMetrics(state, true);

  return (
    <div className="plan-summary">
      {/* The dates first: "when" answers the question before "how much" does. A project with no tasks
          has no dates — and no line about them either. */}
      <p className="plan-summary__period">
        <ProjectPeriod state={state} />
      </p>
      <ul className="plan-summary__metrics" aria-label={t("project.metrics.label")}>
        {metrics.map((metric) => (
          <li key={metric.key} className={metric.warn ? "is-warn" : undefined}>
            <strong className="plan-summary__value">{metric.value}</strong>
            <span className="plan-summary__label">{t(`project.metrics.${metric.key}`)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
