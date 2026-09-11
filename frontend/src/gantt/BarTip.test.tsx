import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { ProjectState, Task } from "../api/projects";
import { renderWithProviders } from "../test/utils";
import { GAP, SHOW_DELAY } from "./BarTip";
import { Gantt } from "./Gantt";

const TASK: Task = {
  id: "t1",
  category_id: "c1",
  name: "Логотип",
  start_date: "2026-03-04",
  end_date: "2026-03-10",
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
  baseline_start: null,
  baseline_duration: null,
  baseline_end: null,
};

const STATE: ProjectState = {
  id: "p1",
  name: "Редизайн",
  slug: "redizayn",
  deadline: null,
  project_end: null,
  plan_approved_at: null,
  plan_version: 0,
  undoable: null,
  // Calendar mode: the existing tests' fixtures live on real dates. Relative projects
  // build their own state on top of this (see the relative-scale tests).
  schedule_mode: "calendar" as const,
  start_date: null,

  calendar: { working_days: 31, holidays: [], extra_workdays: [] },
  categories: [{ id: "c1", name: "Дизайн", color: "#3b82f6", position: 0 }],
  tasks: [TASK],
  dependencies: [],
};

const NAMES = new Map([
  ["u1", "Алексей"],
  ["u2", "Мария"],
  ["u3", "Нигяр"],
]);

/**
 * The strip with the hover card.
 *
 * `onSelectTask` is always passed: with it the bar is a button, without it a picture, and
 * half the checks below (keyboard focus) are impossible on a picture in principle.
 */
function draw(
  options: {
    state?: ProjectState;
    names?: ReadonlyMap<string, string>;
    /** The right to move the bar: the shortcuts line in the card depends on it. */
    canWrite?: boolean;
  } = {},
) {
  return renderWithProviders(
    <Gantt
      projectId="p1"
      state={options.state ?? STATE}
      assigneeNames={options.names}
      canWrite={options.canWrite}
      onSelectTask={() => {}}
    />,
    { locale: "ru" },
  );
}

function bar() {
  return screen.getByRole("button", { name: /Логотип/ });
}

/**
 * Hovering with a wait for the card.
 *
 * The wait has to be real: the card comes out after a delay, and without waiting every
 * check below would read an empty strip.
 */
async function hoverBar() {
  await userEvent.hover(bar());
  return screen.findByTestId("bar-tip");
}

/** Waiting on real time: the card's delay is counted by a timer. */
function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The same project with the same tasks, but with assignees. */
function withAssignees(...ids: string[]): ProjectState {
  return { ...STATE, tasks: [{ ...TASK, assignee_ids: ids }] };
}

