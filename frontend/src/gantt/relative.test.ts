import { describe, expect, it } from "vitest";

import type { ProjectState } from "../api/projects";
import {
  RELATIVE_EPOCH,
  dateOfProjectDay,
  projectDayNumber,
  relativeMonths,
  relativeWeekEnd,
  relativeWeeks,
  relativeWindow,
  weeksAcross,
} from "./relative";
import { buildScale } from "./timescale";

/** The minimum state relativeWindow reads. */
function state(partial: Partial<ProjectState>): ProjectState {
  return {
    id: "p1",
    name: "Тест",
    slug: "test",
    deadline: null,
    project_end: null,
    plan_approved_at: null,
    plan_version: 0,
    undoable: null,
    schedule_mode: "relative",
    start_date: null,
    calendar: { working_days: 31, holidays: [], extra_workdays: [] },
    categories: [],
    tasks: [],
    dependencies: [],
    ...partial,
  };
}

describe("относительная ось", () => {
  it("считает день проекта с единицы и обращается обратно", () => {
    expect(projectDayNumber(RELATIVE_EPOCH)).toBe(1);
    expect(projectDayNumber("2001-01-08")).toBe(8);
    expect(dateOfProjectDay(1)).toBe(RELATIVE_EPOCH);
    expect(dateOfProjectDay(26)).toBe("2001-01-26");
  });

  it("считает день от переданного якоря — для относительного вида календарного проекта", () => {
    expect(projectDayNumber("2026-08-24", "2026-08-24")).toBe(1);
    expect(dateOfProjectDay(8, "2026-08-24")).toBe("2026-08-31");
  });

  it("окно пустого проекта — четыре недели от эпохи", () => {
    expect(relativeWindow(state({}))).toEqual({ from: "2001-01-01", to: "2001-01-28" });
  });

  it("окно занимает всю отведённую ширину целыми неделями", () => {
    // 1000 pixels with a day at 18 (the "Month" scale) is seven whole weeks and a remainder of 118
    // pixels, which does not add up to a week. The remainder is covered by the "beyond the plan" band
    // rather than by an eighth incomplete week: the header is cut by weeks, and half a week at its end
    // would read as a break.
    expect(weeksAcross(1000, 18)).toBe(7);
    expect(relativeWindow(state({}), RELATIVE_EPOCH, weeksAcross(1000, 18))).toEqual({
      from: "2001-01-01",
      to: "2001-02-18",
    });
  });

  it("узкое окно не сжимает шкалу меньше «Месяца 1»", () => {
    // There is no width yet (the first render, jsdom) or it is enough for a week — an empty project
    // still shows the whole month.
    expect(weeksAcross(0, 18)).toBe(4);
    expect(weeksAcross(200, 18)).toBe(4);
    expect(relativeWindow(state({}), RELATIVE_EPOCH, weeksAcross(200, 18))).toEqual({
      from: "2001-01-01",
      to: "2001-01-28",
    });
  });

  it("задачи за краем окна тянут его дальше отведённой ширины", () => {
    // The screen's width is the window's lower bound rather than its edge: a plan going further is
    // shown in full and scrolls.
    const long = state({ project_end: "2001-04-30" });
    expect(relativeWindow(long, RELATIVE_EPOCH, weeksAcross(500, 18)).to).toBe("2001-05-06");
  });

  it("окно дотягивается до конца последней занятой недели", () => {
    const withTask = state({
      project_end: "2001-02-09",
      tasks: [],
    });
    // 9 February is day 40, the sixth week; the window ends on its last day.
    expect(relativeWindow(withTask)).toEqual({ from: "2001-01-01", to: "2001-02-11" });
  });

  it("дедлайн и сегодняшний день окно не растягивают", () => {
    const withDeadline = state({ deadline: "2026-06-01" });
    expect(relativeWindow(withDeadline).to).toBe("2001-01-28");
  });

  it("режет шкалу на недели по семь дней и месяцы по четыре недели", () => {
    const scale = buildScale({ from: "2001-01-01", to: "2001-02-11", dayWidth: 10 });
    const weeks = relativeWeeks(scale);
    expect(weeks).toHaveLength(6);
    expect(weeks[0]).toEqual({ number: 1, x: 0, width: 70 });
    expect(weeks[5]).toEqual({ number: 6, x: 350, width: 70 });

    const months = relativeMonths(scale);
    expect(months).toHaveLength(2);
    expect(months[0]).toEqual({ number: 1, x: 0, width: 280 });
    // The truncated last "month" is two weeks: the window rounds to weeks rather than to months, as in
    // the mockup, where month 2 begins with the fifth week.
    expect(months[1]).toEqual({ number: 2, x: 280, width: 140 });
  });
});

describe("relativeWeekEnd", () => {
  it("округляет вверх до конца недели — тем же правилом, что и окно", () => {
    expect(relativeWeekEnd("2001-01-01")).toBe("2001-01-07"); // Day 1 → the end of week 1
    expect(relativeWeekEnd("2001-01-07")).toBe("2001-01-07"); // Day 7 is already the end
    expect(relativeWeekEnd("2001-01-08")).toBe("2001-01-14"); // Day 8 → the end of week 2
  });
});
