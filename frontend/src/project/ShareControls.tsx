import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { errorKey } from "../api/errors";
import {
  getShare,
  issueShare,
  revokeShare,
  rotateShare,
  setShareComments,
  shareQueryKey,
} from "../api/share";
import { ConfirmAction } from "../components/ConfirmAction";
import { useToast } from "../components/toast";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * Managing a project's public link: issue, copy, reissue, close. One body for both places the
 * link is managed from — the dialog on the project screen and the block in the settings. These
 * used to be two components, and they diverged where divergence costs the most: the settings had
 * no "Copy", no `allowed` check, and a reissue sent the same POST as the first issue — that is, a
 * 409 instead of a new link.
 *
 * The address arrives from the server whole and is not assembled here: only it knows the install's
 * domain (`PUBLIC_BASE_URL`), and a browser assembling the link from its own `location.origin`
 * would be wrong exactly where it would be noticed last — in a link already sent to the client.
 *
 * Reissuing and revoking are named by different buttons, because these are different decisions: a
 * reissue kills the previous link and gives a new one (it has to be sent out again), while
 * revoking closes the project to the outside entirely. A single "refresh" button would hide that
 * difference right up until the moment it matters.
 */
export function ShareControls({
  projectId,
  onCancel,
}: {
  projectId: string;
  /** The "Cancel" button next to "Publish" — only where there is somewhere to go
   *  (a dialog). In the settings there is nowhere to go: the block stands on the page. */
  onCancel?: () => void;
}) {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [copied, setCopied] = useState(false);

  const share = useQuery({
    queryKey: shareQueryKey(projectId),
    queryFn: () => getShare(projectId),
    retry: false,
  });

  function refresh() {
    return queryClient.invalidateQueries({ queryKey: shareQueryKey(projectId) });
  }

  const issue = useMutation({
    mutationFn: () => issueShare(projectId),
    onSuccess: () => {
      setCopied(false);
      return refresh();
    },
  });

  // A reissue is a separate call: "create" and "kill the previous address" must not be confused by
  // a double click or a network retry.
  const rotate = useMutation({
    mutationFn: () => rotateShare(projectId),
    onSuccess: () => {
      setCopied(false);
      // The only visible trace of a reissue is a different string in the address field, and those
      // strings differ in the middle of the token and are indistinguishable by eye. Without a toast
      // it would turn out that the previous link died silently.
      showToast({ message: t("share.reissued") });
      return refresh();
    },
  });

  const comments = useMutation({
    mutationFn: (enabled: boolean) => setShareComments(projectId, enabled),
    onSuccess: refresh,
  });

  const revoke = useMutation({
    mutationFn: () => revokeShare(projectId),
    onSuccess: () => {
      setCopied(false);
      showToast({ message: t("share.revoked") });
      return refresh();
    },
  });

  const failure = share.error ?? issue.error ?? rotate.error ?? comments.error ?? revoke.error;
  const busy = issue.isPending || rotate.isPending || comments.isPending || revoke.isPending;
  const url = share.data?.url ?? null;

  async function copy() {
    if (url === null) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // The clipboard is not always available: without https and without permission the browser
      // refuses. The address is visible in the field at that and can be selected by hand — so the
      // refusal is not shown as an error, it broke nothing.
      setCopied(false);
    }
  }

  return (
    <>
      {share.isPending && <p role="status">{t("common.loading")}</p>}

      {failure !== undefined && failure !== null && (
        <p className="error" role="alert">
          {t(errorKey(failure))}
        </p>
      )}

      {share.data?.allowed === false && <p className="muted">{t("share.disabled")}</p>}

      {share.data?.allowed && url === null && (
        <>
          <p className="muted">{t("share.hint")}</p>
          <div className="modal__actions">
            <button type="button" onClick={() => issue.mutate()} disabled={busy}>
              {t("share.publish")}
            </button>
            {onCancel !== undefined && (
              <button type="button" className="button--quiet" onClick={onCancel}>
                {t("common.cancel")}
              </button>
            )}
          </div>
        </>
      )}

      {share.data?.allowed && url !== null && (
        <>
          <p className="field">
            <label htmlFor="share-url">{t("share.url")}</label>
            <input id="share-url" name="share-url" readOnly value={url} />
          </p>

          <p className="checkbox">
            <input
              id="share-comments"
              name="share-comments"
              type="checkbox"
              checked={share.data.comments_enabled}
              disabled={busy}
              onChange={(event) => comments.mutate(event.target.checked)}
            />
            <label htmlFor="share-comments">{t("share.comments_enabled")}</label>
          </p>

          {/* Both buttons ask, and they ask in response to a press rather than as a hint above:
              "reissue" sounds like a refresh while it means that an address already sent to the
              client will stop opening. A hint read before the decision is made is not read at
              all. */}
          <div className="modal__actions">
            <button type="button" onClick={() => void copy()} disabled={busy}>
              {copied ? t("share.copied") : t("share.copy")}
            </button>
            <ConfirmAction
              className="button--quiet"
              label={t("share.reissue")}
              warning={t("share.reissue_warning")}
              confirm={t("share.reissue_confirm")}
              onConfirm={() => rotate.mutate()}
              disabled={busy}
            />
            <ConfirmAction
              className="button--quiet"
              label={t("share.revoke")}
              warning={t("share.revoke_warning")}
              confirm={t("share.revoke_confirm")}
              onConfirm={() => revoke.mutate()}
              disabled={busy}
            />
          </div>
        </>
      )}
    </>
  );
}
