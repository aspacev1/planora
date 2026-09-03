import { useLocale } from "../i18n/LocaleProvider";
import type { Formats } from "./ProposalTable";

/**
 * Итоги — карточкой сбоку, на виду при любой прокрутке: «сколько всего»
 * спрашивают, не дочитав смету.
 *
 * Числа приходят готовыми: их считает экран из уже показанных строк (см.
 * Proposal.tsx), а карточка их только показывает — второе место с той же
 * арифметикой разошлось бы с колонкой цены на первой же правке.
 */
export function ProposalSummary({
  currency,
  taxRatePct,
  totalHours,
  totalDays,
  subtotal,
  tax,
  formats,
  canWrite,
  canPush,
  pushing,
  onPush,
}: {
  currency: string;
  taxRatePct: number;
  totalHours: number;
  totalDays: number;
  subtotal: number;
  tax: number;
  formats: Formats;
  canWrite: boolean;
  /** Есть что переносить: без единой строки кнопка погашена. */
  canPush: boolean;
  pushing: boolean;
  onPush: () => void;
}) {
  const { t } = useLocale();

  return (
    <aside className="proposal-summary" aria-label={t("proposal.summary.title")}>
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
          <dd className="proposal-summary__amount">{formats.money(subtotal + tax)}</dd>
        </div>
      </dl>
      {canWrite && (
        <button
          type="button"
          className="button--primary proposal-summary__push"
          disabled={!canPush || pushing}
          onClick={onPush}
        >
          {t("proposal.push.action")}
        </button>
      )}
    </aside>
  );
}
