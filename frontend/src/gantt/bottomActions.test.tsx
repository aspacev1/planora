import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { STATE, captureMutations, projectFixtures, renderProject } from "../test/project";

/**
 * Низ ленты — «+ Добавить задачу» и «+ Новая категория» после самой последней
 * категории (см. BottomActions.tsx). Строка ГОСТЬ рисуется гостю в трёх
 * случаях: категорий уже нет ни одной (макет «пустой ленты» — см.
 * CategoryForm.test.tsx), и то, что происходит после этой строки.
 */

beforeEach(projectFixtures);

// STATE (см. test/project.ts) кончается категорией «Разработка» — она и есть
// «последняя», и «+ Добавить задачу» целится в неё, а не в «Дизайн».

/** «+ Добавить задачу» — своя строка, не «плюс» на строке категории. */
function addTaskCta(): HTMLButtonElement {
  return document.querySelector(".gantt__row--add-task button") as HTMLButtonElement;
}

function addCategoryCta(): HTMLButtonElement {
  return document.querySelector(".gantt__row--add-category button") as HTMLButtonElement;
}

describe("низ ленты", () => {
  it("«+ Добавить задачу» открывает строку ввода в последней категории", async () => {
    renderProject(STATE);
    await screen.findByRole("button", { name: /Логотип/ });

    await userEvent.click(addTaskCta());

    expect(screen.getByRole("textbox", { name: "Новая задача в «Разработка»" })).toHaveFocus();
  });

  it("подпись называет категорию, в которую строка кладёт задачу", async () => {
    renderProject(STATE);
    await screen.findByRole("button", { name: /Логотип/ });

    // Видимый текст и произносимое имя — одна и та же строка: прежде подпись
    // называлась просто «Добавить задачу», а имя категории знала только
    // читалка (см. AddTaskRow).
    const cta = addTaskCta();
    expect(cta).toHaveAccessibleName("Добавить задачу в «Разработка»");
    expect(cta).toHaveTextContent("Добавить задачу в «Разработка»");
  });

  it("нажимается вся строка, а не одна колонка названий", async () => {
    renderProject(STATE);
    await screen.findByRole("button", { name: /Логотип/ });

    // Подсветка под курсором накрывает строку целиком, включая полосу шкалы
    // (см. `.gantt__row:hover` в gantt.css) — значит, и нажатие обязано
    // работать всюду, где строка подсвечена.
    const lane = document.querySelector(".gantt__row--add-task .gantt__lane") as HTMLElement;
    expect(lane).not.toBeNull();
    await userEvent.click(lane);

    expect(screen.getByRole("textbox", { name: "Новая задача в «Разработка»" })).toHaveFocus();
  });

  it("половина со стороны шкалы читалке не показывается: действие у строки одно", async () => {
    renderProject(STATE);
    await screen.findByRole("button", { name: /Логотип/ });

    const lane = document.querySelector(".gantt__row--add-task .gantt__lane") as HTMLElement;
    expect(lane).toHaveAttribute("aria-hidden", "true");
    expect(lane).toHaveAttribute("tabindex", "-1");
  });

  it("«+ Новая категория» заводит категорию строкой, а не окном", async () => {
    const sent = captureMutations();
    renderProject(STATE);
    await screen.findByRole("button", { name: /Логотип/ });

    await userEvent.click(addCategoryCta());
    // Без окна: короткий путь снизу ленты не спрашивает цвет — он подобран
    // автоматически, как и в полной форме (см. project/categoryColors.ts).
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const field = screen.getByRole("textbox", { name: "Новая категория" });
    expect(field).toHaveFocus();
    await userEvent.type(field, "Тестирование{Enter}");

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toEqual({
      type: "create_category",
      name: "Тестирование",
      color: expect.stringMatching(/^#[0-9a-f]{6}$/i),
    });

    // Категория пришла настоящим блоком, а поле осталось открытым и пустым —
    // следующую заводят сразу, не касаясь мыши (тот же приём, что у задачи).
    expect(await screen.findByText("Тестирование")).toBeInTheDocument();
    expect(field).toHaveValue("");
    expect(field).toHaveFocus();
  });

  it("Esc закрывает поле новой категории, ничего не отправив", async () => {
    const sent = captureMutations();
    renderProject(STATE);
    await screen.findByRole("button", { name: /Логотип/ });

    await userEvent.click(addCategoryCta());
    await userEvent.type(
      screen.getByRole("textbox", { name: "Новая категория" }),
      "Передумал{Escape}",
    );

    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Новая категория" })).not.toBeInTheDocument(),
    );
    expect(sent).toHaveLength(0);
    // Кнопка остаётся на месте — ею заводят категорию заново.
    expect(addCategoryCta()).toBeInTheDocument();
  });

  it("гостю низ ленты действий не обещает", async () => {
    renderProject(STATE, { canWrite: false });
    await screen.findByRole("button", { name: /Логотип/ });

    expect(document.querySelector(".gantt__row--add-task")).not.toBeInTheDocument();
    expect(document.querySelector(".gantt__row--add-category")).not.toBeInTheDocument();
  });

  it("после последней строки остаётся воздух, а не обрыв таблицы", async () => {
    renderProject(STATE);
    await screen.findByRole("button", { name: /Логотип/ });

    expect(document.querySelector(".gantt__bottom-space")).toBeInTheDocument();
  });
});
