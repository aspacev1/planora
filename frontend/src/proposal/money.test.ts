import { describe, expect, it } from "vitest";

import { formatMoney, formatMoneyAmount, lineAmount, sumMoney, taxOf, toCents } from "./money";

/**
 * The money on screen must agree with the document to the cent. The document computes in Decimal and
 * rounds half up (see export/proposal_pdf.py); what is checked here is exactly the values where double
 * and Decimal diverge.
 */
describe("деньги сметы", () => {
  it("перемножает оценку и ставку точно, а не в double", () => {
    // 0.5 × 2.01 in double is 1.00499999…, and "to cents" would give 1.00.
    expect(toCents(lineAmount(0.5, 2.01))).toBe(101n);
    // 0.5 × 2.25 = 1.125: half up, not to even.
    expect(toCents(lineAmount(0.5, 2.25))).toBe(113n);
    expect(formatMoneyAmount("en", lineAmount(0.5, 2.25))).toBe("1.13");
  });

  it("складывает строки без потери и налог считает от точной суммы", () => {
    const subtotal = sumMoney([lineAmount(0.1, 1), lineAmount(0.2, 1), lineAmount(0.3, 1)]);
    expect(toCents(subtotal)).toBe(60n);
    // 0.6 × 18.5% = 0.111 → 0.11; a tax on a value rounded to cents would be the same here, but not on
    // 1.005 × 10% = 0.1005 → 0.10, where rounding up prematurely would give 0.101 → 0.10 against 0.11 at
    // 1.01 × 10%.
    expect(toCents(taxOf(subtotal, 18.5))).toBe(11n);
    expect(toCents(taxOf(lineAmount(0.5, 2.01), 10))).toBe(10n);
  });

  it("не теряет разряды на больших ставках", () => {
    // The server's ceiling: an estimate of 999999.99 at a rate of 9999999999.99 is past 2⁵³ in
    // hundredths, and a `number` would already lie here.
    expect(toCents(lineAmount(999999.99, 9999999999.99))).toBe(999999989999000000n);
  });

  it("форматирует по языку и валюте, а сломанный код валюты не роняет смету", () => {
    expect(formatMoney("en", "USD", lineAmount(2, 400))).toBe("$800.00");
    expect(formatMoney("en", "EU", lineAmount(2, 400))).toBe("800 EU");
  });
});
