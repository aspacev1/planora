import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { STATE, captureMutations, projectFixtures, renderProject } from "../test/project";

/**
 * The strip's bottom — "+ Add task" and "+ New category" after the very last category (see
 * BottomActions.tsx). The GUEST row is drawn for a guest in three cases: there are no categories left
 * at all (the "empty strip" mockup — see CategoryForm.test.tsx), and what happens after that row.
 */

beforeEach(projectFixtures);

// STATE (see test/project.ts) ends with the "Development" category — that is the "last" one, and
// "+ Add task" aims at it rather than at "Design".

/** "+ Add task" — its own row, not the "plus" on a category's row. */
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

    // The visible text and the spoken name are one and the same string: the caption used to say
    // simply "Add task" while only the screen reader knew the category's name (see AddTaskRow).
    const cta = addTaskCta();
    expect(cta).toHaveAccessibleName("Добавить задачу в «Разработка»");
    expect(cta).toHaveTextContent("Добавить задачу в «Разработка»");
  });

  it("нажимается вся строка, а не одна колонка названий", async () => {
    renderProject(STATE);
    await screen.findByRole("button", { name: /Логотип/ });

    // The hover highlight covers the whole row, including the scale's band (see `.gantt__row:hover`
    // in gantt.css) — which means the press must work everywhere the row is highlighted.
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
    // Without a dialog: the short path at the bottom of the strip does not ask for a colour — it is
    // picked automatically, as in the full form (see project/categoryColors.ts).
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

    // The category arrived as a real block while the field stayed open and empty — the next one is
    // created straight away without touching the mouse (the same device as a task's).
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
    // The button stays in place — it is used to create a category anew.
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
