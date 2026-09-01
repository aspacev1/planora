import type { ProjectState } from "../api/projects";
import { useLocale } from "../i18n/LocaleProvider";
import { ProjectPeriod } from "./ProjectHead";
import { projectMetrics } from "./summary";

/**
 * Сводка проекта: срок работ и все метрики — в раскрывающейся панели у имени.
 *
 * Пришла на место полосы карточек в 52 пикселя, которая стояла над каждым
 * экраном проекта. Постоянного места ей больше нет, и не от жадности к
 * пикселям: в строке с именем, вкладками и действиями семь цифр не помещаются
 * ни на одном ноутбуке — строка переносится, и ярус возвращается тот же, от
 * которого уходили. Открывают её тогда, когда спрашивают «сколько тут
 * работы», а спрашивают не каждым взглядом на план.
 *
 * Считает общий модуль — тот же счёт, что у полной шапки публичной страницы:
 * два вида сводки не имеют права назвать одному проекту разные числа.
 */
export function PlanSummary({ state }: { state: ProjectState }) {
  const { t } = useLocale();
  const metrics = projectMetrics(state, true);

  return (
    <div className="plan-summary">
      {/* Срок первым: «когда» отвечает на вопрос раньше, чем «сколько».
          Проекту без задач срока нет — и строки о нём тоже. */}
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
