import { describe, expect, it } from "vitest";

import type { ProjectState, Task } from "../api/projects";
import { deadlineOverrunDays, overdueTasks, pastDeadlineTasks } from "./verdict";

const TODAY = "2026-03-15";

/** The default task is ahead of today: overdueness is declared by the test itself. */
function task(fields: Partial<Task> = {}): Task {
  return {
    id: "t1",
    category_id: "c1",
    name: "Логотип",
    start_date: "2026-03-16",
    end_date: "2026-03-20",
    duration_days: 5,
    milestone: false,
    critical: false,
    criticality: "normal",
    risk: "green",
    risk_note: "",
    status: "in_progress",
    progress_pct: 40,
    position: 0,
    assignee_ids: [],
    baseline_start: null,
    baseline_duration: null,
    baseline_end: null,
    ...fields,
  };
}

function project(fields: Partial<ProjectState> = {}): ProjectState {
  return {
    id: "p1",
    name: "Редизайн",
    slug: "redizayn",
    deadline: null,
    project_end: null,
    schedule_mode: "calendar",
    start_date: "2026-03-02",
    plan_approved_at: null,
    plan_version: 0,
    undoable: null,
    calendar: { working_days: 31, holidays: [], extra_workdays: [] },
    categories: [],
    tasks: [task()],
    dependencies: [],
    ...fields,
  };
}

/** A relative plan: axis coordinates from RELATIVE_EPOCH rather than dates. */
function relative(fields: Partial<ProjectState> = {}): ProjectState {
  return project({
    schedule_mode: "relative",
    start_date: null,
    tasks: [task({ start_date: "2001-01-01", end_date: "2001-01-05" })],
    ...fields,
  });
}

describe("просрочка", () => {
  it("считает незакрытую задачу, чей срок прошёл", () => {
    const state = project({ tasks: [task({ end_date: "2026-03-10" })] });

    expect(overdueTasks(state, TODAY)).toHaveLength(1);
  });

  it("не считает завершённую: сделанное поздно уже не требует действия", () => {
    const state = project({ tasks: [task({ end_date: "2026-03-10", status: "done" })] });

    expect(overdueTasks(state, TODAY)).toEqual([]);
  });

  it("не трогает относительный план: там «даты» — координаты 2001 года", () => {
    // The trap is live: without a mode check a comparison with today would mark every row of a plan with
    // no assigned dates as overdue — and "Reports" and "My tasks" showed that for years.
    const state = relative();

    expect(overdueTasks(state, TODAY)).toEqual([]);
  });
});

describe("выход за дедлайн проекта", () => {
  it("меряется днями, а не задачами", () => {
    const state = project({ deadline: "2026-06-01", project_end: "2026-06-08" });

    expect(deadlineOverrunDays(state)).toBe(7);
  });

  it("молчит, когда проект укладывается", () => {
    const state = project({ deadline: "2026-06-08", project_end: "2026-06-01" });

    expect(deadlineOverrunDays(state)).toBeNull();
  });

  it("молчит у относительного плана: сравнивать дедлайн не с чем", () => {
    const state = relative({ deadline: "2026-06-01", project_end: "2001-01-05" });

    expect(deadlineOverrunDays(state)).toBeNull();
  });

  it("в счёт задач за дедлайном входят и завершённые — вопрос «в срок ли»", () => {
    const state = project({
      deadline: "2026-03-05",
      tasks: [
        task({ end_date: "2026-03-10", status: "done" }),
        task({ id: "t2", end_date: "2026-03-10" }),
      ],
    });

    // Both end later than the deadline, and one of them being finished does not change the answer: this is
    // a different quantity from the overdueness above.
    expect(pastDeadlineTasks(state)).toHaveLength(2);
    expect(overdueTasks(state, TODAY)).toHaveLength(1);
  });
});
