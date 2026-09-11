import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { drag } from "../test/pointer";
import {
  STATE,
  TWO_TASKS,
  WITH_CRITICAL_PATH,
  WITH_MILESTONE,
  captureMutations,
  projectFixtures,
  renderProject,
} from "../test/project";
import { DAY_WIDTH } from "./scale";

beforeEach(projectFixtures);

/** A task's bar by its name: it is declared a button with a name and dates. */
async function bar(name: RegExp | string) {
  return screen.findByRole("button", { name });
}

/** A grip inside the bar: the edges and the fill are hidden from screen readers. */
function grip(element: HTMLElement, kind: "start" | "end" | "progress"): HTMLElement {
  const found = element.querySelector<HTMLElement>(`.gantt__grip--${kind}`);
  if (found === null) throw new Error(`у полоски нет ручки «${kind}»`);
  return found;
}

describe("грани полоски", () => {
  it("правая грань меняет длительность, не трогая начала", async () => {
    const sent = captureMutations();
    renderProject();
    const logo = await bar(/Логотип/);

    // The task runs from Wednesday 4 March for five working days — through Tuesday the 10th (in
    // the fixture's calendar the 20th is a day off, but that is further on). We drag the end two
    // days to the right: to Thursday the 12th, that is, to seven working days.
    drag(grip(logo, "end"), { fromX: 300, toX: 300 + 2 * DAY_WIDTH.day });

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toMatchObject({ type: "set_duration", task_id: "t1", duration_days: 7 });
  });

  it("левая грань двигает начало и меняет длительность одной операцией", async () => {
    const sent = captureMutations();
    renderProject();
    const logo = await bar(/Логотип/);

    // The start travels a day to the left — the end stays put, which means the task becomes
    // longer by exactly that day (3 March is a Tuesday, a working day).
    drag(grip(logo, "start"), { fromX: 100, toX: 100 - DAY_WIDTH.day });

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toMatchObject({
      type: "resize_task",
      task_id: "t1",
      start_date: "2026-03-03",
      duration_days: 6,
    });
  });

  it("не даёт схлопнуть полоску короче дня", async () => {
    const sent = captureMutations();
    renderProject();
    const logo = await bar(/Логотип/);

    // The left edge is dragged far past the right one: the bar runs into one day rather than
    // turning itself inside out.
    drag(grip(logo, "start"), { fromX: 100, toX: 100 + 40 * DAY_WIDTH.day });

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toMatchObject({ type: "resize_task", duration_days: 1 });
  });

  it("не отправляет ничего, если грань вернули на место", async () => {
    const sent = captureMutations();
    renderProject();
    const logo = await bar(/Логотип/);

    drag(grip(logo, "end"), { fromX: 300, toX: 312 }); // less than half a day

    expect(sent).toHaveLength(0);
  });

  it("нажатие на грань не начинает перенос всей полоски", async () => {
    const sent = captureMutations();
    renderProject();
    const logo = await bar(/Логотип/);

    drag(grip(logo, "end"), { fromX: 300, toX: 300 + 2 * DAY_WIDTH.day });

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent.map((one) => one.op.type)).not.toContain("move_task");
  });

  it("нажатие на грань не начинает выделение текста", async () => {
    renderProject();
    const logo = await bar(/Логотип/);

    // fireEvent returns false when a handler prevented the default. The check is not a
    // formality: a grip is a `span` inside the bar, and without preventing it the browser treats
    // a press on it as the start of a selection. Live testing showed a gesture that highlighted
    // neighbouring task names instead of stretching the bar and sent nothing at all.
    const allowed = fireEvent.pointerDown(grip(logo, "end"), {
      pointerId: 1,
      button: 0,
      clientX: 300,
    });

    expect(allowed).toBe(false);
  });

  it("гость граней не получает", async () => {
    renderProject(STATE, { canWrite: false });
    const logo = await screen.findByRole("button", { name: /Логотип/ });

    expect(logo.querySelector(".gantt__grip--start")).toBeNull();
    expect(logo.querySelector(".gantt__grip--end")).toBeNull();
  });
});

