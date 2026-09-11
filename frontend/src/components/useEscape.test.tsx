import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { APPROVED, captureMutations, projectFixtures, renderProject } from "../test/project";

beforeEach(projectFixtures);

/**
 * Esc through the eyes of a person with more than one layer on screen.
 *
 * What is checked is not the stack's construction but the promise: one press removes one layer — the
 * one the person opened last. Everything else stays where it was, together with what was left unfinished.
 */

const bar = () => screen.findByRole("button", { name: /Логотип/ });
const panel = () => screen.queryByRole("complementary");

describe("Esc при нескольких слоях", () => {
  it("закрывает окно причины, но оставляет карточку, из которой его открыли", async () => {
    const sent = captureMutations();
    renderProject(APPROVED);
    await userEvent.click(await bar());

    // Editing a date in the card past the threshold — the "explain the shift" dialog on top of it.
    const start = await screen.findByLabelText(/старт/i);
    await userEvent.clear(start);
    await userEvent.type(start, "2026-03-25");
    await userEvent.tab();
    await screen.findByRole("dialog");

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // The main thing: the card is in place. Esc cancelled the shift rather than the work on the task.
    expect(panel()).toBeInTheDocument();
    expect(sent).toHaveLength(0);

    // The second press goes to what is left below.
    await userEvent.keyboard("{Escape}");
    expect(panel()).not.toBeInTheDocument();
  });

  it("закрывает раскрытое меню ленты, но не карточку под ним", async () => {
    renderProject();
    await userEvent.click(await bar());

    await userEvent.click(screen.getByRole("button", { name: /Масштаб/ }));
    const scale = screen.getByRole("button", { name: /Масштаб/ });
    expect(scale).toHaveAttribute("aria-expanded", "true");

    await userEvent.keyboard("{Escape}");

    expect(scale).toHaveAttribute("aria-expanded", "false");
    expect(panel()).toBeInTheDocument();
  });

  it("снимает вопрос об удалении, а не карточку с задачей, о которой он", async () => {
    renderProject();
    await userEvent.click(await bar());

    await userEvent.click(screen.getByRole("button", { name: "Удалить задачу" }));
    expect(screen.getByRole("button", { name: "Да, удалить" })).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("button", { name: "Да, удалить" })).not.toBeInTheDocument();
    expect(panel()).toBeInTheDocument();
  });

  it("Esc в ячейке таблицы возвращает набранное, но карточку не закрывает", async () => {
    renderProject();
    await userEvent.click(await bar());

    // The start cell is edited right in the table; it suppresses its own Esc — it returns the previous
    // value and closes.
    // The name and the date stand in the card too: a strip row is looked up by its own bar.
    const row = (await bar()).closest(".gantt__row") as HTMLElement;
    await userEvent.click(within(row).getByText("4 марта"));
    const cell = within(row).getByLabelText(/Начало/);
    await userEvent.click(cell);
    await userEvent.keyboard("{Escape}");

    expect(within(row).queryByLabelText(/Начало/)).not.toBeInTheDocument();
    expect(within(row).getByText("4 марта")).toBeInTheDocument();
    expect(panel()).toBeInTheDocument();
  });

  it("не путает порядок, когда нижний слой уходит раньше верхнего", async () => {
    renderProject();
    await userEvent.click(await bar());

    // The menu is on top of the card, but the card is closed with the mouse — the stack must forget
    // precisely it rather than the top layer.
    await userEvent.click(screen.getByRole("button", { name: /Масштаб/ }));
    await userEvent.click(screen.getByRole("button", { name: "Закрыть карточку" }));
    expect(panel()).not.toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: /Масштаб/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});
