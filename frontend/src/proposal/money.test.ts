import { describe, expect, it } from "vitest";

import { formatMoney, formatMoneyAmount, lineAmount, sumMoney, taxOf, toCents } from "./money";

/**
 * Деньги на экране обязаны сходиться с документом до копейки. Документ
 * считает в Decimal и округляет половину вверх (см. export/proposal_pdf.py);
 * здесь проверяются ровно те значения, на которых double и Decimal
 * расходятся.
 */
describe("деньги сметы", () => {
  it("перемножает оценку и ставку точно, а не в double", () => {
    // 0.5 × 2.01 в double — 1.00499999…, и «к копейкам» дало бы 1,00.
    expect(toCents(lineAmount(0.5, 2.01))).toBe(101n);
    // 0.5 × 2.25 = 1.125: половина вверх, а не к чётному.
    expect(toCents(lineAmount(0.5, 2.25))).toBe(113n);
    expect(formatMoneyAmount("en", lineAmount(0.5, 2.25))).toBe("1.13");
  });

  it("складывает строки без потери и налог считает от точной суммы", () => {
    const subtotal = sumMoney([lineAmount(0.1, 1), lineAmount(0.2, 1), lineAmount(0.3, 1)]);
    expect(toCents(subtotal)).toBe(60n);
    // 0.6 × 18.5 % = 0.111 → 0,11; налог от округлённого до копеек был бы тем же
    // здесь, но не на 1.005 × 10 % = 0.1005 → 0,10, где округление вверх
    // раньше времени дало бы 0,101 → 0,10 против 0,11 при 1,01 × 10 %.
    expect(toCents(taxOf(subtotal, 18.5))).toBe(11n);
    expect(toCents(taxOf(lineAmount(0.5, 2.01), 10))).toBe(10n);
  });

  it("не теряет разряды на больших ставках", () => {
    // Потолок сервера: оценка 999999.99 при ставке 9999999999.99 — за 2⁵³ в
    // сотых, и `number` здесь уже врал бы.
    expect(toCents(lineAmount(999999.99, 9999999999.99))).toBe(999999989999000000n);
  });

  it("форматирует по языку и валюте, а сломанный код валюты не роняет смету", () => {
    expect(formatMoney("en", "USD", lineAmount(2, 400))).toBe("$800.00");
    expect(formatMoney("en", "EU", lineAmount(2, 400))).toBe("800 EU");
  });
});
