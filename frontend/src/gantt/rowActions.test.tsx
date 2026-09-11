import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import {
  STATE,
  THREE_TASKS,
  captureMutations,
  projectFixtures,
  renderProject,
} from "../test/project";
import { server } from "../test/server";
import { renderWithProviders } from "../test/utils";
import { Gantt } from "./Gantt";

/**
 * What a strip row shows on hover, and the "⋯" menu the row's secondary actions moved
 * into.
 *
 * The row used to answer only "when": the name, the dates, the bar. Everything else —
 * how much has already been said about this task, who is doing it, and "a row could go
 * here too" — lived in the card, that is, opened one task at a time. A plan, though, is
 * worked on looking at the whole list at once.
 *
 * Then this same "everything else" moved from the row (where it surfaced on hover and
 * ate room from the name) into a single "⋯" menu: the name gets the maximum width, and
 * the secondary actions are gathered in one predictable place.
 *
 * The "⋯" button is named identically on any row ("Task actions") — which row it
 * belongs to is said by `aria-describedby` rather than by the button's name (see
 * RowMenu). So the tests look for rows not by the button's caption but by the task's or
 * category's id — the same `data-testid` the panel itself is marked with.
 */

beforeEach(projectFixtures);

/** The reply counter on the named task's row. */
function comments(name: string) {
  return screen.queryByRole("img", { name: new RegExp(`Обсуждение «${name}»`) });
}

/** A task row's "⋯" menu by its id. */
async function openRowMenu(taskId: string) {
  await userEvent.click(await screen.findByTestId(`row-menu-${taskId}-button`));
}

/** A category row's "⋯" menu by its id. */
async function openCategoryMenu(categoryId: string) {
  await userEvent.click(await screen.findByTestId(`category-menu-${categoryId}-button`));
}

describe("обсуждение на строке", () => {
  it("показывает число реплик, не открывая карточку", async () => {
    server.use(
      http.get("/api/projects/p1/comments/counts", () => HttpResponse.json({ t1: 3 })),
    );
    renderProject();

    expect(await screen.findByLabelText("Обсуждение «Логотип»: 3 реплики")).toHaveTextContent(
      "3",
    );
  });

  it("щелчок по счётчику открывает карточку сразу на обсуждении", async () => {
    server.use(
      http.get("/api/projects/p1/comments/counts", () => HttpResponse.json({ t1: 1 })),
      http.get("/api/projects/p1/comments", () => HttpResponse.json([])),
    );
    renderProject();

    await userEvent.click(await screen.findByLabelText("Обсуждение «Логотип»: 1 реплика"));

    const panel = await screen.findByRole("complementary", { name: /Логотип/ });
    // The discussion specifically, not the properties: a counter that leads somewhere
    // other than it promised is an extra click on the tab on every opening.
    expect(within(panel).getByRole("tab", { name: "Комментарии" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("у задачи без реплик знака на строке нет — начинают разговор через «⋯»", async () => {
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });

    // A "0" on each of a hundred rows is a ripple in which the single row with a
    // conversation cannot be seen. There used to be an empty invitation sign staying
    // silent until hover in its place; now the row has not even that — a conversation
    // can only be started through the menu.
    expect(comments("Логотип")).not.toBeInTheDocument();

    await openRowMenu("t1");
    expect(await screen.findByRole("button", { name: "Добавить комментарий" })).toBeInTheDocument();
  });

  it("гостю число видно, а щёлкать по нему нечем", () => {
    // The public page: there is no task card there at all, and the sign stops being a
    // control — what is left is a caption with a number (see Bar in Row.tsx, where the
    // bar itself stops being a button the same way).
    renderWithProviders(
      <Gantt projectId="p1" state={STATE} commentCounts={new Map([["t1", 2]])} />,
      { locale: "ru" },
    );

    const badge = screen.getByLabelText("Обсуждение «Логотип»: 2 реплики");
    expect(badge).toHaveTextContent("2");
    expect(badge).not.toHaveClass("is-clickable");
  });

  it("гостю пустого знака нет: щёлкать по нему всё равно нечем", () => {
    renderWithProviders(<Gantt projectId="p1" state={STATE} />, { locale: "ru" });

    expect(comments("Логотип")).not.toBeInTheDocument();
  });
});

describe("исполнители со строки", () => {
  it("назначает человека, не открывая карточку", async () => {
    const sent = captureMutations();
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });

    await openRowMenu("t1");
    await userEvent.click(await screen.findByRole("button", { name: "Назначить исполнителя" }));
    await userEvent.click(await screen.findByRole("button", { name: /Мария/ }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toEqual({ type: "assign_user", task_id: "t1", user_id: "u2" });
    // The panel does not close after a choice: two and three people are put on a task in a row.
    expect(screen.getByTestId("row-menu-t1")).toBeInTheDocument();
  });

  it("повторный выбор снимает назначение", async () => {
    const sent = captureMutations();
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });

    await openRowMenu("t1");
    await userEvent.click(await screen.findByRole("button", { name: "Назначить исполнителя" }));
    await userEvent.click(await screen.findByRole("button", { name: /Мария/ }));
    await waitFor(() => expect(sent).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: /Мария/ }));

    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1].op).toEqual({ type: "unassign_user", task_id: "t1", user_id: "u2" });
  });

  it("Esc закрывает меню, ничего не назначив", async () => {
    const sent = captureMutations();
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });

    await openRowMenu("t1");
    await userEvent.click(await screen.findByRole("button", { name: "Назначить исполнителя" }));
    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByTestId("row-menu-t1")).not.toBeInTheDocument());
    expect(sent).toHaveLength(0);
  });

  it("читателю пункта нет: назначать он не может", async () => {
    renderProject(undefined, { canWrite: false });
    await screen.findByRole("button", { name: /Логотип/ });

    await openRowMenu("t1");
    expect(screen.queryByRole("button", { name: "Назначить исполнителя" })).not.toBeInTheDocument();
  });
});

