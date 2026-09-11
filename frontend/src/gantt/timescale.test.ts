import { describe, expect, it } from "vitest";

import { buildScale } from "./timescale";

const scale = buildScale({ from: "2026-03-01", to: "2026-06-15", dayWidth: 26 });

describe("шкала времени", () => {
  it("ширина ленты равна числу дней на ширину дня", () => {
    expect(scale.days.length).toBe(107);
    expect(scale.width).toBe(107 * 26);
  });

  it("первый день начинается в нуле", () => {
    expect(scale.xOf("2026-03-01")).toBe(0);
  });

  it("ширина полоски включает оба конца", () => {
    // a task from 4 to 6 March takes three days
    expect(scale.widthOf("2026-03-04", "2026-03-06")).toBe(3 * 26);
  });

  it("однодневная задача не схлопывается в ноль", () => {
    expect(scale.widthOf("2026-03-04", "2026-03-04")).toBe(26);
  });

  it("перевод пикселей в дату обратен переводу даты в пиксели", () => {
    for (const iso of ["2026-03-01", "2026-04-15", "2026-06-15"]) {
      expect(scale.dateAt(scale.xOf(iso))).toBe(iso);
    }
  });

  it("месяцы идут в порядке и покрывают всю ленту", () => {
    expect(scale.months.map((m) => m.key)).toEqual(["2026-03", "2026-04", "2026-05", "2026-06"]);
    expect(scale.months.reduce((sum, m) => sum + m.days, 0)).toBe(scale.days.length);
  });

  it("день недели считается по календарю, а не по остатку от деления", () => {
    expect(scale.days[0].weekday).toBe(0); // 1 March 2026 is a Sunday
  });

  it("тот же день недели считается верно и при другом начале ленты", () => {
    // Shifting the start by a day must shift the weekday too. An index from the strip's start would
    // not notice that, and the error would only show up when the window's bounds changed.
    const shifted = buildScale({ from: "2026-03-02", to: "2026-03-31", dayWidth: 26 });
    expect(shifted.days[0].weekday).toBe(1); // 2 March 2026 is a Monday
  });

  it("день на границе месяца попадает в свой месяц", () => {
    expect(scale.months[0].days).toBe(31); // March
    expect(scale.months[3].days).toBe(15); // June is truncated at the fifteenth
  });

  it("перевод пикселей в дату берёт день, внутрь которого попала точка", () => {
    // The middle of the second day is still the second day rather than the third.
    expect(scale.dateAt(26 + 13)).toBe("2026-03-02");
    // Exactly on the boundary is already the next one.
    expect(scale.dateAt(26 * 2)).toBe("2026-03-03");
  });

  it("точка за пределами ленты прижимается к её краю", () => {
    // Dragging in plan 3 will ask for a date by the cursor's coordinate, and the cursor can travel
    // beyond the edge. Returning undefined or a date outside the window would mean making every caller
    // check that itself.
    expect(scale.dateAt(-100)).toBe("2026-03-01");
    expect(scale.dateAt(scale.width + 100)).toBe("2026-06-15");
  });

  it("лента из одного дня остаётся лентой", () => {
    const single = buildScale({ from: "2026-03-04", to: "2026-03-04", dayWidth: 26 });
    expect(single.days.length).toBe(1);
    expect(single.width).toBe(26);
    expect(single.dateAt(0)).toBe("2026-03-04");
  });

  it("перевод не зависит от часового пояса машины", () => {
    // The arithmetic runs on UTC midnight. A Date object computed in the local zone slips by a day west
    // of Greenwich — and the bar slips with it.
    const across = buildScale({ from: "2026-10-24", to: "2026-11-02", dayWidth: 10 });
    expect(across.days.map((d) => d.date)).toEqual([
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });
});