describe("карточка наведения на полоску", () => {
  it("называет статус, даты и готовность", async () => {
    draw();

    const tip = await hoverBar();

    expect(tip).toHaveTextContent("Логотип");
    expect(tip).toHaveTextContent("В работе");
    expect(tip).toHaveTextContent("4 мар → 10 мар");
    expect(tip).toHaveTextContent("40%");
  });

  it("исчезает, когда курсор ушёл с полоски", async () => {
    draw();

    await hoverBar();

    await userEvent.unhover(bar());
    expect(screen.queryByTestId("bar-tip")).not.toBeInTheDocument();
  });

  it("предупреждает знаком о заблокированной задаче", async () => {
    draw({ state: { ...STATE, tasks: [{ ...TASK, status: "blocked" }] } });

    expect(await hoverBar()).toHaveTextContent("⚠ Заблокировано");
  });

  it("одного исполнителя зовёт по имени", async () => {
    draw({ state: withAssignees("u1"), names: NAMES });

    expect(await hoverBar()).toHaveTextContent("Алексей");
  });

  it("нескольких сводит к первому и счётчику остальных", async () => {
    draw({ state: withAssignees("u1", "u2", "u3"), names: NAMES });

    // A card this wide will not take an enumeration, and "+2" answers the question "is this
    // one person's work" no worse than three names.
    const tip = await hoverBar();
    expect(tip).toHaveTextContent("Алексей +2");
    expect(tip).not.toHaveTextContent("Мария");
  });

  it("без имён обходится без строки исполнителей, но процент оставляет", async () => {
    // Exactly what happens on the public page: the organization's roster is not given to a
    // guest, and the assignees stay nameless.
    draw({ state: withAssignees("u1", "u2") });

    const tip = await hoverBar();
    expect(tip).not.toHaveTextContent("Алексей");
    expect(tip).toHaveTextContent("40%");
  });

  it("не пишет имён, которых нет в составе", async () => {
    // Someone who has left the organization stays in `assignee_ids` but no longer has a
    // name: the card stays silent about them rather than writing "undefined".
    draw({ state: withAssignees("u9"), names: NAMES });

    expect(await hoverBar()).not.toHaveTextContent("undefined");
  });

  it("гаснет на время жеста и не возвращается под палец сама", async () => {
    draw();

    await hoverBar();

    // A card following the cursor would cover the very grid of days the person is aiming at.
    fireEvent.pointerDown(bar(), { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    expect(screen.queryByTestId("bar-tip")).not.toBeInTheDocument();

    fireEvent.pointerMove(bar(), { pointerId: 1, clientX: 160, clientY: 100 });
    expect(screen.queryByTestId("bar-tip")).not.toBeInTheDocument();

    // And after the release too: the pointer is still on the bar, and there was no fresh
    // hover.
    fireEvent.pointerUp(bar(), { pointerId: 1, clientX: 160, clientY: 100 });
    expect(screen.queryByTestId("bar-tip")).not.toBeInTheDocument();

    await userEvent.unhover(bar());
    expect(await hoverBar()).toBeInTheDocument();
  });

  it("показывается по фокусу с клавиатуры сразу и прячется, когда фокус ушёл", () => {
    draw();

    // Without a delay: a bar under focus was chosen rather than brushed on the way to a
    // neighbouring one, and there is nothing to wait for here.
    fireEvent.focus(bar());
    expect(screen.getByTestId("bar-tip")).toBeInTheDocument();

    fireEvent.blur(bar());
    expect(screen.queryByTestId("bar-tip")).not.toBeInTheDocument();
  });

  it("называет сочетания клавиш тому, кто может двигать полоску", async () => {
    // The hover card is the only place where a person reads about a task without opening
    // anything: the hint about the keys lives here rather than in a help page nobody looks for.
    draw({ canWrite: true });

    const tip = await hoverBar();

    expect(tip).toHaveTextContent("Shift + ←→");
    expect(tip).toHaveTextContent("Esc");
    // The modifier is called what it is called on this system: "Ctrl" on a Mac would name a
    // key that cancels nothing there.
    expect(tip).toHaveTextContent(/(Ctrl|⌘)\+Z/);
  });

  it("читателю сочетаний не обещает", async () => {
    draw();

    // A reader cannot move the bar, and the keys would promise them work the server will reject.
    expect(await hoverBar()).not.toHaveTextContent("Shift");
  });

  it("скрыта от чтения с экрана: полоска называет то же самое сама", async () => {
    draw();

    expect(await hoverBar()).toHaveAttribute("aria-hidden", "true");
    // The bar has no native tooltip: the browser's would pop up on top of this card and say
    // the same thing in a second window.
    expect(bar()).not.toHaveAttribute("title");
    expect(bar()).toHaveAccessibleName("Логотип, 4 марта — 10 марта");
  });

  it("под курсором не появляется сразу", async () => {
    draw();

    await userEvent.hover(bar());

    expect(screen.queryByTestId("bar-tip")).not.toBeInTheDocument();
  });

  it("не оставляет вспышки за курсором, прошедшим ленту насквозь", async () => {
    draw();

    // The cursor goes across the bar rather than onto it: without a delay every bar on the
    // way would strike a card.
    await userEvent.hover(bar());
    await userEvent.unhover(bar());
    await wait(SHOW_DELAY * 2);

    expect(screen.queryByTestId("bar-tip")).not.toBeInTheDocument();
  });

  it("гаснет, когда лента поехала под ней", async () => {
    const { container } = draw();

    await hoverBar();

    // The card stands by window coordinates and does not travel with the strip: left
    // hanging, it would attribute one task's work to another.
    fireEvent.scroll(container.querySelector(".gantt__scroll")!);
    expect(screen.queryByTestId("bar-tip")).not.toBeInTheDocument();
  });

  it("переворачивается у нижнего края по своей настоящей высоте", async () => {
    // The height is measured rather than taken out of thin air: a task with a long name has
    // a taller card, and by a number from the code it would be cut off at the bottom of the
    // window rather than flipped.
    const height = 200;
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => height,
    });

    try {
      draw();
      await userEvent.hover(bar());
      fireEvent.pointerMove(bar(), { pointerId: 1, clientX: 100, clientY: 700 });

      const tip = await screen.findByTestId("bar-tip");
      expect(tip).toHaveStyle({ top: `${700 - GAP - height}px` });
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
    }
  });

  it("скрыта от чтения с экрана: полоска называет то же самое сама", async () => {
    draw();

    expect(await hoverBar()).toHaveAttribute("aria-hidden", "true");
    // The bar has no native tooltip: the browser's would pop up on top of this card and say
    // the same thing in a second window.
    expect(bar()).not.toHaveAttribute("title");
    expect(bar()).toHaveAccessibleName("Логотип, 4 марта — 10 марта");
  });
});

describe("флаг риска на полоске", () => {
  it("рисует точку и называет риск с причиной в карточке, у «сделано» — нет", async () => {
    const flagged: ProjectState = {
      ...STATE,
      tasks: [{ ...TASK, risk: "yellow", risk_note: "жду доступ к API" }],
    };
    draw({ state: flagged });
    expect(screen.getByTestId("bar-t1")).toHaveAttribute("data-risk", "yellow");

    const tip = await hoverBar();
    expect(tip).toHaveTextContent("Риск: Есть риск — жду доступ к API");
  });

  it("у сделанной задачи флаг — уже история, не сигнал", () => {
    const done: ProjectState = {
      ...STATE,
      tasks: [{ ...TASK, status: "done", progress_pct: 100, risk: "red" }],
    };
    draw({ state: done });
    expect(screen.getByTestId("bar-t1")).not.toHaveAttribute("data-risk");
  });
});
