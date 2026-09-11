import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { server } from "../test/server";
import { THREE_TASKS, projectFixtures, renderProject } from "../test/project";

beforeEach(projectFixtures);

describe("вкладки карточки задачи", () => {
  it("открывается на «Свойствах»; «История» и «Комментарии» — по вкладке", async () => {
    server.use(
      http.get("/api/projects/p1/revisions", () =>
        HttpResponse.json([
          {
            seq: 1,
            created_at: "2026-08-13T10:00:00Z",
            actor: { id: "u2", name: "Мария" },
            reason: null,
            batch_id: null,
            undoes_seq: null,
            op: { type: "set_progress", task_id: "t1", from: 30, to: 40 },
            names: {},
          },
        ]),
      ),
    );

    renderProject();
    await userEvent.click(await screen.findByRole("button", { name: /Логотип/ }));
    const panel = screen.getByRole("complementary");

    // By default the task's properties, the fields are visible at once.
    expect(within(panel).getByLabelText("Название")).toBeInTheDocument();
    expect(within(panel).queryByRole("region", { name: "Комментарии" })).not.toBeInTheDocument();

    await userEvent.click(within(panel).getByRole("tab", { name: "История" }));
    // The author and the event's phrase are neighbouring nodes of one line: the name is set in a separate
    // `span`, and the whole line does not collapse into a single text node.
    expect(await within(panel).findByText(/изменил готовность с 30% на 40%/)).toBeInTheDocument();
    expect(within(panel).getByText("Мария")).toBeInTheDocument();
    // The properties went out of sight while another tab is open.
    expect(within(panel).queryByLabelText("Название")).not.toBeInTheDocument();

    await userEvent.click(within(panel).getByRole("tab", { name: "Комментарии" }));
    expect(within(panel).getByRole("region", { name: "Комментарии" })).toBeInTheDocument();

    await userEvent.click(within(panel).getByRole("tab", { name: "Свойства" }));
    expect(within(panel).getByLabelText("Название")).toBeInTheDocument();
  });

  it("переход к другой задаче возвращает карточку на «Свойства»", async () => {
    renderProject(THREE_TASKS);
    await userEvent.click(await screen.findByRole("button", { name: /Первая/ }));
    const panel = screen.getByRole("complementary");

    await userEvent.click(within(panel).getByRole("tab", { name: "История" }));
    expect(within(panel).getByRole("tab", { name: "История" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // A neighbouring task was opened without closing the card — the previous tab must not silently stay
    // open on somebody else's history.
    await userEvent.click(screen.getByRole("button", { name: /Вторая/ }));

    await waitFor(() =>
      expect(within(panel).getByRole("tab", { name: "Свойства" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(within(panel).getByLabelText("Название")).toHaveValue("Вторая");
  });

  it("удаление задачи доступно с любой вкладки", async () => {
    renderProject();
    await userEvent.click(await screen.findByRole("button", { name: /Логотип/ }));
    const panel = screen.getByRole("complementary");

    await userEvent.click(within(panel).getByRole("tab", { name: "Комментарии" }));
    expect(within(panel).getByRole("button", { name: "Удалить задачу" })).toBeInTheDocument();
  });
});
