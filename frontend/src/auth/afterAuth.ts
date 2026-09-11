import type { Location } from "react-router-dom";

/** Where to lead a person when there is nowhere to return to. */
export const AFTER_AUTH_FALLBACK = "/projects";

/**
 * The address the person was sent to the sign-in for.
 *
 * `RequireAuth` puts the original address into the navigation state, and the sign-in and registration
 * screens return the person precisely there. Without that a link to a project turns after the sign-in
 * into a general list — that is, exactly what the link was followed for is lost, and that is a new
 * participant's very first screen.
 *
 * The history state is not created by us alone: any page of the same origin can put anything there
 * through `history.pushState`. So we take only an internal path: `//example.com` would be read by the
 * browser as a navigation to somebody else's site, while a return to the sign-in itself would lock the
 * person in a loop — they type a password and see the password form again.
 */
export function afterAuthPath(state: unknown): string {
  const from = (state as { from?: unknown } | null | undefined)?.from;
  if (from === null || typeof from !== "object") return AFTER_AUTH_FALLBACK;

  const { pathname, search, hash } = from as Partial<Location>;
  if (typeof pathname !== "string" || !pathname.startsWith("/") || pathname.startsWith("//")) {
    return AFTER_AUTH_FALLBACK;
  }
  if (pathname === "/login" || pathname === "/register") return AFTER_AUTH_FALLBACK;

  return `${pathname}${typeof search === "string" ? search : ""}${typeof hash === "string" ? hash : ""}`;
}
