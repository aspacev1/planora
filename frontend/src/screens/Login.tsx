import { useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { errorKey } from "../api/errors";
import { afterAuthPath } from "../auth/afterAuth";
import { useAuth } from "../auth/AuthProvider";
import { pendingInvite, withInvite } from "../auth/invite";
import { Field } from "../components/Field";
import { useLocale } from "../i18n/LocaleProvider";

export function Login() {
  const { t } = useLocale();
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  // The person came by an invitation and turned in here to sign in under their own account. After
  // signing in they return to the invitation rather than ending up in the list of projects, having
  // forgotten what they came for.
  //
  // The memory is a fallback path for the one transition where the query string is powerless:
  // between "Forgot your password?" and "Sign in" stands an email, the link in it is built by the
  // server, and there is no invitation there. A return by memory is safe: it leads to the invitation
  // screen, where "Accept" has to be pressed anyway — a person does not silently join any
  // organization.
  const inviteToken = params.get("invite") ?? pendingInvite();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [failureKey, setFailureKey] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setFailureKey(null);
    try {
      await login({ email, password });
      // The invitation comes before the saved address: it is named in the very link the person came
      // here by, while the saved address is only a memory of where they were turned aside.
      navigate(
        inviteToken === null
          ? afterAuthPath(location.state)
          : `/invite/${encodeURIComponent(inviteToken)}`,
      );
    } catch (error) {
      setFailureKey(errorKey(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="screen screen--narrow">
      <h1>{t("auth.login.title")}</h1>

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
        <Field
          id="password"
          label={t("auth.field.password")}
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          required
        />

        {failureKey && (
          <p className="error" role="alert">
            {t(failureKey)}
          </p>
        )}

        <button type="submit" disabled={pending}>
          {t("auth.login.submit")}
        </button>
      </form>

      <p className="muted">
        {/* Password recovery is part of an invitee's path rather than a separate story: invitations
            are sent to work addresses, which have had an account for a long time, and the password
            to it is not always remembered. */}
        <Link to={withInvite("/forgot-password", inviteToken)}>
          {t("auth.login.link_forgot")}
        </Link>
      </p>

      <p className="muted">
        {t("auth.login.no_account")}{" "}
        {/* The state travels to registration too: someone arriving by a link most often has no
            account yet, and losing the address a step later is the same loss. */}
        <Link to={withInvite("/register", inviteToken)} state={location.state}>
          {t("auth.login.link_register")}
        </Link>
      </p>
    </main>
  );
}
