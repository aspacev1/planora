import { afterEach, describe, expect, it, vi } from "vitest";

import { edgeScroll } from "./edgeScroll";

/**
 * Лента с настоящей шириной и прокруткой: в jsdom у элементов нет ни того, ни
 * другого, а слой без ширины сознательно вырождается в пустышку (см. `IDLE`).
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
      // Браузер шлёт событие сам; здесь оно нужно ровно затем же, зачем и
      // там, — сообщить жесту, что лента уехала.
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

    // Колесо, трекпад, полоса прокрутки — для жеста это один и тот же ход
    // ленты, и день под неподвижным пальцем меняется от него так же, как от
    // подкачки у края.
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

    // Нажали на полоску, а лента ещё доезжает по инерции: это щелчок, и
    // пересчитывать в нём нечего.
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
    // Таблица на 260 пикселей закреплена слева и накрывает начало шкалы.
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
      // Указатель у видимого края шкалы — сразу справа от таблицы.
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
