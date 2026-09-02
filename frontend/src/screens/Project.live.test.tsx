import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../test/server";
import { STATE, captureMutations, projectFixtures, renderProject } from "../test/project";
import { FakeWebSocket, lastSocket } from "../test/socket";

/**
 * Экран проекта при живой связи и при её обрыве.
 *
 * Сокет здесь подделан (см. test/socket.ts), а сервер — перехвачен: проверяется
 * поведение экрана, а не то, умеет ли jsdom ходить в сеть.
 */

/** Приводит экран в состояние «связь была и оборвалась». */
async function goOffline() {
  await act(async () => lastSocket().accept());
  await act(async () => lastSocket().drop());
}

/**
 * «Плюс» в углу таблицы — не «+ Новая категория» с низа ленты (см.
 * `gantt/BottomActions.tsx`): у обеих одно и то же имя для читалки, а обрыв
 * связи гасит только этот — вместе с остальными «плюсами» ленты он приходит
 * только пока проект можно править (см. `editable` в Project.tsx). Строка
 * снизу ленты о разрыве не знает вовсе и остаётся нажимаемой: она полагается
 * на общий запрет в `useProjectMutation`, а не на собственный признак.
 */
function cornerAddCategoryButton() {
  const corner = document.querySelector(".gantt__corner") as HTMLElement;
  return within(corner).queryByRole("button", { name: "Новая категория" });
}

beforeEach(projectFixtures);

describe("экран проекта при обрыве связи", () => {
  it("говорит, что связи нет и на какой момент показаны данные", async () => {
    // Часы прибиты гвоздями: иначе тест проверял бы текущее время, то есть
    // ничего. 14:32 по местному — то самое время из спецификации.
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

    // «Плюсы» ленты уходят вместе с правом писать: кнопка, обещающая
    // действие, которое сервер отклонит, хуже отсутствующей.
    expect(cornerAddCategoryButton()).toBeNull();
    expect(screen.queryByRole("button", { name: /Добавить задачу/ })).not.toBeInTheDocument();
  });

  it("не отправляет изменений, пока связи нет", async () => {
    // Жесты ходят мимо кнопок шапки, поэтому проверяется именно жест. Сам
    // общий путь изменений заперт отдельно — см. useProjectMutation.test.tsx:
    // без этого запрет держался бы на одной лишь разметке.
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

    // Переподключение: следующий сокет открывается по таймеру отката.
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    await act(async () => lastSocket().accept());

    await waitFor(() => expect(cornerAddCategoryButton()).toBeEnabled());
    expect(screen.queryByText(/нет связи/i)).not.toBeInTheDocument();
  });

  it("показывает изменение, пришедшее от соседа, без перезагрузки", async () => {
    renderProject(STATE);
    await screen.findByRole("button", { name: /Логотип/ });
    await act(async () => lastSocket().accept());

    // Сосед переименовал задачу: сервер отдаёт уже новое состояние, а сокет
    // сообщает, что состояние изменилось.
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
    // Раскладка без WebSocket: сокет не открывается ни разу. Живых обновлений
    // нет, но экран остаётся рабочим — иначе serverless-раскладка молча
    // превращается в приложение для чтения.
    renderProject(STATE);
    await screen.findByRole("button", { name: /Логотип/ });

    await act(async () => lastSocket().drop());

    expect(screen.queryByText(/нет связи/i)).not.toBeInTheDocument();
    expect(cornerAddCategoryButton()).toBeEnabled();
  });
});
