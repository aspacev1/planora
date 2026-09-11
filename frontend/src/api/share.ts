import { request } from "./client";

/** The key of one project's publication state. */
export function shareQueryKey(projectId: string) {
  return ["project", projectId, "share"] as const;
}

export type Share = {
  /**
   * Whether public links are allowed at all: the install's switch and the organization's setting. It
   * arrives even when there is no link yet — otherwise the interface would not tell "not published"
   * from "publishing is forbidden" and would offer a button that ends in a refusal.
   */
  allowed: boolean;
  /** The page's full address. `null` — the project is not published. */
  url: string | null;
  comments_enabled: boolean;
  created_at: string | null;
};

export function getShare(projectId: string): Promise<Share> {
  return request<Share>(`/api/projects/${projectId}/share`);
}

/** The link's first issue. If it already exists the server answers with a 409 — a repeated request
 * does not kill an address that has just been sent out. */
export function issueShare(projectId: string): Promise<Share> {
  return request<Share>(`/api/projects/${projectId}/share`, { method: "POST" });
}

/** A reissue: the old address dies instantly. A separate call, so that "create" and "kill the
 * previous one" cannot be confused by a retry. */
export function rotateShare(projectId: string): Promise<Share> {
  return request<Share>(`/api/projects/${projectId}/share/rotate`, { method: "POST" });
}

export function setShareComments(projectId: string, enabled: boolean): Promise<Share> {
  return request<Share>(`/api/projects/${projectId}/share`, {
    method: "PATCH",
    body: JSON.stringify({ comments_enabled: enabled }),
  });
}

export function revokeShare(projectId: string): Promise<void> {
  return request<void>(`/api/projects/${projectId}/share`, { method: "DELETE" });
}
