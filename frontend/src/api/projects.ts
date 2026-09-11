import { request } from "./client";
import type { SlugCheck } from "./org";

export const PROJECTS_QUERY_KEY = ["projects"] as const;

/** The state key of a single project. Separate from the list's: they live their own lives. */
export function projectQueryKey(id: string) {
  return ["project", id] as const;
}

export type Project = {
  id: string;
  name: string;
  slug: string;
};

/**
 * The project's working calendar exactly as the server sent it.
 *
 * `working_days` is a bitmask where bit 0 is Monday: that is how Python counts
 * it, and converting it to another numbering along the way would mean keeping a
 * second representation of one and the same thing.
 */
export type Calendar = {
  working_days: number;
  holidays: string[];
  extra_workdays: string[];
};

export const CRITICALITY_LEVELS = ["low", "normal", "high", "critical"] as const;

/**
 * The assignee's risk flag: am I going to make the deadline. A person's word,
 * not a computation — the scorecard compares it against the fact ("warned in
 * advance" or "missed silently").
 */
export const RISK_FLAGS = ["green", "yellow", "red"] as const;
export type RiskFlag = (typeof RISK_FLAGS)[number];
export type Criticality = (typeof CRITICALITY_LEVELS)[number];

/**
 * The status is a stored field rather than something derived from progress and
 * dates as in the Planora mockup: "blocked" cannot be derived from progress at
 * all, a person assigns it. The status is coupled to progress loosely, and the
 * rules of that coupling live on the server (see the backend's
 * `set_status`/`set_progress`); the client repeats them only in optimistic
 * guesses.
 */
export const TASK_STATUSES = ["planned", "in_progress", "done", "blocked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type Category = {
  id: string;
  name: string;
  color: string;
  position: number;
};

export type Task = {
  id: string;
  category_id: string;
  name: string;
  description?: string;
  start_date: string;
  /**
   * The offset from the project's start in working days — a relative plan's
   * model of a task. Computed by the server from the `start_date` coordinate; a
   * calendar project has none. The client does not recompute working days here
   * either.
   */
  duration_days: number;
  /** Computed by the server. The client does not repeat calendar arithmetic. */
  end_date: string;
  /**
   * A milestone: a point on the scale instead of a stretch — a stage handover,
   * an approval, a contractor's deadline. Drawn as a diamond on its own day and
   * has no duration: the server keeps it equal to one day and rejects
   * `set_duration` on a milestone.
   *
   * A flag rather than something derived from "the duration equals one day":
   * one-day tasks are plentiful, and they do not become milestones.
   */
  milestone: boolean;
  /**
   * A task with no slack: move it by a day and the whole project moves by a day.
   *
   * Computed by the server and sent with the state: slack is measured in working
   * days, and the working calendar is a property of the project — a second
   * computation of it here would diverge from the first on the very first
   * holiday.
   */
  critical: boolean;
  criticality: Criticality;
  /** The assignee's risk flag and the reason on one line; not shown for "done". */
  risk: RiskFlag;
  risk_note: string;
  status: TaskStatus;
  progress_pct: number;
  position: number;
  assignee_ids: string[];
  /**
   * The baseline plan: the dates as of approval. `null` on every task while the
   * plan is not approved, and on those created after approval — the latter are
   * precisely what is "beyond the original plan". There is deliberately no
   * separate flag: it would be computable from these same fields and would one
   * day diverge from them.
   */
  baseline_start: string | null;
  baseline_duration: number | null;
  /** Computed by the server from the project's calendar — like the ordinary end date. */
  baseline_end: string | null;
  /** Arrives only to those entitled to read it. */
  internal_note?: string;
};

export type Dependency = {
  from_task_id: string;
  to_task_id: string;
};

export type ProjectOverrides = {
  timezone: string | null;
  working_days: number | null;
  shift_threshold_days: number | null;
  holidays_extra: string[];
  workdays_extra: string[];
};

/**
 * What time the plan lives by: `relative` — a preliminary plan without dates
 * ("Month 1 / Week 1"), `calendar` — the start is assigned, the dates are real.
 */
export type ScheduleMode = "relative" | "calendar";

