import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../test/server";
import { STATE, captureMutations, projectFixtures, renderProject } from "../test/project";
import { FakeWebSocket, lastSocket } from "../test/socket";

/**
 * The project screen with a live connection and when it drops.
 *
 * The socket here is faked (see test/socket.ts) and the server is intercepted: what is checked is
 * the screen's behaviour rather than whether jsdom can reach the network.
 */

/** Brings the screen into the "there was a connection and it dropped" state. */
async function goOffline() {
  await act(async () => lastSocket().accept());
  await act(async () => lastSocket().drop());
}

/**
 * The "plus" in the table's corner — not "+ New category" at the bottom of the strip (see
 * `gantt/BottomActions.tsx`): both carry the same name for a screen reader, while a dropped
 * connection disables only this one — along with the strip's other "pluses" it only arrives while
 * the project can be edited (see `editable` in Project.tsx). The row at the bottom of the strip
 * knows nothing about the drop and stays pressable: it relies on the shared ban in
 * `useProjectMutation` rather than on a flag of its own.
 */
function cornerAddCategoryButton() {
  const corner = document.querySelector(".gantt__corner") as HTMLElement;
  return within(corner).queryByRole("button", { name: "Новая категория" });
}

beforeEach(projectFixtures);

describe("экран проекта при обрыве связи", () => {
  it("говорит, что связи нет и на какой момент показаны данные", async () => {
    // The clock is nailed down: otherwise the test would be checking the current time, that is,
    // nothing. 14:32 local is the very time from the specification.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 2, 11, 14, 32));

    renderProject(STATE);
    await screen.findByRole("button", { name: /Логотип/ });
    await goOffline();

    const bar = await screen.findByText(/нет связи/i);
    expect(bar).toHaveTextContent("14:32");
    vi.useRealTimers();
  });

  it("запирает редактирование, пока связи нет", async () => {
    renderProject(STATE);
    await screen.findByRole("button", { name: /Логотип/ });
    expect(cornerAddCategoryButton()).toBeEnabled();

    await goOffline();

    // The strip's "pluses" go along with the right to write: a button promising an action the
    // server will reject is worse than a missing one.
    expect(cornerAddCategoryButton()).toBeNull();
    expect(screen.queryByRole("button", { name: /Добавить задачу/ })).not.toBeInTheDocument();
  });

  it("не отправляет изменений, пока связи нет", async () => {
    // Gestures go past the header's buttons, so what is checked is precisely a gesture. The shared
    // change path itself is locked separately — see useProjectMutation.test.tsx: without that the
    // ban would rest on the markup alone.
    const user = userEvent.setup();
    const sent = captureMutations();

    renderProject(STATE);
    const bar = await screen.findByRole("button", { name: /Логотип/ });
    await goOffline();

    bar.focus();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");

    expect(sent).toHaveLength(0);
  });

  it("возвращает редактирование, когда связь восстановилась", async () => {
    renderProject(STATE);
    await screen.findByRole("button", { name: /Логотип/ });
    await goOffline();
    expect(cornerAddCategoryButton()).toBeNull();

    // Reconnection: the next socket opens by the backoff timer.
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    await act(async () => lastSocket().accept());

    await waitFor(() => expect(cornerAddCategoryButton()).toBeEnabled());
    expect(screen.queryByText(/нет связи/i)).not.toBeInTheDocument();
  });

  it("показывает изменение, пришедшее от соседа, без перезагрузки", async () => {
    renderProject(STATE);
    await screen.findByRole("button", { name: /Логотип/ });
    await act(async () => lastSocket().accept());

    // A colleague renamed the task: the server gives the new state already, and the socket reports
    // that the state has changed.
    const renamed = { ...STATE, tasks: [{ ...STATE.tasks[0], name: "Знак" }] };
    server.use(http.get("/api/projects/p1", () => HttpResponse.json(renamed)));

    await act(async () =>
      lastSocket().emit({
        type: "revision",
        seq: 2,
        created_at: "2026-03-11T09:00:00+00:00",
        actor: { id: "u2", name: "Мария" },
        reason: null,
        op: { type: "set_task_fields", task_id: "t1" },
      }),
    );

    expect(await screen.findByRole("button", { name: /Знак/ })).toBeInTheDocument();
  });

  it("не мешает работать там, где живой связи не бывает вовсе", async () => {
    // A deployment without WebSocket: the socket never opens. There are no live updates, but the
    // screen stays workable — otherwise a serverless deployment silently turns into a read-only
    // application.
    renderProject(STATE);
    await screen.findByRole("button", { name: /Логотип/ });

    await act(async () => lastSocket().drop());

    expect(screen.queryByText(/нет связи/i)).not.toBeInTheDocument();
    expect(cornerAddCategoryButton()).toBeEnabled();
  });
});
