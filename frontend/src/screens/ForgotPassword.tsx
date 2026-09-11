import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { requestPasswordReset } from "../api/auth";
import { errorKey } from "../api/errors";
import { withInvite } from "../auth/invite";
import { Field } from "../components/Field";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * The request for a password recovery email.
 *
 * After submitting, the screen says "if the address is registered, the email has gone out" rather than
 * "the email has gone out": the server deliberately answers the same for any address, and promising more
 * than it knows would mean lying to half the readers.
 */
export function ForgotPassword() {
  const { t } = useLocale();
  const [params] = useSearchParams();
  // The invitation travels through the recovery too: people land here in the middle of the "came by a
  // link — the account already exists — I do not remember the password" path, and the return to the
  // sign-in must lead back to the invitation rather than to the former organization.
  const inviteToken = params.get("invite");
  const [email, setEmail] = useState("");
  const mutation = useMutation({ mutationFn: requestPasswordReset });

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    mutation.mutate(email);
  }

  return (
    <main className="screen screen--narrow">
      <h1>{t("auth.forgot.title")}</h1>

      {mutation.isSuccess ? (
        <p role="status">{t("auth.forgot.sent")}</p>
      ) : (
        <>
          <p className="muted">{t("auth.forgot.intro")}</p>

          <form onSubmit={onSubmit} noValidate>
            <Field
              id="email"
              label={t("auth.field.email")}
              type="email"
              value={email}
              onChange={setEmail}
              autoComplete="email"
              required
            />

            {mutation.isError && (
              <p className="error" role="alert">
                {t(errorKey(mutation.error))}
              </p>
            )}

            <button type="submit" disabled={mutation.isPending}>
              {t("auth.forgot.submit")}
            </button>
          </form>
        </>
      )}

      <p className="muted">
        <Link to={withInvite("/login", inviteToken)}>{t("auth.forgot.link_login")}</Link>
      </p>
    </main>
  );
}
