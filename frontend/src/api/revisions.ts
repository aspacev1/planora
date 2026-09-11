import { request } from "./client";

/**
 * The journal's key lies under the project's key: `["project", id, ...]`.
 *
 * This is not decoration. A change to the project invalidates the whole subtree with one
 * `invalidateQueries` by prefix, and the history refreshes along with the state on its own — without a
 * separate list of keys that someone will one day forget to extend.
 */
export function revisionsQueryKey(projectId: string, taskId: string) {
  return ["project", projectId, "revisions", taskId] as const;
}

/** The whole project's feed — its own branch of the same subtree, with the filters in the key. */
export function feedQueryKey(projectId: string, filters: FeedFilters) {
  return ["project", projectId, "revisions", "feed", filters] as const;
}

export type RevisionEntry = {
  seq: number;
  created_at: string;
  /** There may be no author: the AI's operations and system entries go without a person. */
  actor: { id: string; name: string } | null;
  /** The shift's reason — a person's text. Not translated. */
  reason: string | null;
  /** Shared by a batch applied in one action (the AI). */
  batch_id: string | null;
  /** The number of the revision this one undid. `null` — an ordinary entry. */
  undoes_seq: number | null;
  /** The event as parameters. It is assembled into a phrase by the client, in the reader's language. */
  op: Record<string, unknown>;
  /**
   * The names of the entities the operation mentions, by id. For deleted ones — from the restoration
   * snapshot: a name outlives a deletion in the journal.
   */
  names: Record<string, string>;
};

export type FeedFilters = {
  taskId?: string;
  actorId?: string;
  /** The operation types as the journal knows them; assembled from the filter's groups. */
  types?: string[];
};

export function listTaskRevisions(projectId: string, taskId: string): Promise<RevisionEntry[]> {
  return request<RevisionEntry[]>(
    `/api/projects/${projectId}/revisions?task_id=${encodeURIComponent(taskId)}`,
  );
}

/** The feed's page size. As a separate constant: the feed recognizes the last page by it — shorter than
 *  the limit means "there is nothing further". */
export const FEED_PAGE = 50;

export function listProjectRevisions(
  projectId: string,
  filters: FeedFilters,
  beforeSeq?: number,
): Promise<RevisionEntry[]> {
  const params = new URLSearchParams();
  if (filters.taskId) params.set("task_id", filters.taskId);
  if (filters.actorId) params.set("actor_id", filters.actorId);
  for (const type of filters.types ?? []) params.append("types", type);
  if (beforeSeq !== undefined) params.set("before_seq", String(beforeSeq));
  params.set("limit", String(FEED_PAGE));
  return request<RevisionEntry[]>(`/api/projects/${projectId}/revisions?${params}`);
}
