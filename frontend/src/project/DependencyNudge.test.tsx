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
 * A server that moves the end along with the start.
 *
 * The shared harness deliberately does not: it has no calendar, and an end recomputed "by eye"
 * would diverge from the real one on the very first holiday. Here the recomputation cannot be
 * avoided — the nudge is computed precisely from the predecessor's end — so the calendar shift
 * lives in exactly this file, where the dates are picked without holidays.
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
 * The only behaviour the system derives from links.
 *
 * Dates are not recomputed along them — and that is exactly what has to be checked here: the system
 * offers but does not move on its own.
 */
describe("предложение подвинуть связанную задачу", () => {
  it("появляется, когда сдвинутая задача наехала на связанную", async () => {
    const sent = movingServer(WITH_DEPENDENCY);
    renderProject(WITH_DEPENDENCY);
    const bar = await screen.findByRole("button", { name: /Логотип/ });

    // "Logo" runs from 4 to 10 March, "Mockup" starts on the 11th. A five-day shift to the right
    // puts the predecessor's end on the 15th.
    dragDays(bar, 5);

    expect(
      await screen.findByRole("button", { name: /Подвинуть «Макет» на 5 дней/ }),
    ).toBeInTheDocument();
    // And nothing was moved by the mere fact of the nudge: exactly one operation left — the one the
    // person made.
    expect(sent).toHaveLength(1);
  });

  it("двигает связанную задачу за край предшественника по одной кнопке", async () => {
    const sent = movingServer(WITH_DEPENDENCY);
    renderProject(WITH_DEPENDENCY);
    dragDays(await screen.findByRole("button", { name: /Логотип/ }), 5);

    await userEvent.click(await screen.findByRole("button", { name: /Подвинуть «Макет»/ }));

    await waitFor(() => expect(sent).toHaveLength(2));
    // To the day after the predecessor's end rather than "somewhere further away": the nudge
    // computes exactly the overlap.
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

    // "Logo" ends on 10 March, "Mockup" started on the 11th. Shifting "Mockup" five days to the left
    // puts it on the 6th — across its own link. This half used to stay silent: the nudge knew only
    // about a predecessor's shift.
    dragDays(bar, -5);

    // What is offered is to move the one that was shifted — to the day after the predecessor's end.
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

    // To the left: no overlap arises.
    dragDays(bar, -3);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /Подвинуть/ })).toBeNull();
  });

  it("молчит, когда даты двигает автоперенос", async () => {
    // An offer to do what is done reads as a glitch: the person presses "Move", nothing happens, and
    // the button is the one that looks guilty.
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
