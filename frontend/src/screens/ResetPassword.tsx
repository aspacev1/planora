import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { resetPassword } from "../api/auth";
import { errorKey } from "../api/errors";
import { withInvite } from "../auth/invite";
import { Field } from "../components/Field";
import { useLocale } from "../i18n/LocaleProvider";
import { MIN_PASSWORD_LENGTH } from "./Register";

/**
 * The screen the link from the recovery email leads to.
 *
 * It opens without a session: mail is not necessarily read in the browser the person was working in.
 * The token is redeemed only by submitting the form — merely landing on the page burns nothing, so
 * mail scanners opening links before the person are no threat to it.
 *
 * After a success — to the sign-in rather than straight inside: the server deliberately does not open
 * a session from a token in an email, and signing in with a password just set is a matter of seconds.
 */
export function ResetPassword() {
  const { t } = useLocale();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  // People come to this screen by a link from an email, and that is built by the server — there is no
  // invitation token in it and cannot be. The parameter is read for the case where they came here from
  // inside the application; across an email, though, the invitation is carried by the memory (see
  // auth/invite.ts), and that is read by the sign-in screen.
  const inviteToken = params.get("invite");

  const [password, setPassword] = useState("");
  const [localErrorKey, setLocalErrorKey] = useState<string | null>(null);
  const mutation = useMutation({ mutationFn: resetPassword });

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    // The server will check the length too, but there is no reason for a person to wait for an answer
    // for the sake of something obvious.
    if (password.length < MIN_PASSWORD_LENGTH) {
      setLocalErrorKey("auth.error.password_too_short");
      return;
    }
    setLocalErrorKey(null);
    mutation.mutate({ token, new_password: password });
  }

  const shownErrorKey =
    localErrorKey ?? (mutation.error ? errorKey(mutation.error) : null);

  return (
    <main className="screen screen--narrow">
      <h1>{t("auth.reset.title")}</h1>

      {token === "" && (
        <p className="error" role="alert">
          {t("auth.error.missing_token")}
        </p>
      )}

      {mutation.isSuccess && (
        <>
          <p role="status">{t("auth.reset.done")}</p>
          <p className="muted">
            <Link to={withInvite("/login", inviteToken)}>{t("auth.reset.link_login")}</Link>
          </p>
        </>
      )}

      {!mutation.isSuccess && token !== "" && (
        <form onSubmit={onSubmit} noValidate>
          <Field
            id="password"
            label={t("auth.field.new_password")}
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            required
          />

          {shownErrorKey && (
            <p className="error" role="alert">
              {t(shownErrorKey)}
            </p>
          )}

          <button type="submit" disabled={mutation.isPending}>
            {t("auth.reset.submit")}
          </button>
        </form>
      )}

      {/* A dead link — expired or already redeemed — is cured only by a new one, and the road to it
          must be one step rather than a guess. */}
      {(mutation.isError || token === "") && (
        <p className="muted">
          <Link to={withInvite("/forgot-password", inviteToken)}>
            {t("auth.reset.link_again")}
          </Link>
        </p>
      )}
    </main>
  );
}
