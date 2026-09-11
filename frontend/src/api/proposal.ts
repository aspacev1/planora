import { request } from "./client";
import type { Comment } from "./comments";

/**
 * A project's commercial proposal: the quote before the plan.
 *
 * A line's price deliberately does not travel on the wire: it equals effort × rate, and a
 * sent copy would diverge from the factors. The totals are computed by the screen — they
 * are the product and the sum of numbers already shown.
 */

export type EffortUnit = "days" | "hours";

/**
 * A deal stage that is marked by hand. "In the plan" is not here: it is derived from the
 * lines' references to tasks (`plan_task_id`) and the counters below.
 */
export type ProposalStage = "draft" | "sent" | "agreed";

/** A role the organization has already written in quotes, with its latest rate. */
export type RoleSuggestion = { role: string; rate: number };

export type ProposalTask = {
  id: string;
  category_id: string;
  name: string;
  /** A short description is a table column; the detailed one (`details`) is the card. */
  description: string;
  details: string;
  /** The performer's role in words rather than a member: a quote is written before people are assigned. */
  role: string;
  /** The effort in the proposal's units (see ProposalState.effort_unit). */
  effort: number;
  /** The rate per unit of effort, in the proposal's currency. */
  rate: number;
  notes: string;
  risks: string;
  assumptions: string;
  position: number;
  comment_count: number;
  /**
   * The plan task the line was assembled from or transferred into. `null` — it is not in
   * the plan yet: a transfer will create it, and skip the linked ones.
   */
  plan_task_id: string | null;
};

export type ProposalCategory = {
  id: string;
  name: string;
  /** One line about the whole section — it stands on its row in the table. */
  description: string;
  position: number;
  tasks: ProposalTask[];
};

export type ProposalState = {
  effort_unit: EffortUnit;
  /** How many hours count as a day when transferring an hourly quote into a plan. */
  hours_per_day: number;
  tax_rate_pct: number;
  /** An ISO 4217 code — "USD", for example. */
  currency: string;
  /** The proposal's assumptions and notes as a whole, one item per line. */
  notes: string;
  status: ProposalStage;
  sent_at: string | null;
  agreed_at: string | null;
  /** How many lines are already in the plan and how many estimated lines can still be transferred. */
  pushed_count: number;
  pushable_count: number;
  role_suggestions: RoleSuggestion[];
  /**
   * What the plan is filled with — for the "Assemble from the plan" card on an empty quote.
   * The categories counted are those that have tasks: that is how many sections the assembly
   * will create.
   */
  plan_facts: { categories: number; tasks: number };
  categories: ProposalCategory[];
};

export type ProposalSettingsPatch = Partial<{
  effort_unit: EffortUnit;
  hours_per_day: number;
  tax_rate_pct: number;
  currency: string;
  notes: string;
}>;

export type ProposalTaskPatch = Partial<{
  name: string;
  description: string;
  details: string;
  role: string;
  effort: number;
  rate: number;
  notes: string;
  risks: string;
  assumptions: string;
}>;

/**
 * The key is inside the project's key: a revision from the socket invalidates the whole
 * project, and the quote — whose transfer into the plan itself produces a revision — is
 * refreshed by the same call.
 */
export function proposalQueryKey(projectId: string) {
  return ["project", projectId, "proposal"] as const;
}

/** A line's feed is inside the quote's key: invalidating the quote touches the conversation too. */
export function proposalCommentsQueryKey(projectId: string, taskId: string) {
  return ["project", projectId, "proposal", "comments", taskId] as const;
}

export function getProposal(projectId: string): Promise<ProposalState> {
  return request<ProposalState>(`/api/projects/${projectId}/proposal`);
}

