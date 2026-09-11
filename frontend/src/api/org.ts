import { request } from "./client";

export const ORG_QUERY_KEY = ["org"] as const;

/** The organization's defaults — the very ones projects inherit. */
export type OrganizationSettings = {
  default_locale: string;
  default_timezone: string;
  /** A bitmask where bit 0 is Monday: that is how the server counts it. */
  working_days: number;
  week_start: number;
  holiday_calendar: string[];
  default_shift_threshold_days: number;
  public_sharing_enabled: boolean;
  default_comments_enabled: boolean;
};

export type Organization = {
  id: string;
  name: string;
  slug: string;
  role: string;
  settings: OrganizationSettings;
};

/** The slug field's answer: what the input will turn into and what to do if it is taken. */
export type SlugCheck = {
  normalized: string;
  available: boolean;
  suggestion: string;
};

export const MEMBERS_QUERY_KEY = ["org", "members"] as const;

export type Member = {
  id: string;
  name: string;
  email: string;
  role: string;
};

export const ORGANIZATIONS_QUERY_KEY = ["org", "list"] as const;

/** The organization the person is currently in. */
export function organization(): Promise<Organization> {
  return request<Organization>("/api/org");
}

/**
 * The organizations the person belongs to — the switcher's contents.
 *
 * It arrives even when there is one organization: deciding whether to show the switcher is the
 * interface's business, not the server's.
 */
export function organizations(): Promise<Organization[]> {
  return request<Organization[]>("/api/org/list");
}

/**
 * Switches the session to another organization.
 *
 * The choice lives on the session rather than on the page: after a reload the person stays where
 * they were working rather than returning to their own organization.
 */
export function switchOrganization(orgId: string): Promise<Organization> {
  return request<Organization>("/api/org/switch", {
    method: "POST",
    body: JSON.stringify({ org_id: orgId }),
  });
}

/**
 * The people who can be made assignees.
 *
 * The `client` role never gets this route and sees a 403. That is not a breakage: the caller must
 * survive the refusal by hiding the assignee choice rather than showing an error in a form it has
 * nothing to do with.
 */
export function members(): Promise<Member[]> {
  return request<Member[]>("/api/org/members");
}

/**
 * Editing the organization's settings.
 *
 * Only the changed fields are sent: the server tells "not sent" from "sent as null", and sending
 * the whole form would mean overwriting somebody else's edits made between the screen opening and
 * the button being pressed.
 */
export function updateOrganization(
  patch: Partial<OrganizationSettings & { name: string; slug: string }>,
): Promise<Organization> {
  return request<Organization>("/api/org", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function checkOrgSlug(slug: string): Promise<SlugCheck> {
  return request<SlugCheck>(`/api/org/slug-check?slug=${encodeURIComponent(slug)}`);
}

/**
 * Changes a member's role. The owner edits, and only they.
 *
 * An owner is appointed precisely from here rather than by an invitation: an invitation with no
 * address goes to whoever holds it, and anyone who opened a forwarded link would become an owner.
 * Here the recipient is named by name.
 *
 * The last owner cannot be demoted — the server answers `last_owner`. An organization without an
 * owner is not demoted but locked: there is nothing left in it to appoint a new one with.
 */
export function updateMemberRole(userId: string, role: string): Promise<Member> {
  return request<Member>(`/api/org/members/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

/**
 * Removes a person from the organization — or lets them out themselves.
 *
 * One route for both actions: in both cases the membership is gone, and all that makes them
 * different is who is entitled to perform it — an owner over anyone, or a person over themselves.
 * Hence "Leave the organization": it is the same call with one's own id.
 */
export function removeMember(userId: string): Promise<void> {
  return request<void>(`/api/org/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
}
