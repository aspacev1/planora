import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import type { ProjectState } from "../api/projects";
import { STATE, projectFixtures, renderProject } from "../test/project";

beforeEach(() => {
  projectFixtures();
  localStorage.clear();
});

async function tape(): Promise<HTMLElement> {
  await screen.findByRole("heading", { name: "Редизайн" });
  const box = document.querySelector<HTMLElement>(".gantt__scroll");
  if (box === null) throw new Error("ленты нет");
  return box;
}

/**
 * jsdom раскладку не считает, и scrollTop у него всегда ноль — значение
 * подставляется руками, как высота окна в тестах useViewportFit. Событие
 * обязательно: без него лента о прокрутке не узнает.
 */
function scrollTapeTo(box: HTMLElement, top: number) {
  Object.defineProperty(box, "scrollTop", { value: top, configurable: true });
  fireEvent.scroll(box);
}

const bar = () => document.querySelector<HTMLElement>(".project-bar");
const summary = () => document.querySelector<HTMLElement>(".plan-summary");

describe("шапка проекта одной строкой", () => {
  it("наверху плана уже показывает всё: имя, вкладки и сводку", async () => {
    renderProject();
    await tape();

    // Ничего прокручивать не нужно — это и есть суть перестройки: прежде
    // сводка появлялась строкой только после прокрутки ленты на 32 пикселя,
    // а до того над лентой стояли четыре яруса во весь рост.
    const row = bar();
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByRole("heading", { name: "Редизайн" })).
      toBeInTheDocument();
    expect(within(row as HTMLElement).getByRole("link", { name: "История" })).
      toBeInTheDocument();

    // Сводка — уголком у имени: постоянного места семи цифрам в этой строке
    // нет, а раскрывается она тем же счётом, что была полоса карточек.
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Сводка по проекту" }));
    expect(summary()).toHaveTextContent("Всего задач");
  });

  it("прокрутка ленты шапку больше не двигает", async () => {
    renderProject();
    const box = await tape();
    const before = bar()?.className;

    scrollTapeTo(box, 60);

    // Ни складывания, ни подмены на сжатую строку: состояние одно, и прыжка
    // содержимого на пороге больше нет.
    expect(bar()?.className).toBe(before);
    expect(document.querySelector(".project-fold")).toBeNull();
    expect(document.querySelector(".project-head-compact")).toBeNull();
    expect(screen.getByRole("heading", { name: "Редизайн" })).toBeInTheDocument();
  });

  it("редкие действия убраны под «⋯», а не стоят в строке", async () => {
    renderProject();
    await tape();

    // В самой строке их нет — иначе ярус снова растёт от каждой новой кнопки.
    expect(screen.queryByRole("button", { name: "Экспорт" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Ещё действия" }));

    // Ищем внутри самой строки: слово «Настройки» есть и в колонке
    // приложения, но там это настройки рабочего пространства, а не проекта.
    const row = within(bar() as HTMLElement);
    expect(row.getByRole("button", { name: "Экспорт" })).toBeInTheDocument();
    expect(row.getByRole("link", { name: /Настройки/ })).toBeInTheDocument();
  });

  it("согласование остаётся в строке: это не редкое действие", async () => {
    renderProject();
    await tape();

    // Состояние плана и кнопка при нём — то, ради чего в проект возвращаются;
    // под «⋯» им не место.
    expect(bar()).toHaveTextContent("План проекта · черновик");
    expect(bar()).toHaveTextContent("Согласовать план");
  });
});

/** Относительный проект: подсказка про даты старта живёт только у него. */
const RELATIVE: ProjectState = {
  ...STATE,
  schedule_mode: "relative",
  project_end: "2001-01-12",
  calendar: { working_days: 31, holidays: [], extra_workdays: [] },
  tasks: [
    {
      ...STATE.tasks[0],
      start_date: "2001-01-01",
      end_date: "2001-01-12",
      start_offset_days: 0,
      duration_days: 10,
    },
  ],
};

describe("подсказка про относительный план", () => {
  const hint = () => document.querySelector(".gantt__plan-hint");

  it("закрывается и не возвращается при следующем открытии проекта", async () => {
    const first = renderProject(RELATIVE);
    await tape();
    expect(hint()).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(hint()).toBeNull();

    first.unmount();
    renderProject(RELATIVE);
    await tape();

    // Полоса в полсотни пикселей не встаёт над лентой заново на каждом входе.
    expect(hint()).toBeNull();
  });

  it("у календарного проекта её нет вовсе", async () => {
    renderProject();
    await tape();

    expect(hint()).toBeNull();
  });
});

describe("полноэкранная лента", () => {
  it("кнопка разворачивает ленту, Esc возвращает обычный вид", async () => {
    renderProject();
    await tape();

    fireEvent.click(screen.getByRole("button", { name: "На весь экран" }));

    // Шапка со вкладками спрятана: над лентой ничего не стоит.
    expect(document.querySelector(".project__body--focus")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Редизайн" })).toBeNull();
    expect(screen.queryByRole("link", { name: "История" })).toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(document.querySelector(".project__body--focus")).toBeNull();
    expect(screen.getByRole("heading", { name: "Редизайн" })).toBeInTheDocument();
  });

  it("кнопка называет выход, пока лента развёрнута", async () => {
    renderProject();
    await tape();

    fireEvent.click(screen.getByRole("button", { name: "На весь экран" }));

    // Тулбар остаётся на экране — выход из режима живёт в нём же.
    const exit = screen.getByRole("button", { name: "Выйти из полного экрана" });
    expect(exit).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(exit);

    expect(screen.getByRole("button", { name: "На весь экран" })).toBeInTheDocument();
  });

  it("доступна и читателю: полный экран — способ смотреть, а не менять", async () => {
    renderProject(undefined, { canWrite: false });
    await tape();

    expect(screen.getByRole("button", { name: "На весь экран" })).toBeInTheDocument();
  });
});
