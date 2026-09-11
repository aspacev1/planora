import { request } from "./client";

export const INVITATIONS_QUERY_KEY = ["org", "invitations"] as const;

/** The invitation's key by token: every link has its own, and there can be several acceptance screens. */
export function inviteQueryKey(token: string) {
  return ["invitation", token] as const;
}

export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";

export type Invitation = {
  id: string;
  /** null — an invitation by link only: it goes to whoever holds it. */
  email: string | null;
  role: string;
  status: InviteStatus;
  project_ids: string[];
  created_at: string;
  expires_at: string;
  last_sent_at: string | null;
  invited_by: string | null;
  accepted_at: string | null;
};

export type InvitationList = {
  /**
   * Whether mail is configured in the install. Without it the send button is not shown at all — an
   * install without a mail server stays fully usable rather than showing a button that always answers
   * with a refusal.
   */
  mail_enabled: boolean;
  invitations: Invitation[];
};

export type Issued = {
  id: string;
  email: string | null;
  role: string;
  expires_at: string;
  /**
   * The open link. It arrives only in response to an issue and nowhere else: the database holds the
   * token's hash, and there is nowhere to take it a second time. Hence the screen's behaviour too — the
   * link is shown at once and is not hidden until the next action.
   */
  url: string;
  sent: boolean;
  /** Why the email did not go out. The invitation is created at that. */
  mail_error: string | null;
};

export type InviteInput = {
  emails: string[];
  role: string;
  project_ids?: string[];
  deliver?: boolean;
};

export type InvitePreview = {
  org_name: string;
  role: string;
  email: string | null;
  inviter_name: string | null;
  expires_at: string;
};

export type JoinedOrganization = {
  id: string;
  name: string;
  slug: string;
  role: string;
};

export function listInvitations(): Promise<InvitationList> {
  return request<InvitationList>("/api/org/invitations");
}

export function createInvitations(input: InviteInput): Promise<Issued[]> {
  return request<Issued[]>("/api/org/invitations", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** A new link in place of the previous one — also known as "send again". */
export function reissueInvitation(id: string, deliver: boolean): Promise<Issued> {
  return request<Issued>(`/api/org/invitations/${id}/reissue`, {
    method: "POST",
    body: JSON.stringify({ deliver }),
  });
}

export function revokeInvitation(id: string): Promise<void> {
  return request<void>(`/api/org/invitations/${id}`, { method: "DELETE" });
}

/** What invitation is in hand — it answers someone who has not signed in yet too. */
export function previewInvitation(token: string): Promise<InvitePreview> {
  return request<InvitePreview>(`/api/invitations/${encodeURIComponent(token)}`);
}

export function acceptInvitation(token: string): Promise<JoinedOrganization> {
  return request<JoinedOrganization>(`/api/invitations/${encodeURIComponent(token)}/accept`, {
    method: "POST",
  });
}
