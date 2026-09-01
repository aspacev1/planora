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
 * То, что строка ленты показывает при наведении, и меню «⋯», куда переехали
 * вторичные действия строки.
 *
 * Раньше строка отвечала только на «когда»: имя, даты, полоска. Всё
 * остальное — сколько об этой задаче уже сказано, кто её делает, и «а сюда бы
 * ещё одну строку» — жило в карточке, то есть открывалось по одной задаче за
 * раз. Планом же занимаются, глядя на весь список сразу.
 *
 * Дальше это же «всё остальное» перебралось со строки (где оно всплывало по
 * наведению и отъедало место у имени) в единое меню «⋯»: имя получает
 * максимум ширины, а вторичные действия собраны в одном предсказуемом месте.
 *
 * Кнопка «⋯» названа одинаково на любой строке («Действия с задачей») —
 * какой строке она принадлежит, говорит `aria-describedby`, а не имя кнопки
 * (см. RowMenu). Поэтому строки в тестах ищут не по подписи кнопки, а по
 * идентификатору задачи или категории — тем же `data-testid`, которым
 * помечена и сама панель.
 */

beforeEach(projectFixtures);

/** Счётчик реплик на строке названной задачи. */
function comments(name: string) {
  return screen.queryByRole("img", { name: new RegExp(`Обсуждение «${name}»`) });
}

/** Меню «⋯» строки задачи по её идентификатору. */
async function openRowMenu(taskId: string) {
  await userEvent.click(await screen.findByTestId(`row-menu-${taskId}-button`));
}

/** Меню «⋯» строки категории по её идентификатору. */
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
    // Именно обсуждение, а не свойства: счётчик, приводящий не туда, куда
    // обещал, — это лишний щелчок по вкладке на каждое открытие.
    expect(within(panel).getByRole("tab", { name: "Комментарии" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("у задачи без реплик знака на строке нет — начинают разговор через «⋯»", async () => {
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });

    // «0» на каждой из ста строк — рябь, в которой не видно единственной
    // строки с разговором. Раньше на её месте молчал до наведения пустой
    // знак-приглашение; теперь на строке нет и его — начать разговор можно
    // только через меню.
    expect(comments("Логотип")).not.toBeInTheDocument();

    await openRowMenu("t1");
    expect(await screen.findByRole("button", { name: "Добавить комментарий" })).toBeInTheDocument();
  });

  it("гостю число видно, а щёлкать по нему нечем", () => {
    // Публичная страница: карточки задачи там нет вовсе, и знак перестаёт быть
    // органом управления — остаётся подписью с числом (см. Bar в Row.tsx, где
    // тем же образом перестаёт быть кнопкой сама полоска).
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
    // Панель не закрывается после выбора: на задачу сажают двоих и троих подряд.
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
  // В STATE (см. test/project.ts) задачи есть только у «Дизайна»; «Разработка»
  // пуста — она и объясняет пустую полосу.

  it("объясняет пустую полосу и заводит из неё первую задачу", async () => {
    renderProject(STATE);
    await screen.findByRole("button", { name: /Логотип/ });

    const hint = screen.getByRole("button", { name: "Задач пока нет — добавьте первую" });
    // Подсказка стоит в полосе своей категории, а не отдельной строкой ленты.
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

    // «Задач пока нет» рядом с уже открытым полем спорило бы с набираемым
    // именем строкой ниже.
    expect(document.querySelector(".gantt__lane-hint")).toBeNull();
  });

  it("«плюс» пустой категории виден без наведения, у наполненной — нет", async () => {
    renderProject(STATE);
    await screen.findByRole("button", { name: /Логотип/ });

    // Признак — на строке: сама видимость задана стилем (см. is-empty в
    // gantt.css), а jsdom стилей не считает.
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
  /** «Плюс» на верхней границе строки названной задачи — теперь пункт меню «⋯». */
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
    // Порядок строк в разметке — это и есть порядок ленты: поле стоит между
    // первой и второй, а не в конце категории.
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
    // Одна операция, а не «создать в конце» плюс «переставить»: человек сделал
    // одно движение, и отменяется оно одним нажатием.
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
    // Первая заняла номер «Второй» и сдвинула её вниз — значит, следующая
    // встаёт на номер ниже, иначе «б» оказалась бы над «а».
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
    // Номер не назван вовсе: конец списка знает сервер, и вкладке его считать
    // не за чем.
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

    // Щелчок вне панели — по названию проекта, например.
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

    // Вопрос — на месте пункта, а не отдельным окном: удаление ещё не
    // случилось, и отменить его можно, не закрывая меню.
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