export function updateProposalSettings(
  projectId: string,
  patch: ProposalSettingsPatch,
): Promise<ProposalState> {
  return request<ProposalState>(`/api/projects/${projectId}/proposal`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function createProposalCategory(
  projectId: string,
  name: string,
  description = "",
): Promise<{ id: string; name: string; position: number }> {
  return request(`/api/projects/${projectId}/proposal/categories`, {
    method: "POST",
    body: JSON.stringify({ name, description }),
  });
}

export function updateProposalCategory(
  projectId: string,
  categoryId: string,
  patch: Partial<{ name: string; description: string }>,
): Promise<{ id: string; name: string; position: number }> {
  return request(`/api/projects/${projectId}/proposal/categories/${categoryId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteProposalCategory(projectId: string, categoryId: string): Promise<void> {
  return request(`/api/projects/${projectId}/proposal/categories/${categoryId}`, {
    method: "DELETE",
  });
}

/** A new line: the name is required, the rest only if named straight away. */
export type NewProposalTask = { name: string; role?: string; effort?: number; rate?: number };

export function createProposalTask(
  projectId: string,
  categoryId: string,
  input: NewProposalTask,
): Promise<{ id: string; category_id: string; name: string }> {
  return request(`/api/projects/${projectId}/proposal/categories/${categoryId}/tasks`, {
    method: "POST",
    // Unnamed fields do not travel at all: JSON.stringify omits undefined.
    body: JSON.stringify(input),
  });
}

/** Mark a deal stage — in either direction; the timestamps are set by the server. */
export function setProposalStage(projectId: string, stage: ProposalStage): Promise<ProposalState> {
  return request<ProposalState>(`/api/projects/${projectId}/proposal/stage`, {
    method: "POST",
    body: JSON.stringify({ stage }),
  });
}

export function updateProposalTask(
  projectId: string,
  taskId: string,
  patch: ProposalTaskPatch,
): Promise<ProposalState> {
  return request<ProposalState>(`/api/projects/${projectId}/proposal/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteProposalTask(projectId: string, taskId: string): Promise<void> {
  return request(`/api/projects/${projectId}/proposal/tasks/${taskId}`, {
    method: "DELETE",
  });
}

/** The same reply shape as the project's feed: one component draws them. */
export function proposalComments(projectId: string, taskId: string): Promise<Comment[]> {
  return request<Comment[]>(`/api/projects/${projectId}/proposal/tasks/${taskId}/comments`);
}

export function addProposalComment(
  projectId: string,
  taskId: string,
  body: string,
): Promise<Comment> {
  return request<Comment>(`/api/projects/${projectId}/proposal/tasks/${taskId}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

/** What will happen on a transfer: where a section will land, how many days a line comes to. */
export type PushPreview = {
  categories: {
    id: string;
    name: string;
    /** The plan category found by name; `null` — a new one will be created. */
    plan_category: { id: string; name: string } | null;
    tasks: {
      id: string;
      name: string;
      duration_days: number;
      /** Already transferred earlier: it does not go into the plan a second time. */
      in_plan: boolean;
      /** The estimate is greater than zero; without an estimate a line is not transferred by default. */
      estimated: boolean;
    }[];
  }[];
};

/** Inside the quote's key: a revision from the socket invalidates it too. */
export function pushPreviewQueryKey(projectId: string) {
  return ["project", projectId, "proposal", "push-plan"] as const;
}

export function pushPlanPreview(projectId: string): Promise<PushPreview> {
  return request<PushPreview>(`/api/projects/${projectId}/proposal/push-plan`);
}

/**
 * Transferring the quote into the plan: a section becomes a category, a line becomes a task
 * at the plan's start. On the server this is a batch of ordinary revisions with a shared
 * batch_id — it reads as one entry in the history and is removed by one undo; the `batch_id`
 * in the response is the handle for the toast's "Revert". The named lines are transferred;
 * the server skips the already transferred ones itself.
 */
export function pushProposalToPlan(
  projectId: string,
  taskIds: string[],
): Promise<{ created_tasks: number; batch_id: string }> {
  return request(`/api/projects/${projectId}/proposal/push-to-plan`, {
    method: "POST",
    body: JSON.stringify({ task_ids: taskIds }),
  });
}

/**
 * Assembling an empty quote from the plan — the reverse of a transfer: a category becomes a
 * section, a task becomes a line with an estimate from its duration and a reference to the
 * task, so that a later transfer does not create it a second time. The assembly only reads
 * the plan and produces no revisions. Refusals: `proposal_not_empty`, `plan_empty`.
 */
export function buildProposalFromPlan(
  projectId: string,
): Promise<{ created_categories: number; created_tasks: number }> {
  return request(`/api/projects/${projectId}/proposal/build-from-plan`, { method: "POST" });
}
