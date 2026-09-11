import { describe, expect, it } from "vitest";

import { formatDate, formatMonth, weekdayNarrow } from "./dates";
import { SUPPORTED_LOCALES, flattenKeys as flatten, translate } from "./index";

describe("переводы", () => {
  it("подставляет параметры", () => {
    expect(translate("ru", "auth.greeting", { name: "Алексей" })).toBe("Привет, Алексей");
  });

  it("склоняет русские числительные по настоящим правилам", () => {
    expect(translate("ru", "common.days", { count: 1 })).toBe("1 день");
    expect(translate("ru", "common.days", { count: 3 })).toBe("3 дня");
    expect(translate("ru", "common.days", { count: 5 })).toBe("5 дней");
    expect(translate("ru", "common.days", { count: 21 })).toBe("21 день");
    expect(translate("ru", "common.days", { count: 112 })).toBe("112 дней");
  });

  it("падает на азербайджанский, если ключа нет", () => {
    expect(translate("en", "missing.key.for.test")).toBe(translate("az", "missing.key.for.test"));
  });

  it("возвращает сам ключ, если его нет нигде", () => {
    expect(translate("en", "totally.unknown")).toBe("totally.unknown");
  });
});

describe("даты", () => {
  it("называет месяц словом на каждом языке, а не кодом", () => {
    // The trap is live rather than made up: ICU in the browser knows the `az` locale but contains no
    // month names for it and falls back to the root locale — `Intl.DateTimeFormat("az", { month:
    // "long" })` gives "M09". For the default language that is half a scale rendered unreadable, so the
    // names live in the dictionaries. The test catches a return to `Intl` and a typo in a month's number.
    for (const locale of SUPPORTED_LOCALES) {
      const t = (key: string, params?: Record<string, string | number>) =>
        translate(locale, key, params);
      expect(formatDate(t, "2026-09-15")).toMatch(/\p{L}{3,}/u);
      expect(formatDate(t, "2026-09-15")).not.toMatch(/M\d|calendar\./);
      expect(formatMonth(t, "2026-09-01")).toMatch(/2026/);
      expect(formatMonth(t, "2026-09-01")).not.toMatch(/M\d|calendar\./);
    }
  });

  it("день с числом собирается в порядке, принятом в языке", () => {
    expect(formatDate((k, p) => translate("ru", k, p), "2026-09-15")).toBe("15 сентября");
    expect(formatDate((k, p) => translate("en", k, p), "2026-09-15")).toBe("September 15");
    expect(formatDate((k, p) => translate("az", k, p), "2026-09-15")).toBe("15 sentyabr");
  });

  it("все семь дней недели подписаны на каждом языке", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const labels = [0, 1, 2, 3, 4, 5, 6].map((day) =>
        weekdayNarrow((k, p) => translate(locale, k, p), day),
      );
      expect(new Set(labels).size).toBe(7);
      expect(labels.some((label) => label.startsWith("calendar."))).toBe(false);
    }
  });
});

describe("полнота словарей", () => {
  it("во всех языках один и тот же набор ключей", async () => {
    const [az, en, ru] = await Promise.all([
      import("./az.json"),
      import("./en.json"),
      import("./ru.json"),
    ]);
    const keys = (o: object) => Object.keys(flatten(o)).sort();
    expect(keys(en.default)).toEqual(keys(az.default));
    expect(keys(ru.default)).toEqual(keys(az.default));
  });
});
