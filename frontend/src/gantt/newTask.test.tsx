import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { STATE, captureMutations, projectFixtures, renderProject } from "../test/project";
import { server } from "../test/server";
import { RELATIVE_EPOCH } from "./relative";
import { startDayFor } from "./useQuickTask";

/**
 * Заведение задачи — строкой в ленте.
 *
 * Проверяется тот путь, которым задачи и заводят: «плюс» на категории, имя,
 * Enter, следующее имя. Раньше здесь открывалось окно на
 * девять полей, и на десяти задачах это было десять открытий и закрытий.
 */

beforeEach(projectFixtures);

/** Поле новой задачи в категории «Дизайн». */
function field() {
  return screen.getByRole("textbox", { name: "Новая задача в «Дизайн»" });
}

/**
 * Строка новой задачи открывается «плюсом» на строке категории.
 *
 * У самой последней категории то же имя для читалки носит и строка
 * «+ Добавить задачу» с низа ленты (см. `gantt/BottomActions.tsx`) — она
 * целится в ту же категорию, и оба «плюса» делают одно и то же. Здесь берём
 * именно строку категории: тест проверяет её собственный «плюс», а не низ
 * ленты, у которого своя проверка ниже.
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
    // Окна с девятью полями больше нет: имя спрашивается на месте, остальное
    // правится в карточке.
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
      // Сегодня в поясе проекта и один рабочий день: всё остальное у задачи
      // уже есть, и спрашивать это ради строки списка не за что.
      start_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      duration_days: 1,
    });

    // Задача приехала с сервера — строка ввода на месте, пустая и в фокусе:
    // следующую пишут сразу, не касаясь мыши.
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

    // Прежняя кнопка тулбара клала задачу в первую категорию, потому что не
    // знала, куда ещё. Теперь плюс стоит на том, чему добавляет ребёнка: на
    // строке категории — задачу, в углу таблицы — категорию.
    expect(screen.queryByRole("button", { name: "Новая задача" })).not.toBeInTheDocument();
    // Внутри угла таблицы: то же имя носит и «+ Новая категория» с низа ленты.
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
    // Предупреждение о ключе словаря здесь не нужно: сообщение об отказе
    // переведено, и падает тест не на нём.
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
    // Строка ожидания снята: задачи нет, и держать её имя на ленте значило бы
    // обещать несуществующее.
    await waitFor(() =>
      expect(screen.queryByText("Лишняя", { selector: ".gantt__label-name" })).not.toBeInTheDocument(),
    );
  });

  it("читателю строки не открыть: заводить задачи ему нечем", async () => {
    // Полоска у читателя по-прежнему кнопка: карточку задачи он открывает и
    // читает — не может он только менять.
    renderProject(undefined, { canWrite: false });
    await screen.findByRole("button", { name: /Логотип/ });

    expect(screen.queryByRole("button", { name: /Добавить задачу/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Новая задача" })).not.toBeInTheDocument();
  });
});

describe("день новой задачи", () => {
  // «Сегодня» здесь — просто аргумент: пояс читателя считает вызывающий, и
  // правило от него не зависит.
  it("у идущего этапа — сегодня: заведённая сегодня вчера не начиналась", () => {
    // «Дизайн» начался 4 марта, сегодня — 10-е: этап уже идёт.
    expect(startDayFor(STATE, "c1", "2026-03-10")).toBe("2026-03-10");
  });

  it("у будущего этапа — его начало, а не сегодня", () => {
    // Плана пишут наперёд: задача, поставленная на сегодня, уехала бы на месяц
    // левее собственного этапа и за пределы видимого окна.
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
    // Ответ задерживается: без задержки строка ожидания живёт доли секунды, и
    // проверить её нечем.
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

    // Имя уже на ленте — но не кнопкой: задачи ещё нет, открывать нечего.
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

      // Два созвона — две строки: ответ на первый не должен снимать второй.
      await waitFor(() =>
        expect(document.querySelectorAll(".gantt__row--pending")).toHaveLength(2),
      );
      release();
    } finally {
      vi.useRealTimers();
    }
  });
});
