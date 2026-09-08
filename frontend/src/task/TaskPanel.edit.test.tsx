import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { server } from "../test/server";
import { STATE, captureMutations, projectFixtures, renderProject } from "../test/project";

beforeEach(projectFixtures);

/** Открыть карточку щелчком по полоске. */
async function openPanel() {
  await userEvent.click(await screen.findByRole("button", { name: /Логотип/ }));
}

describe("правка полей карточки", () => {
  it("сохраняет описание одной операцией, а не тремя", async () => {
    const sent = captureMutations();
    renderProject();
    await openPanel();

    await userEvent.clear(screen.getByLabelText(/описание/i));
    await userEvent.type(screen.getByLabelText(/описание/i), "Знак и логотип");
    await userEvent.tab();

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op.type).toBe("set_task_fields");
  });

  it("не шлёт операцию, если значение не изменилось", async () => {
    const sent = captureMutations();
    renderProject();
    await openPanel();

    await userEvent.click(screen.getByLabelText(/описание/i));
    await userEvent.tab();

    expect(sent).toHaveLength(0);
  });

  it("смена даты старта уходит операцией переноса", async () => {
    const sent = captureMutations();
    renderProject();
    await openPanel();

    fireEvent.change(screen.getByLabelText(/старт/i), { target: { value: "2026-03-19" } });

    await waitFor(() =>
      expect(sent[0].op).toMatchObject({ type: "move_task", start_date: "2026-03-19" }),
    );
  });

  it("возвращает прежнее значение, если сервер отказал", async () => {
    server.use(
      http.post("/api/projects/p1/mutations", () =>
        HttpResponse.json({ detail: "progress_out_of_range" }, { status: 422 }),
      ),
    );

    renderProject();
    await openPanel();
    fireEvent.change(screen.getByLabelText(/выполнено/i), { target: { value: "150" } });
    fireEvent.blur(screen.getByLabelText(/выполнено/i));

    expect(await screen.findByText(/от 0 до 100/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/выполнено/i)).toHaveValue(40));
  });

  it("исполнители переключаются по одному и каждый своей операцией", async () => {
    const sent = captureMutations();
    renderProject();
    await openPanel();

    await userEvent.click(screen.getByRole("button", { name: /Мария/ }));
    await waitFor(() => expect(sent[0].op.type).toBe("assign_user"));

    await userEvent.click(screen.getByRole("button", { name: /Мария/ }));
    await waitFor(() => expect(sent[1].op.type).toBe("unassign_user"));
  });
});

describe("флаг риска в карточке", () => {
  it("выбор флага уходит одной операцией вместе с причиной", async () => {
    const sent = captureMutations();
    renderProject();
    await openPanel();

    // У зелёного флага причины нет: пустое поле читалось бы как забытое.
    expect(screen.queryByLabelText("Причина")).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Риск"), "yellow");

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toEqual({ type: "set_risk", task_id: "t1", risk: "yellow", note: "" });
  });

  it("причина у не-зелёного флага сохраняется той же операцией", async () => {
    const sent = captureMutations();
    renderProject({
      ...STATE,
      tasks: [{ ...STATE.tasks[0], risk: "yellow", risk_note: "" }],
    });
    await openPanel();

    await userEvent.type(screen.getByLabelText("Причина"), "жду доступ");
    await userEvent.tab();

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toEqual({
      type: "set_risk",
      task_id: "t1",
      risk: "yellow",
      note: "жду доступ",
    });
  });
});
