import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { errorKey } from "../api/errors";
import { MEMBERS_QUERY_KEY, members } from "../api/org";
import {
  getScorecard,
  recalculateScorecard,
  scorecardMetricTasks,
  scorecardQueryKey,
  scorecardTasksQueryKey,
  updateScorecardMetric,
} from "../api/scorecard";
import type {
  ScorecardAlert,
  ScorecardMetric,
  ScorecardMetricPatch,
  ScorecardState,
  ScorecardTaskEntry,
} from "../api/scorecard";
import { Avatar } from "../components/Avatar";
import { useToast } from "../components/toast";
import { formatShortDate, formatTime } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";
import { useLiveBlocksEditing } from "../live/LiveProvider";
import { formatAmount } from "../proposal/money";

import "./scorecard.css";

/**
 * Вкладка «Scorecard»: недельная панель здоровья проекта.
 *
 * Прогноз финиша и таблица метрик слева, «Требует внимания» и качество данных
 * справа. Значения приходят с сервера посчитанными, экран их только рисует:
 * формулы метрик живут в одном месте (backend/app/scorecard.py), и клиент,
 * пересчитывающий их, был бы вторым местом с той же арифметикой.
 *
 * События одной метрики склеиваются в одну карточку: риск и правило «красная
 * 2 недели подряд» — это два взгляда на одну беду, и две карточки о ней
 * дублировали бы сигнал.
 */
