import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { dragDays } from "../test/pointer";
import {
  APPROVED,
  APPROVED_WITH_EXTRA,
  captureMutations,
  projectFixtures,
  renderProject,
} from "../test/project";
import { server } from "../test/server";
import { lastSocket } from "../test/socket";

beforeEach(projectFixtures);

/**
 * Section 5's rule through a person's eyes.
 *
 * What is checked is not that a component called a function but what is visible on screen: the
 * dialog appeared, the button is disabled, the operation did not leave. That is exactly what is
 * promised to the user — "a change is not applied until the reason has been entered".
 */

const bar = () => screen.findByRole("button", { name: /Логотип/ });

describe("порог сдвига", () => {
  it("сдвиг дальше порога открывает окно и ничего не отправляет", async () => {
    const sent = captureMutations();
    renderProject(APPROVED);

    // Seven days to the right with a threshold of two days.
    dragDays(await bar(), 7);

    expect(await screen.findByRole("dialog")).toHaveTextContent(/Сдвиг на 7 дней/);
    expect(sent).toHaveLength(0);
  });

  it("кнопка сохранения неактивна, пока причина пуста", async () => {
    renderProject(APPROVED);
    dragDays(await bar(), 7);
    await screen.findByRole("dialog");

    const save = screen.getByRole("button", { name: "Сохранить" });
    expect(save).toBeDisabled();

    // Whitespace does not count as a reason — exactly as on the server.
    await userEvent.type(screen.getByLabelText("Причина"), "   ");
    expect(save).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Причина"), "брендбук");
    expect(save).toBeEnabled();
  });

  it("введённая причина уходит на сервер вместе с операцией", async () => {
    const sent = captureMutations();
    renderProject(APPROVED);
    dragDays(await bar(), 7);
    await screen.findByRole("dialog");

    await userEvent.type(screen.getByLabelText("Причина"), "заказчик не прислал брендбук");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      op: { type: "move_task", start_date: "2026-03-11" },
      reason: "заказчик не прислал брендбук",
    });
  });

  it("правка длительности не спрашивает причину за уже объяснённый сдвиг старта", async () => {
    const sent = captureMutations();
    // The start travelled five days with a threshold of two — with a reason, as it should be.
    renderProject({
      ...APPROVED,
      tasks: [{ ...APPROVED.tasks[0], start_date: "2026-03-09", end_date: "2026-03-13" }],
    });
    await userEvent.click(await bar());

    // The duration changes by a day: its dimension has not moved from the baseline, and a dialog
    // with the other dimension's number "a 5-day shift" would be a mistake here (see the server).
    fireEvent.change(screen.getByLabelText(/Длительность, рабочих/), { target: { value: "6" } });
    fireEvent.blur(screen.getByLabelText(/Длительность, рабочих/));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toMatchObject({ type: "set_duration", duration_days: 6 });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("набор числа не открывает окно на полпути: «15» — это пятнадцать, а не единица", async () => {
    const sent = captureMutations();
    renderProject(APPROVED);
    await userEvent.click(await bar());

    // A duration of 5 with a threshold of 2: a "1" on the way to "15" is already a deviation of
    // four days, and the reason dialog would open over a number the person never named.
    const duration = screen.getByLabelText(/Длительность, рабочих/);
    await userEvent.clear(duration);
    await userEvent.type(duration, "15");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sent).toHaveLength(0);

    await userEvent.tab();

    // One number left — and the dialog asks about exactly that.
    expect(await screen.findByRole("dialog")).toHaveTextContent(/Сдвиг на 10 дней/);
    expect(sent).toHaveLength(0);
  });

  it("откат по отказу возвращает к состоянию на момент отправки, а не до окна", async () => {
    let attempts = 0;
    server.use(
      http.post("/api/projects/p1/mutations", () => {
        attempts += 1;
        return HttpResponse.json({ detail: "task_not_found" }, { status: 404 });
      }),
    );
    renderProject(APPROVED);
    dragDays(await bar(), 7);
    await screen.findByRole("dialog");

    // While the dialog was open a colleague renamed the category — and the state was refetched
    // over the live connection.
    const renamed = {
      ...APPROVED,
      categories: [{ ...APPROVED.categories[0], name: "Дизайн v2" }],
    };
    server.use(http.get("/api/projects/p1", () => HttpResponse.json(renamed)));
    await act(async () => lastSocket().accept());
    await act(async () =>
      lastSocket().emit({
        type: "revision",
        seq: 2,
        created_at: "2026-03-11T09:00:00+00:00",
        actor: { id: "u2", name: "Мария" },
        reason: null,
        op: { type: "rename_category", category_id: "c1" },
      }),
    );
    expect(await screen.findByText("Дизайн v2")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Причина"), "брендбук");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(attempts).toBe(1));

    // The rollback returned the bar but did not erase somebody else's rename: the snapshot for the
    // rollback is taken right before sending rather than before the dialog opened.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Дизайн v2")).toBeInTheDocument();
  });

  it("«Вернуть» не отправляет ничего", async () => {
    const sent = captureMutations();
    renderProject(APPROVED);
    dragDays(await bar(), 7);
    await screen.findByRole("dialog");

    await userEvent.click(screen.getByRole("button", { name: "Вернуть" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(sent).toHaveLength(0);
  });

  it("сдвиг внутри порога проходит молча", async () => {
    const sent = captureMutations();
    renderProject(APPROVED);

    dragDays(await bar(), 2);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].reason).toBeUndefined();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("до согласования плана ничего не спрашивается", async () => {
    const sent = captureMutations();
    renderProject(); // a draft: plan_approved_at = null

    dragDays(await bar(), 30);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("правка даты в карточке спрашивает причину так же, как перетаскивание", async () => {
    const sent = captureMutations();
    renderProject(APPROVED);
    await userEvent.click(await bar());

    const start = await screen.findByLabelText(/старт/i);
    await userEvent.clear(start);
    await userEvent.type(start, "2026-03-25");
    await userEvent.tab();

    expect(await screen.findByRole("dialog")).toHaveTextContent(/Сдвиг на 21 день/);
    expect(sent).toHaveLength(0);
  });

  it("отказ сервера «нужна причина» открывает то же окно и повторяет с ней", async () => {
    // The tab knows nothing about the baseline plan: the state arrived without it, as if the plan
    // had been approved in another tab a minute ago. The rule fires all the same — the last word is
    // the server's.
    const sent = captureMutations();
    let refused = false;
    server.use(
      http.post("/api/projects/p1/mutations", async ({ request }) => {
        const body = (await request.json()) as { reason?: string };
        if (!refused) {
          refused = true;
          return HttpResponse.json(
            { detail: "reason_required" },
            {
              status: 409,
              headers: {
                "X-Shift-Deviation-Days": "9",
                "X-Shift-Threshold-Days": "2",
              },
            },
          );
        }
        sent.push(body as never);
        return HttpResponse.json({ seq: 1, op: {}, inverse: {} }, { status: 201 });
      }),
    );
    renderProject();

    dragDays(await bar(), 9);

    expect(await screen.findByRole("dialog")).toHaveTextContent(/Сдвиг на 9 дней/);
    await userEvent.type(screen.getByLabelText("Причина"), "подрядчик сорвал срок");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ reason: "подрядчик сорвал срок" });
  });
});

describe("базовый план на диаграмме", () => {
  it("рисует призрак под полоской и бейдж отклонения", async () => {
    // The task travelled: the plan promised an end on 10 March, and in fact it is the 17th.
    renderProject({
      ...APPROVED,
      tasks: [{ ...APPROVED.tasks[0], start_date: "2026-03-11", end_date: "2026-03-17" }],
    });

    expect(await screen.findByTestId("ghost-t1")).toBeInTheDocument();
    expect(screen.getByTestId("deviation-t1")).toHaveTextContent("+7 дн.");
  });

  it("не рисует бейдж, пока задача стоит по плану", async () => {
    renderProject(APPROVED);
    await bar();

    // The ghost is in place at that: it shows where the bar is supposed to stand, and coinciding
    // with it is an answer too.
    expect(screen.getByTestId("ghost-t1")).toBeInTheDocument();
    expect(screen.queryByTestId("deviation-t1")).not.toBeInTheDocument();
  });

  it("помечает задачу, добавленную после согласования", async () => {
    renderProject(APPROVED_WITH_EXTRA);

    // The marker stands by the bar and explains itself with a tooltip: why this task has no ghost
    // of the baseline plan.
    const badge = await screen.findByTestId("beyond-t2");
    expect(badge).toHaveTextContent("Сверх плана");
    expect(badge).toHaveAttribute(
      "title",
      "Задача добавлена после согласования плана: сравнивать не с чем",
    );
    // Exactly one is marked: the first task does have a baseline plan.
    expect(screen.queryByTestId("beyond-t1")).not.toBeInTheDocument();
    // The marker does not share a class name with the "beyond the plan" band past the scale's edge:
    // that one stands exactly twice — in the header and in the body — and once repainted, with its
    // hatched frame, a marker that carried the same name.
    expect(document.querySelectorAll(".gantt__beyond")).toHaveLength(2);
  });

  it("в карточке показывает даты плана и отклонение", async () => {
    renderProject({
      ...APPROVED,
      tasks: [{ ...APPROVED.tasks[0], start_date: "2026-03-11", end_date: "2026-03-17" }],
    });
    await userEvent.click(await screen.findByRole("button", { name: /Логотип/ }));

    const panel = await screen.findByRole("complementary");
    expect(panel).toHaveTextContent(/По плану: 4 мар — 10 мар/);
    expect(panel).toHaveTextContent(/Отклонение от плана: 7 дней/);
  });
});
