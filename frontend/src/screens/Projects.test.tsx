import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";

import type { ProjectState, Task } from "../api/projects";
import { server } from "../test/server";
import { ORG, USER, renderApp, sessionHandlers } from "../test/utils";

/** Открыть окно, набрать название, отправить. */
async function createProjectNamed(name: string) {
  await userEvent.click(await screen.findByRole("button", { name: /создать проект/i }));
  await userEvent.type(screen.getByLabelText(/название/i), name);
  await userEvent.click(screen.getByRole("button", { name: /^создать$/i }));
}

/**
 * Спокойная задача: согласована, идёт своим ходом, кончается впереди. Всё
 * остальное — просрочку, блокировку, расхождение — тест объявляет сам.
 */
function task(fields: Partial<Task> = {}): Task {
  return {
    id: "t1",
    category_id: "c1",
    name: "Логотип",
    start_date: "2026-03-16",
    end_date: "2026-03-20",
    duration_days: 5,
    milestone: false,
    critical: false,
    criticality: "normal",
    risk: "green",
    risk_note: "",
    status: "in_progress",
    progress_pct: 40,
    position: 0,
    assignee_ids: [],
    baseline_start: "2026-03-16",
    baseline_duration: 5,
    baseline_end: "2026-03-20",
    ...fields,
  };
}

function state(fields: Partial<ProjectState> = {}): ProjectState {
  return {
    id: "p1",
    name: "Редизайн",
    slug: "redizayn",
    deadline: null,
    project_end: "2026-03-20",
    schedule_mode: "calendar",
    start_date: "2026-03-02",
    plan_approved_at: "2026-03-01T09:00:00+00:00",
    plan_version: 1,
    undoable: null,
    calendar: { working_days: 31, holidays: [], extra_workdays: [] },
    categories: [{ id: "c1", name: "Дизайн", color: "#3b82f6", position: 0 }],
    tasks: [task()],
    dependencies: [],
    ...fields,
  };
}

/**
 * Список проектов и состояние каждого из них.
 *
 * Строка несёт сводку, а сводного маршрута на сервере нет: список отдаёт
 * имена, состояния приходят по одному. Тест обязан описать оба конца — иначе
 * он проверял бы строку, которой нечего сказать.
 */
function projectsWithStates(...states: ProjectState[]) {
  return [
    http.get("/api/projects", () =>
      HttpResponse.json(states.map(({ id, name, slug }) => ({ id, name, slug }))),
    ),
    ...states.map((project) =>
      http.get(`/api/projects/${project.id}`, () => HttpResponse.json(project)),
    ),
  ];
}

/**
 * Два проекта и сервер, который и правда с ними расстаётся.
 *
 * Список отдаёт то, что живо, удалённый проект отвечает 404-м — иначе тест
 * про исчезнувшую строку проходил бы и в том случае, когда клиент лишь
 * убрал её у себя, а на сервере ничего не случилось.
 */
function deletableProjects() {
  const states = [
    state({ id: "p1", name: "Редизайн", slug: "redizayn" }),
    state({ id: "p2", name: "Смета", slug: "smeta" }),
  ];
  const alive = new Set(states.map((project) => project.id));
  /** Кого сервер получил приказ удалить. Пустой — значит, никого. */
  const deleted: string[] = [];

  return {
    deleted,
    handlers: [
      http.get("/api/projects", () =>
        HttpResponse.json(
          states
            .filter((project) => alive.has(project.id))
            .map(({ id, name, slug }) => ({ id, name, slug })),
        ),
      ),
      ...states.map((project) =>
        http.get(`/api/projects/${project.id}`, () =>
          alive.has(project.id)
            ? HttpResponse.json(project)
            : HttpResponse.json({ detail: "not_found" }, { status: 404 }),
        ),
      ),
      http.delete("/api/projects/:projectId", ({ params }) => {
        const id = String(params.projectId);
        deleted.push(id);
        alive.delete(id);
        return new HttpResponse(null, { status: 204 });
      }),
    ],
  };
}

/** Шестерёнка на строке названного проекта — не на соседней. */
async function gearOf(name: string): Promise<HTMLElement> {
  const rows = await screen.findAllByRole("row");
  const row = rows.find((node) => within(node).queryByRole("link", { name }) !== null);
  if (row === undefined) throw new Error(`строки «${name}» на экране нет`);
  return within(row).findByRole("button", { name: "Действия проекта" });
}