export type ProjectState = {
  id: string;
  name: string;
  slug: string;
  deadline: string | null;
  project_end: string | null;
  schedule_mode: ScheduleMode;
  /** The assigned start date; `null` while the plan is relative. */
  start_date: string | null;
  /**
   * Auto-shifting along links: a successor does not start before its predecessor
   * has ended. Off by default — before it a link moved nothing at all. When it
   * is on the strip does not offer to move the task by hand (see
   * DependencyNudge): an offer to do what is already done reads as a glitch.
   */
  auto_schedule?: boolean;
  /** `null` — the plan is still a draft: edits are free, nothing is asked. */
  plan_approved_at: string | null;
  plan_version: number;
  /**
   * What the "Undo" button will undo. `null` — there is nothing to undo.
   *
   * It arrives with the state rather than as a separate request: the button must
   * be disabled immediately rather than come alive a frame after the render.
   */
  undoable: { seq: number; op: Record<string, unknown>; batch_id: string | null } | null;
  calendar: Calendar;
  settings?: { shift_threshold_days: number; timezone: string };
  /**
   * The project's raw overrides: `null` means "inherit from the organization",
   * not "empty". The settings screen needs exactly that distinction — showing an
   * inherited number as the project's own means offering the person to override
   * what they never overrode.
   */
  overrides?: ProjectOverrides;
  categories: Category[];
  tasks: Task[];
  dependencies: Dependency[];
};

/**
 * The operations exactly as the wire accepts them.
 *
 * There are no restoration fields here and there cannot be: `category_id` when
 * creating a category, `task_id` when creating a task and `position` are
 * assigned by the server. The server rejects extra fields (`extra="forbid"`),
 * but relying on that as the only protection will not do — a type must describe
 * the contract honestly, otherwise such a field will one day be added and only
 * be discovered in production.
 */
export type Op =
  | { type: "create_category"; name: string; color: string }
  | {
      type: "create_task";
      category_id: string;
      name: string;
      start_date: string;
      duration_days: number;
      /**
       * The row's place in the category's list. Not named — the task goes to the
       * end; named — to this number, and the rows that occupied it move down.
       * That way the "plus" on a row boundary creates a task where it was
       * pointed at, in one operation — that is, one history entry and one press
       * of "Undo".
       */
      position?: number;
      description?: string;
      internal_note?: string;
      criticality?: Criticality;
      status?: TaskStatus;
      progress_pct?: number;
      milestone?: boolean;
    }
  | { type: "delete_category"; category_id: string }
  /**
   * Renaming a category is its own operation rather than part of
   * `create_category`: the heading is edited in place (in the strip's row or in
   * the quote), and the edit must remain one history entry rather than a
   * "delete, create anew" pair.
   */
  | { type: "rename_category"; category_id: string; name: string }
  | { type: "delete_task"; task_id: string }
  | { type: "move_task"; task_id: string; start_date: string }
  /**
   * Shifting a whole category by N calendar days is one operation rather than a
   * batch of `move_task`s numbering the tasks: the person made one motion, and
   * the history must show one entry while an undo returns everything with one
   * press.
   *
   * Days rather than a target date: a category has no bounds of its own — its
   * summary band is drawn from its tasks' outermost dates.
   */
  | { type: "move_category"; category_id: string; days: number }
  /**
   * The bar's left edge: the start and the duration at once, the end staying
   * put. One operation rather than a `move_task` + `set_duration` pair — the
   * edge is dragged in one motion, and the person never created the intermediate
   * state of "already moved but not yet shortened".
   */
  | { type: "resize_task"; task_id: string; start_date: string; duration_days: number }
  | { type: "set_duration"; task_id: string; duration_days: number }
  | { type: "set_milestone"; task_id: string; milestone: boolean }
  | {
      type: "set_task_fields";
      task_id: string;
      name: string;
      description: string;
      internal_note: string;
    }
  | { type: "set_criticality"; task_id: string; criticality: Criticality }
  /** The flag and the reason in one operation: the card changes them in one gesture. */
  | { type: "set_risk"; task_id: string; risk: RiskFlag; note: string }
  | { type: "set_status"; task_id: string; status: TaskStatus }
  | { type: "set_progress"; task_id: string; progress_pct: number }
  | { type: "reorder_task"; task_id: string; category_id: string; position: number }
  /**
   * A category takes another place in the list of stages. A separate operation
   * from `reorder_task`: a task's place is described by a (category, number)
   * pair — it is also moved from stage to stage — while a category has no
   * parent, and only one number.
   */
  | { type: "reorder_category"; category_id: string; position: number }
  | { type: "assign_user"; task_id: string; user_id: string }
  | { type: "unassign_user"; task_id: string; user_id: string }
  | { type: "add_dependency"; from_task_id: string; to_task_id: string }
  | { type: "remove_dependency"; from_task_id: string; to_task_id: string };

/** The response to an applied operation. The revision number is what tells it from its neighbours. */
export type Revision = {
  seq: number;
  op: Record<string, unknown>;
  inverse: Record<string, unknown>;
};

export function listProjects(): Promise<Project[]> {
  return request<Project[]>("/api/projects");
}

