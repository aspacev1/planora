/**
 * The memory of an address-confirmation email that has just been sent.
 *
 * The server holds a pause between emails and answers a too-early repeat with a refusal. The client
 * has nowhere to learn when that pause expires: the email after registration goes out along with
 * the response, and `/api/auth/me` tells nothing about emails. So the browser remembers that an
 * email has just gone out — and the strip shows "an email was sent to …" instead of a button that
 * would answer "too often" on the very first press.
 *
 * The storage is `localStorage`: reloading the page right after registration must not erase this
 * memory, otherwise the button promises again what the server will not give. The record is tied to
 * the address: somebody else's memory must not show the next person signing in on this computer an
 * email that was not sent to them.
 */

const KEY = "planora.verification_sent";

/**
 * The same as the server holds (RESEND_COOLDOWN in backend/app/email_verification.py). The numbers
 * are set separately deliberately: they have no shared place, and having diverged they would give a
 * button that came alive a second before the refusal — that is, exactly the refusal all of this
 * exists to avoid. So there is one second more here.
 */
export const RESEND_COOLDOWN_MS = 61_000;

type Stored = { email: string; at: number };

/** Remembers: an email to this address has just gone out. */
export function noteVerificationSent(email: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ email, at: Date.now() } satisfies Stored));
  } catch {
    // A browser's private mode can forbid storage. Then the strip works as if without memory: the
    // button is enabled, and a too-early repeat is explained in the server's words. That is no
    // reason to crash.
  }
}

/**
 * When an email went to this address. `null` — none was sent, one was sent to someone else, or the
 * record is corrupted.
 */
export function verificationSentAt(email: string): number | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return null;
    const stored = JSON.parse(raw) as Partial<Stored>;
    if (typeof stored.at !== "number" || stored.email !== email) return null;
    return stored.at;
  } catch {
    // Somebody else's or a corrupted record under our key is the same thing as its absence: there is
    // nothing to parse it with, and crashing in the application's frame will not do.
    return null;
  }
}
