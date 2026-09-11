import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { STATE, captureMutations, projectFixtures, renderProject } from "../test/project";
import { server } from "../test/server";
import { RELATIVE_EPOCH } from "./relative";
import { startDayFor } from "./useQuickTask";

/**
 * Creating a task — as a row in the strip.
 *
 * What is checked is the path tasks are actually created by: the "plus" on a category, the
 * name, Enter, the next name. A dialog with nine fields used to open here, and with ten tasks
 * that was ten openings and closings.
 */

beforeEach(projectFixtures);

/** The new task field in the "Design" category. */
function field() {
  return screen.getByRole("textbox", { name: "Новая задача в «Дизайн»" });
}

/**
 * The new task row is opened by the "plus" on a category's row.
 *
 * For the very last category the "+ Add task" row at the bottom of the strip carries the same
 * name for the screen reader (see `gantt/BottomActions.tsx`) — it aims at the same category,
 * and both "pluses" do the same thing. Here we take the category's row specifically: the test
 * checks its own "plus" rather than the bottom of the strip, which has its own check below.
 */
async function openRow(category = "Дизайн") {
  const buttons = screen.getAllByRole("button", { name: `Добавить задачу в «${category}»` });
  const button = buttons.find((candidate) => candidate.closest(".gantt__row--category")) ?? buttons[0];
  await userEvent.click(button);
}

