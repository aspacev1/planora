import { request } from "./client";

export const ADMIN_USERS_QUERY_KEY = ["admin", "users"] as const;

export type AdminUser = {
  id: string;
  name: string;
  email: string;
  /** The registration date — the moment the account was created. */
  created_at: string;
  /** The last time a request arrived with this person's session. `null` —
      no activity is visible yet. */
  last_active_at: string | null;
  /** The organizations the person belongs to. Empty — they left them all,
      including their own, created at registration. */
  organizations: string[];
};

/**
 * All the install's accounts — the newest registrations first.
 *
 * Available only to the director role on the server; for the rest the route answers with a 403 (see
 * `error.forbidden` in the dictionary).
 */
export function adminUsers(): Promise<AdminUser[]> {
  return request<AdminUser[]>("/api/admin/users");
}