/** Раскрыть шестерёнку строки и выбрать в ней удаление. */
async function askToDelete(name: string) {
  await userEvent.click(await gearOf(name));
  await userEvent.click(screen.getByRole("button", { name: "Удалить проект" }));
}

/** 11 марта 2026 в Баку — пояс организации, по которому считается «сегодня». */
function atMarch11(run: () => Promise<void>) {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(Date.UTC(2026, 2, 11, 9, 0)));
  return run().finally(() => vi.useRealTimers());
}

describe("экран проектов", () => {
  it("переводит интерфейс, но не данные", async () => {
    server.use(
      ...sessionHandlers(),
      ...projectsWithStates(state({ name: "Şəhər Layihəsi", slug: "seher-layihesi" })),
    );

    renderApp({ route: "/projects", locale: "ru" });

    // Заголовок, а не любой текст: слово «Проекты» есть и в колонке.
    expect(await screen.findByRole("heading", { name: "Проекты" })).toBeInTheDocument();
    // А название проекта осталось азербайджанским на русском интерфейсе: это
    // содержимое пользователя, и переводится интерфейс, а не данные.
    expect(await screen.findByText("Şəhər Layihəsi")).toBeInTheDocument();
  });

  it("пустой список объясняет, что делать дальше", async () => {
    server.use(...sessionHandlers(), http.get("/api/projects", () => HttpResponse.json([])));

    renderApp({ route: "/projects", locale: "ru" });

    expect(await screen.findByText(/пока ни одного проекта/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /создать проект/i })).toBeInTheDocument();
  });

  it("отказ сервера объясняется словами, а не пустым экраном", async () => {
    server.use(
      ...sessionHandlers(),
      http.get("/api/projects", () =>
        HttpResponse.json({ detail: "no_organization" }, { status: 403 }),
      ),
    );

    renderApp({ route: "/projects", locale: "ru" });

    expect(await screen.findByText(/не состоите ни в одной организации/i)).toBeInTheDocument();
  });

  it("создаёт проект и уводит на него", async () => {
    server.use(
      ...sessionHandlers(),
      http.get("/api/projects", () => HttpResponse.json([])),
      http.post("/api/projects", async ({ request }) => {
        expect(await request.json()).toEqual({ name: "Редизайн сайта" });
        return HttpResponse.json(
          { id: "p1", name: "Редизайн сайта", slug: "redizayn-sayta" },
          { status: 201 },
        );
      }),
      // Экран проекта — цель перехода; здесь он нужен лишь как адрес, куда
      // приложение обязано привести.
      http.get("/api/projects/p1", () =>
        HttpResponse.json({
          id: "p1",
          name: "Редизайн сайта",
          slug: "redizayn-sayta",
          deadline: null,
          project_end: null,
          calendar: { working_days: 31, holidays: [], extra_workdays: [] },
          settings: { shift_threshold_days: 2, timezone: "Asia/Baku" },
          categories: [],
          tasks: [],
          dependencies: [],
        }),
      ),
    );

    renderApp({ route: "/projects", locale: "ru" });
    await createProjectNamed("Редизайн сайта");

    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1"),
    );
  });

  it("не даёт отправить пустое название", async () => {
    server.use(...sessionHandlers(), http.get("/api/projects", () => HttpResponse.json([])));

    renderApp({ route: "/projects", locale: "ru" });
    await userEvent.click(await screen.findByRole("button", { name: /создать проект/i }));

    expect(screen.getByRole("button", { name: /^создать$/i })).toBeDisabled();
  });

  it("объясняет отказ сервера переведённым текстом", async () => {
    server.use(
      ...sessionHandlers(),
      http.get("/api/projects", () => HttpResponse.json([])),
      http.post("/api/projects", () => HttpResponse.json({ detail: "forbidden" }, { status: 403 })),
    );

    renderApp({ route: "/projects", locale: "ru" });
    await createProjectNamed("Тест");

    // Текст берётся из словаря по коду `forbidden`. Сам код наружу не выходит.
    expect(await screen.findByText(/у вас нет прав/i)).toBeInTheDocument();
    expect(screen.queryByText("forbidden")).not.toBeInTheDocument();
  });
});

