import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { STATE, projectFixtures, renderProject } from "../test/project";

beforeEach(projectFixtures);

async function tape(): Promise<HTMLElement> {
  await screen.findByRole("heading", { name: "Редизайн" });
  const box = document.querySelector<HTMLElement>(".gantt__scroll");
  if (box === null) throw new Error("ленты нет");
  return box;
}

/**
 * jsdom does not compute layout, and its scrollTop is always zero — the value is substituted by
 * hand, like the window's height in the useViewportFit tests. The event is mandatory: without it
 * the strip will not learn about the scroll.
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

    // There is nothing to scroll — and that is the whole point of the rebuild: the summary used to
    // appear as a line only after the strip was scrolled by 32 pixels, and before that four tiers
    // stood above the strip at full height.
    const row = bar();
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByRole("heading", { name: "Редизайн" })).
      toBeInTheDocument();
    expect(within(row as HTMLElement).getByRole("link", { name: "История" })).
      toBeInTheDocument();

    // The summary is under a chevron by the name: there is no permanent place for seven figures on
    // this line, and it unfolds with the same reckoning the card bar had.
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Сводка по проекту" }));
    expect(summary()).toHaveTextContent("Всего задач");
  });

  it("прокрутка ленты шапку больше не двигает", async () => {
    renderProject();
    const box = await tape();
    const before = bar()?.className;

    scrollTapeTo(box, 60);

    // Neither folding nor a swap for a squeezed line: the state is one, and there is no jump of
    // content at the threshold any more.
    expect(bar()?.className).toBe(before);
    expect(document.querySelector(".project-fold")).toBeNull();
    expect(document.querySelector(".project-head-compact")).toBeNull();
    expect(screen.getByRole("heading", { name: "Редизайн" })).toBeInTheDocument();
  });

  it("редкие действия убраны под «⋯», а не стоят в строке", async () => {
    renderProject();
    await tape();

    // They are not in the line itself — otherwise the tier grows again with every new button.
    expect(screen.queryByRole("button", { name: "Экспорт" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Ещё действия" }));

    // We look inside the line itself: the word "Settings" is also in the application's column, but
    // there it is the workspace's settings rather than the project's.
    const row = within(bar() as HTMLElement);
    expect(row.getByRole("button", { name: "Экспорт" })).toBeInTheDocument();
    expect(row.getByRole("link", { name: /Настройки/ })).toBeInTheDocument();
  });

  it("согласование остаётся в строке: это не редкое действие", async () => {
    renderProject();
    await tape();

    // The plan's state and the button by it are what people come back to a project for; they have
    // no place under "⋯".
    expect(bar()).toHaveTextContent("План проекта · черновик");
    expect(bar()).toHaveTextContent("Согласовать план");
  });
});

describe("полноэкранная лента", () => {
  it("кнопка разворачивает ленту, Esc возвращает обычный вид", async () => {
    renderProject();
    await tape();

    fireEvent.click(screen.getByRole("button", { name: "На весь экран" }));

    // The header with the tabs is hidden: nothing stands above the strip.
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

    // The header is hidden along with the expand button — the exit lives on top of the strip.
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

  it("кнопка — значок без подписи, но с именем", async () => {
    renderProject();
    await tape();

    // An eleven-letter caption stood last in an overloaded row, and arrows into the corners are
    // understood without it. The name stayed with the button in full — for whoever listens to the
    // screen and whoever hovers the cursor.
    const button = screen.getByRole("button", { name: "На весь экран" });
    expect(button).toHaveAttribute("title", "На весь экран");
    expect(button).toHaveTextContent("");
    expect(button.querySelector("svg")).not.toBeNull();
  });
});

describe("органы вида — в шапке, второго яруса над лентой нет", () => {
  it("масштаб и «Вид» стоят в строке шапки, тулбара над лентой нет", async () => {
    renderProject();
    await tape();

    expect(document.querySelector(".project-toolbar")).toBeNull();

    const row = within(bar() as HTMLElement);
    // The scale is named by one value, but the button's name is the full one — for a screen reader.
    expect(row.getByRole("button", { name: "Масштаб: День" })).toHaveTextContent("День");
    expect(row.getByRole("button", { name: "Вид" })).toBeInTheDocument();
    expect(row.getByRole("button", { name: "На весь экран" })).toBeInTheDocument();
  });

  it("масштаб из шапки меняет ленту", async () => {
    renderProject();
    await tape();

    fireEvent.click(screen.getByRole("button", { name: "Масштаб: День" }));
    fireEvent.click(screen.getByRole("radio", { name: "Месяц" }));

    expect(document.querySelector(".gantt")).toHaveClass("gantt--month");
    expect(screen.getByRole("button", { name: "Масштаб: Месяц" })).toBeInTheDocument();
  });

  it("на других вкладках органов вида нет: масштаб у истории ни к чему", async () => {
    renderProject(undefined, { route: "/projects/p1/history" });
    await screen.findByRole("heading", { name: "Редизайн" });

    expect(screen.queryByRole("button", { name: /Масштаб/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "На весь экран" })).toBeNull();
    // The header itself with the tabs and "⋯" is in place.
    expect(within(bar() as HTMLElement).getByRole("button", { name: "Ещё действия" })).toBeInTheDocument();
  });

  it("создание живёт в ленте: «плюс» категории — у заголовка списка", async () => {
    renderProject();
    await tape();

    expect(screen.queryByRole("button", { name: "Новая задача" })).toBeNull();
    const corner = document.querySelector(".gantt__corner") as HTMLElement;
    expect(within(corner).getByRole("button", { name: "Новая категория" })).toBeInTheDocument();
  });
});

describe("дела плана — у его состояния", () => {
  it("перенос назначенной даты старта — под «⋯», а не в строке", async () => {
    renderProject();
    await tape();

    expect(screen.queryByRole("button", { name: "Изменить дату старта" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Ещё действия" }));

    expect(
      within(bar() as HTMLElement).getByRole("button", { name: "Изменить дату старта" }),
    ).toBeInTheDocument();
  });

  it("первая привязка стоит в строке рядом с состоянием плана", async () => {
    renderProject({ ...STATE, schedule_mode: "relative", start_date: null, deadline: null });
    await tape();

    const row = within(bar() as HTMLElement);
    const button = row.getByRole("button", { name: "Назначить дату старта" });
    expect(button).toHaveClass("button--accent");
    // The "Relative plan" chip does not duplicate the button.
    expect(screen.queryByText("Относительный план")).toBeNull();
  });

  it("читателю относительного плана — плашка режима вместо кнопки", async () => {
    renderProject(
      { ...STATE, schedule_mode: "relative", start_date: null, deadline: null },
      { canWrite: false },
    );
    await tape();

    expect(screen.queryByRole("button", { name: "Назначить дату старта" })).toBeNull();
    expect(within(bar() as HTMLElement).getByText("Относительный план")).toBeInTheDocument();
  });
});
