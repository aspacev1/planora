import { describe, expect, it } from "vitest";

import {
  COMFORTABLE_PAGES,
  MAX_PAGES,
  ZOOMS,
  daysPerPage,
  defaultZoom,
  pageCount,
  windowDays,
  zoomAllowed,
  zoomOptions,
} from "./pageBudget";

/**
 * The same table of expectations as the server's (`backend/tests/test_export_api.py`, the "the scale
 * rule" block).
 *
 * If these two sets diverge, the dialog will start writing one number of pages on the button while a
 * different one arrives in the file — and the first to notice will not be a developer but a person who
 * downloaded a twelve-page file instead of the promised two.
 */

describe("ёмкость страницы", () => {
  it("считается формулой от ширины, а не берётся из таблицы", () => {
    expect(daysPerPage("day", "landscape")).toBe(74);
    expect(daysPerPage("week", "landscape")).toBe(203);
    expect(daysPerPage("month", "landscape")).toBe(420);
  });

  it("книжной странице всегда нужно не меньше страниц, чем альбомной", () => {
    for (const zoom of ZOOMS) {
      expect(pageCount(365, zoom, "portrait")).toBeGreaterThanOrEqual(
        pageCount(365, zoom, "landscape"),
      );
    }
    expect(pageCount(365, "day", "portrait")).toBeGreaterThan(
      pageCount(365, "day", "landscape"),
    );
  });

  it("пустой проект — одна страница с шапкой, а не ноль", () => {
    expect(pageCount(0, "day", "landscape")).toBe(1);
  });
});

describe("умолчание масштаба", () => {
  it.each([
    [90, "day"],
    [180, "week"],
    [365, "week"],
    [730, "month"],
  ] as const)("проект в %i дн. открывается масштабом «%s»", (days, expected) => {
    expect(defaultZoom(days, "landscape")).toBe(expected);
    expect(pageCount(days, expected, "landscape")).toBeLessThanOrEqual(COMFORTABLE_PAGES);
  });

  it("умолчание никогда не оказывается запрещённым самому себе", () => {
    // On a ten-year portfolio even a month goes past the ceiling — and it is allowed all the same: it
    // has no less detailed neighbour, and a refusal there would mean the project cannot be exported at
    // all.
    for (const days of [30, 365, 1095, 5000, 20000]) {
      const zoom = defaultZoom(days, "landscape");
      expect(zoomAllowed(zoom, days, "landscape")).toBe(true);
    }
    expect(pageCount(5000, "month", "landscape")).toBeGreaterThan(MAX_PAGES);
    expect(zoomAllowed("month", 5000, "landscape")).toBe(true);
  });
});

describe("цена подробности", () => {
  it("на кнопке недоступного масштаба всё равно написано число страниц", () => {
    const options = zoomOptions(1200, "landscape");
    const day = options.find((option) => option.zoom === "day");

    expect(day?.allowed).toBe(false);
    // Not "the button disappeared" but "here is what it costs": a person must understand what the detail
    // costs rather than guess where the button went.
    expect(day?.pages).toBeGreaterThan(MAX_PAGES);
  });

  it("день доступен до пятнадцати месяцев и недоступен дальше", () => {
    expect(pageCount(444, "day", "landscape")).toBeLessThanOrEqual(MAX_PAGES);
    expect(pageCount(445, "day", "landscape")).toBeGreaterThan(MAX_PAGES);
  });
});

describe("окно периода", () => {
  const start = "2026-01-01";
  const end = "2026-12-31";
  const today = "2026-06-01";

  it("«весь проект» — от первой задачи до последней", () => {
    expect(windowDays("all", start, end, today)).toBe(365);
  });

  it("узкие окна укладывают дневной масштаб в одну страницу", () => {
    expect(windowDays("next_4w", start, end, today)).toBe(28);
    expect(pageCount(28, "day", "landscape")).toBe(1);
    expect(windowDays("next_3m", start, end, today)).toBe(90);
    expect(pageCount(90, "day", "landscape")).toBe(2);
  });

  it("окно не выходит за пределы проекта", () => {
    // The project ends in a week: "the coming three months" is a week rather than three months of empty
    // scale.
    expect(windowDays("next_3m", start, "2026-06-08", today)).toBe(8);
  });

  it("проект целиком в прошлом всё равно даёт окно", () => {
    expect(windowDays("next_4w", "2024-01-01", "2024-03-01", today)).toBe(1);
  });

  it("узкий период возвращает дневной масштаб на длинном проекте", () => {
    const whole = windowDays("all", "2026-01-01", "2028-12-31", today);
    expect(defaultZoom(whole, "landscape")).toBe("month");

    const narrow = windowDays("next_4w", "2026-01-01", "2028-12-31", today);
    expect(defaultZoom(narrow, "landscape")).toBe("day");
    expect(pageCount(narrow, "day", "landscape")).toBe(1);
  });
});
