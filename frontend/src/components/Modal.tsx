import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { useLocale } from "../i18n/LocaleProvider";
import { useEscape } from "./useEscape";

/**
 * What in a dialog accepts the focus. The same list as for the first field on
 * opening: Tab is also cycled through it (see `trapTab`).
 */
const FOCUSABLE =
  'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Tab does not leave the dialog: from the last field it goes to the first, from
 * the first backwards to the last.
 *
 * `aria-modal` promises a screen reader that the page behind the dialog is not
 * there right now — and the keyboard must keep the same promise. Without the Tab
 * cycle it went from the "Create" button into the sidebar under the backdrop, and
 * a person on the keyboard went on pressing links they could not see.
 */
function trapTab(event: KeyboardEvent<HTMLElement>, dialog: HTMLElement | null) {
  if (event.key !== "Tab" || dialog === null) return;
  const nodes = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
  if (nodes.length === 0) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !dialog.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

type ModalProps = {
  title: string;
  onClose: () => void;
  /**
   * The dialog has something typed in but not yet saved.
   *
   * Computed by the consumer rather than by the dialog: only the form knows what
   * exactly the person managed to type, and every form's "empty" is its own —
   * somewhere it is an empty field, somewhere a role chosen away from the default.
   */
  dirty?: boolean;
  /**
   * A wide dialog — for content that does not fit into a form's column.
   *
   * A flag rather than an arbitrary width: there are few dialogs in the
   * application, and a second size must stay a second size rather than turn into a
   * field every consumer tunes to its own taste.
   */
  wide?: boolean;
  children: ReactNode;
};

/**
 * A dialog that behaves like a dialog.
 *
 * It closes on Esc and on a click outside, puts the focus on the first field when
 * opening and returns it where it was opened from. None of this is decoration:
 * without the focus return a person on the keyboard ends up at the top of the page
 * after closing, and without Esc they have no way at all to leave without finding
 * the cross with a mouse.
 *
 * Both of these gestures are short and easy to make by accident: the "Cancel"
 * button has to be reached for, while you hit outside the dialog by missing a
 * select by a couple of dozen pixels. While there is nothing typed in, the price of
 * a miss is zero, and the dialog closes at once. As soon as something is typed into
 * the form (`dirty`), both gestures ask first — otherwise the task form with its
 * dozen fields is lost to a single accidental click. The form's own "Cancel" button
 * closes the dialog without a question at that: it is aimed at, while the backdrop
 * is missed.
 *
 * One component for the whole application, deliberately: the next screen that needs
 * a dialog must not reinvent these four rules and get one of them wrong.
 */
export function Modal({ title, onClose, dirty = false, wide = false, children }: ModalProps) {
  const { t } = useLocale();
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  // Captured on mount rather than on closing: by the time of closing the focus has
  // long been inside the dialog, and it is too late to ask for it.
  const opener = useRef<Element | null>(null);

  const [asking, setAsking] = useState(false);
  // The field the person was interrupted at by the question: that is where they are
  // returned if they answered "continue". Otherwise refusing to close would cost
  // your place in the form.
  const interrupted = useRef<Element | null>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    opener.current = document.activeElement;

    // The first field rather than the dialog itself: the person opened the form to
    // fill it in, and an extra Tab press here is an extra step in every creation in a row.
    const focusable = dialog.current?.querySelector<HTMLElement>(FOCUSABLE);
    focusable?.focus();

    return () => {
      const previous = opener.current;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  /** An easily-missed gesture: with nothing typed it closes at once, with something typed it asks. */
  const close = useCallback(() => {
    if (!dirty) {
      onClose();
      return;
    }
    // A repeat miss while the question is already asked changes nothing — and must
    // not rewrite the place to return the focus to: otherwise "continue" would
    // return the person to their own button rather than to the field they were
    // interrupted at.
    if (asking) return;
    interrupted.current = document.activeElement;
    setAsking(true);
  }, [asking, dirty, onClose]);

  const dismiss = useCallback(() => {
    setAsking(false);
    const previous = interrupted.current;
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
  }, []);

  // Esc through the shared layer stack rather than through a listener of its own on
  // the document: a dialog almost always pops up on top of something — a task card,
  // a menu, another dialog — and a listener of its own on each would close them all
  // with one press. The listener is still on the document rather than on the dialog
  // itself: Esc must work when the focus has left the dialog too — otherwise the
  // rule applies not always, and that is worse than not applying at all.
  //
  // Esc on top of the question itself means "continue", not "close": the key cancels
  // the last action rather than carrying it through. Otherwise two Escs in a row —
  // the habitual "close everything" gesture — would lead to exactly the loss the
  // question is asked to prevent. There is one layer at that: the question lives
  // inside the dialog, and giving it a place of its own in the stack would mean
  // demanding a third Esc where the person expects two.
  useEscape(() => {
    if (asking) {
      dismiss();
      return;
    }
    close();
  });

  // The focus moves to "continue": the question was asked with a key, and the person
  // will answer it with a key too. The safe one stands first at hand.
  useEffect(() => {
    if (asking) keepEditing.current?.focus();
  }, [asking]);

  return (
    <div
      className="modal__backdrop"
      data-testid="modal-backdrop"
      // A click on the backdrop specifically, not on something bubbled up from the
      // dialog: otherwise the dialog would close on a click on any of its fields.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className={`modal${wide ? " modal--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialog}
        onKeyDown={(event) => trapTab(event, dialog.current)}
      >
        <h2 className="modal__title" id={titleId}>
          {title}
        </h2>
        {children}

        {/* The question is inside the same dialog rather than a second dialog on top
            of the first: dialogs on top of dialogs close in two goes and confuse
            which of them Esc means. */}
        {asking && (
          <div className="modal__confirm" role="alert">
            <p>{t("modal.discard.question")}</p>
            <div className="modal__actions">
              <button type="button" ref={keepEditing} onClick={dismiss}>
                {t("modal.discard.keep")}
              </button>
              <button type="button" className="button--quiet" onClick={onClose}>
                {t("modal.discard.close")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
