import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import { errorKey } from "../api/errors";
import { projectQueryKey, undoBatch } from "../api/projects";
import { useDismissToast, useToast } from "../components/toast";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * The toast's actions after a transfer: look at what came out, or put it all back.
 *
 * "Revert" removes the very batch whose number the server named in its answer to the transfer — rather
 * than "the last change": while the toast hangs around, a colleague on the project manages to apply
 * theirs, and an unaddressed undo would remove their edit. The lines' references to tasks are cleared
 * by the database at that, and the lines become transferable again.
 */
export function PushDone({ projectId, batchId }: { projectId: string; batchId: string }) {
  const { t } = useLocale();
  const dismiss = useDismissToast();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const undo = () => {
    // First hide, then act: the result will be shown by the table itself, while a hanging toast would
    // offer to revert what has already been reverted.
    dismiss();
    undoBatch(projectId, batchId).then(
      () => queryClient.invalidateQueries({ queryKey: projectQueryKey(projectId) }),
      (refusal: unknown) => toast({ message: t(errorKey(refusal)), tone: "error" }),
    );
  };

  return (
    <>
      <button
        type="button"
        className="toast__action"
        onClick={() => {
          dismiss();
          navigate(`/projects/${projectId}`);
        }}
      >
        {t("proposal.push.open_gantt")}
      </button>
      <button type="button" className="toast__action" onClick={undo}>
        {t("undo.action")}
      </button>
    </>
  );
}
