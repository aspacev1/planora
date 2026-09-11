import { fireEvent } from "@testing-library/react";

import { DAY_WIDTH } from "../gantt/scale";

/**
 * Pointer gestures.
 *
 * There are exactly four events, and the last one is not a formality: after the button is released the
 * browser itself sends a click on the same element. A helper that does not send it does not reproduce
 * the browser, and a drag written against it would end in production with a card being opened.
 */
export function drag(
  element: HTMLElement,
  { fromX, toX, fromY = 0, toY = 0 }: { fromX: number; toX: number; fromY?: number; toY?: number },
) {
  fireEvent.pointerDown(element, { pointerId: 1, button: 0, clientX: fromX, clientY: fromY });
  fireEvent.pointerMove(element, { pointerId: 1, clientX: toX, clientY: toY });
  fireEvent.pointerUp(element, { pointerId: 1, clientX: toX, clientY: toY });
  fireEvent.click(element, { clientX: toX, clientY: toY });
}

/**
 * Dragging a bar by a whole number of days.
 *
 * Days rather than pixels: a day's width is the picture's scale, and a test that knows it as a number
 * breaks when the default scale changes, although what it checks is not the scale but a task's move.
 */
export function dragDays(element: HTMLElement, days: number, fromX = 100) {
  drag(element, { fromX, toX: fromX + days * DAY_WIDTH.day });
}
