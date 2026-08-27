import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { projectFixtures, renderProject } from "../test/project";

beforeEach(projectFixtures);

const REAL_HEIGHT = window.innerHeight;

function resizeWindowTo(height: number) {
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
  fireEvent(window, new Event("resize"));
}

afterEach(() => {
  Object.defineProperty(window, "innerHeight", { value: REAL_HEIGHT, configurable: true });
});

async function tape(): Promise<HTMLElement> {
  await screen.findByRole("button", { name: /Логотип/ });
  const box = document.querySelector<HTMLElement>(".gantt__scroll");
  if (box === null) throw new Error("ленты нет");
  return box;
}

describe("высота ленты", () => {
  it("ограничена окном — иначе закрепляться шапке шкалы негде", async () => {
    renderProject();

    // Без числа контейнер вырастает во всю высоту содержимого, вертикально не
    // прокручивается никогда, и `position: sticky` у шапки не срабатывает:
    // вертикально едет страница, шапка уезжает вместе с ней.
    expect(await tape()).toHaveStyle({ maxHeight: `${window.innerHeight}px` });
  });

  it("едет за размером окна", async () => {
    renderProject();
    const box = await tape();

    resizeWindowTo(600);

    expect(box).toHaveStyle({ maxHeight: "600px" });
  });

  it("не схлопывается там, где на ленту не осталось места", async () => {
    renderProject();
    const box = await tape();

    // Окно, в которое лента не помещается вовсе: лучше отдать прокрутку
    // странице и показать несколько строк, чем полосу в один ряд.
    resizeWindowTo(80);

    expect(box).toHaveStyle({ maxHeight: "240px" });
  });
});
