import { request } from "./client";

/**
 * Скоркард проекта: недельная панель здоровья плана.
 *
 * GET — с побочным эффектом: планировщика на сервере нет, и первый читатель
 * после границы недели дозаписывает недельные снимки (ленивая фиксация).
 * Значения приходят посчитанными: клиент их не пересказывает, он только
 * рисует — формулы метрик живут в одном месте, на сервере (app/scorecard.py).
 */

export type ScorecardStatus = "ok" | "warn" | "risk" | "no_data";
export type ScorecardDirection = "lte" | "gte";
export type ScorecardMetricKey =
  | "overdue_tasks"
  | "finish_drift"
  | "scope_growth"
  | "date_shifts"
  | "close_rate"
  | "stale_in_progress"
  | "data_quality";

export type ScorecardHistoryPoint = {
  week_start: string;
  value: number | null;
  status: ScorecardStatus;
};

export type ScorecardMetric = {
  key: ScorecardMetricKey;
  direction: ScorecardDirection;
  target: number;
  enabled: boolean;
  owner: { id: string; name: string } | null;
  value: number | null;
  status: ScorecardStatus;
  /** Недель подряд (включая текущую) в текущем статусе. */
  streak: number;
  /** Снимки окна истории, от старых к новым; текущая неделя — последней. */
  history: ScorecardHistoryPoint[];
  /** Средняя глубина просрочки, р.д. — только у overdue_tasks. */
  avg_days?: number | null;
  /** Создано / закрыто за неделю — только у scope_growth. */
  added_count?: number | null;
  closed_count?: number | null;
};

export type ScorecardAlert = {
  id: string;
  metric_key: ScorecardMetricKey;
  kind: "rule_triggered" | "metric_risk";
  week_start: string;
  created_at: string;
  payload: {
    value?: number | null;
    /** Изменение к прошлой неделе; null, если сравнивать не с чем. */
    delta?: number | null;
    total?: number;
    tasks?: { id: string; name: string; assignee: string | null; days_overdue?: number }[];
    /** Кто тянет метрику вниз сильнее всех. */
    top_assignee?: { name: string; count: number } | null;
    task_id?: string;
    task_name?: string;
  };
};

/** Прогноз финиша и ближайшая веха — шапка скоркарда. */
export type ScorecardOutlook = {
  projected_finish: string | null;
  milestone: {
    id: string;
    name: string;
    date: string;
    status: "upcoming" | "overdue";
  } | null;
};

export type ScorecardState = {
  week: { number: number; start: string; end: string };
  computed_at: string | null;
  metrics: ScorecardMetric[];
  alerts: ScorecardAlert[];
  outlook: ScorecardOutlook;
  data_quality: {
    value: number;
    total: number;
    /** Задач с хотя бы одной бедой (объединение множеств). */
    affected: number;
    /** Задач с обеими бедами сразу (пересечение). */
    both: number;
    unassigned: number;
    unreal_deadline: number;
  } | null;
};

/** Запись drill-down: задача с атрибутами своей метрики. */
export type ScorecardTaskEntry = {
  id: string;
  name: string | null;
  status?: string | null;
  end_date?: string | null;
  assignees?: string[];
  days_overdue?: number;
  in_progress_days?: number;
  delta_days?: number;
  closed_in_week?: boolean;
  added_in_week?: boolean;
  reasons?: string[];
};

export type ScorecardMetricTasks = {
  metric_key: ScorecardMetricKey;
  week_start: string;
  value: number | null;
  details: {
    tasks?: ScorecardTaskEntry[];
    added?: ScorecardTaskEntry[];
    closed?: ScorecardTaskEntry[];
    unassigned?: ScorecardTaskEntry[];
    unreal_deadline?: ScorecardTaskEntry[];
    [key: string]: unknown;
  };
};

export type ScorecardMetricPatch = Partial<{
  owner_user_id: string | null;
  target_value: number;
  enabled: boolean;
}>;

/**
 * Ключ — внутри ключа проекта: ревизия из сокета сбрасывает проект целиком,
 * и скоркард, чьё правило само рождает ревизии, обновляется тем же вызовом.
 */
export function scorecardQueryKey(projectId: string) {
  return ["project", projectId, "scorecard"] as const;
}

/** Drill-down недели — внутри ключа скоркарда: сброс задевает и его. */
export function scorecardTasksQueryKey(projectId: string, metricKey: string, week: string) {
  return ["project", projectId, "scorecard", "tasks", metricKey, week] as const;
}

export function getScorecard(projectId: string): Promise<ScorecardState> {
  return request<ScorecardState>(`/api/projects/${projectId}/scorecard?weeks=13`);
}

/** Пересчёт текущей недели мимо кэша; сервер держит предел — раз в минуту. */
export function recalculateScorecard(projectId: string): Promise<ScorecardState> {
  return request<ScorecardState>(`/api/projects/${projectId}/scorecard/recalculate?weeks=13`, {
    method: "POST",
  });
}

export function updateScorecardMetric(
  projectId: string,
  metricKey: string,
  patch: ScorecardMetricPatch,
): Promise<ScorecardState> {
  return request<ScorecardState>(
    `/api/projects/${projectId}/scorecard/metrics/${metricKey}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
}

export function scorecardMetricTasks(
  projectId: string,
  metricKey: string,
  week: string,
): Promise<ScorecardMetricTasks> {
  return request<ScorecardMetricTasks>(
    `/api/projects/${projectId}/scorecard/metrics/${metricKey}/tasks?week=${week}`,
  );
}
