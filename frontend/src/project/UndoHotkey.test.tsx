import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import type { ProjectState } from "../api/projects";
import { STATE, projectFixtures, renderProject } from "../test/project";
import { server } from "../test/server";

beforeEach(projectFixtures);

/** A project where the server named the last change undoable. */
const UNDOABLE: ProjectState = {
  ...STATE,
  undoable: {
    seq: 7,
    op: { type: "move_task", task_id: "t1", from: "2026-03-04", to: "2026-03-11" },
    batch_id: null,
  },
};

/** Counts the calls to undo and answers the same way the server does. */
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

/** The strip is rendered — from this moment the hotkey is already listening. */
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
    // The toast is mandatory: on the history tab an undone change otherwise looks as if nothing
    // happened, and the person presses the key a second time.
    expect(await screen.findByRole("status")).toHaveTextContent("Изменение отменено");
  });

  it("работает и на вкладке истории — отменяется проект, а не то, что под фокусом", async () => {
    const undone = countUndo();
    // The history feed also asks for the approval chronicle: the test does not need it, but the
    // harness counts an undeclared request as the test's error.
    server.use(http.get("/api/projects/p1/plan/approvals", () => HttpResponse.json([])));
    renderProject(UNDOABLE, { route: "/projects/p1/history" });
    await screen.findByRole("region", { name: "История" });

    await userEvent.keyboard("{Control>}z{/Control}");

    await waitFor(() => expect(undone()).toBe(1));
  });

  it("отказ объявляет тревогой, а не сводкой с галочкой", async () => {
    // The key is the only source of an answer: there is no error line next to the strip. A refusal
    // shown in the confirmation tone reports exactly the opposite of what happened: the undo did not
    // go through while the toast carries a tick.
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

    // Silence would read as a broken key.
    expect(await screen.findByRole("status")).toHaveTextContent("Отменять нечего");
    expect(undone()).toBe(0);
  });

  it("не трогает отмену внутри поля ввода", async () => {
    const undone = countUndo();
    renderProject(UNDOABLE);
    await drawn();

    // The field is created by hand rather than through the form: a form is also a dialog, and a
    // dialog locks the undo by its own rule, and the test would stop checking what its name says.
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

    // The "plus" in the table's corner rather than "+ New category" at the bottom of the strip: both
    // buttons carry the same name for a screen reader — they do the same thing — and only the place
    // tells them apart (see `gantt/BottomActions.tsx`).
    const corner = document.querySelector(".gantt__corner") as HTMLElement;
    await userEvent.click(within(corner).getByRole("button", { name: "Новая категория" }));
    const dialog = await screen.findByRole("dialog");
    // The focus is on the dialog's button rather than in its field: the rule about input fields has
    // nothing to do with it here, what is checked is precisely an open dialog.
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

  it("на русской раскладке та же клавиша отменяет: «я» на физической KeyZ", async () => {
    const undone = countUndo();
    renderProject(UNDOABLE);
    await drawn();

    await userEvent.keyboard("{Control>}[KeyZ]{/Control}");

    await waitFor(() => expect(undone()).toBe(1));
  });

  it("Ctrl+Y на немецкой раскладке — не отмена, хотя стоит на физической KeyZ", async () => {
    const undone = countUndo();
    renderProject(UNDOABLE);
    await drawn();

    // On QWERTZ the letter "y" lives on the key with the code KeyZ. The combination at that is the
    // commonly accepted "redo", and undoing by it would be the opposite action.
    await drawn().then((node) =>
      node.dispatchEvent(
        new KeyboardEvent("keydown", { key: "y", code: "KeyZ", ctrlKey: true, bubbles: true }),
      ),
    );

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
