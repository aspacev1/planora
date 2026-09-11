import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";

import { projectQueryKey } from "../api/projects";
import type { ProjectState } from "../api/projects";
import { useDismissToast } from "../components/toast";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * The project's state from the cache — as an observer rather than a second request.
 *
 * Its freshness is held by the project screen: it re-reads the state after every edit of its own and
 * on every signal from the socket. Here one number from it is needed, and a `useQuery` of our own
 * would mean an extra GET on every bar move.
 */
function useCachedProject(projectId: string): ProjectState | undefined {
  const queryClient = useQueryClient();

  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient],
  );
  const read = useCallback(
    () => queryClient.getQueryData<ProjectState>(projectQueryKey(projectId)),
    [queryClient, projectId],
  );

  return useSyncExternalStore(subscribe, read);
}

/**
 * The "Undo" in the toast after a bar is moved.
 *
 * The button promises to revert a specific move — the one whose number the server named in its
 * answer to it. While the toast hangs around for its six seconds, the top of the journal manages to
 * move on: a colleague on the project applied their edit over the socket, the person themselves
 * corrected something in a card. Undoing "the last one" at that moment would remove the wrong step,
 * so the button goes dark as soon as the journal's top stops being what it names.
 *
 * The check here is a courtesy rather than a defence: between a glance at the cache and the server's
 * answer lies the network, and a change fits into that gap just as well. The defence is
 * `expected_seq` in the request: the server checks the number under the project's lock and refuses
 * (`undo_conflict`) rather than undoing blindly.
 */
export function UndoMove({
  projectId,
  seq,
  onUndo,
}: {
  projectId: string;
  /** The number of the revision the button promises to undo. */
  seq: number;
  onUndo: () => void;
}) {
  const { t } = useLocale();
  const dismiss = useDismissToast();
  const state = useCachedProject(projectId);

  // There is no state in the cache — the project screen was closed while the toast hung around. That
  // is not "the journal's top moved on" but "unknown", and there is nothing to disable the button
  // for: the server will decide, it is the last instance anyway.
  const stale = state !== undefined && state.undoable?.seq !== seq;

  return (
    <button
      type="button"
      className="toast__action"
      disabled={stale}
      title={stale ? t("undo.stale") : undefined}
      onClick={() => {
        // First hide, then act: the undo will show its own result on the strip, while a hanging toast
        // would offer to undo what has already been undone.
        dismiss();
        onUndo();
      }}
    >
      {t("undo.action")}
    </button>
  );
}
