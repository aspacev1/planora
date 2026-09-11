import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import type { ProjectState } from "../api/projects";
import {
  APPROVED,
  APPROVED_WITH_EXTRA,
  STATE,
  projectFixtures,
  renderProject,
} from "../test/project";

beforeEach(projectFixtures);

/**
 * A figure in a cell of the plan's summary.
 *
 * Looked up from the caption rather than from the number: there are many numbers on screen,
 * and a "1" would be found in the first one to hand. The search is limited to the summary
 * itself — the same words stand in the chart's legend and in the task's card too.
 */
async function openSummary(): Promise<HTMLElement> {
  const toggle = await screen.findByRole("button", { name: "Сводка по проекту" });
  if (toggle.getAttribute("aria-expanded") !== "true") await userEvent.click(toggle);
  return screen.getByRole("list", { name: "Сводка по проекту" });
}

async function metric(label: string): Promise<string> {
  const strip = await openSummary();
  const cell = within(strip).getByText(label).closest("li");
  return cell?.querySelector(".plan-summary__value")?.textContent ?? "";
}

describe("шапка проекта", () => {
  it("называет срок работ", async () => {
    renderProject();

    // The dates run from the earliest start to the project end computed by the server rather
    // than to the last task's end: the end can be later than it.
    await openSummary();
    expect(screen.getByText("4 марта — 8 июня")).toBeInTheDocument();
  });

  it("проект без задач срока не выдумывает", async () => {
    renderProject({ ...STATE, tasks: [], project_end: null });

    // Such a project has no dates — the panel starts straight with the metrics.
    await openSummary();
    expect(document.querySelector(".plan-summary__period")).toBeEmptyDOMElement();
  });

  it("несогласованный план так и называет себя черновиком", async () => {
    renderProject();

    expect(await screen.findByText("План проекта · черновик")).toBeInTheDocument();
    expect(screen.queryByText(/изменен/i)).toBeNull();
  });

  it("согласованный план показывает версию", async () => {
    renderProject(APPROVED);

    expect(await screen.findByText("План проекта · v1")).toBeInTheDocument();
    // The dates coincide with the baseline plan: there is nowhere for a divergence to come
    // from, and a marker about one would be a false alarm.
    expect(screen.queryByText(/изменен/i)).toBeNull();
  });

  it("бейдж плана называет своё состояние, а не только текст", async () => {
    // A draft and an approved plan differ by the badge's colour, and the theme takes the colour
    // from `data-state`: without it both would stay amber — that is, an approved plan would
    // demand attention all the time.
    // The text lies in a nested node (on a phone it is hidden, leaving a dot), while the state
    // is carried by the chip itself.
    renderProject();
    expect(
      (await screen.findByText("План проекта · черновик")).closest(".project-head__plan-label"),
    ).toHaveAttribute("data-state", "draft");

    renderProject(APPROVED);
    expect(
      (await screen.findByText("План проекта · v1")).closest(".project-head__plan-label"),
    ).toHaveAttribute("data-state", "approved");
  });

  it("состояние плана стоит в строке названия, а не хвостом за сводкой", async () => {
    renderProject(APPROVED);

    // What is checked is precisely the place: a divergence from the approved plan is read
    // together with the project's name rather than among the summary's figures above the strip.
    const label = await screen.findByText("План проекта · v1");
    expect(label.closest(".project-bar")).not.toBeNull();
    expect(label.closest(".plan-summary")).toBeNull();
  });

  it("публикация убрана под «⋯»: её открывают редко", async () => {
    renderProject();

    // It is not in the header's line — the tier grows with every permanent button, and that is
    // exactly how it grew last time.
    expect(screen.queryByRole("button", { name: "Поделиться" })).toBeNull();

    await userEvent.click(await screen.findByRole("button", { name: "Ещё действия" }));

    const share = screen.getByRole("button", { name: "Поделиться" });
    expect(share.closest(".project-bar__actions")).not.toBeNull();
  });

  it("работа сверх плана помечает план как изменённый", async () => {
    renderProject(APPROVED_WITH_EXTRA);

    expect(await screen.findByText(/1 изменение после v1/)).toBeInTheDocument();
  });

  it("уехавшая от базового плана задача помечает план как изменённый", async () => {
    renderProject({
      ...APPROVED,
      tasks: [{ ...APPROVED.tasks[0], start_date: "2026-03-11", end_date: "2026-03-17" }],
    });

    expect(await screen.findByText(/1 изменение после v1/)).toBeInTheDocument();
  });

  it("пометка называет число разошедшихся задач, а не один лишь факт", async () => {
    // Two tasks have travelled from the baseline plan, the third stands still: the number
    // answers "how serious is this" before the list is opened.
    renderProject({
      ...APPROVED,
      tasks: [
        { ...APPROVED.tasks[0], id: "t1", start_date: "2026-03-11", end_date: "2026-03-17" },
        {
          ...APPROVED.tasks[0],
          id: "t2",
          name: "Вторая",
          position: 1,
          duration_days: 9,
          baseline_duration: 5,
        },
        { ...APPROVED.tasks[0], id: "t3", name: "Третья", position: 2 },
      ],
    });

    expect(await screen.findByText(/2 изменения после v1/)).toBeInTheDocument();
  });

  it("задача, которую и подвинули, и растянули, считается один раз", async () => {
    // Otherwise the number would depend on how many times the task was touched, and would grow
    // where it is still the same one row diverging from the plan.
    renderProject({
      ...APPROVED,
      tasks: [
        {
          ...APPROVED.tasks[0],
          start_date: "2026-03-11",
          end_date: "2026-03-20",
          duration_days: 8,
        },
      ],
    });

    expect(await screen.findByText(/1 изменение после v1/)).toBeInTheDocument();
  });

  it("пометка ведёт в список изменений, а не просто сообщает о них", async () => {
    renderProject(APPROVED_WITH_EXTRA);

    // A button rather than a set: there is somewhere to go behind the marker, and that must be
    // visible before the press — otherwise the list stays unknown to everyone.
    expect(await screen.findByRole("button", { name: /1 изменение после v1/ })).toBeInTheDocument();
  });
});

