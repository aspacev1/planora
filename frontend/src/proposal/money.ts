/**
 * Деньги сметы — точным счётом, как на сервере, и через Intl, как даты в
 * i18n/dates.
 *
 * Суммы не считаются в double: `0.5 × 2.01` в нём — это 1.00499999…, и
 * округление к копейкам даёт «1,00» там, где сервер, считающий в Decimal
 * (см. export/proposal_pdf.py), пишет в документ «1,01». Один и тот же
 * документ на экране и в PDF обязан сходиться до копейки, поэтому оценка и
 * ставка — числа с двумя знаками, какими их хранит сервер, — перемножаются
 * целыми сотыми, а сумма держится в целых с фиксированным сдвигом до самого
 * форматирования. Округление к копейкам — половина вверх (ROUND_HALF_UP), как
 * в `_money` документа.
 *
 * Свой форматтер, а не toFixed: разряды и десятичный знак зависят от языка
 * читателя, и «1,500.00» на русском экране читается как полторы единицы.
 */

/**
 * Сумма в стомиллионных долях (8 знаков после запятой), целым числом.
 *
 * Восемь знаков — ровно столько, сколько нужно, чтобы не потерять ни одной
 * цифры: оценка × ставка даёт четыре, налог от этого в процентах с двумя
 * знаками — ещё четыре. `bigint`, а не `number`: ставка до десяти миллиардов
 * на оценку до миллиона выходит за 2⁵³ уже в сотых.
 */
export type Money = bigint;

const SCALE = 100_000_000n;
const CENT = SCALE / 100n;

export const ZERO: Money = 0n;

/** Число с двумя знаками → целые сотые. Так хранит и сервер: Numeric(…, 2). */
function hundredths(value: number): bigint {
  return BigInt(Math.round(value * 100));
}

/** Стоимость строки: оценка × ставка, точно. */
export function lineAmount(effort: number, rate: number): Money {
  // сотые × сотые = десятитысячные; до восьми знаков — ещё четыре.
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

/** Налог от суммы по ставке в процентах с двумя знаками — точно, как сервер. */
export function taxOf(subtotal: Money, ratePct: number): Money {
  // subtotal × (pct / 100) / 100: сотые процента и сами проценты — четыре
  // порядка, и они снимаются одним делением; остаток нулевой, потому что
  // subtotal — произведение сотых, а не произвольная дробь.
  return (subtotal * hundredths(ratePct)) / 10_000n;
}

/** До копеек, половина вверх — ROUND_HALF_UP, как в PDF. */
export function toCents(value: Money): bigint {
  const sign = value < 0n ? -1n : 1n;
  const magnitude = value < 0n ? -value : value;
  return sign * ((magnitude + CENT / 2n) / CENT);
}

/** Сумма как число с двумя знаками — для тех, кому нужно именно число. */
export function moneyToNumber(value: Money): number {
  return Number(toCents(value)) / 100;
}

export function isPositive(value: Money): boolean {
  return value > 0n;
}

export function formatAmount(locale: string, value: number): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
}

/** Сумма без валюты — в ячейках таблицы, где валюта названа шапкой. */
export function formatMoneyAmount(locale: string, value: Money): string {
  return formatAmount(locale, moneyToNumber(value));
}

export function formatMoney(locale: string, currency: string, value: Money): string {
  const amount = moneyToNumber(value);
  // Код валюты — ввод человека, и до конца набора он не код: Intl на «EU»
  // поднимает RangeError, а смета не должна падать из-за недописанной буквы.
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
