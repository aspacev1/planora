import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { WITH_DEPENDENCY, projectFixtures, renderProject } from "../test/project";

beforeEach(projectFixtures);

/** Левый край и ширина полоски — так, как их поставила шкала. */
function barBox(name: string): { left: number; width: number } {
  // Имя полоски начинается с имени задачи и продолжается датами — этим она
  // отличается от кнопок карточки вроде «Убрать связь с „Макет“».
  const bar = screen.getByRole("button", { name: new RegExp(`^${name}, `) });
  return {
    left: Number.parseFloat(bar.style.left),
    // Ширина живёт свойством, а не `width`: полоску растягивают за грань, и
    // к её ширине по датам прибавляется сдвиг пальца (см. gantt.css).
    width: Number.parseFloat(bar.style.getPropertyValue("--bar-w")),
  };
}

function pointsOf(container: HTMLElement): number[][] {
  const line = container.querySelector("svg.arrows .arrows__line");
  if (!line) throw new Error("стрелки нет");
  // Из пути берутся все пары координат подряд, без разбора команд: тесту
  // важны концы линии, а начало пути — всегда первая пара, конец — последняя,
  // какие бы дуги ни стояли между ними.
  const numbers = line.getAttribute("d")!.match(/-?[\d.]+/g)!.map(Number);
  const points: number[][] = [];
  for (let i = 0; i < numbers.length; i += 2) points.push([numbers[i], numbers[i + 1]]);
  return points;
}

describe("стрелки связей", () => {
  it("рисует стрелку между связанными задачами", async () => {
    const { container } = renderProject(WITH_DEPENDENCY);
    await screen.findByRole("button", { name: /Логотип/ });

    expect(container.querySelectorAll("svg.arrows .arrows__line")).toHaveLength(1);
  });

  it("держит стрелку на концах полосок, когда открывается карточка", async () => {
    // План требовал здесь другого: чтобы точки после открытия карточки
    // изменились. Изменяться им нечего — стрелки живут в системе координат
    // ленты, а не окна, и открытие карточки сужает окно, но не двигает
    // полоски. Проверять надо не движение точек, а то, ради чего оно затевалось
    // бы: что стрелка по-прежнему упирается в концы полосок. Этот тест поймает
    // и уехавшую стрелку, и стрелку, забывшую пересчитаться.
    const { container } = renderProject(WITH_DEPENDENCY);
    await screen.findByRole("button", { name: /Логотип/ });

    await userEvent.click(screen.getByRole("button", { name: /Логотип/ }));
    expect(screen.getByRole("complementary")).toBeInTheDocument();

    const from = barBox("Логотип");
    const to = barBox("Макет");
    const points = pointsOf(container);

    expect(points[0][0]).toBe(from.left + from.width);
    // Ломаная кончается на размер наконечника раньше полоски: остриё
    // треугольника доводит стрелку ровно до её левого края.
    expect(points.at(-1)![0]).toBe(to.left - 4);
    expect(container.querySelector("svg.arrows .arrows__head")!.getAttribute("d")).toContain(
      `L${to.left} `,
    );
  });

  it("подсвечивает нарушенную связь, когда приёмник начат до готовности источника", async () => {
    // Конец отрезка включительный: старт в последний день источника — уже
    // нахлёст, и такую стрелку лента красит цветом тревоги.
    const { container } = renderProject({
      ...WITH_DEPENDENCY,
      tasks: [
        WITH_DEPENDENCY.tasks[0],
        { ...WITH_DEPENDENCY.tasks[1], start_date: "2026-03-10" },
      ],
    });
    await screen.findByRole("button", { name: /Логотип/ });

    expect(container.querySelector("svg.arrows .arrows__line")).toHaveClass("is-violated");
  });

  it("не подсвечивает связь, когда приёмник начинается после источника", async () => {
    const { container } = renderProject(WITH_DEPENDENCY);
    await screen.findByRole("button", { name: /Логотип/ });

    expect(container.querySelector("svg.arrows .arrows__line")).not.toHaveClass("is-violated");
  });

  it("не рисует стрелку в задачу, которой нет в проекте", async () => {
    // Связь переживает задачу ровно на один ответ сервера: её удалили в
    // соседней вкладке. Рисовать стрелку в пустоту нельзя — она уходит в
    // NaN и уносит с собой весь слой.
    const { container } = renderProject({
      ...WITH_DEPENDENCY,
      dependencies: [{ from_task_id: "t1", to_task_id: "t404" }],
    });
    await screen.findByRole("button", { name: /Логотип/ });

    expect(container.querySelectorAll("svg.arrows .arrows__line")).toHaveLength(0);
  });
});
