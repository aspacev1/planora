import { request } from "./client";

export type Comment = {
  id: string;
  /** `null` — a reply to the whole project rather than to a task. */
  task_id: string | null;
  /**
   * The signature under a reply. A guest and a member are signed the same way — by name; what tells
   * them apart is the `guest` flag rather than the shape of the record.
   */
  author: { name: string; guest: boolean };
  body: string;
  created_at: string;
};

export function commentsQueryKey(projectId: string, taskId?: string) {
  // The task is at the end of the key rather than a key of its own: a task's feed is the same project
  // feed filtered by the server, and refreshing one must touch the other.
  return taskId === undefined
    ? (["project", projectId, "comments"] as const)
    : (["project", projectId, "comments", taskId] as const);
}

/**
 * The reply counter's key is inside the feed's key rather than next to it.
 *
 * The counter must refresh at exactly the same time as the feed itself: with one's own reply from the
 * card and with somebody else's arriving over the socket. Both places already invalidate the project's
 * feed whole, and a nested key is picked up by the same call. A separate one would have to be
 * invalidated second — and one day it would be forgotten.
 */
export function commentCountsQueryKey(projectId: string) {
  return ["project", projectId, "comments", "counts"] as const;
}

/**
 * How many replies each task has — the number the strip shows on a row.
 *
 * As a separate request rather than a count over the feed: the feed is served as a tail of a hundred
 * replies, and counting over it would lie exactly where there is a lot of conversation. Tasks with no
 * replies are absent from the response: zero is the absence of a key.
 */
export function commentCounts(projectId: string): Promise<Record<string, number>> {
  return request<Record<string, number>>(`/api/projects/${projectId}/comments/counts`);
}

export function listComments(projectId: string, taskId?: string): Promise<Comment[]> {
  const query = taskId === undefined ? "" : `?task_id=${encodeURIComponent(taskId)}`;
  return request<Comment[]>(`/api/projects/${projectId}/comments${query}`);
}

export function addComment(
  projectId: string,
  body: string,
  taskId?: string,
): Promise<Comment> {
  return request<Comment>(`/api/projects/${projectId}/comments`, {
    method: "POST",
    body: JSON.stringify(taskId === undefined ? { body } : { body, task_id: taskId }),
  });
}