describe("новая задача", () => {
  it("«плюс» открывает строку в ленте, а не окно", async () => {
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });

    await openRow();

    expect(field()).toHaveFocus();
    // There is no dialog with nine fields any more: the name is asked for in place, the rest is
    // edited in the card.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Enter создаёт задачу и оставляет строку открытой для следующей", async () => {
    const sent = captureMutations();
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });
    await openRow();

    await userEvent.type(field(), "Макет{Enter}");

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toEqual({
      type: "create_task",
      category_id: "c1",
      name: "Макет",
      // Today in the project's zone and one working day: the task already has everything else,
      // and there is no reason to ask for it for the sake of a list row.
      start_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      duration_days: 1,
    });

    // The task arrived from the server — the input row is in place, empty and focused: the next
    // one is written straight away without touching the mouse.
    expect(await screen.findByRole("button", { name: /Макет/ })).toBeInTheDocument();
    expect(field()).toHaveValue("");
    expect(field()).toHaveFocus();
  });

  it("две задачи подряд — двумя Enter, без единого щелчка", async () => {
    const sent = captureMutations();
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });
    await openRow();

    await userEvent.type(field(), "Макет{Enter}Вёрстка{Enter}");

    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map((row) => row.op.name)).toEqual(["Макет", "Вёрстка"]);
    expect(await screen.findByRole("button", { name: /Вёрстка/ })).toBeInTheDocument();
  });

  it("пустой Enter закрывает строку, ничего не отправив", async () => {
    const sent = captureMutations();
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });
    await openRow();

    await userEvent.type(field(), "{Enter}");

    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Новая задача в «Дизайн»" }),
      ).not.toBeInTheDocument(),
    );
    expect(sent).toHaveLength(0);
  });

  it("Esc закрывает строку и набранное не отправляет", async () => {
    const sent = captureMutations();
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });
    await openRow();

    await userEvent.type(field(), "Передумал{Escape}");

    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Новая задача в «Дизайн»" }),
      ).not.toBeInTheDocument(),
    );
    expect(sent).toHaveLength(0);
  });

  it("уход фокуса сохраняет набранное: имя не пропадает от щелчка мимо", async () => {
    const sent = captureMutations();
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });
    await openRow();

    await userEvent.type(field(), "Макет");
    await userEvent.click(await screen.findByRole("button", { name: /Логотип/ }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toMatchObject({ type: "create_task", name: "Макет" });
  });

  it("кнопки «Новая задача» над лентой нет: задачу заводят на её категории", async () => {
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });

    // The former toolbar button put a task into the first category, because it did not know
    // where else. Now the plus stands on what it adds a child to: on a category's row a task, in
    // the table's corner a category.
    expect(screen.queryByRole("button", { name: "Новая задача" })).not.toBeInTheDocument();
    // Inside the table's corner: "+ New category" at the bottom of the strip carries the same name.
    const corner = document.querySelector(".gantt__corner") as HTMLElement;
    expect(within(corner).getByRole("button", { name: "Новая категория" })).toBeInTheDocument();
  });

  it("задача заводится в той категории, чей «плюс» нажали", async () => {
    const sent = captureMutations();
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });

    await openRow("Разработка");
    await userEvent.type(
      screen.getByRole("textbox", { name: "Новая задача в «Разработка»" }),
      "Каркас{Enter}",
    );

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toMatchObject({ category_id: "c2", name: "Каркас" });
  });

  it("свёрнутая категория раскрывается: поля, которого не видно, не бывает", async () => {
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });

    await userEvent.click(screen.getByRole("button", { name: "Свернуть или развернуть «Дизайн»" }));
    expect(screen.queryByRole("button", { name: /Логотип/ })).not.toBeInTheDocument();

    await openRow();

    expect(field()).toHaveFocus();
    expect(screen.getByRole("button", { name: /Логотип/ })).toBeInTheDocument();
  });

  it("отказ сервера объясняется словами, а не исчезновением строки", async () => {
    // No warning about a dictionary key is needed here: the refusal message is translated, and
    // the test is not failing on it.
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });
    server.use(
      http.post("/api/projects/p1/mutations", () =>
        HttpResponse.json({ detail: "task_limit_reached" }, { status: 400 }),
      ),
    );
    await openRow();

    await userEvent.type(field(), "Лишняя{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent(/задач/i);
    // The pending row is removed: the task is not there, and holding its name on the strip would
    // promise something that does not exist.
    await waitFor(() =>
      expect(screen.queryByText("Лишняя", { selector: ".gantt__label-name" })).not.toBeInTheDocument(),
    );
  });

  it("читателю строки не открыть: заводить задачи ему нечем", async () => {
    // For a reader the bar is still a button: they open and read the task's card — the only thing
    // they cannot do is change it.
    renderProject(undefined, { canWrite: false });
    await screen.findByRole("button", { name: /Логотип/ });

    expect(screen.queryByRole("button", { name: /Добавить задачу/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Новая задача" })).not.toBeInTheDocument();
  });
});

describe("день новой задачи", () => {
  // "Today" here is just an argument: the reader's zone is computed by the caller, and the rule
  // does not depend on it.
  it("у идущего этапа — сегодня: заведённая сегодня вчера не начиналась", () => {
    // "Design" started on 4 March, today is the 10th: the stage is already under way.
    expect(startDayFor(STATE, "c1", "2026-03-10")).toBe("2026-03-10");
  });

  it("у будущего этапа — его начало, а не сегодня", () => {
    // Plans are written in advance: a task placed on today would travel a month to the left of
    // its own stage and outside the visible window.
    expect(startDayFor(STATE, "c1", "2026-02-01")).toBe("2026-03-04");
  });

  it("у пустого этапа — сегодня: начала у него ещё нет", () => {
    expect(startDayFor(STATE, "c2", "2026-02-01")).toBe("2026-02-01");
  });

  it("у плана без дат считает от первого дня проекта, а не от сегодня", () => {
    const relative = { ...STATE, schedule_mode: "relative" as const, tasks: [] };
    expect(startDayFor(relative, "c1", "2026-02-01")).toBe(RELATIVE_EPOCH);
  });
});

describe("строка ожидания", () => {
  it("имя видно сразу, а полоска — только когда сервер ответил", async () => {
    // The answer is delayed: without a delay the pending row lives for fractions of a second, and
    // there is nothing to check it with.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });
    server.use(
      http.post("/api/projects/p1/mutations", async () => {
        await held;
        return HttpResponse.json({ seq: 1, op: {}, inverse: {} }, { status: 201 });
      }),
    );
    await openRow();

    await userEvent.type(field(), "Макет{Enter}");

    // The name is already on the strip — but not as a button: the task is not there yet, there is nothing to open.
    const pending = await screen.findByText("Макет", { selector: ".gantt__label-name" });
    expect(pending.closest(".gantt__row")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("button", { name: /Макет/ })).not.toBeInTheDocument();

    release();
    await waitFor(() =>
      expect(document.querySelector(".gantt__row--pending")).not.toBeInTheDocument(),
    );
  });

  it("одинаковые имена ждут порознь", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      renderProject();
      await screen.findByRole("button", { name: /Логотип/ });
      server.use(
        http.post("/api/projects/p1/mutations", async () => {
          await held;
          return HttpResponse.json({ seq: 1, op: {}, inverse: {} }, { status: 201 });
        }),
      );
      await user.click(screen.getByRole("button", { name: "Добавить задачу в «Дизайн»" }));

      await user.type(field(), "Созвон{Enter}Созвон{Enter}");

      // Two calls are two rows: the answer to the first must not remove the second.
      await waitFor(() =>
        expect(document.querySelectorAll(".gantt__row--pending")).toHaveLength(2),
      );
      release();
    } finally {
      vi.useRealTimers();
    }
  });
});
