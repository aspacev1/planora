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

/** Полоска задачи по её названию: она объявлена кнопкой с именем и датами. */
async function bar(name: RegExp | string) {
  return screen.findByRole("button", { name });
}

/** Ручка внутри полоски: грани и заливка скрыты от чтения с экрана. */
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

    // Задача идёт со среды 4 марта пять рабочих дней — по вторник 10-го
    // (в календаре оснастки 20-е выходное, но оно дальше). Тянем конец на
    // два дня вправо: до четверга 12-го, то есть на семь рабочих дней.
    drag(grip(logo, "end"), { fromX: 300, toX: 300 + 2 * DAY_WIDTH.day });

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toMatchObject({ type: "set_duration", task_id: "t1", duration_days: 7 });
  });

  it("левая грань двигает начало и меняет длительность одной операцией", async () => {
    const sent = captureMutations();
    renderProject();
    const logo = await bar(/Логотип/);

    // Начало уезжает на день влево — конец остаётся на месте, значит задача
    // становится длиннее ровно на этот день (3 марта — вторник, рабочий).
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

    // Левую грань тащат далеко за правую: полоска упирается в один день, а не
    // выворачивается наизнанку.
    drag(grip(logo, "start"), { fromX: 100, toX: 100 + 40 * DAY_WIDTH.day });

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toMatchObject({ type: "resize_task", duration_days: 1 });
  });

  it("не отправляет ничего, если грань вернули на место", async () => {
    const sent = captureMutations();
    renderProject();
    const logo = await bar(/Логотип/);

    drag(grip(logo, "end"), { fromX: 300, toX: 312 }); // меньше половины дня

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

    // fireEvent отдаёт false, когда обработчик отменил умолчание. Проверка не
    // формальная: ручка — `span` внутри полоски, и без отмены браузер считает
    // нажатие на неё началом выделения. Живая проверка показала жест, который
    // вместо растягивания полоски подсвечивал названия соседних задач и не
    // отправлял ничего вовсе.
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

    // Полоска занимает семь календарных дней (4–10 марта), сорок процентов
    // из них уже залито. Тянем границу до семидесяти — числа считаются из
    // ширины дня, а не записаны литералами: масштаб по умолчанию однажды
    // сменится, и тест обязан проверять процент, а не масштаб.
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
    // Запланированная задача заливки не рисует: процент лёг бы в поле, а на
    // полоске не отразился, и жест выглядел бы сорвавшимся.
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
  /** Кружок на краю полоски. Скрыт от чтения с экрана — ищем по классу. */
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
   * Связь тянут указателем, а цель ищут попаданием в точку: `elementFromPoint`
   * в jsdom не работает, поэтому его подменяет строка, названная тестом.
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
    expect(days()).toBe(122); // март — июнь: окно заглушки кончается 30 июня

    fireEvent.pointerDown(span(), { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(span(), { pointerId: 1, clientX: 100 + 130 * DAY_WIDTH.day });
    // Конец этапа пришёлся на 25 июля — окно доросло до его конца: этап, как
    // и полоска, не должен выезжать за сетку в пустоту без дат.
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
    // Задача идёт с 4 марта; конец 12-го — это семь рабочих дней (7-е и 8-е
    // выходные). Записать дату окончания напрямую нельзя, и ячейка переводит
    // названный день в длительность тем же счётом, что и правая грань.
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

    expect(container.querySelector("svg.arrows polyline")).toHaveClass("is-critical");
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
});
