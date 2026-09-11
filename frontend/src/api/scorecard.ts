import { request } from "./client";

/**
 * A project's scorecard: the weekly plan-health dashboard.
 *
 * GET has a side effect: there is no scheduler on the server, and the first reader after a week's
 * boundary writes the weekly snapshots in (lazy fixation). The values arrive computed: the client
 * does not retell them, it only draws — the metrics' formulas live in one place, on the server
 * (app/scorecard.py).
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
  | "data_quality"
  | "team_pace";

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
  /** Consecutive weeks (including the current one) in the current status. */
  streak: number;
  /** The history window's snapshots, oldest to newest; the current week comes last. */
  history: ScorecardHistoryPoint[];
  /** The average depth of overdueness, working days — only for overdue_tasks. */
  avg_days?: number | null;
  /** Created / closed for the week — only for scope_growth. */
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
    /** The change from last week; null if there is nothing to compare with. */
    delta?: number | null;
    total?: number;
    tasks?: { id: string; name: string; assignee: string | null; days_overdue?: number }[];
    /** Who drags the metric down the most. */
    top_assignee?: { name: string; count: number } | null;
    task_id?: string;
    task_name?: string;
  };
};

/** The finish forecast and the nearest milestone — the scorecard's header. */
export type ScorecardOutlook = {
  projected_finish: string | null;
  milestone: {
    id: string;
    name: string;
    date: string;
    status: "upcoming" | "overdue";
  } | null;
};

/** The header's three figures and the week counter: computed by the server from the snapshots. */
export type ScorecardSummary = {
  planned: number;
  done: number;
  overdue: { value: number | null; status: ScorecardStatus; avg_days: number | null };
  blocked: {
    value: number;
    status: ScorecardStatus;
    longest: { id: string; name: string; days: number } | null;
  };
  finish_drift: {
    value: number | null;
    status: ScorecardStatus;
    projected_finish: string | null;
  };
};

export type TeamSignal = "green" | "yellow" | "red";

/** A signal's reason — as a code with parameters; the phrase is assembled by the client from the dictionary. */
export type TeamReason =
  | { kind: "in_pace" }
  | { kind: "overdue_silent"; count: number }
  | { kind: "overdue_warned"; count: number }
  | { kind: "blocked"; task_id: string; task: string; days: number }
  | { kind: "risk_flag"; task_id: string; task: string; risk: "yellow" | "red" }
  | { kind: "reopened"; task_id: string; task: string };

export type TeamTaskState = "done" | "late" | "blocked" | "risk" | "progress" | "planned";

/** The week's task in a person's row. */
export type TeamTask = {
  id: string;
  name: string;
  status: string | null;
  due: string | null;
  risk: string;
  state: TeamTaskState;
  late_days?: number;
  warned?: boolean;
  warned_kind?: "risk" | "blocked" | null;
  blocked_days?: number;
  reopened?: boolean;
};

export type TeamMember = {
  user: { id: string; name: string };
  planned: number;
  done: number;
  extra: number;
  on_time: number;
  /** Eight weeks, oldest on the left; `closed` is empty for a week with no snapshot. */
  trend: { week_start: string; closed: number | null }[];
  tasks: TeamTask[];
  /** Only with the right to assessment (`assessment`). */
  signal?: TeamSignal;
  reason?: TeamReason;
};

export type ScorecardTeam = {
  assessment: boolean;
  members: TeamMember[];
  unassigned_planned: number;
};

export type ScorecardState = {
  week: { number: number; start: string; end: string };
  computed_at: string | null;
  metrics: ScorecardMetric[];
  alerts: ScorecardAlert[];
  outlook: ScorecardOutlook;
  summary: ScorecardSummary;
  /** Empty for anyone not entitled to the per-person breakdown (a client, a guest). */
  team: ScorecardTeam | null;
  data_quality: {
    value: number;
    total: number;
    /** Tasks with at least one trouble (the union of the sets). */
    affected: number;
    /** Tasks with both troubles at once (the intersection). */
    both: number;
    unassigned: number;
    unreal_deadline: number;
  } | null;
};

/** A drill-down record: a task with its metric's attributes. */
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
 * The key is inside the project's key: a revision from the socket invalidates the whole project,
 * and the scorecard, whose own rule produces revisions, is refreshed by the same call.
 */
export function scorecardQueryKey(projectId: string) {
  return ["project", projectId, "scorecard"] as const;
}

/** A week's drill-down is inside the scorecard's key: an invalidation touches it too. */
export function scorecardTasksQueryKey(projectId: string, metricKey: string, week: string) {
  return ["project", projectId, "scorecard", "tasks", metricKey, week] as const;
}

export function getScorecard(projectId: string): Promise<ScorecardState> {
  return request<ScorecardState>(`/api/projects/${projectId}/scorecard?weeks=13`);
}

/** A recomputation of the current week past the cache; the server holds a limit — once a minute. */
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
