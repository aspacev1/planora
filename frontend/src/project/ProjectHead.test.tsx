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
 * Цифра в ячейке сводки плана.
 *
 * Ищется от подписи, а не от числа: чисел на экране много, и «1» нашлось бы
 * в первой попавшейся. Поиск ограничен самой сводкой — те же слова стоят и в
 * легенде диаграммы, и в карточке задачи.
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

    // Срок — от самого раннего старта до посчитанного сервером окончания, а не
    // до конца последней задачи: окончание бывает позже её.
    await openSummary();
    expect(screen.getByText("4 марта — 8 июня")).toBeInTheDocument();
  });

  it("проект без задач срока не выдумывает", async () => {
    renderProject({ ...STATE, tasks: [], project_end: null });

    // Срока у такого проекта нет — панель начинается сразу с метрик.
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
    // Даты совпадают с базовым планом: расхождению взяться неоткуда, и
    // пометка о нём была бы ложной тревогой.
    expect(screen.queryByText(/изменен/i)).toBeNull();
  });

  it("бейдж плана называет своё состояние, а не только текст", async () => {
    // Черновик и согласованный план различаются цветом бейджа, и цвет тема
    // берёт из `data-state`: без него оба остались бы янтарными — то есть
    // согласованный план всё время требовал бы внимания.
    renderProject();
    expect(await screen.findByText("План проекта · черновик")).toHaveAttribute(
      "data-state",
      "draft",
    );

    renderProject(APPROVED);
    expect(await screen.findByText("План проекта · v1")).toHaveAttribute("data-state", "approved");
  });

  it("состояние плана стоит в строке названия, а не хвостом за сводкой", async () => {
    renderProject(APPROVED);

    // Проверяется именно место: расхождение с согласованным планом читают
    // вместе с именем проекта, а не среди цифр сводки над лентой.
    const label = await screen.findByText("План проекта · v1");
    expect(label.closest(".project-bar")).not.toBeNull();
    expect(label.closest(".plan-summary")).toBeNull();
  });

  it("публикация убрана под «⋯»: её открывают редко", async () => {
    renderProject();

    // В строке шапки её нет — ярус растёт от каждой постоянной кнопки, и
    // именно так он вырос в прошлый раз.
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
    // Две задачи уехали от базового плана, третья стоит на месте: число
    // отвечает на «насколько всё серьёзно» до того, как список открыт.
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
    // Иначе число зависело бы от того, сколько раз задачу трогали, и росло бы
    // там, где расходится с планом всё та же одна строка.
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

    // Кнопка, а не набор: за пометкой есть куда пойти, и это должно быть видно
    // до нажатия — иначе список остаётся никому не известным.
    expect(await screen.findByRole("button", { name: /1 изменение после v1/ })).toBeInTheDocument();
  });
});

/**
 * Пять задач, разложенных по всем четырём статусам, при дедлайне 1 июня.
 *
 * Две уходят за дедлайн, и одна из них — завершённая: пересечение «Завершено»
 * и «После дедлайна проекта» заложено в оснастку нарочно, иначе тест на него
 * проверял бы отсутствие пересечения, а не его.
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

    // Две задачи уходят за 1 июня, и одна из них уже готова. Пересечение с
    // «Завершено» — не сбой счёта: это ответы на разные вопросы, «сделано ли»
    // и «в срок ли».
    expect(await metric("После дедлайна проекта")).toBe("2");
    expect(await metric("Завершено")).toBe("2");
  });

  it("без дедлайна проекта ячейки просрочки нет вовсе", async () => {
    renderProject({ ...MIXED, deadline: null });

    // Нулевая ячейка не показывается: «После дедлайна 0» — норма, а не сводка,
    // и полоса называет только то, что есть.
    const strip = await openSummary();
    expect(await metric("Всего задач")).toBe("5");
    expect(within(strip).queryByText("После дедлайна проекта")).toBeNull();
  });

  it("«Заблокировано» стоит в полосе и при нуле", async () => {
    // Единственная задача — в работе, заблокированных нет. Ячейка всё равно
    // на месте: её исчезновение читается как пропавший счётчик, а не как
    // «всё хорошо».
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

    // Сравнивать не с чем — счёт нулевой, и ячейка не показывается вовсе.
    const strip = await openSummary();
    expect(await metric("Всего задач")).toBe("1");
    expect(within(strip).queryByText("Вне плана")).toBeNull();
  });
});
