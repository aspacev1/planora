import { useQuery } from "@tanstack/react-query";

import { ORG_QUERY_KEY, organization } from "../api/org";

/**
 * The roles allowed to change a project. The list repeats the server's permission matrix — and
 * repeats it deliberately rather than replacing it: the server decides either way, while what is
 * decided here is only whether to show a drag handle and whether to open fields for editing.
 *
 * The difference matters: an interface that hid a button protects nothing — it merely refrains from
 * offering a person an action that would end in a refusal anyway.
 */
const WRITERS = new Set(["owner", "editor"]);

export function roleCanWrite(role: string | undefined | null): boolean {
  return typeof role === "string" && WRITERS.has(role);
}

/**
 * The roles the server gives the commercial proposal to — the rates and the document for the client
 * (`Action.PROPOSAL_READ`). A client is promised dates and volume rather than what the price adds up
 * from, and the document button is not offered to them: it would end in a refusal anyway.
 */
const PROPOSAL_READERS = new Set(["owner", "editor", "viewer"]);

export function roleCanReadProposal(role: string | undefined | null): boolean {
  return typeof role === "string" && PROPOSAL_READERS.has(role);
}

/**
 * Whether the current person can change their organization's projects.
 *
 * The query's key is the same as the header's — the organization's roster is not requested a second
 * time: the answer is already in the cache by the time the project screen asks about it.
 */
export function useCanWrite(): boolean {
  return roleCanWrite(useOrgRole());
}

/**
 * The person's role in the current organization, as the server named it.
 *
 * Needed where the two states of "can write or not" are not enough: re-approving a plan and the
 * organization's settings are available to the owner rather than to anyone who can move bars.
 */
export function useOrgRole(): string | undefined {
  const org = useQuery({
    queryKey: ORG_QUERY_KEY,
    queryFn: organization,
    retry: false,
    staleTime: Infinity,
  });
  return org.data?.role;
}