describe("пустая категория", () => {
  // In STATE (see test/project.ts) only "Design" has tasks; "Development" is empty — that
  // is what explains the empty band.

  it("объясняет пустую полосу и заводит из неё первую задачу", async () => {
    renderProject(STATE);
    await screen.findByRole("button", { name: /Логотип/ });

    const hint = screen.getByRole("button", { name: "Задач пока нет — добавьте первую" });
    // The hint stands in its own category's band rather than as a separate strip row.
    expect(hint.closest(".gantt__row")).toHaveAttribute("data-drop-id", "c2");

    await userEvent.click(hint);
    expect(screen.getByRole("textbox", { name: "Новая задача в «Разработка»" })).toHaveFocus();
  });

  it("подсказка одна на ленту, и наполненной категории её не достаётся", async () => {
    renderProject(STATE);
    await screen.findByRole("button", { name: /Логотип/ });

    expect(document.querySelectorAll(".gantt__lane-hint")).toHaveLength(1);
  });

  it("подсказка уходит, как только в категорию открыли поле ввода", async () => {
    renderProject(STATE);
    await screen.findByRole("button", { name: /Логотип/ });

    await userEvent.click(screen.getByRole("button", { name: "Задач пока нет — добавьте первую" }));

    // "No tasks yet" next to an already open field would argue with the name being typed
    // on the line below.
    expect(document.querySelector(".gantt__lane-hint")).toBeNull();
  });

  it("«плюс» пустой категории виден без наведения, у наполненной — нет", async () => {
    renderProject(STATE);
    await screen.findByRole("button", { name: /Логотип/ });

    // The flag is on the row: the visibility itself is set by a style (see is-empty in
    // gantt.css), and jsdom does not compute styles.
    const rows = [...document.querySelectorAll(".gantt__row--category")];
    const byId = (id: string) => rows.find((row) => row.getAttribute("data-drop-id") === id);
    expect(byId("c2")).toHaveClass("is-empty");
    expect(byId("c1")).not.toHaveClass("is-empty");
  });

  it("читателю пустая полоса действия не обещает", async () => {
    renderProject(STATE, { canWrite: false });
    await screen.findByRole("button", { name: /Логотип/ });

    expect(document.querySelector(".gantt__lane-hint")).toBeNull();
  });
});