export function createProject(name: string): Promise<Project> {
  return request<Project>("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function getProject(id: string): Promise<ProjectState> {
  return request<ProjectState>(`/api/projects/${id}`);
}

/**
 * Deleting a whole project. The only change that bypasses the revision journal:
 * the journal lives inside the project and dies with it, so this action has no
 * undo — warning the person about that is the caller's duty.
 */
export function deleteProject(id: string): Promise<void> {
  return request<void>(`/api/projects/${id}`, { method: "DELETE" });
}

/**
 * The only way to change anything in a project.
 *
 * The reason is not substituted with an empty string when there is none: the
 * server tells "no reason was required" from "the reason is empty", and the
 * former is the absence of a key rather than a key with a value.
 */
export function applyOp(projectId: string, op: Op, reason?: string): Promise<Revision> {
  return request<Revision>(`/api/projects/${projectId}/mutations`, {
    method: "POST",
    body: JSON.stringify(reason === undefined ? { op } : { op, reason }),
  });
}

/**
 * Editing a project's settings.
 *
 * `null` here is a value rather than an omission: it resets the override back to
 * "inherit from the organization". A field that is not in the object at all is
 * left unchanged.
 */
export function updateProject(
  projectId: string,
  patch: Partial<{
    name: string;
    slug: string;
    deadline: string | null;
    timezone: string | null;
    working_days: number | null;
    shift_threshold_days: number | null;
    holidays_extra: string[];
    workdays_extra: string[];
    /**
     * Auto-shifting along links. `null` is not a value for it: the organization
     * has no such setting, there is nothing to inherit — only yes or no.
     */
    auto_schedule: boolean;
  }>,
): Promise<ProjectState> {
  return request<ProjectState>(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/** What can be asked of binding to a start date — and of its preview. */
export type ScheduleRequest = {
  start_date: string;
  /** The new working week's mask; not sent — the current one stays. */
  working_days?: number;
  /** false — on a repeat change of the start, leave the tasks' dates as they are. */
  shift_tasks?: boolean;
};

/**
 * A preview of the binding: the project's bounds after it, changing nothing. The
 * dates are computed by the server — by the working calendar with the holidays,
 * which the client neither knows nor should know.
 */
export function previewSchedule(
  projectId: string,
  body: ScheduleRequest,
): Promise<{ start_date: string; end_date: string | null }> {
  return request(`/api/projects/${projectId}/schedule/preview`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Assigning (or moving) the start date. Converts a relative plan into a calendar
 * one: the offsets, durations and links are preserved, only the axis they are
 * laid out on changes. The action has no undo through the journal — the way back
 * is the "Relative plan" view.
 */
export function applySchedule(projectId: string, body: ScheduleRequest): Promise<ProjectState> {
  return request(`/api/projects/${projectId}/schedule`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function checkProjectSlug(projectId: string, slug: string): Promise<SlugCheck> {
  return request<SlugCheck>(
    `/api/projects/${projectId}/slug-check?slug=${encodeURIComponent(slug)}`,
  );
}

/**
 * Undo the last change.
 *
 * What exactly to undo is still decided by the server: a revision from the
 * middle of the journal is not undone, and `seq` is a condition rather than a
 * choice. It is the number of the change whose undo the interface promised the
 * person; if the top of the journal has moved on — someone else's edit over the
 * socket, your own edit in the card — the server answers `undo_conflict` instead
 * of removing the wrong step.
 *
 * A reason is needed when the undo takes a task further from the baseline plan
 * than the threshold — an undo goes through the same check as any other shift.
 */
export function undoLast(
  projectId: string,
  options: { seq?: number; reason?: string } = {},
): Promise<{ seq: number }> {
  // The keys are not substituted empty: the server tells "no number was named"
  // from "a named number", and the former is the absence of a key rather than a
  // key with a value.
  const body: Record<string, unknown> = {};
  if (options.seq !== undefined) body.expected_seq = options.seq;
  if (options.reason !== undefined) body.reason = options.reason;
  return request(`/api/projects/${projectId}/undo`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Roll back a whole batch — the one the AI applied with a single button. Called
 *  by the history feed: a batch stands there as one line and rolls back with one press. */
export function undoBatch(projectId: string, batchId: string): Promise<{ undone: number }> {
  return request(`/api/projects/${projectId}/batches/${batchId}/undo`, { method: "POST" });
}

/** One approved version of the plan. The snapshot holds the tasks' dates and durations. */
export type PlanApproval = {
  version: number;
  approved_at: string;
  approved_by: { id: string; name: string } | null;
  snapshot: Record<string, { name: string; start_date: string; duration_days: number }>;
};

/**
 * Approve the plan — or re-approve it if it is already approved.
 *
 * There is one route: the action is one and the same, the difference is only in
 * who is allowed it, and the server decides that.
 */
export function approvePlan(projectId: string): Promise<{ version: number; approved_at: string }> {
  return request(`/api/projects/${projectId}/plan/approvals`, { method: "POST" });
}

export function listPlanApprovals(projectId: string): Promise<PlanApproval[]> {
  return request<PlanApproval[]>(`/api/projects/${projectId}/plan/approvals`);
}
