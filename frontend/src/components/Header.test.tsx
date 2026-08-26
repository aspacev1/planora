import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { server } from "../test/server";
import { ORG, USER, renderApp } from "../test/utils";

beforeEach(() => {
  server.use(
    http.get("/api/auth/me", () => HttpResponse.json(USER)),
    http.get("/api/org", () => HttpResponse.json(ORG)),
    http.get("/api/projects", () => HttpResponse.json([])),
  );
});

describe("шапка", () => {
  it("подписана названием организации, и оно не переводится", async () => {
    renderApp({ route: "/projects", locale: "ru" });

    expect(await screen.findByText("Şəhər Studiyası")).toBeInTheDocument();
  });

  it("ведёт «Проектами» туда же, куда приводит вход", async () => {
    renderApp({ route: "/projects", locale: "ru" });

    // Вход, приглашение и неизвестный адрес приводят на `/projects` — пункт
    // колонки обязан вести туда же. Пока он указывал на «/», щелчок по
    // единственному пункту про проекты открывал другой экран.
    expect(await screen.findByRole("link", { name: "Проекты" })).toHaveAttribute(
      "href",
      "/projects",
    );
    // Про проекты в колонке один пункт, а не три: соседние «Портфель» и
    // «Отчёты» показывали те же проекты под своим заголовком, и различить их
    // снаружи было нечем.
    expect(screen.queryByRole("link", { name: "Портфель" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Отчёты" })).toBeNull();
  });

  it("подсвечивает ровно один раздел — тот, на котором стоит человек", async () => {
    renderApp({ route: "/my-tasks", locale: "ru" });

    expect(await screen.findByRole("link", { name: "Мои задачи" })).toHaveClass("is-current");
    expect(screen.getByRole("link", { name: "Проекты" })).not.toHaveClass("is-current");
  });

  it("держит «Проекты» подсвеченными и внутри проекта", async () => {
    server.use(
      http.get("/api/projects/p1", () =>
        HttpResponse.json({
          id: "p1",
          name: "Редизайн",
          slug: "redizayn",
          deadline: null,
          categories: [],
          tasks: [],
        }),
      ),
      http.get("/api/projects/:projectId/comments", () => HttpResponse.json([])),
      http.get("/api/org/members", () => HttpResponse.json([])),
    );

    renderApp({ route: "/projects/p1", locale: "ru" });

    // Страница проекта — часть раздела «Проекты», и колонка обязана это
    // показывать: иначе человек стоит на экране, который не подсвечивает ни
    // один пункт, и по колонке не видно, где он.
    const projects = await screen.findByRole("link", { name: "Проекты" });
    expect(projects).toHaveClass("is-current");
    expect(screen.getByRole("link", { name: "Мои задачи" })).not.toHaveClass("is-current");
  });

  it("ведёт в настройки одним пунктом, а не тремя шестерёнками подряд", async () => {
    renderApp({ route: "/projects", locale: "ru" });

    expect(await screen.findByRole("link", { name: "Настройки" })).toHaveAttribute(
      "href",
      "/settings",
    );
    // Организация, участники и профиль стали вкладками внутри — своих пунктов
    // в колонке у них больше нет.
    expect(screen.queryByRole("link", { name: "Организация" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Профиль" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Команда" })).toBeNull();
  });

  it("переключает язык из самой колонки, над «Настройками»", async () => {
    const patches: Record<string, unknown>[] = [];
    server.use(
      http.patch("/api/auth/me", async ({ request }) => {
        const patch = (await request.json()) as Record<string, unknown>;
        patches.push(patch);
        return HttpResponse.json({ ...USER, ...patch });
      }),
    );

    renderApp({ route: "/projects", locale: "ru" });

    const chooser = await screen.findByRole("group", { name: "Язык интерфейса" });
    const settings = screen.getByRole("link", { name: "Настройки" });
    // Над «Настройками» и под разделами работы — в нижнем ряду колонки.
    expect(settings.previousElementSibling).toBe(chooser);

    await userEvent.click(within(chooser).getByRole("button", { name: "AZ" }));

    // Выбор ушёл в профиль, а не только в память браузера, и интерфейс
    // переключился сразу, не дожидаясь ответа сервера.
    await waitFor(() => expect(patches).toEqual([{ locale: "az" }]));
    expect(await screen.findByRole("link", { name: "Layihələr" })).toBeInTheDocument();
  });

  it("не здоровается: разделы стоят сразу под названием организации", async () => {
    server.use(
      http.get("/api/auth/me", () => HttpResponse.json({ ...USER, name: "Алексей Смирнов" })),
    );

    renderApp({ route: "/projects", locale: "ru" });

    const projects = await screen.findByRole("link", { name: "Проекты" });
    expect(screen.queryByText(/Привет/)).toBeNull();
    // Между логотипом и первым разделом не осталось строки с именем: колонка
    // начинается организацией и сразу переходит к работе.
    const sidebar = projects.closest(".sidebar")!;
    expect(sidebar.querySelector(".sidebar__user")).toBeNull();
  });

  it("подписывает выход значком, как и остальные пункты колонки", async () => {
    renderApp({ route: "/projects", locale: "ru" });

    const logout = await screen.findByRole("button", { name: "Выйти" });
    expect(logout.querySelector("svg.sidebar__icon")).not.toBeNull();
  });

  it("сворачивается щелчком по логотипу и запоминает выбор", async () => {
    renderApp({ route: "/projects", locale: "ru" });

    // Сворачивает сам логотип: отдельной кнопки со стрелкой в колонке нет.
    const logo = await screen.findByRole("button", { name: "Скрыть меню" });
    expect(logo).toContainElement(await screen.findByText("Şəhər Studiyası"));

    await userEvent.click(logo);

    // Кнопка сменила имя — колонка свёрнута, и выбор пережил бы перезагрузку.
    expect(screen.getByRole("button", { name: "Показать меню" })).toBeInTheDocument();
    expect(localStorage.getItem("planora.sidebar_collapsed")).toBe("1");

    await userEvent.click(screen.getByRole("button", { name: "Показать меню" }));

    expect(screen.getByRole("button", { name: "Скрыть меню" })).toBeInTheDocument();
    expect(localStorage.getItem("planora.sidebar_collapsed")).toBeNull();
  });

  it("держит подпись каждого пункта отдельным узлом", async () => {
    renderApp({ route: "/projects", locale: "ru" });

    // Свёрнутая колонка прячет подписи, оставляя значки. Спрятать подпись
    // можно только тогда, когда она — свой узел: голым текстом внутри ссылки
    // она гасится вместе со значком, и от рейки остаётся пустая полоса. Ровно
    // так колонка и выглядела — один логотип, без единого пункта.
    for (const name of ["Проекты", "Мои задачи"]) {
      const link = await screen.findByRole("link", { name });
      expect(link.querySelector(".sidebar__label")).toHaveTextContent(name);
      expect(link.querySelector("svg.sidebar__icon")).not.toBeNull();
    }
  });

  it("называет каждый пункт помимо видимой подписи", async () => {
    renderApp({ route: "/projects", locale: "ru" });

    // Свёрнутая колонка прячет подпись — и с экрана, и из дерева доступности:
    // значок рядом `aria-hidden`, и пункт остался бы вовсе безымянным. Имя
    // поэтому задано отдельно, и задано у всех пунктов, а не только у нижних.
    await screen.findByRole("link", { name: "Проекты" });
    for (const item of document.querySelectorAll(".sidebar__nav .sidebar__link")) {
      expect(item).toHaveAttribute("aria-label", item.textContent);
    }
  });

  it("объясняет свёрнутую колонку своей подсказкой, а не атрибутом `title`", async () => {
    renderApp({ route: "/projects", locale: "ru" });

    // Нативную подсказку рисует система: приложение не знает ни где она
    // встанет, ни когда погаснет. Эта вставала поверх пункта «Проекты» и
    // висела ещё пару секунд после ухода курсора — своя знает про колонку.
    const logo = await screen.findByRole("button", { name: "Скрыть меню" });
    expect(logo).not.toHaveAttribute("title");
    expect(logo.querySelector(".sidebar__tip")).toHaveTextContent("Скрыть меню");

    await userEvent.click(logo);

    // Подсказка говорит про действие, а не про состояние, и меняется вместе с
    // именем кнопки: в рейке она — единственное, что объясняет квадрат.
    const rail = screen.getByRole("button", { name: "Показать меню" });
    expect(rail.querySelector(".sidebar__tip")).toHaveTextContent("Показать меню");
  });

  it("называет `aria-expanded` то, что сворачивает", async () => {
    renderApp({ route: "/projects", locale: "ru" });

    // Без `aria-controls` читалка сообщает «свёрнуто», не говоря чего. Обе
    // области перечислены: подписи пропадают и у разделов, и у нижнего блока.
    const logo = await screen.findByRole("button", { name: "Скрыть меню" });
    const controls = logo.getAttribute("aria-controls")?.split(" ") ?? [];

    expect(controls).toHaveLength(2);
    for (const id of controls) expect(document.getElementById(id)).not.toBeNull();
  });

  it("ставит в квадрат первую букву организации, а не продукта", async () => {
    renderApp({ route: "/projects", locale: "ru" });

    // Тема рисовала здесь `content: "P"` поверх погашенной разметки, и у
    // организации «Şəhər Studiyası» квадрат опознавал Planora. В свёрнутой
    // колонке этот квадрат — единственное, что от неё остаётся, и говорить он
    // обязан про место работы.
    await screen.findByText("Şəhər Studiyası");
    expect(document.querySelector(".sidebar__avatar")).toHaveTextContent("Ş");
  });
});
