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
 * Правило раздела 5 глазами человека.
 *
 * Проверяется не то, что компонент вызвал функцию, а то, что видно на экране:
 * окно появилось, кнопка неактивна, операция не ушла. Именно это и обещано
 * пользователю — «изменение не применяется, пока причина не введена».
 */

const bar = () => screen.findByRole("button", { name: /Логотип/ });

describe("порог сдвига", () => {
  it("сдвиг дальше порога открывает окно и ничего не отправляет", async () => {
    const sent = captureMutations();
    renderProject(APPROVED);

    // Семь дней вправо при пороге в два дня.
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

    // Пробелы причиной не считаются — ровно как на сервере.
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
    // Старт уехал на пять дней при пороге в два — с причиной, как положено.
    renderProject({
      ...APPROVED,
      tasks: [{ ...APPROVED.tasks[0], start_date: "2026-03-09", end_date: "2026-03-13" }],
    });
    await userEvent.click(await bar());

    // Длительность меняется на день: её измерение от базы не ушло, и окно
    // с чужим числом «сдвиг на 5 дней» здесь было бы ошибкой (см. сервер).
    fireEvent.change(screen.getByLabelText(/Длительность, рабочих/), { target: { value: "6" } });

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toMatchObject({ type: "set_duration", duration_days: 6 });
    expect(screen.queryByRole("dialog")).toBeNull();
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

    // Пока окно открыто, сосед переименовал категорию — и состояние
    // перезапросилось по живой связи.
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

    // Откат вернул полоску, но не стёр чужое переименование: снимок для
    // отката взят перед самой отправкой, а не до того, как открылось окно.
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
    renderProject(); // черновик: plan_approved_at = null

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
    // Вкладка о базовом плане не знает: состояние пришло без него, как если бы
    // план утвердили в соседней вкладке минуту назад. Правило всё равно
    // срабатывает — последнее слово за сервером.
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
    // Задача уехала: план обещал окончание 10 марта, а по факту 17-е.
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

    // Призрак при этом на месте: он показывает, где полоске полагается стоять,
    // и совпадение с ней — тоже ответ.
    expect(screen.getByTestId("ghost-t1")).toBeInTheDocument();
    expect(screen.queryByTestId("deviation-t1")).not.toBeInTheDocument();
  });

  it("помечает задачу, добавленную после согласования", async () => {
    renderProject(APPROVED_WITH_EXTRA);

    // Метка стоит у полоски и объясняет себя подсказкой: почему у этой задачи
    // нет призрака базового плана.
    const badge = await screen.findByTestId("beyond-t2");
    expect(badge).toHaveTextContent("Сверх плана");
    expect(badge).toHaveAttribute(
      "title",
      "Задача добавлена после согласования плана: сравнивать не с чем",
    );
    // Помечена ровно одна: у первой задачи базовый план есть.
    expect(screen.queryByTestId("beyond-t1")).not.toBeInTheDocument();
    // Метка не делит имя класса с полосой «вне плана» за краем шкалы: та
    // стоит ровно дважды — в шапке и в теле — и однажды своей рамкой со
    // штриховкой перекрасила и метку, носившую то же имя.
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
