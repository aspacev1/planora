import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { ME_QUERY_KEY, register as registerRequest } from "../api/auth";
import type { User } from "../api/auth";
import { errorKey } from "../api/errors";
import { afterAuthPath } from "../auth/afterAuth";
import { forgetInvite, withInvite } from "../auth/invite";
import { noteVerificationSent } from "../auth/verificationNotice";
import { inviteQueryKey, previewInvitation } from "../api/invitations";
import { Field } from "../components/Field";
import { useLocale } from "../i18n/LocaleProvider";

/** The server demands the same: `password: str = Field(min_length=8)`. */
export const MIN_PASSWORD_LENGTH = 8;

export function Register() {
  const { t, adoptProfileLocale } = useLocale();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  // Only from the query string, unlike the sign-in screen: an invitation here fills in
  // the address and locks the field, and that is too strong an action to do from memory.
  // A person who opened somebody else's link and changed their mind must get an empty
  // form at /register rather than a locked address that is not theirs.
  const inviteToken = params.get("invite");

  const [name, setName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [localErrorKey, setLocalErrorKey] = useState<string | null>(null);

  // The invitation is asked for here too, not only on the invitation screen: the address
  // it was issued to is filled into the form and is not editable, and there is nowhere
  // else to take it from.
  const invitation = useQuery({
    queryKey: inviteQueryKey(inviteToken ?? ""),
    queryFn: () => previewInvitation(inviteToken as string),
    enabled: inviteToken !== null,
    retry: false,
  });
  const boundEmail = invitation.data?.email ?? null;
  // Until the invitation arrives there is nothing to submit the form with: the address in
  // it is still empty, and the submission would go with an empty field the person neither
  // filled in nor could fill in. The branch concerns only arrivals by link — without a
  // token the request is disabled and there is nothing to wait for.
  const waitingForInvitation = inviteToken !== null && invitation.isPending;

  const mutation = useMutation({
    mutationFn: registerRequest,
    onSuccess: (user: User) => {
      // The registration's response is the same profile that /api/auth/me hands out. We
      // put it in straight away: otherwise the next screen goes for it a second time, and
      // the person watches a loading indicator for no reason.
      queryClient.setQueryData(ME_QUERY_KEY, user);
      adoptProfileLocale(user.locale);
      // The invitation has done its job: the server created the membership right in the
      // registration. Holding on to it any longer would mean taking the person to the
      // screen of an already accepted invitation on their very next sign-in.
      if (inviteToken !== null) forgetInvite();
      // The confirmation email is sent by the server itself, right after the response. The
      // strip in the application's frame will read this mark and say which address the
      // email went to — instead of a button that would answer the very first press with
      // "too often".
      noteVerificationSent(user.email);
      // The same return as on sign-in: a person may have come by a link to a project and
      // created an account right here.
      navigate(afterAuthPath(location.state));
    },
  });

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    // The server will check the length too, but there is no reason for a person to wait
    // for an answer for the sake of something obvious.
    if (password.length < MIN_PASSWORD_LENGTH) {
      setLocalErrorKey("auth.error.password_too_short");
      return;
    }
    setLocalErrorKey(null);
    mutation.mutate({
      name,
      email: boundEmail ?? email,
      password,
      // The company name is only for free registration: with an invitation the organization
      // already exists, and creating a second one would be the wrong field.
      ...(inviteToken === null ? { company_name: companyName } : {}),
      ...(inviteToken === null ? {} : { invite_token: inviteToken }),
    });
  }

  const shownErrorKey =
    localErrorKey ??
    (mutation.error ? errorKey(mutation.error) : null) ??
    // A dead link is explained before the form is submitted rather than after: there is no
    // point creating an account to learn that the invitation has expired.
    (invitation.error ? errorKey(invitation.error) : null);

  return (
    <main className="screen screen--narrow">
      <h1>{t("auth.register.title")}</h1>

      {invitation.data && (
        <p className="muted">
          {t("invite.accept.summary", {
            org: invitation.data.org_name,
            role: t(`members.role.${invitation.data.role}`),
          })}
        </p>
      )}

      {/* noValidate: we translate our own validation ourselves, while the browser's built-in
          messages arrive in the browser's language rather than the interface's. */}
      <form onSubmit={onSubmit} noValidate>
        <Field
          id="name"
          label={t("auth.field.name")}
          value={name}
          onChange={setName}
          autoComplete="name"
          required
        />
        {/* The company name is only for free registration: with an invitation the
            organization already exists, and asking for the name of one the person is not
            creating is beside the point. */}
        {inviteToken === null && (
          <Field
            id="company_name"
            label={t("auth.field.company_name")}
            value={companyName}
            onChange={setCompanyName}
            autoComplete="organization"
            required
          />
        )}
        <Field
          id="email"
          label={t("auth.field.email")}
          type="email"
          value={boundEmail ?? email}
          onChange={setEmail}
          autoComplete="email"
          required
          // The invitation's address is not editable: the invitation is tied to it, and an
          // edit would turn the submission into a certain refusal.
          readOnly={boundEmail !== null}
        />
        <Field
          id="password"
          label={t("auth.field.password")}
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

        {/* The button is disabled for the duration of the request: a double click otherwise
            creates two registration attempts for one address. */}
        <button type="submit" disabled={mutation.isPending || waitingForInvitation}>
          {t("auth.register.submit")}
        </button>
      </form>

      <p className="muted">
        {t("auth.register.have_account")}{" "}
        {/* The token travels to the sign-in too — by the same rule the sign-in screen carries
            it to registration. Without this the most frequent path of an invitee broke off
            here: invitations are sent to work addresses, an account usually already exists on
            them, registration answers "address taken", and the person was going by this very
            link — into their former organization. */}
        <Link to={withInvite("/login", inviteToken)} state={location.state}>
          {t("auth.register.link_login")}
        </Link>
      </p>
    </main>
  );
}
