import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import type { ProjectState } from "../api/projects";
import { STATE, projectFixtures, renderProject } from "../test/project";
import { server } from "../test/server";

beforeEach(projectFixtures);

/** Проект, в котором сервер назвал последнее изменение отменяемым. */
const UNDOABLE: ProjectState = {
  ...STATE,
  undoable: {
    seq: 7,
    op: { type: "move_task", task_id: "t1", from: "2026-03-04", to: "2026-03-11" },
    batch_id: null,
  },
};

/** Считает обращения к отмене и отвечает так же, как сервер. */
function countUndo(): () => number {
  let called = 0;
  server.use(
    http.post("/api/projects/p1/undo", () => {
      called += 1;
      return HttpResponse.json({ seq: 8 }, { status: 201 });
    }),
  );
  return () => called;
}

/** Лента отрисована — с этого момента горячая клавиша уже слушает. */
async function drawn() {
  return screen.findByRole("button", { name: /Логотип/ });
}

describe("отмена с клавиатуры", () => {
  it("Ctrl+Z отменяет последнее изменение проекта", async () => {
    const undone = countUndo();
    renderProject(UNDOABLE);
    await drawn();

    await userEvent.keyboard("{Control>}z{/Control}");

    await waitFor(() => expect(undone()).toBe(1));
    // Тост обязателен: на вкладке истории отменённое изменение иначе выглядит
    // как ничего не произошло, и человек жмёт клавишу второй раз.
    expect(await screen.findByRole("status")).toHaveTextContent("Изменение отменено");
  });

  it("работает и на вкладке истории — отменяется проект, а не то, что под фокусом", async () => {
    const undone = countUndo();
    // Лента истории спрашивает и летопись согласований: тесту она не нужна,
    // но неописанный запрос оснастка считает ошибкой теста.
    server.use(http.get("/api/projects/p1/plan/approvals", () => HttpResponse.json([])));
    renderProject(UNDOABLE, { route: "/projects/p1/history" });
    await screen.findByRole("region", { name: "История" });

    await userEvent.keyboard("{Control>}z{/Control}");

    await waitFor(() => expect(undone()).toBe(1));
  });

  it("отказ объявляет тревогой, а не сводкой с галочкой", async () => {
    // Клавиша — единственный источник ответа: строки ошибки рядом с лентой
    // нет. Отказ, показанный тоном подтверждения, сообщает ровно обратное
    // тому, что случилось: отмена не прошла, а тост носит галочку.
    server.use(
      http.post("/api/projects/p1/undo", () =>
        HttpResponse.json({ detail: "undo_conflict" }, { status: 409 }),
      ),
    );
    renderProject(UNDOABLE);
    await drawn();

    await userEvent.keyboard("{Control>}z{/Control}");

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveClass("toast--error");
    expect(failure).not.toHaveTextContent("✓");
  });

  it("отвечает и тогда, когда отменять нечего", async () => {
    const undone = countUndo();
    renderProject(STATE);
    await drawn();

    await userEvent.keyboard("{Control>}z{/Control}");

    // Молчание читалось бы как сломанная клавиша.
    expect(await screen.findByRole("status")).toHaveTextContent("Отменять нечего");
    expect(undone()).toBe(0);
  });

  it("не трогает отмену внутри поля ввода", async () => {
    const undone = countUndo();
    renderProject(UNDOABLE);
    await drawn();

    // Поле заводится руками, а не через форму: форма — это ещё и окно, а окно
    // запирает отмену своим правилом, и тест перестал бы проверять то, что
    // написано в его названии.
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    await userEvent.keyboard("{Control>}z{/Control}");
    field.remove();

    expect(undone()).toBe(0);
  });

  it("молчит, пока открыто окно", async () => {
    const undone = countUndo();
    renderProject(UNDOABLE);
    await drawn();

    // «Плюс» в углу таблицы, а не «+ Новая категория» с низа ленты: у обеих
    // кнопок одно и то же имя для читалки — они делают одно и то же, — и
    // различает их только место (см. `gantt/BottomActions.tsx`).
    const corner = document.querySelector(".gantt__corner") as HTMLElement;
    await userEvent.click(within(corner).getByRole("button", { name: "Новая категория" }));
    const dialog = await screen.findByRole("dialog");
    // Фокус — на кнопке окна, а не в его поле: правило про поля ввода здесь
    // ни при чём, проверяется именно открытое окно.
    within(dialog).getByRole("button", { name: "Отмена" }).focus();
    await userEvent.keyboard("{Control>}z{/Control}");

    expect(undone()).toBe(0);
  });

  it("Ctrl+Shift+Z ничего не отменяет: возврата у нас нет", async () => {
    const undone = countUndo();
    renderProject(UNDOABLE);
    await drawn();

    await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");

    expect(undone()).toBe(0);
  });

  it("читателю клавиша недоступна — как и кнопка", async () => {
    const undone = countUndo();
    renderProject(UNDOABLE, { canWrite: false });
    await drawn();

    await userEvent.keyboard("{Control>}z{/Control}");

    expect(undone()).toBe(0);
  });
});