describe("вставка строки посередине", () => {
  /** The "plus" on the upper boundary of the named task's row — now an item in the "⋯" menu. */
  async function insert(taskId: string) {
    await openRowMenu(taskId);
    await userEvent.click(await screen.findByRole("button", { name: "Добавить задачу" }));
  }

  it("открывает поле ввода прямо над той строкой, на которую указали", async () => {
    renderProject(THREE_TASKS);
    await screen.findByRole("button", { name: /Первая/ });

    await insert("t2");

    const field = screen.getByRole("textbox", { name: "Новая задача в «Дизайн»" });
    expect(field).toHaveFocus();
    // The order of rows in the markup is the strip's order: the field stands between the
    // first and the second, not at the end of the category.
    const names = [...document.querySelectorAll(".gantt__row")].map(
      (row) =>
        row.querySelector(".gantt__label-name")?.textContent ??
        (row.querySelector("input") === null ? null : "поле"),
    );
    expect(names.filter(Boolean)).toEqual([
      "Дизайн",
      "Первая",
      "поле",
      "Вторая",
      "Третья",
      "Разработка",
    ]);
  });

  it("задача уходит на номер той строки, перед которой её завели", async () => {
    const sent = captureMutations();
    renderProject(THREE_TASKS);
    await screen.findByRole("button", { name: /Первая/ });

    await insert("t3");
    await userEvent.type(
      screen.getByRole("textbox", { name: "Новая задача в «Дизайн»" }),
      "Между{Enter}",
    );

    await waitFor(() => expect(sent).toHaveLength(1));
    // One operation rather than "create at the end" plus "reorder": the person made one
    // motion, and it is undone with one press.
    expect(sent[0].op).toMatchObject({ type: "create_task", name: "Между", position: 2 });
  });

  it("две подряд ложатся в набранном порядке, а не задом наперёд", async () => {
    const sent = captureMutations();
    renderProject(THREE_TASKS);
    await screen.findByRole("button", { name: /Первая/ });

    await insert("t2");
    await userEvent.type(
      screen.getByRole("textbox", { name: "Новая задача в «Дизайн»" }),
      "а{Enter}б{Enter}",
    );

    await waitFor(() => expect(sent).toHaveLength(2));
    // The first took "Second"'s number and pushed it down — so the next one goes to the
    // number below, otherwise "b" would end up above "a".
    expect(sent.map((row) => [row.op.name, row.op.position])).toEqual([
      ["а", 1],
      ["б", 2],
    ]);
  });

  it("вторая задача, набранная уже после ответа на первую, тоже встаёт перед названной", async () => {
    const sent = captureMutations();
    renderProject(THREE_TASKS);
    await screen.findByRole("button", { name: /Первая/ });

    await insert("t2");
    const field = () => screen.getByRole("textbox", { name: "Новая задача в «Дизайн»" });
    await userEvent.type(field(), "а{Enter}");
    // The server answered: "a" stands in "Second"'s place, and that one moved by one.
    // There is no pending row any more — the state already reflects the insertion.
    await waitFor(() => expect(document.querySelector(".gantt__row--pending")).toBeNull());
    await screen.findByText("а");

    await userEvent.type(field(), "б{Enter}");

    await waitFor(() => expect(sent).toHaveLength(2));
    // "Second"'s number is already 2 — and "b" goes to it rather than to 3 behind
    // "Second": the shift the server has already made is not added a second time.
    expect(sent.map((row) => [row.op.name, row.op.position])).toEqual([
      ["а", 1],
      ["б", 2],
    ]);
  });

  it("«плюс» на строке категории по-прежнему кладёт задачу в конец", async () => {
    const sent = captureMutations();
    renderProject(THREE_TASKS);
    await screen.findByRole("button", { name: /Первая/ });

    await userEvent.click(screen.getByRole("button", { name: "Добавить задачу в «Дизайн»" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Новая задача в «Дизайн»" }),
      "Последняя{Enter}",
    );

    await waitFor(() => expect(sent).toHaveLength(1));
    // No number is named at all: the end of the list is known by the server, and there is
    // no reason for the tab to compute it.
    expect(sent[0].op).not.toHaveProperty("position");
  });

  it("читателю пункта «Добавить задачу» на границе строк нет", async () => {
    renderProject(THREE_TASKS, { canWrite: false });
    await screen.findByRole("button", { name: /Первая/ });

    await openRowMenu("t1");
    expect(screen.queryByRole("button", { name: "Добавить задачу" })).not.toBeInTheDocument();
  });
});

describe("меню «⋯» задачи", () => {
  it("открывается вправо-вниз от кнопки и закрывается щелчком мимо", async () => {
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });

    await openRowMenu("t1");
    expect(screen.getByTestId("row-menu-t1")).toBeInTheDocument();

    // A click outside the panel — on the project's name, for example.
    await userEvent.click(document.body);
    await waitFor(() => expect(screen.queryByTestId("row-menu-t1")).not.toBeInTheDocument());
  });

  it("«Открыть задачу» открывает карточку и закрывает меню", async () => {
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });

    await openRowMenu("t1");
    await userEvent.click(await screen.findByRole("button", { name: "Открыть задачу" }));

    expect(await screen.findByRole("complementary", { name: /Логотип/ })).toBeInTheDocument();
    expect(screen.queryByTestId("row-menu-t1")).not.toBeInTheDocument();
  });

  it("«Дублировать» заводит копию задачи", async () => {
    const sent = captureMutations();
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });

    await openRowMenu("t1");
    await userEvent.click(await screen.findByRole("button", { name: "Дублировать" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toMatchObject({
      type: "create_task",
      category_id: "c1",
      name: "Логотип (копия)",
      start_date: "2026-03-04",
      duration_days: 5,
    });
  });

  it("«Переместить» переносит задачу в другую категорию", async () => {
    const sent = captureMutations();
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });

    await openRowMenu("t1");
    await userEvent.click(await screen.findByRole("button", { name: "Переместить" }));
    await userEvent.click(await screen.findByRole("button", { name: "Разработка" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toEqual({
      type: "reorder_task",
      task_id: "t1",
      category_id: "c2",
      position: 0,
    });
  });

  it("«Удалить» спрашивает подтверждение и удаляет только после него", async () => {
    const sent = captureMutations();
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });

    await openRowMenu("t1");
    await userEvent.click(await screen.findByRole("button", { name: "Удалить" }));

    // The question goes in the item's place rather than as a separate dialog: the deletion
    // has not happened yet, and it can be cancelled without closing the menu.
    expect(sent).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Отмена" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Да, удалить" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toEqual({ type: "delete_task", task_id: "t1" });
  });

  it("читателю остаётся «Открыть задачу», но не правки", async () => {
    renderProject(undefined, { canWrite: false });
    await screen.findByRole("button", { name: /Логотип/ });

    await openRowMenu("t1");
    expect(screen.getByRole("button", { name: "Открыть задачу" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Дублировать" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Удалить" })).not.toBeInTheDocument();
  });
});

