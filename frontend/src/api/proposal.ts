import { request } from "./client";
import type { Comment } from "./comments";

/**
 * Коммерческое предложение проекта: смета до плана.
 *
 * Цена строки на проводе не ездит намеренно: она равна effort × rate, и
 * присланная копия разъехалась бы с сомножителями. Итоги считает экран —
 * это произведение и сумма уже показанных чисел.
 */

export type EffortUnit = "days" | "hours";

export type ProposalTask = {
  id: string;
  category_id: string;
  name: string;
  /** Короткое описание — колонка таблицы; подробное (`details`) — карточка. */
  description: string;
  details: string;
  /** Роль исполнителя словами, а не участник: смету пишут до назначения людей. */
  role: string;
  /** Трудоёмкость в единицах предложения (см. ProposalState.effort_unit). */
  effort: number;
  /** Ставка за единицу трудоёмкости, в валюте предложения. */
  rate: number;
  notes: string;
  risks: string;
  assumptions: string;
  position: number;
  comment_count: number;
  /**
   * Задача плана, из которой строка собрана или в которую перенесена.
   * `null` — в плане её ещё нет: перенос заведёт её, а связанные пропустит.
   */
  plan_task_id: string | null;
};

export type ProposalCategory = {
  id: string;
  name: string;
  /** Одна строка о разделе целиком — стоит на его строке в таблице. */
  description: string;
  position: number;
  tasks: ProposalTask[];
};

export type ProposalState = {
  effort_unit: EffortUnit;
  /** Сколько часов считать днём при переносе почасовой сметы в план. */
  hours_per_day: number;
  tax_rate_pct: number;
  /** Код ISO 4217 — например, «USD». */
  currency: string;
  /** Допущения и примечания предложения целиком, по пункту на строку. */
  notes: string;
  categories: ProposalCategory[];
  /**
   * Чем наполнен план — для карточки «Собрать из плана» на пустой смете.
   * Категории считаются те, в которых есть задачи: столько разделов сборка
   * и заведёт.
   */
  plan: { tasks: number; categories: number };
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
 * Ключ — внутри ключа проекта: ревизия из сокета сбрасывает проект целиком,
 * и смета, чей перенос в план сам рождает ревизию, обновляется тем же вызовом.
 */
export function proposalQueryKey(projectId: string) {
  return ["project", projectId, "proposal"] as const;
}

/** Лента строки — внутри ключа сметы: сброс сметы задевает и разговор. */
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

export function createProposalTask(
  projectId: string,
  categoryId: string,
  name: string,
): Promise<{ id: string; category_id: string; name: string }> {
  return request(`/api/projects/${projectId}/proposal/categories/${categoryId}/tasks`, {
    method: "POST",
    body: JSON.stringify({ name }),
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

/** Та же форма реплики, что у ленты проекта: рисует их один компонент. */
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

/**
 * Перенос сметы в план: раздел — категорией, строка — задачей на старте
 * плана. На сервере это пачка обычных ревизий с общим batch_id — в истории
 * читается одной записью и снимается одной отменой.
 */
export function pushProposalToPlan(projectId: string): Promise<{ created_tasks: number }> {
  return request(`/api/projects/${projectId}/proposal/push-to-plan`, { method: "POST" });
}

/**
 * Сборка пустой сметы из плана — обратный путь к переносу: категория —
 * разделом, задача — строкой с оценкой из длительности и ссылкой на задачу,
 * чтобы перенос потом не завёл её второй раз. План сборка только читает, и
 * ревизий не рождает. Отказы: `proposal_not_empty`, `plan_empty`.
 */
export function buildProposalFromPlan(
  projectId: string,
): Promise<{ created_categories: number; created_tasks: number }> {
  return request(`/api/projects/${projectId}/proposal/build-from-plan`, { method: "POST" });
}
