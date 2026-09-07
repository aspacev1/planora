import { describe, expect, it } from "vitest";

import type { Task } from "../api/projects";
import { deviationDays } from "./baseline";

/** Задача, чей старт уже уехал на пять дней от базового плана. */
const SHIFTED: Task = {
  id: "t1",
  category_id: "c1",
  name: "Логотип",
  description: "",
  internal_note: "",
  start_date: "2026-03-09",
  end_date: "2026-03-13",
  duration_days: 5,
  milestone: false,
  critical: false,
  criticality: "high",
  risk: "green",
  risk_note: "",
  status: "in_progress",
  progress_pct: 40,
  position: 0,
  assignee_ids: [],
  baseline_start: "2026-03-04",
  baseline_duration: 5,
  baseline_end: "2026-03-10",
};

describe("отклонение от базового плана", () => {
  it("без подмены отвечает наибольшим из двух измерений", () => {
    expect(deviationDays(SHIFTED)).toBe(5);
    expect(deviationDays({ ...SHIFTED, duration_days: 12 })).toBe(7);
  });

  it("правка длительности меряется длительностью, а не уже объяснённым сдвигом старта", () => {
    // То же правило, что у `deviation_days` на сервере: иначе каждая правка
    // длительности на день требовала бы причину за чужое измерение.
    expect(deviationDays(SHIFTED, { duration_days: 6 })).toBe(1);
  });

  it("перенос меряется сдвигом старта, а не растянутой длительностью", () => {
    expect(deviationDays({ ...SHIFTED, duration_days: 12 }, { start_date: "2026-03-05" })).toBe(1);
  });

  it("правка обоих измерений разом берёт большее", () => {
    expect(deviationDays(SHIFTED, { start_date: "2026-03-05", duration_days: 9 })).toBe(4);
  });

  it("без базового плана сравнивать не с чем", () => {
    expect(deviationDays({ ...SHIFTED, baseline_start: null }, { duration_days: 6 })).toBeNull();
  });
});
