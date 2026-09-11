import { useEffect } from "react";

import { errorKey } from "../api/errors";
import type { ProjectState } from "../api/projects";
import { isTextEntry, isUndoChord } from "../components/hotkeys";
import { useToast } from "../components/toast";
import { useLocale } from "../i18n/LocaleProvider";
import { useUndo } from "./useUndo";

/**
 * Ctrl/⌘+Z across the whole project screen.
 *
 * Undo existed in the application, but it could only be reached with the mouse — from the toast
 * right after a move or from the history feed, that is, from a different tab. A person who moved a
 * bar to the wrong place presses Ctrl+Z without thinking; a combination that does not exist reads
 * as "this cannot be undone".
 *
 * The listener is on the document rather than on the strip: what is undone is not what is under the
 * focus but the last thing done in the project, and that must work on both tabs and with the focus
 * anywhere. The component draws nothing — it exists for the sake of this listener and of `useUndo`,
 * which needs the project's state; a node with no markup is more honest than a hook called in the
 * middle of a screen that has three early returns before the state.
 */
export function UndoHotkey({
  projectId,
  state,
  enabled,
}: {
  projectId: string;
  state: ProjectState;
  /** The right and the ability to undo — the same flag as the feed's button. */
  enabled: boolean;
}) {
  const { t } = useLocale();
  const showToast = useToast();
  const { undoable, mutation } = useUndo(projectId, state);
  const { mutate, isPending } = mutation;

  useEffect(() => {
    if (!enabled) return;

    function onKeyDown(event: KeyboardEvent) {
      if (!isUndoChord(event) || isTextEntry(event.target)) return;
      // While a dialog is open, Ctrl+Z belongs to the dialog: the person is editing a task's form
      // rather than the strip behind it, and undoing somebody else's move behind their back is not
      // what they asked for. The shift reason dialog falls here too: a second press during the
      // question would start a second undo.
      if (document.querySelector('[role="dialog"]') !== null) return;
      event.preventDefault();

      if (!undoable) {
        // Silence would read as a broken key: the application must answer "there is nothing to undo"
        // too.
        showToast({ message: t("undo.nothing") });
        return;
      }
      if (isPending) return;

      mutate(undefined, {
        // The toast is the only confirmation for someone who pressed a key: on the strip the bar
        // travels before their eyes, but on the history tab an undo otherwise looks as if nothing
        // happened.
        onSuccess: (undone) => {
          if (undone) showToast({ message: t("undo.done") });
        },
        // A refusal in the refusal tone: a tick next to "this move can no longer be undone" reports
        // exactly the opposite of what happened, while `role="status"` hides the refusal from a
        // screen reader in a summary, when the undo did not succeed.
        onError: (error) => showToast({ message: t(errorKey(error)), tone: "error" }),
      });
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled, isPending, mutate, showToast, t, undoable]);

  return null;
}
