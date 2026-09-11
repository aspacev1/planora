import { request } from "./client";
import type { Comment } from "./comments";
import type { ProjectState } from "./projects";

/**
 * The public page: the same project state plus what only it has.
 *
 * The assignees in it are always empty and there is no internal note at all — that is decided by the
 * server rather than by the markup. The type honestly extends `ProjectState`: the fields are the same,
 * otherwise the public page could not hand it to the same chart.
 */
export type PublicProjectState = ProjectState & {
  org: { name: string; slug: string };
  comments_enabled: boolean;
};

export function publicProjectQueryKey(orgSlug: string, projectSlug: string, token: string) {
  return ["public", orgSlug, projectSlug, token] as const;
}

export function publicCommentsQueryKey(orgSlug: string, projectSlug: string, token: string) {
  return ["public", orgSlug, projectSlug, token, "comments"] as const;
}

/** Inside the feed's key — for the same reason as on the working screen. */
export function publicCommentCountsQueryKey(
  orgSlug: string,
  projectSlug: string,
  token: string,
) {
  return [...publicCommentsQueryKey(orgSlug, projectSlug, token), "counts"] as const;
}

function publicPath(orgSlug: string, projectSlug: string, token: string, suffix = ""): string {
  // The token goes as a query parameter — the same way it arrives in the page's address. Every part is
  // encoded: the slug is built by the server, but it is the address bar that substitutes them here, and
  // anything can end up in it.
  const path = `/api/public/${encodeURIComponent(orgSlug)}/${encodeURIComponent(projectSlug)}`;
  return `${path}${suffix}?s=${encodeURIComponent(token)}`;
}

export function getPublicProject(
  orgSlug: string,
  projectSlug: string,
  token: string,
): Promise<PublicProjectState> {
  return request<PublicProjectState>(publicPath(orgSlug, projectSlug, token));
}

export function listPublicComments(
  orgSlug: string,
  projectSlug: string,
  token: string,
): Promise<Comment[]> {
  return request<Comment[]>(publicPath(orgSlug, projectSlug, token, "/comments"));
}

/** The reply counter on the public strip's rows — without the internal ones: a guest does not see them. */
export function listPublicCommentCounts(
  orgSlug: string,
  projectSlug: string,
  token: string,
): Promise<Record<string, number>> {
  return request<Record<string, number>>(
    publicPath(orgSlug, projectSlug, token, "/comments/counts"),
  );
}

export function addPublicComment(
  orgSlug: string,
  projectSlug: string,
  token: string,
  comment: { name: string; body: string; task_id?: string },
): Promise<Comment> {
  return request<Comment>(publicPath(orgSlug, projectSlug, token, "/comments"), {
    method: "POST",
    body: JSON.stringify(comment),
  });
}
