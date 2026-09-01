import type { ReactNode } from "react";

import type { ProjectState } from "../api/projects";
import { relativeDayLabel } from "../gantt/relative";
import { formatDate } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";
import { planChanges } from "./planChanges";
import { projectMetrics, projectPeriod } from "./summary";

/**
 * Шапка проекта: название с состоянием плана, сводка, действия справа.
 *
 * Осталась публичной странице (`/p/...`), где над лентой больше ничего не
 * стоит и высота ярусов ни с кем не делится. Рабочий экран проекта носит
 * вместо неё однострочную `ProjectBar`: там над лентой стоял ещё ряд вкладок
 * и тулбар, и четыре яруса вместе оставляли задачам треть окна.
 *
 * Название крупное — это то, куда попал; сводка под ним отвечает на «сколько
 * это и когда» до того, как человек начнёт считать полоски глазами; действия
 * стоят особняком справа — то, ради чего сюда возвращаются.
 */
export function ProjectHead({
  state,
  actions,
  planAction,
  onShowChanges,
  showPlan = false,
}: {
  state: ProjectState;
  /** Кнопки над названием. Гостю не передаются вовсе — их у него нет. */
  actions?: ReactNode;
  /** Кнопка согласования плана. Своей строки не рисует — становится в строку названия. */
  planAction?: ReactNode;
  /**
   * Показать, что именно разошлось с согласованным планом. Не передано —
   * пометка о расхождении остаётся текстом и никуда не ведёт.
   */
  onShowChanges?: () => void;
  /**
   * Показывать ли строку плана. Публичная страница её не показывает: версия
   * плана и расхождение с ним — внутренняя кухня, а не то, что обещано клиенту
   * по ссылке.
   */
  showPlan?: boolean;
}) {
  const period = projectPeriod(state);

  return (
    <header className="project-head">
      <div className="project-head__main">
        {/* Название и сводка — одна пара, как в макете Planora: имя проекта
            слева, ключевые действия справа, служебные данные строкой ниже. */}
        <div className="project-head__titles">
          {/* Название проекта — содержимое пользователя: приходит с сервера как
              есть и не переводится ни при каком языке интерфейса. */}
          <div className="project-head__title-row">
            <h1 className="project-head__title">{state.name}</h1>
            {/* Состояние плана едет за названием: у короткого имени стоит
                рядом, за длинным переносится следом — расстояние от имени до
                плашки всегда одно и то же. */}
            {showPlan && (
              <span className="project-head__plan-inline">
                <PlanState state={state} onShowChanges={onShowChanges} />
                {planAction && <span className="project-head__approval">{planAction}</span>}
              </span>
            )}
          </div>

          {/* Срок работ и ничего больше. Счёт категорий и задач ушёл: полоса
              метрик ниже называет то же число задач крупно и в ряду
              остальных, а счёт категорий не отвечал ни на один вопрос,
              который задают, открыв проект. Проекту без задач срока нет — и
              строки тоже. */}
          {period && (
            <p className="project-head__meta">
              <ProjectPeriod state={state} />
            </p>
          )}
        </div>

        {actions && <div className="project-head__actions">{actions}</div>}
      </div>

      <ProjectMetrics state={state} showPlan={showPlan} />
    </header>
  );
}

/**
 * Состояние плана: версия и пометка о расхождении.
 *
 * Одна разметка на полную шапку и на строку рабочего экрана — иначе два вида
 * шапки однажды назвали бы одному проекту разные числа. Расхождение с
 * согласованным планом читается вместе с именем проекта: это то, в каком он
 * состоянии, а не сколько в нём задач.
 */
export function PlanState({
  state,
  onShowChanges,
}: {
  state: ProjectState;
  onShowChanges?: () => void;
}) {
  const { t } = useLocale();
  // Сколько задач разошлось с согласованным планом. Тот же счёт, что показывает
  // открытое окно: пометка в шапке и список в нём обязаны знать одно и то же.
  const changed = planChanges(state).taskCount;
  const note = t("plan.changed_count", { count: changed, version: state.plan_version });

  return (
    <>
      {/* Черновик и согласованный план — один бейдж двух цветов, а не два
          разных знака: `data-state` называет состояние, цвет ему даёт тема. */}
      <span
        className="project-head__plan-label"
        data-state={state.plan_approved_at ? "approved" : "draft"}
      >
        {state.plan_approved_at
          ? t("plan.line", { version: state.plan_version })
          : t("plan.line_draft")}
      </span>
      {/* Расхождение с планом называет себя числом задач, а не одним лишь
          фактом: «изменены 3 задачи» отвечает на «насколько всё серьёзно» до
          того, как список открыт, а прежнее «изменён после согласования»
          заставляло открывать его всегда. Считаются задачи, а не правки:
          число, растущее от повторных движений одной полоски, говорило бы о
          суете, а не о плане.

          Кнопка, а не набор: за пометкой теперь есть куда пойти. Там, где идти
          некуда (публичная страница), она остаётся текстом — орган управления,
          ничего не делающий по нажатию, хуже, чем его отсутствие. */}
      {changed > 0 &&
        (onShowChanges ? (
          <button type="button" className="project-head__plan-note" onClick={onShowChanges}>
            {note}
            {/* Уголок — тот же знак, каким приложение обозначает
                разворачивающееся: он обещает продолжение и отличает
                нажимаемую плашку от соседней, которая просто сообщает. */}
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
 * Срок работ словами языка интерфейса.
 *
 * У относительного плана вместо дат — дни проекта: «День 1 — День 45».
 * Настоящих сроков у него ещё нет, и подставить сюда координаты оси значило бы
 * назвать выдуманную дату.
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
 * Полоса метрик под названием проекта.
 *
 * Отвечает на «сколько тут работы и что с ней не так» цифрами, а не цветом
 * полосок: сводка выше называет объём, полоса — состояние. Четыре статуса не
 * пересекаются и в сумме дают «Всего», а «После дедлайна проекта» и «Вне
 * плана» — флаги поверх статуса и в сумму не входят.
 *
 * Отсюда следствие, которое стоит держать в голове, читая цифры: завершённая
 * задача тоже попадает в просроченные, если кончилась позже дедлайна.
 * «Завершено» и «После дедлайна проекта» пересекаются намеренно — это ответы
 * на разные вопросы: «сделано ли» и «в срок ли».
 */
function ProjectMetrics({ state, showPlan }: { state: ProjectState; showPlan: boolean }) {
  const { t } = useLocale();
  const metrics = projectMetrics(state, showPlan);

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
