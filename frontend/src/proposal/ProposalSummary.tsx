import { Link } from "react-router-dom";

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
  projectId,
  currency,
  taxRatePct,
  totalHours,
  totalDays,
  subtotal,
  tax,
  formats,
  canWrite,
  pushedCount,
  pushableCount,
  onPush,
}: {
  projectId: string;
  currency: string;
  taxRatePct: number;
  totalHours: number;
  totalDays: number;
  subtotal: number;
  tax: number;
  formats: Formats;
  canWrite: boolean;
  /** Сколько строк уже в плане и сколько оценённых ещё можно перенести. */
  pushedCount: number;
  pushableCount: number;
  /** Открыть окно переноса. */
  onPush: () => void;
}) {
  const { t } = useLocale();

  // Главная кнопка отвечает на «что дальше», и ответ меняется по ходу дела:
  // пока в плане ничего нет — перенести; перенесли часть — перенести только
  // новое, счётом; перенесли всё — смотреть диаграмму. Кнопка, зовущая
  // переносить то, что уже перенесено, вернула бы прежние дубли на словах.
  const everythingPushed = pushedCount > 0 && pushableCount === 0;
  const pushLabel =
    pushedCount > 0
      ? t("proposal.push.more", { count: pushableCount })
      : t("proposal.push.action");

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
      {canWrite && everythingPushed && (
        <Link className="button-link proposal-summary__push" to={`/projects/${projectId}`}>
          {t("proposal.push.open_gantt")}
        </Link>
      )}
      {canWrite && !everythingPushed && (
        <button
          type="button"
          className="button--primary proposal-summary__push"
          disabled={pushableCount === 0}
          onClick={onPush}
        >
          {pushLabel}
        </button>
      )}
    </aside>
  );
}
