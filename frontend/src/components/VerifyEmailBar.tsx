import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { resendVerification } from "../api/auth";
import { CONFIG_QUERY_KEY, installConfig } from "../api/config";
import { errorKey } from "../api/errors";
import { useAuth } from "../auth/AuthProvider";
import {
  RESEND_COOLDOWN_MS,
  noteVerificationSent,
  verificationSentAt,
} from "../auth/verificationNotice";
import { useLocale } from "../i18n/LocaleProvider";

import "./verify-bar.css";

/**
 * The "address not confirmed" strip in the application's frame.
 *
 * Before it, confirmation was a ghost: the email went out, the link worked, but a person who never
 * got to the email saw not a word about it anywhere in the application — the state existed only in
 * the database. The strip lives in the frame rather than on one screen, because it belongs to none
 * of them: this is an account's state, and it must catch the eye where the person works.
 *
 * It locks nothing at that: confirmation answers the question "do emails get through" rather than
 * granting permissions (backend/app/email_verification.py). So the strip is a message with a button
 * rather than a wall across the work.
 *
 * In an install without mail it is absent entirely: there emails go nowhere, nobody's address is
 * confirmed, and the strip would hang forever offering nothing.
 */
export function VerifyEmailBar() {
  const { t } = useLocale();
  const { user } = useAuth();
  const email = user?.email ?? "";
  const unverified = user !== null && !user.email_verified;

  // Asked for only for the unconfirmed: the others have no strip, and there is no need for an extra
  // trip to the server on every sign-in for an answer nobody will read.
  const config = useQuery({
    queryKey: CONFIG_QUERY_KEY,
    queryFn: installConfig,
    enabled: unverified,
    retry: false,
    staleTime: Infinity,
  });

  const [sentAt, setSentAt] = useState<number | null>(() => verificationSentAt(email));
  const secondsLeft = useCooldown(sentAt);

  const resend = useMutation({
    mutationFn: resendVerification,
    onSuccess: (result) => {
      // Only an email that went out starts a pause — both here and on the server. Promising "the
      // email was sent" after a delivery refusal would mean sending a person to wait for something
      // that does not exist.
      if (!result.sent) return;
      noteVerificationSent(email);
      setSentAt(Date.now());
    },
  });

  if (!unverified || config.data?.mail_enabled !== true) return null;

  const waiting = secondsLeft > 0;

  return (
    <div className="verify-bar">
      {/* role="status" rather than alert: an address does not confirm itself in the middle of work,
          and there is no reason to interrupt the screen's reading with it. */}
      <p className="verify-bar__text" role="status">
        {waiting
          ? t("auth.verify.sent_to", { email })
          : t("auth.verify.unverified", { email })}
      </p>

      {/* While the pause runs the button is disabled and says itself how long to wait: enabled, it
          would answer "too often" — a refusal to an action it offered itself. */}
      <button
        type="button"
        className="button--quiet verify-bar__button"
        disabled={waiting || resend.isPending}
        onClick={() => resend.mutate()}
      >
        {waiting
          ? t("auth.verify.resend_in", { seconds: secondsLeft })
          : t("auth.verify.resend")}
      </button>

      {resend.data?.sent === false && (
        <p className="verify-bar__note" role="alert">
          {t("auth.verify.not_sent")}
        </p>
      )}
      {resend.isError && (
        <p className="verify-bar__note" role="alert">
          {t(errorKey(resend.error))}
        </p>
      )}
    </div>
  );
}

/**
 * The seconds until the pause ends. 0 — the pause has ended or there was none.
 *
 * The countdown rests on a `setTimeout` that is re-created with every second and is not created at
 * all at zero: a permanent interval in the application's frame would wake React every second for
 * the whole session — for the sake of a line that is not on screen.
 */
function useCooldown(sentAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  const left =
    sentAt === null ? 0 : Math.max(0, Math.ceil((sentAt + RESEND_COOLDOWN_MS - now) / 1000));

  useEffect(() => {
    if (left === 0) return;
    const timer = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(timer);
  }, [left]);

  return left;
}
