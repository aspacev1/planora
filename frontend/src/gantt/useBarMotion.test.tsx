import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { matchMediaMock } from "../test/motion";
import { drag } from "../test/pointer";
import { projectFixtures, renderProject } from "../test/project";
import { MOTION_MS } from "./motion";
import { DAY_WIDTH } from "./scale";

/**
 * The bar stands on `left`/`width` and moves only through `transform`.
 *
 * What is checked here is not styling but the cost of movement. `left` and `width` are layout
 * properties: an animation on them recomputes the position of the whole layer of rows every frame,
 * and with a hundred tasks the strip stutters from it. The test catches a return to them — an edit
 * that will break nothing on the harness's five tasks and will only show up on a live project.
 */

/**
 * The frames the bar asked the browser for.
 *
 * `Element.animate` does not exist in jsdom at all, so this is not a substitute for real behaviour
 * but the only way to see the animation request in the first place.
 */
function captureSlides(): { transform: string }[][] {
  const slides: { transform: string }[][] = [];
  const animate = vi.fn((frames: { transform: string }[]) => {
    slides.push(frames);
    return { cancel: () => {} };
  });
  Object.defineProperty(Element.prototype, "animate", {
    value: animate,
    configurable: true,
    writable: true,
  });
  return slides;
}

beforeEach(projectFixtures);
afterEach(() => {
  delete (Element.prototype as { animate?: unknown }).animate;
  vi.unstubAllGlobals();
});

describe("движение полоски", () => {
  it("под пальцем сдвигает полоску, не трогая её места по датам", async () => {
    renderProject();
    const bar = await screen.findByRole("button", { name: /Логотип/ });
    const placed = bar.style.left;

    fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 100 + 3 * DAY_WIDTH.day });

    // The place by dates is untouched: only the server's answer changes it.
    expect(bar.style.left).toBe(placed);
    expect(bar.style.getPropertyValue("--bar-dx")).toBe(`${3 * DAY_WIDTH.day}px`);
  });

  it("отпущенная полоска доезжает до своего дня, а не прыгает на него", async () => {
    const slides = captureSlides();
    renderProject();
    const bar = await screen.findByRole("button", { name: /Логотип/ });

    // Three days and another ten pixels: the nearest day is chosen, and those ten pixels the bar
    // still has to travel back — from under the finger onto the grid.
    drag(bar, { fromX: 100, toX: 100 + 3 * DAY_WIDTH.day + 10 });

    await waitFor(() => expect(slides.length).toBeGreaterThan(0));
    expect(slides[0]).toEqual([
      { transform: "translate3d(10px, 0, 0)" },
      { transform: "translate3d(0px, 0, 0)" },
    ]);
    // And by this moment the place by dates is already the new one, and there is no offset on the
    // bar: the travel is an animation on top of a ready place rather than the path to it.
    expect(bar.style.left).toBe(`${6 * DAY_WIDTH.day}px`);
    expect(bar.style.getPropertyValue("--bar-dx")).toBe("0px");
  });

  it("жест, ничего не изменивший, возвращает полоску на место сам", async () => {
    renderProject();
    const bar = await screen.findByRole("button", { name: /Логотип/ });

    // Less than half a day — there is no move, and there will be no render with a new place either.
    // There is nobody but the gesture itself to clear the offset.
    drag(bar, { fromX: 100, toX: 100 + 12 });

    await waitFor(() => expect(bar.style.getPropertyValue("--bar-dx")).toBe("0px"));
  });

  it("смена масштаба не показывает переезда: поехали не задачи, а лента", async () => {
    const slides = captureSlides();
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });

    await userEvent.click(screen.getByRole("button", { name: "Масштаб: День" }));
    await userEvent.click(screen.getByRole("radio", { name: "Неделя" }));

    // The bars stood in different places because a day became narrower. That is a different picture
    // of the same strip, and all the bars "travelling" at once would read as the plan collapsing.
    expect(slides).toHaveLength(0);
  });

  it("просьба о меньшем движении отменяет переезд, а не укорачивает его", async () => {
    matchMediaMock("(prefers-reduced-motion: reduce)", true);
    const slides = captureSlides();
    renderProject();
    const bar = await screen.findByRole("button", { name: /Логотип/ });

    drag(bar, { fromX: 100, toX: 100 + 3 * DAY_WIDTH.day + 10 });

    // The general `transition: none` rule from styles.css does not reach here: it suppresses CSS
    // transitions, while the travel is started from code.
    await waitFor(() => expect(bar.style.left).toBe(`${6 * DAY_WIDTH.day}px`));
    expect(slides).toHaveLength(0);
  });

  it("переезд идёт ровно столько же, сколько переходы ленты", async () => {
    const slides = captureSlides();
    const { container } = renderProject();
    const bar = await screen.findByRole("button", { name: /Логотип/ });

    drag(bar, { fromX: 100, toX: 100 + 3 * DAY_WIDTH.day + 10 });

    await waitFor(() => expect(slides.length).toBeGreaterThan(0));
    // One number for both: the duration reaches the styles from the same `MOTION_MS` the code drives
    // the travel with — otherwise they would diverge on the first edit.
    const animate = Element.prototype.animate as unknown as ReturnType<typeof vi.fn>;
    expect(animate.mock.calls[0][1]).toMatchObject({ duration: MOTION_MS });
    expect(container.querySelector<HTMLElement>(".gantt")?.style.getPropertyValue("--motion")).toBe(
      `${MOTION_MS}ms`,
    );
  });
});
