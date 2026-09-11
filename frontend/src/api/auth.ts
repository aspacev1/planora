import { request } from "./client";

/** The profile cache's key: one for the whole application, otherwise there will be two sign-in states. */
export const ME_QUERY_KEY = ["auth", "me"] as const;

export type User = {
  id: string;
  name: string;
  email: string;
  locale: string;
  /**
   * The time zone this person's day is counted by. `null` means "ask the browser": a zone
   * changes along with a person, and one recorded once when the account was created would lie
   * after the very first trip.
   */
  timezone: string | null;
  /** Whether the address is confirmed. In an install without mail it is empty for everyone and
      forbids nothing — it is a flag for a hint rather than for access. */
  email_verified: boolean;
  /**
   * Whether this person carries the director role — the single install-wide role, pinned on the
   * server to one specific address. It decides whether the "Admin panel" item is visible; here
   * it is only so as not to show a menu item leading to a certain refusal: access to the panel
   * itself is checked by the server anew.
   */
  is_director: boolean;
};

export type RegisterInput = {
  name: string;
  email: string;
  password: string;
  /**
   * The company name — that is what the organization the registration creates along with the
   * account is called. Needed only when an organization really is created: without an invitation
   * in hand. With an invitation the person joins somebody else's, and the server does not ask
   * for the field.
   */
  company_name?: string;
  /**
   * The invitation the person came by. With it the account is created right inside the inviting
   * organization — and is created even where free registration is switched off.
   */
  invite_token?: string;
};

export type LoginInput = {
  email: string;
  password: string;
};

export function register(input: RegisterInput): Promise<User> {
  return request<User>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function login(input: LoginInput): Promise<User> {
  return request<User>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function logout(): Promise<void> {
  return request<void>("/api/auth/logout", { method: "POST" });
}

export function me(): Promise<User> {
  return request<User>("/api/auth/me");
}

/**
 * Editing one's own profile — the fourth level of the settings.
 *
 * The language lives here rather than only in the browser's memory: a person who signed in from
 * another computer must see the same language rather than the one somebody else's browser asks
 * for. The same goes for the time zone — with one addition: a `null` in it means "count the day
 * by the browser", and so the field goes to the server exactly when it has been named rather
 * than when it is non-empty.
 */
export function updateProfile(patch: {
  name?: string;
  locale?: string;
  timezone?: string | null;
}): Promise<User> {
  return request<User>("/api/auth/me", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}
/**
 * Redeeming a link from an email. It requires no cookie: mail is read elsewhere.
 *
 * `already_verified` — the link was not opened for the first time. This is not a refusal: the
 * address is confirmed, and all that is left for the person is to choose the words —
 * "confirmed" or "already confirmed".
 */
export function verifyEmail(token: string): Promise<{ already_verified: boolean }> {
  return request<{ already_verified: boolean }>("/api/auth/verify-email", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

/**
 * A repeat email. The response tells the truth about delivery: `sent: false` means the email did
 * not go out, and promising "check your mail" in that case will not do.
 */
export function resendVerification(): Promise<{ sent: boolean }> {
  return request<{ sent: boolean }>("/api/auth/verify-email/resend", { method: "POST" });
}

/**
 * A request for a password recovery email. The response is the same for any address: the server
 * does not report whether such an account exists — and the screen must not promise an email,
 * only "if the address is registered".
 */
export function requestPasswordReset(email: string): Promise<void> {
  return request<void>("/api/auth/password/forgot", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

/** Redeeming a link from an email: a new password instead of a forgotten one. It requires no cookie. */
export function resetPassword(input: { token: string; new_password: string }): Promise<void> {
  return request<void>("/api/auth/password/reset", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
