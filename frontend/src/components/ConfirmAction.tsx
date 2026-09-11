import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useLocale } from "../i18n/LocaleProvider";

/**
 * A button that unfolds a question in its own place before an irreversible action.
 *
 * There is deliberately no dialog here: a dialog interrupts work for a decision the person has
 * already made by pressing the button, and teaches them to close it without reading. An inline
 * confirmation answers a different question — not "are you sure" but "here is what is about to
 * break" — and stands exactly where they are looking.
 *
 * There is one component for all such buttons: there are three rules here (warn in words, give a
 * way out, do not lose the focus), and every screen reinventing them gets one wrong.
 */
export function ConfirmAction({
  label,
  icon,
  warning,
  confirm,
  onConfirm,
  className,
  disabled = false,
}: {
  /** The button's own caption — before the question. */
  label: string;
  /**
   * A sign instead of a caption — for a button on a table row, where there is no room for a word.
   * The caption goes nowhere at that: it becomes the button's name, and from the screen it is
   * still read as words rather than as "a cross".
   */
  icon?: ReactNode;
  /** What exactly will break. Not "are you sure?" but the consequence. */
  warning: string;
  /** The confirmation's caption: it names the action rather than answering "yes". */
  confirm: string;
  onConfirm: () => void;
  className?: string;
  disabled?: boolean;
}) {
  const { t } = useLocale();
  const [confirming, setConfirming] = useState(false);
  const group = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Whether the popover has just been opened: the focus returns to the button only after it folds
  // back, not on the first render.
  const wasConfirming = useRef(false);

  // The focus moves to the popover itself rather than to the confirm button: a person on the
  // keyboard presses Enter faster than they read, and a confirmation that caught that same Enter
  // confirms nothing — it brings back the previous behaviour with one extra press added. The focus
  // is not put on the cancel button either: the popover names the consequence itself, and aloud it
  // is read first.
  useEffect(() => {
    if (confirming) {
      group.current?.focus();
    } else if (wasConfirming.current) {
      // The popover is folded — and the node the focus stood on went with it. Without a return, a
      // person on the keyboard ended up at the top of the document and had to find their place
      // again after every "cancel". The button may have gone along with the deleted row at that —
      // then there is nowhere to return to.
      trigger.current?.focus();
    }
    wasConfirming.current = confirming;
  }, [confirming]);

  if (confirming) {
    return (
      <span className="plan__confirm" role="group" aria-label={warning} tabIndex={-1} ref={group}>
        <span className="muted">{warning}</span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            // The question folds at once: it has already been answered, and the action's own result
            // will be shown by the screen — as an error next to it or as the disappearance of what
            // was deleted.
            setConfirming(false);
            onConfirm();
          }}
        >
          {confirm}
        </button>
        <button type="button" className="button--quiet" onClick={() => setConfirming(false)}>
          {t("common.cancel")}
        </button>
      </span>
    );
  }

  return (
    <button
      ref={trigger}
      type="button"
      className={className}
      disabled={disabled}
      aria-label={icon === undefined ? undefined : label}
      title={icon === undefined ? undefined : label}
      onClick={() => setConfirming(true)}
    >
      {icon ?? label}
    </button>
  );
}
