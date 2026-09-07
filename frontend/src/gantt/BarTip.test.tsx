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
  // Календарный режим: заглушки существующих тестов живут настоящими датами.
  // Относительные проекты собирают своё состояние поверх этого (см. тесты
  // относительной шкалы).
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
 * Лента с карточкой наведения.
 *
 * `onSelectTask` передаётся всегда: с ним полоска — кнопка, а без него
 * картинка, и половина проверок ниже (фокус с клавиатуры) на картинке
 * невозможна в принципе.
 */
function draw(
  options: {
    state?: ProjectState;
    names?: ReadonlyMap<string, string>;
    /** Право двигать полоску: от него зависит строка сочетаний в карточке. */
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
 * Наведение с ожиданием карточки.
 *
 * Ждать приходится по-настоящему: карточка выходит с выдержкой, и без
 * ожидания каждая проверка ниже читала бы пустую ленту.
 */
async function hoverBar() {
  await userEvent.hover(bar());
  return screen.findByTestId("bar-tip");
}

/** Ожидание настоящего времени: выдержку карточки отсчитывает таймер. */
function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Проект с теми же задачами, но с назначенными исполнителями. */
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

    // Перечисления карточка такой ширины не выдержит, а «+2» отвечает на
    // вопрос «одна ли это работа» не хуже трёх имён.
    const tip = await hoverBar();
    expect(tip).toHaveTextContent("Алексей +2");
    expect(tip).not.toHaveTextContent("Мария");
  });

  it("без имён обходится без строки исполнителей, но процент оставляет", async () => {
    // Ровно то, что происходит на публичной странице: состав организации
    // гостю не отдают, и назначенные исполнители остаются безымянными.
    draw({ state: withAssignees("u1", "u2") });

    const tip = await hoverBar();
    expect(tip).not.toHaveTextContent("Алексей");
    expect(tip).toHaveTextContent("40%");
  });

  it("не пишет имён, которых нет в составе", async () => {
    // Ушедший из организации остаётся в `assignee_ids`, но имени у него уже
    // нет: карточка молчит о нём, а не пишет «undefined».
    draw({ state: withAssignees("u9"), names: NAMES });

    expect(await hoverBar()).not.toHaveTextContent("undefined");
  });

  it("гаснет на время жеста и не возвращается под палец сама", async () => {
    draw();

    await hoverBar();

    // Карточка, идущая за курсором, закрывала бы ровно ту сетку дней, по
    // которой человек целится.
    fireEvent.pointerDown(bar(), { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    expect(screen.queryByTestId("bar-tip")).not.toBeInTheDocument();

    fireEvent.pointerMove(bar(), { pointerId: 1, clientX: 160, clientY: 100 });
    expect(screen.queryByTestId("bar-tip")).not.toBeInTheDocument();

    // И после отпускания тоже: указатель всё ещё стоит на полоске, а наведения
    // заново не было.
    fireEvent.pointerUp(bar(), { pointerId: 1, clientX: 160, clientY: 100 });
    expect(screen.queryByTestId("bar-tip")).not.toBeInTheDocument();

    await userEvent.unhover(bar());
    expect(await hoverBar()).toBeInTheDocument();
  });

  it("показывается по фокусу с клавиатуры сразу и прячется, когда фокус ушёл", () => {
    draw();

    // Без выдержки: полоску под фокусом выбрали, а не задели по дороге к
    // соседней, и ждать здесь нечего.
    fireEvent.focus(bar());
    expect(screen.getByTestId("bar-tip")).toBeInTheDocument();

    fireEvent.blur(bar());
    expect(screen.queryByTestId("bar-tip")).not.toBeInTheDocument();
  });

  it("называет сочетания клавиш тому, кто может двигать полоску", async () => {
    // Карточка наведения — единственное место, где человек читает про задачу,
    // ничего не открыв: подсказка про клавиши живёт здесь, а не в справке,
    // которую никто не ищет.
    draw({ canWrite: true });

    const tip = await hoverBar();

    expect(tip).toHaveTextContent("Shift + ←→");
    expect(tip).toHaveTextContent("Esc");
    // Модификатор зовётся так, как он зовётся в этой системе: «Ctrl» на Маке
    // назвал бы клавишу, которая там ничего не отменяет.
    expect(tip).toHaveTextContent(/(Ctrl|⌘)\+Z/);
  });

  it("читателю сочетаний не обещает", async () => {
    draw();

    // Двигать полоску читатель не может, и клавиши обещали бы ему работу,
    // которую сервер отклонит.
    expect(await hoverBar()).not.toHaveTextContent("Shift");
  });

  it("скрыта от чтения с экрана: полоска называет то же самое сама", async () => {
    draw();

    expect(await hoverBar()).toHaveAttribute("aria-hidden", "true");
    // Нативной подсказки у полоски нет: браузерная всплывала бы поверх этой
    // карточки и говорила бы то же самое вторым окном.
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

    // Курсор через полоску, а не на полоску: без выдержки каждая полоска на
    // пути высекала бы по карточке.
    await userEvent.hover(bar());
    await userEvent.unhover(bar());
    await wait(SHOW_DELAY * 2);

    expect(screen.queryByTestId("bar-tip")).not.toBeInTheDocument();
  });

  it("гаснет, когда лента поехала под ней", async () => {
    const { container } = draw();

    await hoverBar();

    // Карточка стоит по координатам окна и за лентой не едет: оставшись
    // висеть, она приписывала бы работу одной задачи другой.
    fireEvent.scroll(container.querySelector(".gantt__scroll")!);
    expect(screen.queryByTestId("bar-tip")).not.toBeInTheDocument();
  });

  it("переворачивается у нижнего края по своей настоящей высоте", async () => {
    // Высота — измеренная, а не взятая из головы: у задачи с длинным именем
    // карточка выше, и по числу из кода она у низа окна не переворачивалась
    // бы, а обрезалась.
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
    // Нативной подсказки у полоски нет: браузерная всплывала бы поверх этой
    // карточки и говорила бы то же самое вторым окном.
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