/**
 * Five tasks spread across all four statuses, with a deadline of 1 June.
 *
 * Two go past the deadline, and one of them is finished: the overlap of "Finished" and "Past
 * the project's deadline" is built into the fixture deliberately, otherwise the test for it
 * would be checking the absence of an overlap rather than its presence.
 */
const MIXED: ProjectState = {
  ...STATE,
  tasks: [
    { ...STATE.tasks[0], id: "t1", name: "В работе", status: "in_progress" },
    { ...STATE.tasks[0], id: "t2", name: "Стоит", status: "blocked", position: 1 },
    {
      ...STATE.tasks[0],
      id: "t3",
      name: "Ещё не начата",
      status: "planned",
      position: 2,
      start_date: "2026-06-15",
      end_date: "2026-06-20",
    },
    {
      ...STATE.tasks[0],
      id: "t4",
      name: "Готова, но поздно",
      status: "done",
      progress_pct: 100,
      position: 3,
      start_date: "2026-06-04",
      end_date: "2026-06-10",
    },
    {
      ...STATE.tasks[0],
      id: "t5",
      name: "Готова в срок",
      status: "done",
      progress_pct: 100,
      position: 4,
      start_date: "2026-03-25",
      end_date: "2026-04-01",
    },
  ],
};

describe("полоса метрик", () => {
  it("раскладывает задачи по четырём статусам, и они в сумме дают «всего»", async () => {
    renderProject(MIXED);

    expect(await metric("Всего задач")).toBe("5");
    expect(await metric("В работе")).toBe("1");
    expect(await metric("Заблокировано")).toBe("1");
    expect(await metric("Не начато")).toBe("1");
    expect(await metric("Завершено")).toBe("2");
  });

  it("считает просроченной и завершённую задачу, если она кончилась позже дедлайна", async () => {
    renderProject(MIXED);

    // Two tasks go past 1 June, and one of them is already done. The overlap with "Finished" is
    // not a broken count: these are answers to different questions, "is it done" and "was it on
    // time".
    expect(await metric("После дедлайна проекта")).toBe("2");
    expect(await metric("Завершено")).toBe("2");
  });

  it("без дедлайна проекта ячейки просрочки нет вовсе", async () => {
    renderProject({ ...MIXED, deadline: null });

    // A zero cell is not shown: "Past the deadline 0" is the norm rather than a summary, and the
    // bar names only what is there.
    const strip = await openSummary();
    expect(await metric("Всего задач")).toBe("5");
    expect(within(strip).queryByText("После дедлайна проекта")).toBeNull();
  });

  it("«Заблокировано» стоит в полосе и при нуле", async () => {
    // The only task is in progress, there are no blocked ones. The cell is in place all the
    // same: its disappearance reads as a vanished counter rather than as "everything is fine".
    renderProject();

    expect(await metric("Заблокировано")).toBe("0");
  });

  it("ноль заблокированных — чёрный: тревогу включает только ненулевой счёт", async () => {
    renderProject();

    const strip = await openSummary();
    const cell = within(strip).getByText("Заблокировано").closest("li");
    expect(cell).not.toHaveClass("is-warn");
  });

  it("ненулевой счёт заблокированных — красный", async () => {
    renderProject(MIXED);

    const strip = await openSummary();
    const cell = within(strip).getByText("Заблокировано").closest("li");
    expect(cell).toHaveClass("is-warn");
  });

  it("считает работу, добавленную сверх согласованного плана", async () => {
    renderProject(APPROVED_WITH_EXTRA);

    expect(await metric("Вне плана")).toBe("1");
  });

  it("у черновика вне плана нет ничего: сравнивать не с чем", async () => {
    renderProject();

    // There is nothing to compare with — the count is zero, and the cell is not shown at all.
    const strip = await openSummary();
    expect(await metric("Всего задач")).toBe("1");
    expect(within(strip).queryByText("Вне плана")).toBeNull();
  });
});
