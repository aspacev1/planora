import { Link } from "react-router-dom";

import { proposalPdfUrl } from "../api/export";
import type { ProposalStage } from "../api/proposal";
import { useLocale } from "../i18n/LocaleProvider";
import type { Formats } from "./ProposalTable";
import { PushPlanButton } from "./PushPlanButton";
import { addMoney } from "./money";
import type { Money } from "./money";

/**
 * The totals — as a card on the side, in sight however the page is scrolled: "how much altogether"
 * is asked before the quote has been read through.
 *
 * The numbers arrive ready: they are computed by the screen from the rows already shown (see
 * Proposal.tsx), and the card only shows them — a second place with the same arithmetic would
 * diverge from the price column on the very first edit.
 */
export function ProposalSummary({
  projectId,
  currency,
  taxRatePct,
  totalHours,
  totalDays,
  subtotal,
  tax,
  formats,
  canWrite,
  canExport,
  status,
  pushedCount,
  pushableCount,
  onPush,
}: {
  projectId: string;
  currency: string;
  taxRatePct: number;
  totalHours: number;
  totalDays: number;
  subtotal: Money;
  tax: Money;
  formats: Formats;
  canWrite: boolean;
  /** Whether the viewer is entitled to get the document for the client (see permissions). */
  canExport: boolean;
  /** The deal's stage: whether the transfer button is the primary one or a quiet one depends on it. */
  status: ProposalStage;
  /** How many lines are already in the plan and how many estimated ones can still be transferred. */
  pushedCount: number;
  pushableCount: number;
  /** Open the transfer dialog. */
  onPush: () => void;
}) {
  const { t, locale } = useLocale();

  // The block answers "what next", and the answer changes as things go: while not everything is in
  // the plan — transfer (see PushPlanButton: quiet before the agreement, primary after); everything
  // transferred — look at the chart.
  const everythingPushed = pushedCount > 0 && pushableCount === 0;

  return (
    <aside
      className="proposal-summary"
      aria-label={t("proposal.summary.title")}
    >
      <h3 className="proposal-summary__title">{t("proposal.summary.title")}</h3>
      <dl>
        <div className="proposal-summary__row">
          <dt>{t("proposal.summary.total_hours")}</dt>
          <dd>{formats.hoursLabel(totalHours)}</dd>
        </div>
        <div className="proposal-summary__row">
          <dt>{t("proposal.summary.total_duration")}</dt>
          <dd>{formats.days(totalDays)}</dd>
        </div>
        <div className="proposal-summary__row proposal-summary__row--first">
          <dt>{t("proposal.summary.subtotal")}</dt>
          <dd>{formats.money(subtotal)}</dd>
        </div>
        <div className="proposal-summary__row">
          <dt>{t("proposal.summary.tax", { rate: taxRatePct })}</dt>
          <dd>{formats.money(tax)}</dd>
        </div>
        <div className="proposal-summary__row proposal-summary__total">
          <dt>
            {t("proposal.summary.total")}
            <span className="proposal-summary__currency">{currency}</span>
          </dt>
          <dd className="proposal-summary__amount">
            {formats.money(addMoney(subtotal, tax))}
          </dd>
        </div>
      </dl>
      {/* "Next" — what to do with the proposal once the totals have been read. Separated from the
          numbers by a rule: "how much" and "what now" are different questions. While the deal is not
          agreed, the main action is the document for the client: a quote is written in order to go
          to the client, and the transfer stands as a quiet button below it. After the agreement one
          step is left — the transfer — and its button becomes the primary one (see PushPlanButton),
          while the document moves into the quiet form: it has already gone and been agreed.

          The document is a link with `download` rather than a request from a script: the file is
          assembled by the server, and the browser saves it itself under the name from the response. */}
      {(canExport || canWrite) && (
        <section
          className="proposal-summary__next"
          aria-label={t("proposal.next.title")}
        >
          <span className="proposal-summary__next-label">
            {t("proposal.next.title")}
          </span>
          {canExport && (
            <a
              className={
                status === "agreed"
                  ? "button-link proposal-summary__push"
                  : "button-link proposal-summary__push proposal-summary__pdf"
              }
              href={proposalPdfUrl(projectId, locale)}
              download
            >
              {t("proposal.next.download_pdf")}
            </a>
          )}
          {canWrite &&
            (everythingPushed ? (
              <Link
                className="button-link proposal-summary__push"
                to={`/projects/${projectId}`}
              >
                {t("proposal.push.open_gantt")}
              </Link>
            ) : (
              <>
                <PushPlanButton
                  status={status}
                  pushedCount={pushedCount}
                  pushableCount={pushableCount}
                  className="proposal-summary__push"
                  onPush={onPush}
                />
                <p className="proposal-summary__note">
                  {t("proposal.next.push_note")}
                </p>
              </>
            ))}
        </section>
      )}
    </aside>
  );
}
