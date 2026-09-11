import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { WITH_DEPENDENCY, projectFixtures, renderProject } from "../test/project";

beforeEach(projectFixtures);

/** A bar's left edge and width — as the scale set them. */
function barBox(name: string): { left: number; width: number } {
  // A bar's name starts with the task's name and continues with the dates — that is what tells it
  // from the card's buttons such as "Remove the link with “Mockup”".
  const bar = screen.getByRole("button", { name: new RegExp(`^${name}, `) });
  return {
    left: Number.parseFloat(bar.style.left),
    // The width lives as a property rather than as `width`: a bar is stretched by its edge, and the
    // finger's offset is added to its width by dates (see gantt.css).
    width: Number.parseFloat(bar.style.getPropertyValue("--bar-w")),
  };
}

function pointsOf(container: HTMLElement): number[][] {
  const line = container.querySelector("svg.arrows .arrows__line");
  if (!line) throw new Error("стрелки нет");
  // All the coordinate pairs are taken from the path in turn, without parsing the commands: the test
  // cares about the line's ends, and a path's start is always the first pair and its end the last,
  // whatever arcs stand between them.
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
    // The plan demanded something else here: that the points change after the card is opened. There
    // is nothing for them to change by — the arrows live in the strip's coordinate system rather than
    // the window's, and opening the card narrows the window but does not move the bars. What has to
    // be checked is not the points moving but what that would be done for: that the arrow still rests
    // on the bars' ends. This test will catch both an arrow that drifted and an arrow that forgot to
    // recompute itself.
    const { container } = renderProject(WITH_DEPENDENCY);
    await screen.findByRole("button", { name: /Логотип/ });

    await userEvent.click(screen.getByRole("button", { name: /Логотип/ }));
    expect(screen.getByRole("complementary")).toBeInTheDocument();

    const from = barBox("Логотип");
    const to = barBox("Макет");
    const points = pointsOf(container);

    expect(points[0][0]).toBe(from.left + from.width);
    // The polyline ends short of the bar by the arrowhead's size: the triangle's tip brings the arrow
    // exactly to its left edge.
    expect(points.at(-1)![0]).toBe(to.left - 4);
    expect(container.querySelector("svg.arrows .arrows__head")!.getAttribute("d")).toContain(
      `L${to.left} `,
    );
  });

  it("подсвечивает нарушенную связь, когда приёмник начат до готовности источника", async () => {
    // The stretch's end is inclusive: a start on the source's last day is already an overlap, and the
    // strip paints such an arrow in the alarm colour.
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
    // A link outlives a task by exactly one server answer: it was deleted in another tab. An arrow
    // must not be drawn into nothing — it goes to NaN and takes the whole layer with it.
    const { container } = renderProject({
      ...WITH_DEPENDENCY,
      dependencies: [{ from_task_id: "t1", to_task_id: "t404" }],
    });
    await screen.findByRole("button", { name: /Логотип/ });

    expect(container.querySelectorAll("svg.arrows .arrows__line")).toHaveLength(0);
  });
});
