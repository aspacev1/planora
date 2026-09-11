import { afterEach, describe, expect, it, vi } from "vitest";

import { edgeScroll } from "./edgeScroll";

/**
 * A strip with a real width and scroll: in jsdom elements have neither, and a layer without a width
 * deliberately degenerates into a stub (see `IDLE`).
 */
function scrollport() {
  const box = document.createElement("div");
  box.className = "gantt__scroll";
  const node = document.createElement("div");
  box.append(node);
  document.body.append(box);

  Object.defineProperty(box, "clientWidth", { value: 800 });
  box.getBoundingClientRect = () =>
    ({ left: 0, right: 800, top: 0, bottom: 400, width: 800, height: 400, x: 0, y: 0 }) as DOMRect;

  let scrollLeft = 0;
  Object.defineProperty(box, "scrollLeft", {
    get: () => scrollLeft,
    set(next: number) {
      scrollLeft = next;
      // The browser sends the event itself; here it is needed for exactly the same purpose as there —
      // to tell the gesture that the strip has travelled.
      box.dispatchEvent(new Event("scroll"));
    },
  });

  return { box, node };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("подкачка ленты у края", () => {
  it("считает прокрутку, сделанную не ею самой", () => {
    const { box, node } = scrollport();
    const scroll = edgeScroll(node, () => {});

    // The wheel, the trackpad, the scrollbar — for the gesture these are one and the same travel of the
    // strip, and the day under a motionless finger changes from it just as it does from edge scrolling.
    box.scrollLeft = 120;

    expect(scroll.scrolled()).toBe(120);
    scroll.stop();
  });

  it("будит жест, когда ленту прокрутили сами", () => {
    const { box, node } = scrollport();
    const onScroll = vi.fn();
    const scroll = edgeScroll(node, onScroll);

    scroll.track(400);
    box.scrollLeft = 60;

    expect(onScroll).toHaveBeenCalled();
    scroll.stop();
  });

  it("молчит, пока указатель не двигался", () => {
    const { box, node } = scrollport();
    const onScroll = vi.fn();
    const scroll = edgeScroll(node, onScroll);

    // The bar was pressed while the strip is still coasting from inertia: this is a click, and there is
    // nothing to recompute in it.
    box.scrollLeft = 60;

    expect(onScroll).not.toHaveBeenCalled();
    scroll.stop();
  });

  it("отписывается от ленты, когда жест кончился", () => {
    const { box, node } = scrollport();
    const onScroll = vi.fn();
    const scroll = edgeScroll(node, onScroll);

    scroll.track(400);
    scroll.stop();
    box.scrollLeft = 200;

    expect(onScroll).not.toHaveBeenCalled();
  });

  it("полоса у левого края начинается за закреплённой таблицей, а не за краем узла", () => {
    const { box, node } = scrollport();
    // A 260-pixel table is pinned on the left and covers the scale's start.
    const label = document.createElement("div");
    label.className = "gantt__label";
    label.getBoundingClientRect = () =>
      ({ left: 0, right: 260, top: 0, bottom: 32, width: 260, height: 32, x: 0, y: 0 }) as DOMRect;
    box.prepend(label);
    box.scrollLeft = 200;

    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      const scroll = edgeScroll(node, () => {});
      // The pointer is at the scale's visible edge — right next to the table.
      scroll.track(270);
      frames.shift()?.(0);

      expect(box.scrollLeft).toBeLessThan(200);
      scroll.stop();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("вырождается в пустышку там, где прокручивать нечего", () => {
    const node = document.createElement("div");
    document.body.append(node);

    const scroll = edgeScroll(node, () => {});

    expect(scroll.scrolled()).toBe(0);
    scroll.stop();
  });
});
