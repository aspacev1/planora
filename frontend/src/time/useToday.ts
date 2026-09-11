import { useQuery } from "@tanstack/react-query";

import { ME_QUERY_KEY, me } from "../api/auth";
import type { User } from "../api/auth";
import { ORG_QUERY_KEY, organization } from "../api/org";
import { browserTimeZone, dayIn } from "./zone";

/**
 * The zone this reader's day is counted by.
 *
 * The order of sources runs from the most personal to the most general:
 *
 * 1. the profile — the only one that knows more about the reader than the browser does: someone who
 *    has gone away on holiday or sits behind a VPN chooses the zone by hand, and their choice must
 *    beat everything else;
 * 2. the project — the zone the plan itself lives in: the dates, the deadline and "is the task
 *    behind" are computed in it, and counting "today" differently would mean checking a bar against
 *    one date and its notch against another;
 * 3. the organization — the same answer for screens with no project at all: "My tasks", the reports,
 *    the new task form;
 * 4. the browser — when nobody has been asked yet. Not UTC: for a reader east of Greenwich UTC is
 *    wrong by a whole day every night, while the machine's clock is the closest thing to their wall
 *    available without a single request.
 *
 * The profile and the organization are read from the cache (`enabled: false`) rather than asked
 * for: they are asked for anyway by `AuthProvider` and by the header on every protected screen. A
 * request from here would go out from every task card, and on the public page it would go into a
 * 401 a guest has no reason to expect.
 */
export function useTimeZone(projectZone?: string | null): string | undefined {
  const profile = useQuery({ queryKey: ME_QUERY_KEY, queryFn: me, enabled: false });
  const org = useQuery({ queryKey: ORG_QUERY_KEY, queryFn: organization, enabled: false });

  const user = (profile.data as User | null | undefined) ?? null;
  return (
    user?.timezone ??
    projectZone ??
    org.data?.settings.default_timezone ??
    browserTimeZone()
  );
}

/**
 * Today in the reader's zone — `YYYY-MM-DD`, as the server writes them.
 *
 * Computed on render rather than by a timer: a tab open across midnight learns the new date with the
 * next state update. Setting an alarm clock here would mean jerking the whole strip's repaint about
 * for the sake of a day nobody is looking at at that hour anyway.
 */
export function useToday(projectZone?: string | null): string {
  return dayIn(useTimeZone(projectZone));
}
