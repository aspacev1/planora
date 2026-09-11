/**
 * The invitation, while a person moves around the sign-in screens.
 *
 * The token lives in the query string, and every navigation that does not carry it over loses the
 * invitation for good: the person returns to their former organization while the inviter goes on
 * seeing "Pending" and thinking the email was not opened. So the neighbouring screen's address is
 * built by one function for all four screens rather than branching separately in each of them —
 * that way the rule cannot be kept in one direction and forgotten in the other.
 *
 * The query string alone, however, is not enough. Between "Forgot your password?" and "Sign in"
 * stands an email, and the link in it is built by the server, which has no invitation in it and
 * cannot have. On that transition the token would be lost however careful one is with the links —
 * so it is also remembered for an hour.
 */

const KEY = "planora.pending_invite";

/**
 * An hour is the trip to the mailbox and back.
 *
 * There is nothing to hold it longer for: an invitation a person forgot about yesterday must not
 * surface in the middle of today's sign-in. Less is too little: emails are not read the same minute.
 */
const TTL_MS = 60 * 60 * 1000;

type Stored = { token: string; at: number };

/** The address of the sign-in or registration screen with the saved invitation. */
export function withInvite(path: string, token: string | null): string {
  return token === null ? path : `${path}?invite=${encodeURIComponent(token)}`;
}

/**
 * Remembers an invitation opened by a link.
 *
 * The storage is `localStorage` rather than `sessionStorage`: a mail client opens a link from an
 * email in a new tab, and `sessionStorage` is not inherited by a tab — that is, in exactly the
 * transition all of this exists for, it would be empty.
 */
export function rememberInvite(token: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ token, at: Date.now() } satisfies Stored));
  } catch {
    // A browser's private mode can forbid storage. Then what worked before works — the token in the
    // query string. That is no reason to crash.
  }
}

/** The invitation the person came here by. `null` — there is none or it has gone stale. */
export function pendingInvite(): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return null;
    const stored = JSON.parse(raw) as Partial<Stored>;
    if (typeof stored.token !== "string" || typeof stored.at !== "number") return null;
    if (Date.now() - stored.at > TTL_MS) {
      forgetInvite();
      return null;
    }
    return stored.token;
  } catch {
    // Somebody else's or a corrupted record under our key is the same thing as its absence: there is
    // nothing to parse it with, and crashing at sign-in will not do.
    return null;
  }
}

/** Forgets the invitation: it was accepted, declined or is no longer needed. */
export function forgetInvite(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // see rememberInvite()
  }
}
