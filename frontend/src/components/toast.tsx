import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * A toast at the bottom of the screen: "The task was moved to 19 Aug · Undo".
 *
 * One, not a queue: drags come one after another, and a stack of five "the task was moved" says
 * nothing beyond the last one. A new toast replaces the previous one, appears anew and starts
 * its timer anew.
 *
 * `role="status"` rather than `alert`: this is a confirmation of something already done rather
 * than an alarm, and there is no reason to interrupt a screen reader with it. The exception is a
 * refusal (`tone: "error"`): that is worth announcing at once.
 *
 * A toast must be shown by everyone who changes data silently: deleting a project, revoking an
 * invitation, saving a field on blur. Otherwise you get an inconsistency that reads as a
 * breakage — you moved a bar and saw a confirmation, deleted a project and saw nothing.
 */

type Toast = {
  message: string;
  /**
   * The action in full, as a node. Without it a toast is only a confirmation.
   *
   * A node rather than a "caption and handler" pair: the action lives for the six seconds the
   * toast hangs around, and in that time it can die — there is nothing left to undo, or not the
   * same thing. That is known by whoever offered the action, not by the toast; the toast,
   * holding a handler, would show a live button until the last second and learn the truth only
   * from the server, once it had been pressed.
   */
  action?: ReactNode;
  /**
   * A refusal or a confirmation. The difference is not cosmetic: a tick next to "task not found"
   * reports exactly the opposite of what happened — and the toast shows refusals too, when there
   * is no room for an error line nearby.
   */
  tone?: "done" | "error";
};

const ToastContext = createContext<(toast: Toast) => void>(() => {});
/** Hide the toast. Needed by the action: once pressed, it decides for itself what to show next. */
const DismissContext = createContext<() => void>(() => {});

/** How long the toast hangs around. Enough to read it and manage to press "Undo". */
const TOAST_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<(Toast & { id: number }) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The toast's number. Needed precisely to serve as a key: without it replacing a toast on the
  // same node does not count as an appearance, the node stays the same, and a second "the task
  // was moved" in a row would appear as a cut — the very thing the first one is spared.
  const count = useRef(0);

  const show = useCallback((next: Toast) => {
    if (timer.current !== null) clearTimeout(timer.current);
    count.current += 1;
    setToast({ ...next, id: count.current });
    timer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  const dismiss = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    setToast(null);
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <ToastContext.Provider value={show}>
      <DismissContext.Provider value={dismiss}>
        {children}
        {toast && (
          // Keyed by the toast: the next message is a new node, and the appearance is played anew
          // rather than swapping the text in a chip that is already hanging there.
          //
          // `alert` for a refusal, `status` for a confirmation: a refusal is worth interrupting a
          // screen reader for, "saved" is not.
          <div
            className={toast.tone === "error" ? "toast toast--error" : "toast"}
            role={toast.tone === "error" ? "alert" : "status"}
            key={toast.id}
          >
            <span className="toast__check" aria-hidden="true">
              {toast.tone === "error" ? "!" : "✓"}
            </span>
            <span className="toast__message">{toast.message}</span>
            {toast.action}
          </div>
        )}
      </DismissContext.Provider>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

export function useDismissToast() {
  return useContext(DismissContext);
}
