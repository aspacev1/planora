import { createContext, useCallback, useContext, useState } from "react";
import type { ReactNode } from "react";

import { Modal } from "../components/Modal";
import { useLocale } from "../i18n/LocaleProvider";
import type { ShiftRequest } from "./baseline";

/**
 * The dialog that asks for a shift's reason.
 *
 * It lives as a provider rather than a piece of markup inside a gesture, because there are several
 * gestures — dragging a bar, editing a date in the card, changing a duration — while the dialog is
 * one and the same for them. The specification says so outright: the rule is one regardless of the
 * input method. Written anew in every gesture, it would diverge in each on the small things, and
 * diverge unnoticed.
 *
 * It asks with a promise: the gesture waits for the person's answer and either continues or does
 * not happen at all. The intermediate state of "shifted but not explained" does not arise even for
 * a frame — the change is not sent until the reason has been entered.
 */

/** The person's refusal to explain a shift. Not an error: the gesture simply did not happen. */
export class ShiftCancelled extends Error {
  constructor() {
    super("the shift was cancelled: no reason was entered");
    this.name = "ShiftCancelled";
  }
}

export function isShiftCancelled(error: unknown): boolean {
  return error instanceof ShiftCancelled;
}

/** A `null` in the answer — the person pressed "Revert". */
type AskReason = (request: ShiftRequest) => Promise<string | null>;

const ShiftReasonContext = createContext<AskReason | null>(null);

type Pending = { request: ShiftRequest; answer: (reason: string | null) => void };

export function ShiftReasonProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const ask = useCallback<AskReason>(
    (request) => new Promise<string | null>((resolve) => setPending({ request, answer: resolve })),
    [],
  );

  const close = useCallback(
    (reason: string | null) => {
      setPending((current) => {
        current?.answer(reason);
        return null;
      });
    },
    [],
  );

  return (
    <ShiftReasonContext.Provider value={ask}>
      {children}
      {pending && <ReasonDialog request={pending.request} onAnswer={close} />}
    </ShiftReasonContext.Provider>
  );
}

/**
 * The asking side.
 *
 * Outside the provider it returns `null` rather than throwing: the task card and the strip are also
 * drawn in places where there is no dialog at all (on the public page, for example, where there is
 * nothing to change). The absence of a dialog then means "we do not ask here" rather than a
 * breakage — and the last word about a reason is the server's anyway.
 */
export function useAskShiftReason(): AskReason | null {
  return useContext(ShiftReasonContext);
}

function ReasonDialog({
  request,
  onAnswer,
}: {
  request: ShiftRequest;
  onAnswer: (reason: string | null) => void;
}) {
  const { t } = useLocale();
  const [reason, setReason] = useState("");
  // Whitespace does not count as a reason — exactly as on the server: otherwise the button would
  // come alive from a space while the server answered with a refusal.
  const filled = reason.trim().length > 0;

  return (
    <Modal
      title={t("shift.title", { days: t("common.days", { count: request.deviationDays }) })}
      // Closing with Esc and with a click outside is the same answer as "Revert": the change is not
      // applied.
      onClose={() => onAnswer(null)}
      // A written reason makes a stray click doubly expensive: both the text and the shift it was
      // written for are lost.
      dirty={filled}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (filled) onAnswer(reason.trim());
        }}
      >
        <p className="muted">
          {/* The task's name is user content: it is not translated. */}
          {t("shift.explain", {
            name: request.taskName,
            threshold: t("common.days", { count: request.thresholdDays }),
          })}
        </p>

        <p className="field">
          <label htmlFor="shift-reason">{t("shift.reason")}</label>
          <textarea
            id="shift-reason"
            name="shift-reason"
            rows={3}
            required
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </p>

        <div className="modal__actions">
          {/* An empty reason — the button is disabled. The change itself has gone nowhere at that:
              the asking happens before sending rather than after. */}
          <button type="submit" disabled={!filled}>
            {t("shift.save")}
          </button>
          <button type="button" className="button--quiet" onClick={() => onAnswer(null)}>
            {t("shift.revert")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