describe("модальное окно", () => {
  it("закрывается по Esc и возвращает фокус туда, откуда открылось", async () => {
    server.use(...sessionHandlers(), http.get("/api/projects", () => HttpResponse.json([])));

    renderApp({ route: "/projects", locale: "ru" });
    const opener = await screen.findByRole("button", { name: /создать проект/i });
    await userEvent.click(opener);

    // Фокус при открытии стоит на первом поле: иначе человек с клавиатуры
    // оказывается неизвестно где и обязан искать поле табуляцией.
    expect(screen.getByLabelText(/название/i)).toHaveFocus();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("закрывается кликом вне окна", async () => {
    server.use(...sessionHandlers(), http.get("/api/projects", () => HttpResponse.json([])));

    renderApp({ route: "/projects", locale: "ru" });
    await userEvent.click(await screen.findByRole("button", { name: /создать проект/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("modal-backdrop"));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("с введённым в форме спрашивает, прежде чем закрыться по Esc", async () => {
    server.use(...sessionHandlers(), http.get("/api/projects", () => HttpResponse.json([])));

    renderApp({ route: "/projects", locale: "ru" });
    await userEvent.click(await screen.findByRole("button", { name: /создать проект/i }));
    await userEvent.type(screen.getByLabelText(/название/i), "Редизайн");

    await userEvent.keyboard("{Escape}");

    // Окно на месте, набранное в нём — тоже.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText(/название/i)).toHaveValue("Редизайн");
    expect(screen.getByText(/введённое не сохранится/i)).toBeInTheDocument();
  });

  it("«продолжить» возвращает к форме, а второй Esc её не теряет", async () => {
    server.use(...sessionHandlers(), http.get("/api/projects", () => HttpResponse.json([])));

    renderApp({ route: "/projects", locale: "ru" });
    await userEvent.click(await screen.findByRole("button", { name: /создать проект/i }));
    await userEvent.type(screen.getByLabelText(/название/i), "Редизайн");
    await userEvent.keyboard("{Escape}");

    // Esc поверх вопроса — ответ «продолжить»: привычные два Esc подряд не
    // должны приводить ровно к той потере, ради которой вопрос и задан.
    await userEvent.keyboard("{Escape}");

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText(/введённое не сохранится/i)).not.toBeInTheDocument();
    // Фокус вернулся туда, где человека прервали.
    expect(screen.getByLabelText(/название/i)).toHaveFocus();
  });

  it("закрывает окно, когда потерю введённого подтвердили", async () => {
    server.use(...sessionHandlers(), http.get("/api/projects", () => HttpResponse.json([])));

    renderApp({ route: "/projects", locale: "ru" });
    const opener = await screen.findByRole("button", { name: /создать проект/i });
    await userEvent.click(opener);
    await userEvent.type(screen.getByLabelText(/название/i), "Редизайн");
    await userEvent.keyboard("{Escape}");

    await userEvent.click(screen.getByRole("button", { name: /закрыть без сохранения/i }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("с введённым в форме не закрывается от клика мимо окна", async () => {
    server.use(...sessionHandlers(), http.get("/api/projects", () => HttpResponse.json([])));

    renderApp({ route: "/projects", locale: "ru" });
    await userEvent.click(await screen.findByRole("button", { name: /создать проект/i }));
    await userEvent.type(screen.getByLabelText(/название/i), "Редизайн");

    // Промах мимо селекта на два десятка пикселей — это тот же клик по фону.
    await userEvent.click(screen.getByTestId("modal-backdrop"));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText(/название/i)).toHaveValue("Редизайн");
  });

  it("«Отмена» самой формы закрывает окно без вопроса", async () => {
    server.use(...sessionHandlers(), http.get("/api/projects", () => HttpResponse.json([])));

    renderApp({ route: "/projects", locale: "ru" });
    await userEvent.click(await screen.findByRole("button", { name: /создать проект/i }));
    await userEvent.type(screen.getByLabelText(/название/i), "Редизайн");

    // До кнопки целятся, а по фону промахиваются: спрашивать здесь значило бы
    // требовать два подтверждения на одно осознанное действие.
    await userEvent.click(screen.getByRole("button", { name: /отмена/i }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("сводка в таблице", () => {
  it("столбцы называют готовность, работу, блокировку и просрочку числом", async () => {
    await atMarch11(async () => {
      server.use(
        ...sessionHandlers(),
        ...projectsWithStates(
          state({
            tasks: [
              task({ id: "t1", status: "in_progress", progress_pct: 50 }),
              // Заблокирована и вдобавок не закрыта, а её срок уже прошёл.
              task({ id: "t2", status: "blocked", progress_pct: 0, end_date: "2026-03-05" }),
            ],
          }),
        ),
      );

      renderApp({ route: "/projects", locale: "ru" });

      const name = await screen.findByRole("link", { name: "Редизайн" });
      const cells = within(name.closest("tr")!).getAllByRole("cell");
      expect(cells[0]).toHaveTextContent("25%");
      expect(cells[1]).toHaveTextContent("1");
      expect(cells[2]).toHaveTextContent("1");
      expect(cells[3]).toHaveTextContent("1");
    });
  });

  it("готовность проекта без задач — прочерк, а не 0%", async () => {
    server.use(...sessionHandlers(), ...projectsWithStates(state({ tasks: [] })));

    renderApp({ route: "/projects", locale: "ru" });

    const name = await screen.findByRole("link", { name: "Редизайн" });
    expect(within(name.closest("tr")!).getAllByRole("cell")[0]).toHaveTextContent("—");
  });

  it("столбец «Дедлайн» называет опоздание в днях", async () => {
    server.use(
      ...sessionHandlers(),
      ...projectsWithStates(state({ deadline: "2026-06-01", project_end: "2026-06-08" })),
    );

    renderApp({ route: "/projects", locale: "ru" });

    expect(await screen.findByText("Опоздание на 7 дней")).toBeInTheDocument();
  });

  it("столбец «Дедлайн» называет дату, когда проект укладывается в срок", async () => {
    server.use(
      ...sessionHandlers(),
      ...projectsWithStates(state({ deadline: "2026-06-08", project_end: "2026-06-01" })),
    );

    renderApp({ route: "/projects", locale: "ru" });

    expect(await screen.findByText("Укладываемся в 8 июн")).toBeInTheDocument();
  });

  it("у относительного плана столбец «Дедлайн» — прочерк, а не выдуманный срок", async () => {
    server.use(
      ...sessionHandlers(),
      ...projectsWithStates(
        state({
          schedule_mode: "relative",
          start_date: null,
          deadline: "2026-06-01",
          project_end: "2001-01-05",
          tasks: [task({ start_date: "2001-01-01", end_date: "2001-01-05" })],
        }),
      ),
    );

    renderApp({ route: "/projects", locale: "ru" });

    const name = await screen.findByRole("link", { name: "Редизайн" });
    expect(within(name.closest("tr")!).getAllByRole("cell")[4]).toHaveTextContent("—");
  });

  it("не пришедшая сводка одного проекта не молчит, но и не прячет остальные", async () => {
    server.use(
      ...sessionHandlers(),
      http.get("/api/projects", () =>
        HttpResponse.json([
          { id: "p1", name: "Первый", slug: "pervyy" },
          { id: "p2", name: "Второй", slug: "vtoroy" },
        ]),
      ),
      http.get("/api/projects/p1", () => HttpResponse.json(state({ id: "p1", name: "Первый" }))),
      http.get("/api/projects/p2", () => HttpResponse.error()),
    );

    renderApp({ route: "/projects", locale: "ru" });

    // Строка с посчитанной сводкой остаётся на месте — незачем прятать то,
    // что и так готово; а баннер сверху честно называет то, что не пришло.
    expect(await screen.findByText("Первый")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("Второй")).not.toBeInTheDocument();
  });

  it("при отказе списка не утверждает, что проектов нет", async () => {
    server.use(...sessionHandlers(), http.get("/api/projects", () => HttpResponse.error()));

    renderApp({ route: "/projects", locale: "ru" });

    // Пустой список и несостоявшийся ответ — разные вещи: пока причина в
    // отказе, «проектов нет» было бы враньём поверх баннера ошибки.
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/ни одного проекта/i)).not.toBeInTheDocument();
  });
});

describe("удаление проекта из таблицы", () => {
  it("пункт меню сперва спрашивает, а не удаляет", async () => {
    const { deleted, handlers } = deletableProjects();
    server.use(...sessionHandlers(), ...handlers);

    renderApp({ route: "/projects", locale: "ru" });
    await askToDelete("Редизайн");

    const dialog = screen.getByRole("dialog");
    // Окно называет имя проекта: в таблице из одинаковых строк это
    // единственное место, где видно, что целились в соседнюю.
    expect(
      within(dialog).getByRole("heading", { name: "Удалить проект «Редизайн»?" }),
    ).toBeInTheDocument();
    // И называет последствие, а не спрашивает «вы уверены?».
    expect(within(dialog).getByText(/отменить это будет нельзя/i)).toBeInTheDocument();
    expect(deleted).toEqual([]);
  });

  it("фокус в окне стоит на отказе, а не на удалении", async () => {
    const { handlers } = deletableProjects();
    server.use(...sessionHandlers(), ...handlers);

    renderApp({ route: "/projects", locale: "ru" });
    await askToDelete("Редизайн");

    // Enter, нажатый быстрее, чем прочитано предупреждение, обязан ничего не
    // удалить: у необратимого действия первым под рукой стоит отказ.
    expect(screen.getByRole("button", { name: "Отмена" })).toHaveFocus();
  });

  it("подтверждённое удаление убирает строку и называет проект", async () => {
    const { deleted, handlers } = deletableProjects();
    server.use(...sessionHandlers(), ...handlers);

    renderApp({ route: "/projects", locale: "ru" });
    await askToDelete("Редизайн");
    await userEvent.click(screen.getByRole("button", { name: "Да, удалить проект" }));

    // Удалён названный проект, а не соседний по таблице.
    await waitFor(() => expect(deleted).toEqual(["p1"]));
    await waitFor(() => expect(screen.queryByText("Редизайн")).toBeNull());
    expect(screen.getByText("Смета")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    // Таблица после удаления выглядит так же, как после промаха мимо кнопки:
    // отчитаться о тихой операции обязан тост, и называет он то, что удалено.
    expect(await screen.findByText("Проект «Редизайн» удалён")).toBeInTheDocument();
  });

  it("отказ в окне не трогает ни сервер, ни список", async () => {
    const { deleted, handlers } = deletableProjects();
    server.use(...sessionHandlers(), ...handlers);

    renderApp({ route: "/projects", locale: "ru" });
    await askToDelete("Редизайн");
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Редизайн")).toBeInTheDocument();
    expect(deleted).toEqual([]);
  });

  it("отказ сервера остаётся в окне, а строка — на месте", async () => {
    const { handlers } = deletableProjects();
    server.use(...sessionHandlers(), ...handlers);
    // Отдельным вызовом, а не последним доводом в предыдущем: msw отдаёт
    // предпочтение обработчику, объявленному позже, — но именно вызовом, а
    // внутри одного вызова побеждает первый подошедший.
    server.use(
      http.delete("/api/projects/p1", () =>
        HttpResponse.json({ detail: "forbidden" }, { status: 403 }),
      ),
    );

    renderApp({ route: "/projects", locale: "ru" });
    await askToDelete("Редизайн");
    await userEvent.click(screen.getByRole("button", { name: "Да, удалить проект" }));

    // Окно не закрывается на отказе: закрытое, оно унесло бы с собой и
    // объяснение, и строка молча осталась бы на месте без причины.
    expect(await screen.findByText(/у вас нет прав/i)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Редизайн")).toBeInTheDocument();
  });

  it("редактору шестерёнки в таблице нет", async () => {
    const { handlers } = deletableProjects();
    server.use(...sessionHandlers(), ...handlers);
    // Отдельным вызовом: см. соседний тест про отказ сервера.
    server.use(http.get("/api/org", () => HttpResponse.json({ ...ORG, role: "editor" })));

    renderApp({ route: "/projects", locale: "ru" });

    // Расстаться с проектом целиком — право владельца; редактор правит план.
    expect(await screen.findByText("Редизайн")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Действия проекта" })).toBeNull();
  });
});

describe("адреса списка", () => {
  it("корень ведёт туда же, куда вход, — на список проектов", async () => {
    server.use(...sessionHandlers(), http.get("/api/projects", () => HttpResponse.json([])));

    renderApp({ route: "/", locale: "ru" });

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/projects"));
    expect(await screen.findByRole("heading", { name: "Проекты" })).toBeInTheDocument();
  });

  it("прежний адрес портфеля отвечает переездом, а не «страница не найдена»", async () => {
    server.use(...sessionHandlers(), http.get("/api/projects", () => HttpResponse.json([])));

    renderApp({ route: "/portfolio", locale: "ru" });

    // Портфель разобран: сводка живёт в таблице списка. По старому адресу
    // ходили из закладок, и отвечать на него пустотой — расплата за наведение
    // порядка, которую платит читатель, а не мы.
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/projects"));
    expect(await screen.findByRole("heading", { name: "Проекты" })).toBeInTheDocument();
  });

  it("прежний адрес отчётов отвечает переездом, а не «страница не найдена»", async () => {
    server.use(...sessionHandlers(), http.get("/api/projects", () => HttpResponse.json([])));

    renderApp({ route: "/reports", locale: "ru" });

    // Таблица отчётов переехала в «Проекты» и стала тем, чем этот раздел
    // показывает сводку. По старому адресу ходили и из колонки, и из
    // закладок — переезд отвечает им обоим, а не «страница не найдена».
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/projects"));
    expect(await screen.findByRole("heading", { name: "Проекты" })).toBeInTheDocument();
  });

  it("даёт завести проект всеми способами, не уходя со страницы", async () => {
    server.use(...sessionHandlers(), http.get("/api/projects", () => HttpResponse.json([])));

    renderApp({ route: "/projects", locale: "ru" });

    expect(await screen.findByRole("link", { name: /создать через интервью/i })).toHaveAttribute(
      "href",
      "/projects/new/ai",
    );
    expect(screen.getByRole("link", { name: /импорт из jira/i })).toHaveAttribute(
      "href",
      "/projects/new/jira",
    );
    expect(screen.getByRole("button", { name: /создать проект/i })).toBeInTheDocument();
  });
});

describe("данные организации", () => {
  it("название организации приходит с сервера и не переводится", async () => {
    server.use(...sessionHandlers(), http.get("/api/projects", () => HttpResponse.json([])));

    renderApp({ route: "/projects", locale: "ru" });

    expect(await screen.findByText(ORG.name)).toBeInTheDocument();
    // Имя вошедшего колонка больше не показывает: приветствие убрано, и
    // верхний блок держит только организацию.
    expect(screen.queryByText(new RegExp(USER.name))).toBeNull();
  });
});

describe("пустой список для того, кто не может писать", () => {
  /**
   * Тот же экран глазами заданной роли.
   *
   * Свой `/api/org` идёт первым: msw берёт первый подходящий обработчик, и
   * общий из sessionHandlers перекрыл бы роль, ради которой тест и написан.
   */
  function asRole(role: string) {
    return [
      http.get("/api/org", () => HttpResponse.json({ ...ORG, role })),
      http.get("/api/projects", () => HttpResponse.json([])),
      ...sessionHandlers(),
    ];
  }

  it("не предлагает наблюдателю завести проект: сервер ответил бы отказом", async () => {
    server.use(...asRole("viewer"));

    renderApp({ route: "/projects", locale: "ru" });

    // Сперва дожидаемся текста, который появляется только с известной ролью:
    // проверка отсутствия кнопок до ответа `/api/org` зеленела бы сама собой.
    await screen.findByText(/вам пока не открыли ни одного проекта/i);
    expect(screen.queryByRole("button", { name: /создать проект/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /создать через интервью/i })).toBeNull();
  });

  it("объясняет клиенту, что доступ выдаёт владелец, а не зовёт создавать", async () => {
    server.use(...asRole("client"));

    renderApp({ route: "/projects", locale: "ru" });

    expect(await screen.findByText(/доступ к ним выдаёт владелец/i)).toBeInTheDocument();
    // Прежний призыв обманывал: проекты в организации есть, их просто не выдали.
    expect(screen.queryByText(/создайте первый проект/i)).toBeNull();
  });

  it("владельцу оставляет и кнопку, и прежний призыв", async () => {
    server.use(...asRole("owner"));

    renderApp({ route: "/projects", locale: "ru" });

    expect(await screen.findByRole("button", { name: /создать проект/i })).toBeInTheDocument();
    expect(screen.getByText(/создайте первый проект/i)).toBeInTheDocument();
  });
});