describe("заливка выполненного", () => {
  it("тянется до процента с шагом в пять", async () => {
    const sent = captureMutations();
    renderProject();
    const logo = await bar(/Логотип/);

    // The bar takes seven calendar days (4–10 March), forty percent of which is already filled.
    // We drag the boundary to seventy — the numbers are computed from a day's width rather than
    // written as literals: the default scale will change one day, and the test must check the
    // percentage rather than the scale.
    const width = 7 * DAY_WIDTH.day;
    drag(grip(logo, "progress"), { fromX: width * 0.4, toX: width * 0.7 });

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toMatchObject({ type: "set_progress", task_id: "t1", progress_pct: 70 });
  });

  it("не уходит за сто процентов", async () => {
    const sent = captureMutations();
    renderProject();
    const logo = await bar(/Логотип/);

    const filled = 7 * DAY_WIDTH.day * 0.4;
    drag(grip(logo, "progress"), { fromX: filled, toX: filled + 20 * DAY_WIDTH.day });

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toMatchObject({ type: "set_progress", progress_pct: 100 });
  });

  it("не появляется там, где заливки не видно", async () => {
    // A planned task draws no fill: the percentage would land in the field but not show on the
    // bar, and the gesture would look as if it had failed.
    renderProject(WITH_MILESTONE);
    const planned = await bar(/Сдача/);

    expect(planned.querySelector(".gantt__grip--progress")).toBeNull();
  });
});

describe("вехи", () => {
  it("рисуются ромбом и не имеют граней", async () => {
    renderProject(WITH_MILESTONE);
    const milestone = await bar(/Сдача/);

    expect(milestone).toHaveClass("gantt__bar--milestone");
    expect(milestone.querySelector(".gantt__diamond")).not.toBeNull();
    expect(milestone.querySelector(".gantt__grip--start")).toBeNull();
    expect(milestone.querySelector(".gantt__grip--end")).toBeNull();
  });

  it("занимают на шкале один день, а не длительность", async () => {
    renderProject(WITH_MILESTONE);
    const milestone = await bar(/Сдача/);

    expect(milestone.style.getPropertyValue("--bar-w")).toBe(`${DAY_WIDTH.day}px`);
  });

  it("двигаются по шкале, как обычная задача", async () => {
    const sent = captureMutations();
    renderProject(WITH_MILESTONE);
    const milestone = await bar(/Сдача/);

    drag(milestone, { fromX: 100, toX: 100 + 3 * DAY_WIDTH.day });

    await waitFor(() =>
      expect(sent[0].op).toMatchObject({ type: "move_task", start_date: "2026-03-19" }),
    );
  });
});

describe("связь перетаскиванием", () => {
  /** The circle at a bar's edge. Hidden from screen readers — we look it up by class. */
  function dot(row: HTMLElement, side: "start" | "end"): HTMLElement {
    const found = row.querySelector<HTMLElement>(`.gantt__link-dot--${side}`);
    if (found === null) throw new Error(`у строки нет кружка «${side}»`);
    return found;
  }

  function rowOf(taskId: string): HTMLElement {
    const found = document.querySelector<HTMLElement>(`[data-drop-id="${taskId}"]`);
    if (found === null) throw new Error(`строки ${taskId} нет`);
    return found;
  }

  /**
   * A link is dragged with the pointer while the target is found by hit-testing a point:
   * `elementFromPoint` does not work in jsdom, so a row named by the test stands in for it.
   */
  function dropOn(handle: HTMLElement, target: HTMLElement) {
    const original = document.elementFromPoint;
    document.elementFromPoint = () => target;
    try {
      fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 100, clientY: 20 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300, clientY: 70 });
      fireEvent.pointerUp(handle, { pointerId: 1, clientX: 300, clientY: 70 });
    } finally {
      document.elementFromPoint = original;
    }
  }

  it("от конца первой полоски к второй: первая блокирует вторую", async () => {
    const sent = captureMutations();
    renderProject(TWO_TASKS);
    await bar(/Логотип/);

    dropOn(dot(rowOf("t1"), "end"), rowOf("t2"));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toMatchObject({
      type: "add_dependency",
      from_task_id: "t1",
      to_task_id: "t2",
    });
  });

  it("от начала второй полоски к первой: направление то же, жест обратный", async () => {
    const sent = captureMutations();
    renderProject(TWO_TASKS);
    await bar(/Макет/);

    dropOn(dot(rowOf("t2"), "start"), rowOf("t1"));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toMatchObject({
      type: "add_dependency",
      from_task_id: "t1",
      to_task_id: "t2",
    });
  });

  it("бросок на саму себя ничего не отправляет", async () => {
    const sent = captureMutations();
    renderProject(TWO_TASKS);
    await bar(/Логотип/);

    dropOn(dot(rowOf("t1"), "end"), rowOf("t1"));

    expect(sent).toHaveLength(0);
  });

  it("отпускание мимо кружка снимает связь с руки", async () => {
    const sent = captureMutations();
    renderProject(TWO_TASKS);
    await bar(/Логотип/);
    const handle = dot(rowOf("t1"), "end");

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 100, clientY: 20 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300, clientY: 70 });
    expect(document.querySelector(".is-linking")).not.toBeNull();

    // The circle disappeared along with the row — the release goes to the window. Without this
    // the line would hang after the cursor, and the scroll frame would spin until the next press.
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 300, clientY: 70 });

    expect(document.querySelector(".is-linking")).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("гостю кружков не показывают", async () => {
    renderProject(TWO_TASKS, { canWrite: false });
    await screen.findByRole("button", { name: /Логотип/ });

    expect(document.querySelector(".gantt__link-dot")).toBeNull();
  });
});

