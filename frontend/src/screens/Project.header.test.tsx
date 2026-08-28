import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { projectFixtures, renderProject } from "../test/project";

beforeEach(projectFixtures);

async function tape(): Promise<HTMLElement> {
  await screen.findByRole("heading", { name: "Редизайн" });
  const box = document.querySelector<HTMLElement>(".gantt__scroll");
  if (box === null) throw new Error("ленты нет");
  return box;
}

/**
 * jsdom раскладку не считает, и scrollTop у него всегда ноль — значение
 * подставляется руками, как высота окна в тестах useViewportFit. Признак
 * сжатия читается из события прокрутки, поэтому событие обязательно.
 */
function scrollTapeTo(box: HTMLElement, top: number) {
  Object.defineProperty(box, "scrollTop", { value: top, configurable: true });
  fireEvent.scroll(box);
}

const compactHead = () => document.querySelector(".project-head-compact");
const fold = () => document.querySelector(".project-fold");

describe("сжатие шапки при прокрутке ленты", () => {
  it("прокрутка вглубь складывает шапку в строку, возврат наверх раскрывает", async () => {
    renderProject();
    const box = await tape();

    // Наверху плана шапка полная, сжатой строки нет.
    expect(compactHead()).toBeNull();
    expect(fold()).not.toHaveClass("is-condensed");

    scrollTapeTo(box, 60);

    // Полная шапка остаётся в разметке ради анимации высоты, но помечена
    // свёрнутой и выключена из табуляции; сводку теперь говорит строка.
    expect(fold()).toHaveClass("is-condensed");
    expect(fold()).toHaveAttribute("inert");
    expect(compactHead()).not.toBeNull();

    scrollTapeTo(box, 0);

    expect(fold()).not.toHaveClass("is-condensed");
    expect(compactHead()).toBeNull();
  });

  it("между порогами шапка держит прежнее состояние", async () => {
    renderProject();
    const box = await tape();

    scrollTapeTo(box, 60);
    // 15 — между порогами (4 и 32): сжатие меняет высоту самой ленты, и без
    // зазора шапка дребезжала бы на границе туда-обратно.
    scrollTapeTo(box, 15);

    expect(fold()).toHaveClass("is-condensed");

    // Раскрывается только у самого верха.
    scrollTapeTo(box, 2);

    expect(fold()).not.toHaveClass("is-condensed");
  });

  it("сжатая строка говорит ту же сводку: имя и число задач", async () => {
    renderProject();
    const box = await tape();

    scrollTapeTo(box, 60);

    const strip = compactHead();
    expect(strip).not.toBeNull();
    expect(strip).toHaveTextContent("Редизайн");
    // «Всего задач» — та же метрика тем же счётом, что в полной полосе.
    expect(strip).toHaveTextContent("Всего задач");
  });
});

describe("полноэкранная лента", () => {
  it("кнопка разворачивает ленту, Esc возвращает обычный вид", async () => {
    renderProject();
    await tape();

    fireEvent.click(screen.getByRole("button", { name: "На весь экран" }));

    // Шапка, вкладки и заголовок экрана спрятаны: над лентой ничего не стоит.
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
