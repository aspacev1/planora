import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";

import { ME_QUERY_KEY, resendVerification, verifyEmail } from "../api/auth";
import { errorKey } from "../api/errors";
import { useAuth } from "../auth/AuthProvider";
import { noteVerificationSent } from "../auth/verificationNotice";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * The screen the link from the email leads to.
 *
 * The redemption happens as a request from this page rather than by navigating to the API's own
 * address: the link in an email gets opened before the person does — mail scanners and messenger
 * previews walk every address in turn, and a one-time token would burn out before the email was even
 * read.
 *
 * It opens without a session: mail is not necessarily read in the browser the person signed in with.
 */
export function VerifyEmail() {
  const { t } = useLocale();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";

  // useQuery rather than an effect: React in StrictMode mounts the tree twice, and the second
  // request would arrive with the token already redeemed — a success would turn into an error before
  // the person's eyes. There is one request with the same key here.
  const verification = useQuery({
    queryKey: ["verify-email", token],
    queryFn: async () => {
      const result = await verifyEmail(token);
      // The profile in the cache holds the previous /me answer, where the address is not confirmed
      // yet; without invalidating it the hint would hang around until a reload.
      await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      return result;
    },
    enabled: token !== "",
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const resend = useMutation({
    mutationFn: resendVerification,
    onSuccess: (result) => {
      // The strip in the application's frame counts the pause from this mark — otherwise a person
      // who left here for the projects would see a button there that answers "too often" about an
      // email sent a second ago.
      if (result.sent && user) noteVerificationSent(user.email);
    },
  });

  return (
    <main className="screen screen--narrow">
      <h1>{t("auth.verify.title")}</h1>

      {token === "" && (
        <p className="error" role="alert">
          {t("auth.error.missing_token")}
        </p>
      )}

      {verification.isPending && token !== "" && (
        <p role="status">{t("auth.verify.checking")}</p>
      )}

      {/* Opening a redeemed link again is not an error but the same success in different words: a
          link from an email gets walked twice (from the email and from the browser's history, from a
          phone and from a laptop), and a red chip would answer with a refusal to a person for whom
          everything is fine. */}
      {verification.isSuccess && (
        <p role="status">
          {t(verification.data.already_verified ? "auth.verify.already" : "auth.verify.done")}
        </p>
      )}

      {verification.isError && (
        <>
          <p className="error" role="alert">
            {t(errorKey(verification.error))}
          </p>
          {/* The button is only there for someone signed in: the email goes to the account's address,
              and without a session there is nowhere to send it — while asking for the address anew
              would mean sending emails to other people's mailboxes. */}
          {user && !user.email_verified && (
            <button type="button" disabled={resend.isPending} onClick={() => resend.mutate()}>
              {t("auth.verify.resend")}
            </button>
          )}
        </>
      )}

      {resend.isSuccess && (
        <p role="status">
          {t(resend.data.sent ? "auth.verify.resent" : "auth.verify.not_sent")}
        </p>
      )}
      {resend.isError && (
        <p className="error" role="alert">
          {t(errorKey(resend.error))}
        </p>
      )}

      <p className="muted">
        <Link to="/projects">{t("auth.verify.link_projects")}</Link>
      </p>
    </main>
  );
}
