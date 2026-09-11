import { useQueries, useQuery } from "@tanstack/react-query";

import {
  PROJECTS_QUERY_KEY,
  getProject,
  listProjects,
  projectQueryKey,
} from "../api/projects";
import type { Project, ProjectState } from "../api/projects";

/**
 * All the organization's projects with their states — the raw material for "Projects", "My tasks"
 * and "Reports".
 *
 * The list, then each project's state separately: there is no combined route on the server, and the
 * keys coincide with the project screen's keys — whatever has already been opened comes from the
 * cache, and the list does not pay a second request for what the person has just been looking at.
 * This product's installs are teams with single-digit numbers of projects rather than portals with
 * hundreds: a fan of requests here is cheaper than a new server route that would have to be kept in
 * agreement with the main one.
 *
 * The list and the states are separated in the response too. The projects screen draws the names as
 * soon as the list arrives and fills the cards in with the summary as the states come: waiting for a
 * shared "ready" would mean holding an empty screen because of one slow project. The reports and "My
 * tasks" need everything at once — they are left with `pending` and `error`.
 */
export function useProjectStates(): {
  /** The list and every last state. */
  pending: boolean;
  /** The first error of any of the requests. */
  error: unknown;
  /** The list alone: the cards' names are drawn from it. */
  listPending: boolean;
  /**
   * The list's refusal alone. Separate from the shared one: one project's state failing to arrive is
   * a card without a summary rather than a screen without projects, and a "server unavailable"
   * banner over a normally loaded list would be a lie.
   */
  listError: unknown;
  projects: Project[];
  states: ProjectState[];
  stateById: Map<string, ProjectState>;
} {
  const list = useQuery({ queryKey: PROJECTS_QUERY_KEY, queryFn: listProjects, retry: false });

  const details = useQueries({
    queries: (list.data ?? []).map((project) => ({
      queryKey: projectQueryKey(project.id),
      queryFn: () => getProject(project.id),
      retry: false,
    })),
  });

  const states = details
    .map((query) => query.data)
    .filter((state): state is ProjectState => state !== undefined);

  return {
    pending: list.isPending || details.some((query) => query.isPending),
    // The first error rather than all of them: the screens show one refusal line, and a list of five
    // identical "server unavailable"s would say nothing beyond it.
    error: list.error ?? details.find((query) => query.error)?.error ?? null,
    listPending: list.isPending,
    listError: list.error ?? null,
    projects: list.data ?? [],
    states,
    stateById: new Map(states.map((state) => [state.id, state])),
  };
}
