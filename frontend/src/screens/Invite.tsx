import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { errorKey } from "../api/errors";
import { acceptInvitation, inviteQueryKey, previewInvitation } from "../api/invitations";
import { useAuth } from "../auth/AuthProvider";
import { forgetInvite, rememberInvite, withInvite } from "../auth/invite";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * The invitation screen: what a person opening the link sees.
 *
 * It lives outside RequireAuth: an invitee is by definition not in the organization yet, and often
 * not in the system at all. Demanding a sign-in before they learn what they are being invited to is
 * asking them to sign without looking.
 */
export function Invite() {
  const { t } = useLocale();
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, status, logout } = useAuth();

  const preview = useQuery({
    queryKey: inviteQueryKey(token),
    queryFn: () => previewInvitation(token),
    retry: false,
  });

  // A live invitation is remembered as soon as it becomes clear that it is live: after that the
  // person may be carried off to the sign-in, from there to password recovery, and from there into
  // an email, after which the query string no longer remembers anything.
  useEffect(() => {
    if (preview.isSuccess) rememberInvite(token);
    // There is no point remembering a dead link: it will lead nowhere any more, while it would
    // manage to surface in the middle of the next sign-in.
    if (preview.isError) forgetInvite();
  }, [preview.isSuccess, preview.isError, token]);

  const accept = useMutation({
    mutationFn: () => acceptInvitation(token),
    onSuccess: () => {
      forgetInvite();
      // The server switched the session to the new organization — everything the cache remembers
      // about the former one went stale at that same moment. Invalidation rather than clear(): the
      // signed-in person's profile has gone nowhere, and throwing it out would mean sending the
      // application into "checking the session" right after a successful action.
      void queryClient.invalidateQueries();
      navigate("/projects");
    },
  });

  if (preview.isPending || status === "checking") {
    return (
      <main className="screen screen--narrow screen--center">
        <p role="status">{t("common.loading")}</p>
      </main>
    );
  }

  if (preview.error) {
    // Expired, revoked, accepted — three different messages rather than a single "the link is
    // invalid": for each of them a person does something different.
    return (
      <main className="screen screen--narrow">
        <h1>{t("invite.accept.title")}</h1>
        <p className="error" role="alert">
          {t(errorKey(preview.error))}
        </p>
        <p className="muted">
          <Link to="/projects">{t("invite.accept.go_home")}</Link>
        </p>
      </main>
    );
  }

  const invitation = preview.data;
  // The address ties the invitation down: to someone signed in under a different account the system
  // says outright who it is addressed to and offers to sign out — instead of a refusal from which
  // it is unclear what to do next.
  const wrongAccount =
    user !== null && invitation.email !== null && invitation.email !== user.email.toLowerCase();

  return (
    <main className="screen screen--narrow">
      <h1>{t("invite.accept.title")}</h1>

      <p>
        {t("invite.accept.summary", {
          org: invitation.org_name,
          role: t(`members.role.${invitation.role}`),
        })}
      </p>
      {invitation.inviter_name && (
        <p className="muted">{t("invite.accept.inviter", { name: invitation.inviter_name })}</p>
      )}
      {invitation.email === null && <p className="muted">{t("invite.accept.bearer")}</p>}

      {status === "anonymous" && (
        <p className="invite__choice">
          <Link to={withInvite("/register", token)}>{t("invite.accept.register")}</Link>
          <Link to={withInvite("/login", token)}>{t("invite.accept.login")}</Link>
        </p>
      )}

      {wrongAccount && (
        <>
          <p className="error" role="alert">
            {t("invite.accept.wrong_account", { email: invitation.email as string })}
          </p>
          <button type="button" onClick={() => void logout()}>
            {t("invite.accept.logout")}
          </button>
        </>
      )}

      {status === "authenticated" && !wrongAccount && (
        <>
          {accept.error && (
            <p className="error" role="alert">
              {t(errorKey(accept.error))}
            </p>
          )}
          <button type="button" disabled={accept.isPending} onClick={() => accept.mutate()}>
            {t("invite.accept.submit")}
          </button>
        </>
      )}
    </main>
  );
}
