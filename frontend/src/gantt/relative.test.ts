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
} from "./relative";
import { buildScale } from "./timescale";

/** Минимум состояния, который читает relativeWindow. */
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

  it("окно дотягивается до конца последней занятой недели", () => {
    const withTask = state({
      project_end: "2001-02-09",
      tasks: [],
    });
    // 9 февраля — день 40, шестая неделя; окно кончается её последним днём.
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
    // Обрезанный последний «месяц» — две недели: окно круглится до недель,
    // а не до месяцев, как в макете, где месяц 2 начат пятой неделей.
    expect(months[1]).toEqual({ number: 2, x: 280, width: 140 });
  });
});

describe("relativeWeekEnd", () => {
  it("округляет вверх до конца недели — тем же правилом, что и окно", () => {
    expect(relativeWeekEnd("2001-01-01")).toBe("2001-01-07"); // День 1 → конец недели 1
    expect(relativeWeekEnd("2001-01-07")).toBe("2001-01-07"); // День 7 — уже конец
    expect(relativeWeekEnd("2001-01-08")).toBe("2001-01-14"); // День 8 → конец недели 2
  });
});