export function Scorecard({
  projectId,
  canWrite,
  onOpenTask,
}: {
  projectId: string;
  canWrite: boolean;
  onOpenTask: (taskId: string) => void;
}) {
  const { t, locale } = useLocale();
  const queryClient = useQueryClient();
  const toast = useToast();
  const offline = useLiveBlocksEditing();

  const query = useQuery({
    queryKey: scorecardQueryKey(projectId),
    queryFn: () => getScorecard(projectId),
    retry: false,
  });

  // Открытый drill-down: метрика и неделя. Щелчок по строке открывает
  // текущую неделю, щелчок по столбику спарклайна — его неделю.
  const [drill, setDrill] = useState<{ metric: string; week: string } | null>(null);

  // Состав организации — для выбора владельца метрики. Тем же ключом, что и
  // на экране проекта: список один, и второй запрос сюда не ездит.
  const membersQuery = useQuery({
    queryKey: MEMBERS_QUERY_KEY,
    queryFn: members,
    retry: false,
    staleTime: Infinity,
  });

  const recalc = useMutation({
    mutationFn: () => recalculateScorecard(projectId),
    onSuccess: (state) => queryClient.setQueryData(scorecardQueryKey(projectId), state),
    onError: (refusal: unknown) => toast({ message: t(errorKey(refusal)), tone: "error" }),
  });

  // Правка владельца и цели — оптимистично: поле меняется под рукой, а не
  // после ответа. Откат — снимком, тем же приёмом, что у useProjectMutation.
  const patch = useMutation({
    mutationFn: (input: { metricKey: string; patch: ScorecardMetricPatch }) =>
      updateScorecardMetric(projectId, input.metricKey, input.patch),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: scorecardQueryKey(projectId) });
      const before = queryClient.getQueryData<ScorecardState>(scorecardQueryKey(projectId));
      if (before) {
        queryClient.setQueryData(
          scorecardQueryKey(projectId),
          applyMetricPatch(before, input.metricKey, input.patch, membersQuery.data ?? []),
        );
      }
      return { before };
    },
    onError: (refusal: unknown, _input, context) => {
      if (context?.before) {
        queryClient.setQueryData(scorecardQueryKey(projectId), context.before);
      }
      toast({ message: t(errorKey(refusal)), tone: "error" });
    },
    // Ответ несёт пересчитанные статусы: цель сменилась — цвет обязан
    // смениться тем же движением.
    onSuccess: (state) => queryClient.setQueryData(scorecardQueryKey(projectId), state),
  });

  if (query.isPending) {
    return <p role="status">{t("common.loading")}</p>;
  }

  if (query.error) {
    return (
      <p className="error" role="alert">
        {t(errorKey(query.error))}
      </p>
    );
  }

  const state = query.data;
  const currentWeek = state.week.start;
  // Одна карточка на метрику: риск и правило склеиваются, порядок — по первому
  // событию метрики (сервер отдаёт события новыми сверху).
  const alertGroups = groupAlerts(state.alerts);

  const toggleDrill = (metric: string, week: string) =>
    setDrill((current) =>
      current && current.metric === metric && current.week === week
        ? null
        : { metric, week },
    );

  return (
    <div className="scorecard">
      <div className="scorecard__main">
        <header className="scorecard__head">
          <div>
            <h2 className="scorecard__title">{t("scorecard.title")}</h2>
            <p className="scorecard__subtitle">
              {t("scorecard.subtitle", {
                number: state.week.number,
                start: formatShortDate(t, state.week.start),
                end: formatShortDate(t, state.week.end),
              })}
              {state.computed_at &&
                ` · ${t("scorecard.updated", {
                  time: formatTime(locale, new Date(state.computed_at)),
                })}`}
            </p>
          </div>
          <div className="scorecard__actions">
            {/* Окно истории в MVP одно — селектор статичен, но стоит на месте:
                API уже принимает weeks, и кнопка обещает ровно то, что есть. */}
            <button type="button" className="button--quiet" disabled>
              {t("scorecard.weeks_window")}
            </button>
            {canWrite && (
              <button
                type="button"
                className="scorecard__recalculate"
                disabled={offline || recalc.isPending}
                onClick={() => recalc.mutate()}
              >
                {t("scorecard.recalculate")}
              </button>
            )}
          </div>
        </header>

        <div className="scorecard-table__scroll">
          <table className="scorecard-table">
            <thead>
              <tr>
                <th scope="col">{t("scorecard.columns.metric")}</th>
                <th scope="col">{t("scorecard.columns.value")}</th>
                <th scope="col">{t("scorecard.columns.trend")}</th>
                <th scope="col">{t("scorecard.columns.status")}</th>
              </tr>
            </thead>
            <tbody>
              {state.metrics.map((metric) => (
                <MetricRow
                  key={metric.key}
                  projectId={projectId}
                  metric={metric}
                  currentWeek={currentWeek}
                  members={membersQuery.data ?? []}
                  canWrite={canWrite && !offline}
                  drillWeek={drill?.metric === metric.key ? drill.week : null}
                  onToggle={(week) => toggleDrill(metric.key, week)}
                  onPatch={(next) => patch.mutate({ metricKey: metric.key, patch: next })}
                  onOpenTask={onOpenTask}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <aside className="scorecard-side">
        <OutlookCard outlook={state.outlook} onOpenTask={onOpenTask} />

        <section className="scorecard-card">
          <h3 className="scorecard-card__title">
            {t("scorecard.attention.title")}
            {alertGroups.length > 0 && (
              <span className="scorecard-card__count">{alertGroups.length}</span>
            )}
          </h3>
          {alertGroups.length === 0 ? (
            <p className="scorecard-card__empty">{t("scorecard.attention.empty")}</p>
          ) : (
            alertGroups.map((group) => (
              <AlertCard
                key={group.metricKey}
                group={group}
                onOpenTask={onOpenTask}
                onOpenMetric={() => setDrill({ metric: group.metricKey, week: currentWeek })}
              />
            ))
          )}
        </section>

        {state.data_quality && (
          <QualityCard quality={state.data_quality} status={qualityStatus(state)} />
        )}
      </aside>
    </div>
  );
}

/** Статус качества данных — цвет процента и прогресс-бара. */
function qualityStatus(state: ScorecardState): string {
  return state.metrics.find((metric) => metric.key === "data_quality")?.status ?? "no_data";
}

/**
 * Оптимистичное применение правки метрики: то, что человек только что выбрал,
 * встаёт на экран сразу. Статус не пересчитывается — его пришлёт сервер:
 * пороги живут у него, и догадка экрана разошлась бы с ответом.
 */
function applyMetricPatch(
  state: ScorecardState,
  metricKey: string,
  patch: ScorecardMetricPatch,
  roster: { id: string; name: string }[],
): ScorecardState {
  return {
    ...state,
    metrics: state.metrics.map((metric) => {
      if (metric.key !== metricKey) return metric;
      const next = { ...metric };
      if ("target_value" in patch && patch.target_value !== undefined) {
        next.target = patch.target_value;
      }
      if ("enabled" in patch && patch.enabled !== undefined) next.enabled = patch.enabled;
      if ("owner_user_id" in patch) {
        next.owner =
          patch.owner_user_id == null
            ? null
            : {
                id: patch.owner_user_id,
                name: roster.find((member) => member.id === patch.owner_user_id)?.name ?? "",
              };
      }
      return next;
    }),
  };
}

function MetricRow({
  projectId,
  metric,
  currentWeek,
  members: roster,
  canWrite,
  drillWeek,
  onToggle,
  onPatch,
  onOpenTask,
}: {
  projectId: string;
  metric: ScorecardMetric;
  currentWeek: string;
  members: { id: string; name: string }[];
  canWrite: boolean;
  /** Неделя открытого drill-down этой метрики; null — свёрнуто. */
  drillWeek: string | null;
  onToggle: (week: string) => void;
  onPatch: (patch: ScorecardMetricPatch) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const { t, locale } = useLocale();
  const name = t(`scorecard.metric.${metric.key}`);
  const sign = metric.direction === "lte" ? "≤" : "≥";
  const value =
    metric.value === null ? "—" : formatMetricValue(locale, metric.key, metric.value, true);
  const secondary = metricSecondary(t, locale, metric);
  const badge = t(`scorecard.status.${metric.status}`);

  return (
    <>
      <tr
        className={`scorecard-row${metric.status === "risk" ? " is-risk" : ""}`}
        aria-expanded={drillWeek !== null}
        onClick={() => onToggle(currentWeek)}
      >
        <td className="scorecard-row__metric">
          <span className="scorecard-row__name">{name}</span>
          {/* Правка владельца — прямо в ячейке; щелчок по ней не должен
              разворачивать строку. */}
          <span
            className="scorecard-row__owner"
            onClick={(event) => event.stopPropagation()}
          >
            {canWrite ? (
              <select
                className="scorecard-row__owner-select"
                aria-label={t("scorecard.owner_label", { metric: name })}
                value={metric.owner?.id ?? ""}
                onChange={(event) =>
                  onPatch({ owner_user_id: event.target.value || null })
                }
              >
                <option value="">{t("scorecard.owner_none")}</option>
                {roster.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            ) : metric.owner ? (
              <>
                <Avatar name={metric.owner.name} size={20} />
                {metric.owner.name}
              </>
            ) : (
              t("scorecard.owner_none")
            )}
          </span>
        </td>
        <td className="scorecard-row__value">
          <strong data-status={metric.status}>{value}</strong>
          <span
            className="scorecard-row__target"
            onClick={(event) => event.stopPropagation()}
          >
            {sign}{" "}
            {canWrite ? (
              <input
                className="scorecard-row__target-input"
                type="number"
                min={0}
                step="0.1"
                aria-label={t("scorecard.target_label", { metric: name })}
                defaultValue={metric.target}
                onBlur={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isFinite(next) && next >= 0 && next !== metric.target) {
                    onPatch({ target_value: next });
                  }
                }}
              />
            ) : (
              formatMetricValue(locale, metric.key, metric.target)
            )}
          </span>
          {secondary && <span className="scorecard-row__extra">{secondary}</span>}
        </td>
        <td className="scorecard-row__spark">
          <Sparkline metric={metric} onPick={(week) => onToggle(week)} />
        </td>
        <td className="scorecard-row__status">
          <span className="scorecard-badge" data-status={metric.status}>
            {badge}
            {metric.streak >= 2 &&
              metric.status !== "no_data" &&
              ` ${t("scorecard.streak", { count: metric.streak })}`}
          </span>
        </td>
      </tr>
      {drillWeek !== null && (
        <tr className="scorecard-drill">
          <td colSpan={4}>
            <DrillDown
              projectId={projectId}
              metricKey={metric.key}
              week={drillWeek}
              onOpenTask={onOpenTask}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Десятичные — через словарь чисел: в ru запятая приходит от Intl. Дрейф и
 * объём — величины со знаком: у положительных явно ставим «+», чтобы «уехало
 * вправо» и «подтянули» читались с одного взгляда (минус даёт Intl сам). Знак
 * ставится только у значения, не у цели: цель — порог, а не изменение.
 */
function formatMetricValue(
  locale: string,
  key: string,
  value: number,
  signed = false,
): string {
  const amount = formatAmount(locale, value);
  if (key === "data_quality") return `${amount}%`;
  if (signed && value > 0 && (key === "finish_drift" || key === "scope_growth")) {
    return `+${amount}`;
  }
  return amount;
}

/** Второй ракурс метрики под значением: средняя просрочка, разбивка объёма. */
function metricSecondary(
  t: (key: string, params?: Record<string, string | number>) => string,
  locale: string,
  metric: ScorecardMetric,
): string | null {
  if (metric.key === "overdue_tasks" && metric.avg_days != null) {
    // Дробное — через словарь чисел: в ru запятая приходит от Intl, а t()
    // подставляет строку как есть.
    return t("scorecard.row.avg_overdue", { count: formatAmount(locale, metric.avg_days) });
  }
  if (
    metric.key === "scope_growth" &&
    metric.added_count != null &&
    metric.closed_count != null
  ) {
    return t("scorecard.row.scope_breakdown", {
      added: metric.added_count,
      closed: metric.closed_count,
    });
  }
  return null;
}

/**
 * Спарклайн без библиотек: по столбику на неделю, цвет — статус недели,
 * пустая ячейка — no_data. Высота нормируется на максимум окна: спарклайн
 * показывает форму ряда, а не абсолютную шкалу — числа стоят в соседней
 * колонке и в подсказке.
 */
function Sparkline({
  metric,
  onPick,
}: {
  metric: ScorecardMetric;
  onPick: (week: string) => void;
}) {
  const { t, locale } = useLocale();
  const peak = Math.max(...metric.history.map((point) => point.value ?? 0), 1);
  return (
    <span className="scorecard-spark">
      {metric.history.map((point) => {
        const label = `${formatShortDate(t, point.week_start)} · ${
          point.value === null
            ? t("scorecard.status.no_data")
            : formatMetricValue(locale, metric.key, point.value, true)
        } · ${t(`scorecard.status.${point.status}`)}`;
        return (
          <button
            key={point.week_start}
            type="button"
            className="scorecard-spark__bar"
            data-status={point.status}
            title={label}
            aria-label={label}
            onClick={(event) => {
              event.stopPropagation();
              onPick(point.week_start);
            }}
          >
            {point.value !== null && (
              <span
                className="scorecard-spark__fill"
                data-status={point.status}
                style={{ height: `${Math.max(8, (point.value / peak) * 100)}%` }}
              />
            )}
          </button>
        );
      })}
    </span>
  );
}

/**
 * Список задач метрики за неделю. Прошлые недели сервер читает из снимка,
 * текущую считает вживую — экрану разница не видна, адрес один.
 */
function DrillDown({
  projectId,
  metricKey,
  week,
  onOpenTask,
}: {
  projectId: string;
  metricKey: string;
  week: string;
  onOpenTask: (taskId: string) => void;
}) {
  const { t } = useLocale();
  const query = useQuery({
    queryKey: scorecardTasksQueryKey(projectId, metricKey, week),
    queryFn: () => scorecardMetricTasks(projectId, metricKey, week),
    retry: false,
  });

  if (query.isPending) return <p role="status">{t("common.loading")}</p>;
  if (query.error) {
    return (
      <p className="error" role="alert">
        {t(errorKey(query.error))}
      </p>
    );
  }

  const details = query.data.details;
  // У качества данных два списка причин; у остальных метрик — один общий.
  const entries: ScorecardTaskEntry[] =
    metricKey === "data_quality"
      ? dedupeById([...(details.unassigned ?? []), ...(details.unreal_deadline ?? [])])
      : (details.tasks ?? []);

  if (entries.length === 0) {
    return <p className="scorecard-drill__empty">{t("scorecard.drill.empty")}</p>;
  }

  return (
    <ul className="scorecard-drill__list">
      {/* Ключ — с номером: у сдвигов дат одна задача встречается по разу на
          операцию, и голый id дал бы двум строкам один ключ. */}
      {entries.map((entry, index) => (
        <li key={`${entry.id}-${index}`}>
          <button
            type="button"
            className="scorecard-drill__task"
            onClick={() => onOpenTask(entry.id)}
          >
            <span className="scorecard-drill__task-name">
              {entry.name ?? t("scorecard.drill.deleted")}
            </span>
            <span className="scorecard-drill__task-meta">
              {entry.assignees && entry.assignees.length > 0 && (
                <span>{entry.assignees.join(", ")}</span>
              )}
              {entryNote(t, entry)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function dedupeById(entries: ScorecardTaskEntry[]): ScorecardTaskEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

/** Короткая приписка к задаче — на языке её метрики. */
function entryNote(
  t: (key: string, params?: Record<string, string | number>) => string,
  entry: ScorecardTaskEntry,
): string | null {
  if (entry.days_overdue !== undefined) {
    return t("scorecard.drill.days_overdue", { count: entry.days_overdue });
  }
  if (entry.in_progress_days !== undefined) {
    return t("scorecard.drill.in_progress_days", { count: entry.in_progress_days });
  }
  if (entry.delta_days !== undefined) {
    return t("scorecard.drill.delta_days", { count: entry.delta_days });
  }
  if (entry.added_in_week) {
    return t("scorecard.drill.added");
  }
  if (entry.closed_in_week !== undefined) {
    return t(
      entry.closed_in_week ? "scorecard.drill.closed" : "scorecard.drill.not_closed",
    );
  }
  if (entry.reasons) {
    return entry.reasons
      .map((reason) => t(`scorecard.drill.reason.${reason}`))
      .join(" · ");
  }
  return null;
}

/** События одной метрики под одной крышей: риск и след правила вместе. */
type AlertGroup = {
  metricKey: string;
  risk?: ScorecardAlert;
  rule?: ScorecardAlert;
};

/**
 * Склейка событий по метрике с сохранением порядка появления. У метрики
 * бывает и риск, и правило одновременно — это одна беда, и карточка одна.
 */
function groupAlerts(alerts: ScorecardAlert[]): AlertGroup[] {
  const groups = new Map<string, AlertGroup>();
  for (const alert of alerts) {
    let group = groups.get(alert.metric_key);
    if (!group) {
      group = { metricKey: alert.metric_key };
      groups.set(alert.metric_key, group);
    }
    if (alert.kind === "rule_triggered") group.rule = alert;
    else group.risk = alert;
  }
  return [...groups.values()];
}

/**
 * Карточка события метрики: фраза риска, дельта к прошлой неделе, кто тянет
 * вниз и топ-3 задачи, плюс — если правило сработало — ссылка на созданную
 * задачу «Разобрать». Когда риска нет, а правило есть, остаётся только ссылка.
 */
function AlertCard({
  group,
  onOpenTask,
  onOpenMetric,
}: {
  group: AlertGroup;
  onOpenTask: (taskId: string) => void;
  onOpenMetric: () => void;
}) {
  const { t, locale } = useLocale();
  const metricName = t(`scorecard.metric.${group.metricKey}`);
  const risk = group.risk;
  const rule = group.rule;
  const top = risk?.payload.tasks ?? [];
  const delta = risk?.payload.delta;
  const topAssignee = risk?.payload.top_assignee;

  return (
    <article className="scorecard-alert" data-kind={risk ? "risk" : "rule"}>
      {risk ? (
        <p className="scorecard-alert__head">
          {t("scorecard.attention.risk", { metric: metricName })}
        </p>
      ) : (
        <p className="scorecard-alert__head">
          {t("scorecard.attention.rule", { metric: metricName })}
        </p>
      )}

      {risk && delta != null && delta !== 0 && (
        <p className="scorecard-alert__delta">
          {t(delta > 0 ? "scorecard.attention.delta_up" : "scorecard.attention.delta_down", {
            count: formatAmount(locale, Math.abs(delta)),
          })}
        </p>
      )}

      {risk && topAssignee && (
        <p className="scorecard-alert__by">
          {t("scorecard.attention.top_assignee", {
            name: topAssignee.name,
            count: topAssignee.count,
          })}
        </p>
      )}

      {top.length > 0 && (
        <ul className="scorecard-alert__tasks">
          {top.map((task) => (
            <li key={task.id}>
              <button
                type="button"
                className="scorecard-alert__link"
                onClick={() => onOpenTask(task.id)}
              >
                {task.name}
              </button>
              <span className="scorecard-alert__meta">
                {task.assignee ?? t("scorecard.owner_none")}
                {task.days_overdue !== undefined &&
                  ` · ${t("scorecard.drill.days_overdue", { count: task.days_overdue })}`}
              </span>
            </li>
          ))}
        </ul>
      )}

      {risk && (risk.payload.total ?? 0) > 0 && (
        <button type="button" className="scorecard-alert__all" onClick={onOpenMetric}>
          {t("scorecard.attention.open_all", { count: risk.payload.total ?? 0 })}
        </button>
      )}

      {rule && rule.payload.task_id && (
        <button
          type="button"
          className="scorecard-alert__link scorecard-alert__rule"
          onClick={() => onOpenTask(rule.payload.task_id!)}
        >
          {rule.payload.task_name ?? t("scorecard.attention.open_task")}
        </button>
      )}
    </article>
  );
}

/**
 * Прогноз финиша и ближайшая веха — то, ради чего открывают экран. Не
 * рисуется у относительного плана: там настоящих дат нет, и сервер шлёт
 * пустой outlook.
 */
function OutlookCard({
  outlook,
  onOpenTask,
}: {
  outlook: ScorecardState["outlook"];
  onOpenTask: (taskId: string) => void;
}) {
  const { t } = useLocale();
  if (!outlook.projected_finish && !outlook.milestone) return null;
  const milestone = outlook.milestone;
  return (
    <section className="scorecard-card scorecard-outlook">
      <h3 className="scorecard-card__title">{t("scorecard.outlook.title")}</h3>
      {outlook.projected_finish && (
        <p className="scorecard-outlook__finish">
          <span className="scorecard-outlook__label">{t("scorecard.outlook.finish")}</span>
          <span className="scorecard-outlook__value">
            {formatShortDate(t, outlook.projected_finish)}
          </span>
        </p>
      )}
      {milestone && (
        <button
          type="button"
          className="scorecard-outlook__milestone"
          data-status={milestone.status}
          onClick={() => onOpenTask(milestone.id)}
        >
          <span className="scorecard-outlook__label">
            {t(
              milestone.status === "overdue"
                ? "scorecard.outlook.milestone_overdue"
                : "scorecard.outlook.milestone",
            )}
          </span>
          <span className="scorecard-outlook__value">
            {milestone.name} · {formatShortDate(t, milestone.date)}
          </span>
        </button>
      )}
    </section>
  );
}

/**
 * Качество данных как чек-лист причин, а не один процент: цифры сходятся по
 * построению (нет исполнителя + нереальный срок − обе = затронуто), и сразу
 * видно, что чинить.
 */
function QualityCard({
  quality,
  status,
}: {
  quality: NonNullable<ScorecardState["data_quality"]>;
  status: string;
}) {
  const { t, locale } = useLocale();
  const causes: { key: string; count: number }[] = [
    { key: "scorecard.quality.cause_unassigned", count: quality.unassigned },
    { key: "scorecard.quality.cause_unreal", count: quality.unreal_deadline },
  ];
  if (quality.both > 0) {
    causes.push({ key: "scorecard.quality.cause_both", count: quality.both });
  }
  return (
    <section className="scorecard-card">
      <h3 className="scorecard-card__title">{t("scorecard.quality.title")}</h3>
      <p className="scorecard-quality__value" data-status={status}>
        {t("scorecard.quality.percent", { value: formatAmount(locale, quality.value) })}
      </p>
      <div className="scorecard-quality__bar" role="presentation">
        <div
          className="scorecard-quality__fill"
          data-status={status}
          style={{ width: `${Math.max(0, Math.min(100, quality.value))}%` }}
        />
      </div>
      <p className="scorecard-quality__affected">
        {t("scorecard.quality.affected", {
          affected: quality.affected,
          total: quality.total,
        })}
      </p>
      <ul className="scorecard-quality__causes">
        {causes.map((cause) => (
          <li key={cause.key} data-empty={cause.count === 0}>
            <span>{t(cause.key)}</span>
            <span className="scorecard-quality__count">{cause.count}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
