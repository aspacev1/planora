import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  ORGANIZATIONS_QUERY_KEY,
  ORG_QUERY_KEY,
  organization,
  organizations,
  switchOrganization,
} from "../api/org";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * The organization switcher.
 *
 * It is shown only when there is more than one organization: a person who has accepted nobody and been
 * accepted nowhere has no choice, and a one-item list next to the name is a question with no answer.
 *
 * The organization's name stays the header's caption; the switcher stands next to it rather than
 * instead — otherwise the name would disappear from the screen for everyone else.
 */
export function OrgSwitch() {
  const { t } = useLocale();
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: ORGANIZATIONS_QUERY_KEY,
    queryFn: organizations,
    retry: false,
    staleTime: Infinity,
  });
  // The same key as the header's: the current organization is already in the cache by the time the
  // switcher asks about it, and there will be no second request.
  const current = useQuery({
    queryKey: ORG_QUERY_KEY,
    queryFn: organization,
    retry: false,
    staleTime: Infinity,
  });

  const change = useMutation({
    mutationFn: switchOrganization,
    onSuccess: (org) => {
      // The organization changed — and with it everything that depends on it: the projects, the roster,
      // the invitations. A targeted refresh here would mean a list of screens that would have to be
      // extended with every new one.
      queryClient.setQueryData(ORG_QUERY_KEY, org);
      void queryClient.invalidateQueries();
    },
  });

  const items = list.data ?? [];
  if (items.length < 2) return null;

  return (
    <select
      className="org-switch"
      aria-label={t("org.switch_label")}
      value={current.data?.id ?? ""}
      onChange={(event) => change.mutate(event.target.value)}
    >
      {items.map((org) => (
        <option key={org.id} value={org.id}>
          {org.name}
        </option>
      ))}
    </select>
  );
}
