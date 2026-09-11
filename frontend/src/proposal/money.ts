/**
 * The quote's money — with exact arithmetic as on the server, and through Intl as with dates in
 * i18n/dates.
 *
 * Sums are not computed in double: `0.5 × 2.01` in it is 1.00499999…, and rounding to cents gives
 * "1.00" where the server, computing in Decimal (see export/proposal_pdf.py), writes "1.01" into
 * the document. One and the same document on screen and in the PDF must agree to the cent, so the
 * estimate and the rate — numbers with two decimals, as the server stores them — are multiplied as
 * whole hundredths, and the sum is held as an integer with a fixed shift right up to formatting.
 * Rounding to cents is half up (ROUND_HALF_UP), as in the document's `_money`.
 *
 * Our own formatter rather than toFixed: the grouping and the decimal mark depend on the reader's
 * language, and "1,500.00" on a Russian screen reads as one and a half units.
 */

/**
 * A sum in hundred-millionths (8 decimal places), as an integer.
 *
 * Eight places are exactly as many as are needed not to lose a single digit: estimate × rate gives
 * four, a tax on that in percent with two decimals gives another four. A `bigint` rather than a
 * `number`: a rate of up to ten billion against an estimate of up to a million goes past 2⁵³
 * already in hundredths.
 */
export type Money = bigint;

const SCALE = 100_000_000n;
const CENT = SCALE / 100n;

export const ZERO: Money = 0n;

/** A number with two decimals → whole hundredths. That is how the server stores it too: Numeric(…, 2). */
function hundredths(value: number): bigint {
  return BigInt(Math.round(value * 100));
}

/** A line's cost: estimate × rate, exactly. */
export function lineAmount(effort: number, rate: number): Money {
  // hundredths × hundredths = ten-thousandths; up to eight places is another four.
  return hundredths(effort) * hundredths(rate) * 10_000n;
}

export function addMoney(a: Money, b: Money): Money {
  return a + b;
}

export function sumMoney(values: Iterable<Money>): Money {
  let total = ZERO;
  for (const value of values) total += value;
  return total;
}

/** A tax on the sum at a rate in percent with two decimals — exactly, as the server does. */
export function taxOf(subtotal: Money, ratePct: number): Money {
  // subtotal × (pct / 100) / 100: hundredths of a percent and the percent itself are four orders,
  // and they are removed by one division; the remainder is zero, because subtotal is a product of
  // hundredths rather than an arbitrary fraction.
  return (subtotal * hundredths(ratePct)) / 10_000n;
}

/** To cents, half up — ROUND_HALF_UP, as in the PDF. */
export function toCents(value: Money): bigint {
  const sign = value < 0n ? -1n : 1n;
  const magnitude = value < 0n ? -value : value;
  return sign * ((magnitude + CENT / 2n) / CENT);
}

/** The sum as a number with two decimals — for those who need a number specifically. */
export function moneyToNumber(value: Money): number {
  return Number(toCents(value)) / 100;
}

export function isPositive(value: Money): boolean {
  return value > 0n;
}

export function formatAmount(locale: string, value: number): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
}

/** The sum without a currency — in the table's cells, where the currency is named by the heading. */
export function formatMoneyAmount(locale: string, value: Money): string {
  return formatAmount(locale, moneyToNumber(value));
}

export function formatMoney(locale: string, currency: string, value: Money): string {
  const amount = moneyToNumber(value);
  // The currency code is a person's input, and until typing is finished it is not a code: Intl
  // raises a RangeError on "EU", and a quote must not crash over an unfinished letter.
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${formatAmount(locale, amount)} ${currency}`;
  }
}
