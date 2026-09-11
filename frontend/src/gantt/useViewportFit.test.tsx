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

    // Without a number the container grows to the full height of its content, never scrolls vertically,
    // and the header's `position: sticky` does not fire: what travels vertically is the page, and the
    // header travels with it.
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

    // A window the strip does not fit into at all: better to give the scroll to the page and show a few
    // rows than a band one row high.
    resizeWindowTo(80);

    expect(box).toHaveStyle({ maxHeight: "240px" });
  });
});
