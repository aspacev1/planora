import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import type { ProjectState } from "../api/projects";
import { addDays, daysBetween } from "../gantt/timescale";
import { dragDays } from "../test/pointer";
import { WITH_DEPENDENCY, projectFixtures, renderProject } from "../test/project";
import { server } from "../test/server";

beforeEach(projectFixtures);

/**
 * Сервер, который двигает вместе со стартом и окончание.
 *
 * Общая оснастка этого не делает намеренно: календаря у неё нет, и
 * пересчитанный «на глаз» конец разошёлся бы с настоящим на первом же
 * празднике. Здесь без пересчёта не обойтись — предложение считается именно
 * по окончанию предшественника, — поэтому сдвиг календарный и живёт ровно в
 * этом файле, где даты подобраны без праздников.
 */
function movingServer(state: ProjectState) {
  const sent: Record<string, unknown>[] = [];
  let current = state;

  server.use(
    http.get("/api/projects/p1", () => HttpResponse.json(current)),
    http.post("/api/projects/p1/mutations", async ({ request }) => {
      const body = (await request.json()) as { op: Record<string, unknown> };
      sent.push(body.op);
      if (body.op.type === "move_task") {
        const id = body.op.task_id as string;
        const start = body.op.start_date as string;
        current = {
          ...current,
          tasks: current.tasks.map((task) =>
            task.id === id
              ? {
                  ...task,
                  start_date: start,
                  end_date: addDays(task.end_date, daysBetween(task.start_date, start)),
                }
              : task,
          ),
        };
      }
      return HttpResponse.json({ seq: sent.length, op: body.op, inverse: {} }, { status: 201 });
    }),
  );
  return sent;
}

/**
 * Единственное поведение, которое система выводит из связей.
 *
 * Даты по ним не пересчитываются — и проверять здесь надо ровно это: система
 * предлагает, но не двигает сама.
 */
describe("предложение подвинуть связанную задачу", () => {
  it("появляется, когда сдвинутая задача наехала на связанную", async () => {
    const sent = movingServer(WITH_DEPENDENCY);
    renderProject(WITH_DEPENDENCY);
    const bar = await screen.findByRole("button", { name: /Логотип/ });

    // «Логотип» идёт с 4 по 10 марта, «Макет» начинается 11-го. Сдвиг на пять
    // дней вправо ставит окончание предшественника на 15-е.
    dragDays(bar, 5);

    expect(
      await screen.findByRole("button", { name: /Подвинуть «Макет» на 5 дней/ }),
    ).toBeInTheDocument();
    // И ничего не подвинуто самим фактом предложения: ушла ровно одна
    // операция — та, которую сделал человек.
    expect(sent).toHaveLength(1);
  });

  it("двигает связанную задачу за край предшественника по одной кнопке", async () => {
    const sent = movingServer(WITH_DEPENDENCY);
    renderProject(WITH_DEPENDENCY);
    dragDays(await screen.findByRole("button", { name: /Логотип/ }), 5);

    await userEvent.click(await screen.findByRole("button", { name: /Подвинуть «Макет»/ }));

    await waitFor(() => expect(sent).toHaveLength(2));
    // На следующий день после окончания предшественника, а не «куда-нибудь
    // подальше»: предложение считает ровно перекрытие.
    expect(sent[1]).toMatchObject({
      type: "move_task",
      task_id: "t2",
      start_date: "2026-03-16",
    });
  });

  it("появляется и когда последователя поставили раньше конца предшественника", async () => {
    const sent = movingServer(WITH_DEPENDENCY);
    renderProject(WITH_DEPENDENCY);
    const bar = await screen.findByRole("button", { name: /Макет/ });

    // «Логотип» кончается 10 марта, «Макет» начинался 11-го. Сдвиг «Макета» на
    // пять дней влево ставит его на 6-е — поперёк собственной связи. Прежде
    // эта половина молчала: предложение знало только сдвиг предшественника.
    dragDays(bar, -5);

    // Предлагается подвинуть самого сдвинутого — на следующий день после
    // конца предшественника.
    await userEvent.click(await screen.findByRole("button", { name: /Подвинуть «Макет» на 5 дней/ }));

    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({
      type: "move_task",
      task_id: "t2",
      start_date: "2026-03-11",
    });
  });

  it("закрывается и больше не мешает", async () => {
    movingServer(WITH_DEPENDENCY);
    renderProject(WITH_DEPENDENCY);
    dragDays(await screen.findByRole("button", { name: /Логотип/ }), 5);
    await screen.findByRole("button", { name: /Подвинуть «Макет»/ });

    await userEvent.click(screen.getByRole("button", { name: "Закрыть предложение" }));

    expect(screen.queryByRole("button", { name: /Подвинуть «Макет»/ })).toBeNull();
  });

  it("молчит, когда связанная задача и так начинается после предшественника", async () => {
    const sent = movingServer(WITH_DEPENDENCY);
    renderProject(WITH_DEPENDENCY);
    const bar = await screen.findByRole("button", { name: /Логотип/ });

    // Влево: наезда не возникает.
    dragDays(bar, -3);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /Подвинуть/ })).toBeNull();
  });

  it("молчит, когда даты двигает автоперенос", async () => {
    // Предложение сделать сделанное читается как сбой: человек жмёт
    // «Подвинуть», ничего не происходит, и виноватой выглядит кнопка.
    const auto = { ...WITH_DEPENDENCY, auto_schedule: true };
    const sent = movingServer(auto);
    renderProject(auto);
    const bar = await screen.findByRole("button", { name: /Логотип/ });

    dragDays(bar, 5);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /Подвинуть/ })).toBeNull();
  });

  it("молчит, когда связей нет вовсе", async () => {
    const sent = movingServer({ ...WITH_DEPENDENCY, dependencies: [] });
    renderProject(WITH_DEPENDENCY);
    const bar = await screen.findByRole("button", { name: /Логотип/ });

    dragDays(bar, 5);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /Подвинуть/ })).toBeNull();
  });
});