describe("перенос категории", () => {
  function span(): HTMLElement {
    const found = document.querySelector<HTMLElement>(".gantt__span");
    if (found === null) throw new Error("сводной полосы категории нет");
    return found;
  }

  it("сдвигает весь этап одной операцией", async () => {
    const sent = captureMutations();
    renderProject(TWO_TASKS);
    await bar(/Логотип/);

    drag(span(), { fromX: 100, toX: 100 + 4 * DAY_WIDTH.day });

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toMatchObject({ type: "move_category", category_id: "c1", days: 4 });
  });

  it("окно дотягивается и за полосой категории", async () => {
    renderProject(TWO_TASKS);
    await bar(/Логотип/);
    const days = () => document.querySelectorAll(".gantt__grid-day").length;
    expect(days()).toBe(122); // March to June: the fixture's window ends on 30 June

    fireEvent.pointerDown(span(), { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(span(), { pointerId: 1, clientX: 100 + 130 * DAY_WIDTH.day });
    // The stage's end landed on 25 July — the window grew to its end: a stage, like a bar, must
    // not run past the grid into emptiness with no dates.
    expect(days()).toBe(153);

    fireEvent.pointerUp(span(), { pointerId: 1, clientX: 100 + 130 * DAY_WIDTH.day });
  });

  it("не отправляет ничего на сдвиг меньше половины деления", async () => {
    const sent = captureMutations();
    renderProject(TWO_TASKS);
    await bar(/Логотип/);

    drag(span(), { fromX: 100, toX: 120 });

    expect(sent).toHaveLength(0);
  });

  it("у гостя не тащится", async () => {
    renderProject(TWO_TASKS, { canWrite: false });
    await screen.findByRole("button", { name: /Логотип/ });

    expect(span()).not.toHaveClass("is-draggable");
  });
});

describe("колонки таблицы", () => {
  it("показывает начало и окончание рядом с названием", async () => {
    renderProject();
    const row = await screen.findByText("Логотип");
    const cells = row.closest(".gantt__row") as HTMLElement;

    expect(within(cells).getByText("4 марта")).toBeInTheDocument();
    expect(within(cells).getByText("10 марта")).toBeInTheDocument();
  });

  it("правит начало прямо в ячейке", async () => {
    const sent = captureMutations();
    renderProject();
    const row = (await screen.findByText("Логотип")).closest(".gantt__row") as HTMLElement;

    fireEvent.click(within(row).getByText("4 марта"));
    const input = within(row).getByLabelText(/Начало/);
    fireEvent.change(input, { target: { value: "2026-03-09" } });
    fireEvent.blur(input);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toMatchObject({ type: "move_task", start_date: "2026-03-09" });
  });

  it("правит окончание длительностью: саму дату считает сервер", async () => {
    const sent = captureMutations();
    renderProject();
    const row = (await screen.findByText("Логотип")).closest(".gantt__row") as HTMLElement;

    fireEvent.click(within(row).getByText("10 марта"));
    const input = within(row).getByLabelText(/Окончание/);
    // The task runs from 4 March; the 12th as the end is seven working days (the 7th and 8th are
    // days off). The end date cannot be written directly, and the cell converts the named day
    // into a duration by the same reckoning as the right edge.
    fireEvent.change(input, { target: { value: "2026-03-12" } });
    fireEvent.blur(input);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toMatchObject({ type: "set_duration", duration_days: 7 });
  });

  it("окончание вехи не правится: длительности у неё нет", async () => {
    renderProject(WITH_MILESTONE);
    const row = (await screen.findByText("Сдача")).closest(".gantt__row") as HTMLElement;

    fireEvent.click(within(row).getAllByText("16 марта")[1]);

    expect(within(row).queryByLabelText(/Окончание/)).not.toBeInTheDocument();
  });

  it("на относительной оси день меньше первого не отправляется", async () => {
    const sent = captureMutations();
    renderProject({
      ...STATE,
      schedule_mode: "relative",
      project_end: "2001-01-12",
      tasks: [
        { ...STATE.tasks[0], start_date: "2001-01-03", end_date: "2001-01-12", duration_days: 8 },
      ],
    });
    const row = (await bar(/Логотип/)).closest(".gantt__row") as HTMLElement;

    // The start is "Day 3"; zero and minus are not a project day but the middle of typing.
    fireEvent.click(within(row).getByText("День 3"));
    const input = within(row).getByLabelText(/Начало/);
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    expect(sent).toHaveLength(0);

    fireEvent.click(within(row).getByText("День 3"));
    const again = within(row).getByLabelText(/Начало/);
    fireEvent.change(again, { target: { value: "2" } });
    fireEvent.blur(again);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toMatchObject({ type: "move_task", start_date: "2001-01-02" });
  });

  it("у гостя ячейки не открываются полем", async () => {
    renderProject(STATE, { canWrite: false });
    const row = (await screen.findByText("Логотип")).closest(".gantt__row") as HTMLElement;

    fireEvent.click(within(row).getByText("4 марта"));

    expect(within(row).queryByLabelText(/Начало/)).not.toBeInTheDocument();
  });
});

describe("критический путь", () => {
  it("по умолчанию не рисуется: слой включают в «Виде»", async () => {
    const { container } = renderProject(WITH_CRITICAL_PATH);
    await bar(/Логотип/);

    expect(container.querySelector(".gantt")).not.toHaveClass("show-critical");
  });

  it("включённый помечает задачи без запаса и не трогает остальные", async () => {
    renderProject(WITH_CRITICAL_PATH);
    await bar(/Логотип/);

    await userEvent.click(screen.getByRole("button", { name: "Вид" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Критический путь" }));

    expect(await bar(/Логотип/)).toHaveAttribute("data-critical");
    expect(await bar(/Макет/)).toHaveAttribute("data-critical");
    expect(await bar(/Сбоку/)).not.toHaveAttribute("data-critical");
  });

  it("звено между двумя критическими задачами — тоже критическое", async () => {
    const { container } = renderProject(WITH_CRITICAL_PATH);
    await bar(/Логотип/);

    expect(container.querySelector("svg.arrows .arrows__line")).toHaveClass("is-critical");
  });
});

describe("клавиатура", () => {
  it("Alt со стрелкой растягивает конец задачи", async () => {
    const sent = captureMutations();
    renderProject();
    const logo = await bar(/Логотип/);

    logo.focus();
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toMatchObject({ type: "set_duration", duration_days: 6 });
  });

  it("Shift с Alt двигает начало, не трогая конца", async () => {
    const sent = captureMutations();
    renderProject();
    const logo = await bar(/Логотип/);

    logo.focus();
    await userEvent.keyboard("{Shift>}{Alt>}{ArrowLeft}{/Alt}{/Shift}");

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toMatchObject({
      type: "resize_task",
      start_date: "2026-03-03",
      duration_days: 6,
    });
  });

  it("не даёт укоротить задачу короче дня", async () => {
    const sent = captureMutations();
    renderProject({
      ...STATE,
      tasks: [{ ...STATE.tasks[0], duration_days: 1, end_date: "2026-03-04" }],
    });
    const logo = await bar(/Логотип/);

    logo.focus();
    await userEvent.keyboard("{Alt>}{ArrowLeft}{/Alt}");

    expect(sent).toHaveLength(0);
  });

  it("у вехи граней нет и с клавиатуры", async () => {
    const sent = captureMutations();
    renderProject(WITH_MILESTONE);
    const milestone = await bar(/Сдача/);

    milestone.focus();
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");

    expect(sent).toHaveLength(0);
  });

  it("Alt со стрелкой на вехе не уводит со страницы, хоть и ничего не тянет", async () => {
    renderProject(WITH_MILESTONE);
    const milestone = await bar(/Сдача/);

    // Alt+← is the browser's "back in history". A combination learned on ordinary bars must at
    // least stay silent on a milestone rather than close the project.
    const kept = fireEvent.keyDown(milestone, { key: "ArrowLeft", altKey: true });

    expect(kept).toBe(false);
  });
});