describe("меню «⋯» категории", () => {
  it("«Переименовать категорию» открывает поле на месте названия", async () => {
    const sent = captureMutations();
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });

    await openCategoryMenu("c1");
    await userEvent.click(await screen.findByRole("button", { name: "Переименовать категорию" }));

    const field = screen.getByRole("textbox", { name: "Переименовать «Дизайн»" });
    expect(field).toHaveFocus();
    await userEvent.clear(field);
    await userEvent.type(field, "Вёрстка{Enter}");

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toEqual({ type: "rename_category", category_id: "c1", name: "Вёрстка" });
  });

  it("«Дублировать» заводит копию категории", async () => {
    const sent = captureMutations();
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });

    await openCategoryMenu("c1");
    await userEvent.click(await screen.findByRole("button", { name: "Дублировать" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).toEqual({ type: "create_category", name: "Дизайн (копия)", color: "#3b82f6" });
  });

  it("«Удалить категорию» спрашивает то же самое окно, что и крестик раньше", async () => {
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });

    await openCategoryMenu("c1");
    await userEvent.click(await screen.findByRole("button", { name: "Удалить категорию" }));

    expect(await screen.findByRole("dialog", { name: /Дизайн/ })).toBeInTheDocument();
  });

  it("читателю кнопки «⋯» на категории нет вовсе: строка ему только на чтение", async () => {
    renderProject(undefined, { canWrite: false });
    await screen.findByRole("button", { name: /Логотип/ });

    expect(screen.queryByTestId("category-menu-c1-button")).not.toBeInTheDocument();
  });
});
