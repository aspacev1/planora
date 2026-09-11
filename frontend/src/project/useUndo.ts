import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ApiError } from "../api/client";
import { projectQueryKey, undoBatch, undoLast } from "../api/projects";
import type { ProjectState } from "../api/projects";
import { useAskShiftReason } from "./ShiftReason";
import { thresholdOf } from "./baseline";

/**
 * Undoing the last change — the mechanics of the buttons in the history feed.
 *
 * A button undoes strictly what the server named in `state.undoable`: the choice of what is
 * undoable is the server's decision, and the feed does not argue with it. That entry's number goes
 * into the request: between the feed being rendered and the press a colleague manages to apply
 * their own change, and a numberless undo would remove their edit instead of the named one. The
 * toast after a bar is moved (useDragDates) calls the same endpoint separately and with the same
 * condition — it only takes the number from the answer to its own move.
 *
 * It undoes a batch whole: applying the AI is dozens of operations with a shared `batch_id`, and
 * undoing them one at a time would mean thirty presses in a row.
 *
 * Ctrl/⌘+Z (`UndoHotkey`) calls from here too: a hotkey is a second path to the same button rather
 * than a second way to undo.
 */
export function useUndo(projectId: string, state: ProjectState) {
  const queryClient = useQueryClient();
  const askReason = useAskShiftReason();
  const [error, setError] = useState<unknown>(null);

  const undoable = state.undoable;

  const mutation = useMutation({
    // Returns whether an undo actually happened: there being nothing to undo, or the person closing
    // the reason dialog, is a successful request and a non-event for whoever is waiting for a
    // confirmation. Without this flag the hotkey would report "undone" where nothing was undone.
    mutationFn: async (): Promise<boolean> => {
      if (!undoable) return false;
      if (undoable.batch_id) {
        await undoBatch(projectId, undoable.batch_id);
        return true;
      }
      try {
        // The number of the very entry the button named to the person: between the feed being
        // rendered and the press a colleague manages to apply their own change, and a numberless
        // undo would remove their edit instead of the named one.
        await undoLast(projectId, { seq: undoable.seq });
      } catch (refusal) {
        // An undo obeys the same threshold rule as any other shift: if reverting takes a task
        // further from the baseline plan than the threshold, an explanation is needed just the
        // same. The numbers are taken from the server's hints — the tab has none of its own here:
        // it does not know which dates the inverse operation will lead to.
        if (!(refusal instanceof ApiError) || refusal.code !== "reason_required") throw refusal;
        if (!askReason) throw refusal;
        const reason = await askReason({
          taskName: "",
          deviationDays: refusal.hints.deviationDays ?? 0,
          thresholdDays: refusal.hints.thresholdDays ?? thresholdOf(state),
        });
        if (reason === null) return false;
        await undoLast(projectId, { seq: undoable.seq, reason });
      }
      return true;
    },
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: projectQueryKey(projectId) });
    },
    onError: setError,
  });

  return { undoable, mutation, error };
}
