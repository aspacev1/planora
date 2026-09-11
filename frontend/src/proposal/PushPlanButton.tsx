import type { ProposalStage } from "../api/proposal";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * The transfer-into-the-plan button — one for both places it stands in: the stage bar and the "Next"
 * block of the totals card.
 *
 * The transfer is available from any stage, the draft included: not everyone sends the document to
 * the client, and a quote written for oneself goes into the plan straight away. But the button's
 * weight differs. While the proposal is not agreed it is quiet: the deal's next step is to send it
 * and wait for an answer, and a filled button next to that would invite transferring something the
 * client can still rewrite. After the agreement the transfer is the only thing left to do, and the
 * button becomes the primary one.
 *
 * The ellipsis in the caption is a sign that a dialog follows the press rather than the transfer
 * itself: there the lines are chosen and it is seen where what will land. It stays on the primary
 * button too — the dialog that opens is the same.
 *
 * The caption changes as things go: while nothing is in the plan — transfer; part transferred —
 * transfer only what is new, by count. A button inviting the transfer of what is already transferred
 * would bring the old duplicates back in words.
 */
export function PushPlanButton({
  status,
  pushedCount,
  pushableCount,
  className,
  onPush,
}: {
  status: ProposalStage;
  /** How many lines are already in the plan and how many estimated ones can still be transferred. */
  pushedCount: number;
  pushableCount: number;
  className?: string;
  /** Open the transfer dialog. */
  onPush: () => void;
}) {
  const { t } = useLocale();

  const weight = status === "agreed" ? "button--primary" : "button--quiet";
  const label =
    pushedCount > 0 ? t("proposal.push.more", { count: pushableCount }) : t("proposal.push.action");

  return (
    <button
      type="button"
      className={className === undefined ? weight : `${weight} ${className}`}
      // There is nothing to transfer — without a single estimated line the dialog would show an empty
      // list with a disabled button.
      disabled={pushableCount === 0}
      onClick={onPush}
    >
      {label}
    </button>
  );
}
