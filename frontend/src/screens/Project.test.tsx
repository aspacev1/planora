import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { captureMutations, projectFixtures, renderProject } from "../test/project";
import { server } from "../test/server";
import { ORG, USER, renderApp, sessionHandlers } from "../test/utils";

const STATE = {
  id: "p1",
  name: "Редизайн",
  slug: "redizayn",
  deadline: "2026-06-01",
  project_end: "2026-06-08",
  calendar: { working_days: 31, holidays: ["2026-03-20"], extra_workdays: [] },
  settings: { shift_threshold_days: 2, timezone: "Asia/Baku" },
  categories: [{ id: "c1", name: "Дизайн", color: "#3b82f6", position: 0 }],
  tasks: [
    {
      id: "t1",
      category_id: "c1",
      name: "Логотип",
      description: "",
      start_date: "2026-03-04",
      end_date: "2026-03-10",
      duration_days: 5,
      criticality: "high",
      progress_pct: 40,
      position: 0,
      assignee_ids: [],
    },
  ],
  dependencies: [],
};

describe("экран проекта", () => {
  it("показывает диаграмму, когда состояние пришло", async () => {
    server.use(...sessionHandlers(), http.get("/api/projects/p1", () => HttpResponse.json(STATE)));

    renderApp({ route: "/projects/p1", locale: "ru" });

    expect(await screen.findByRole("button", { name: /Логотип/ })).toBeInTheDocument();
    // Название проекта — содержимое пользователя, оно не переводится.
    expect(screen.getByRole("heading", { name: "Редизайн" })).toBeInTheDocument();
  });

  it("считает «сегодня» по поясу из профиля, а не по поясу проекта", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // 01:00 одиннадцатого марта по UTC: в Баку, где живёт план, это уже утро
    // одиннадцатого, а у читателя в Нью-Йорке — ещё вечер десятого. Выбор
    // человека побеждает: линия обязана стоять на его дне.
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 11, 1, 0)));
    try {
      server.use(
        // Раньше оснастки: из обработчиков одного вызова msw берёт первый
        // подходящий, и общий профиль перебил бы этот.
        http.get("/api/auth/me", () =>
          HttpResponse.json({ ...USER, timezone: "America/New_York" }),
        ),
        ...sessionHandlers(),
        http.get("/api/projects/p1", () => HttpResponse.json(STATE)),
      );

      const { container } = renderApp({ route: "/projects/p1", locale: "ru" });
      await screen.findByRole("button", { name: /Логотип/ });

      expect(container.querySelector('.gantt__day[data-day="2026-03-10"]')).toHaveClass("is-today");
      expect(container.querySelector('.gantt__day[data-day="2026-03-11"]')).not.toHaveClass(
        "is-today",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("подписывает исполнителей в карточке наведения именами из состава", async () => {
    server.use(
      // Раньше оснастки: из обработчиков одного вызова msw берёт первый
      // подходящий, и объявленный после пустой состав так и остался бы пустым.
      http.get("/api/org/members", () =>
        HttpResponse.json([
          { id: "u1", name: "Алексей", email: "a@b.c", role: "owner" },
          { id: "u2", name: "Мария", email: "m@b.c", role: "editor" },
        ]),
      ),
      ...sessionHandlers(),
      http.get("/api/projects/p1", () =>
        HttpResponse.json({
          ...STATE,
          tasks: [{ ...STATE.tasks[0], status: "in_progress", assignee_ids: ["u1", "u2"] }],
        }),
      ),
    );

    renderApp({ route: "/projects/p1", locale: "ru" });

    await userEvent.hover(await screen.findByRole("button", { name: /Логотип/ }));

    // Имена приходят с рабочего экрана: сама лента за составом не ходит.
    await waitFor(() => expect(screen.getByTestId("bar-tip")).toHaveTextContent("Алексей +1"));
  });

  it("несуществующий и чужой проект неразличимы и объясняются словами", async () => {
    server.use(
      ...sessionHandlers(),
      http.get("/api/projects/p1", () =>
        HttpResponse.json({ detail: "project_not_found" }, { status: 404 }),
      ),
    );

    renderApp({ route: "/projects/p1", locale: "ru" });

    expect(await screen.findByText(/проект не найден/i)).toBeInTheDocument();
    // Пустая диаграмма вместо объяснения читалась бы как «проект пуст».
    expect(screen.queryByRole("button", { name: /Логотип/ })).not.toBeInTheDocument();
  });

  it("пока состояние не пришло, диаграмма не рисуется", async () => {
    server.use(...sessionHandlers(), http.get("/api/projects/p1", () => HttpResponse.json(STATE)));

    renderApp({ route: "/projects/p1", locale: "ru" });

    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
    await screen.findByRole("button", { name: /Логотип/ });
  });

  it("настройки проекта — в шапке проекта, а не в общем меню и не в кебабе", async () => {
    server.use(...sessionHandlers(), http.get("/api/projects/p1", () => HttpResponse.json(STATE)));

    renderApp({ route: "/projects/p1", locale: "ru" });

    await screen.findByRole("heading", { name: "Редизайн" });
    // Подпись — одно слово, а вслух называется подлежащее: в колонке рядом
    // тем же словом подписан вход в настройки рабочего пространства, и на
    // глаз их различает место, которого не видно тому, кто экран слушает.
    const settings = screen.getByRole("link", { name: "Настройки проекта" });
    expect(settings).toHaveTextContent(/^Настройки$/);
    expect(settings).toHaveAttribute("href", "/projects/p1/settings");
    expect(settings.closest(".project-head")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Настройки" })).toHaveAttribute("href", "/settings");
    // Кебаб «⋯» не рисуется — в нём был единственный пункт, и тот переехал.
    expect(screen.queryByRole("button", { name: /Ещё действия/i })).not.toBeInTheDocument();
  });

  it("действия шапки — со значками и ростом с кнопку согласования плана", async () => {
    server.use(...sessionHandlers(), http.get("/api/projects/p1", () => HttpResponse.json(STATE)));

    renderApp({ route: "/projects/p1", locale: "ru" });

    await screen.findByRole("heading", { name: "Редизайн" });
    const actions = document.querySelector(".project-head__actions");
    expect(actions).not.toBeNull();
    // У каждого действия свой значок, и все они спрятаны от чтения вслух:
    // рядом стоит слово, и озвученный значок повторил бы его.
    // Четыре: поделиться, экспорт, пригласить, настройки.
    const icons = actions!.querySelectorAll(".icon");
    expect(icons).toHaveLength(4);
    for (const icon of icons) expect(icon).toHaveAttribute("aria-hidden", "true");
  });

  it("пригласить — рядом с «Поделиться», и зовёт в организацию, а не в проект", async () => {
    server.use(
      ...sessionHandlers(),
      http.get("/api/projects/p1", () => HttpResponse.json(STATE)),
      http.get("/api/org/invitations", () =>
        HttpResponse.json({ mail_enabled: false, invitations: [] }),
      ),
      // Форма приглашения запрашивает список проектов для любой роли, не
      // только для «Клиента» — отмеченный им же проект её и предзаполняет.
      http.get("/api/projects", () => HttpResponse.json([])),
    );

    renderApp({ route: "/projects/p1", locale: "ru" });

    await screen.findByRole("heading", { name: "Редизайн" });
    const actions = document.querySelector(".project-head__actions");
    const invite = screen.getByRole("button", { name: "Пригласить" });
    // В одном ряду с публикацией: обе отвечают на «дать посмотреть».
    expect(invite.closest(".project-head__actions")).toBe(actions);
    expect(screen.getByRole("button", { name: "Поделиться" }).closest(".project-head__actions"))
      .toBe(actions);

    await userEvent.click(invite);

    // То же окно, что и на экране состава: приглашают в организацию, откуда бы
    // ни звали, — и роль с правами выдаёт именно оно.
    expect(await screen.findByRole("dialog")).toHaveTextContent("Пригласить в организацию");
  });

  it("не владельцу приглашать нечем: сервер такую попытку отклонит", async () => {
    server.use(
      // Раньше оснастки: из обработчиков одного вызова msw берёт первый
      // подходящий, и общая организация перебила бы эту. Редактор проект
      // менять может, а звать людей в организацию — нет.
      http.get("/api/org", () => HttpResponse.json({ ...ORG, role: "editor" })),
      ...sessionHandlers(),
      http.get("/api/projects/p1", () => HttpResponse.json(STATE)),
    );

    renderApp({ route: "/projects/p1", locale: "ru" });

    await screen.findByRole("heading", { name: "Редизайн" });
    // Остальные действия при этом на месте: право писать у редактора есть.
    expect(screen.getByRole("button", { name: "Поделиться" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Пригласить" })).not.toBeInTheDocument();
  });
});

describe("удаление категории", () => {
  beforeEach(projectFixtures);

  /** Меню «⋯» строки категории по её идентификатору (см. RowMenu). */
  async function openCategoryMenu(categoryId: string) {
    await userEvent.click(await screen.findByTestId(`category-menu-${categoryId}-button`));
  }

  it("пустая категория уходит после подтверждения, что терять нечего", async () => {
    const sent = captureMutations();
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });

    await openCategoryMenu("c2");
    await userEvent.click(await screen.findByRole("button", { name: "Удалить категорию" }));

    // Вопрос задаётся и о пустой: промахнуться мимо соседней строки —
    // обычное дело, и имя в заголовке окна единственное, чем это видно.
    const dialog = await screen.findByRole("dialog", { name: /Разработка/ });
    expect(dialog).toHaveTextContent("В категории нет задач");
    expect(sent).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Да, удалить" }));

    await waitFor(() =>
      expect(sent).toEqual([{ op: { type: "delete_category", category_id: "c2" } }]),
    );
    await waitFor(() => expect(screen.queryByText("Разработка")).not.toBeInTheDocument());
  });

  it("непустая называет, сколько задач уйдёт вместе с ней", async () => {
    const sent = captureMutations();
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });

    await openCategoryMenu("c1");
    await userEvent.click(await screen.findByRole("button", { name: "Удалить категорию" }));

    // Число, а не «вы уверены?»: «удалить категорию» звучит как расставание с
    // заголовком, а уходит вместе с ним весь этап.
    expect(await screen.findByRole("dialog", { name: /Дизайн/ })).toHaveTextContent("1 задача");

    await userEvent.click(screen.getByRole("button", { name: "Да, удалить" }));

    await waitFor(() =>
      expect(sent).toEqual([{ op: { type: "delete_category", category_id: "c1" } }]),
    );
    // Задачи ушли вместе с категорией — так же, как это сделает сервер.
    await waitFor(() => expect(screen.queryByText("Логотип")).not.toBeInTheDocument());
  });

  it("отказ в окне ничего не удаляет", async () => {
    const sent = captureMutations();
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });

    await openCategoryMenu("c1");
    await userEvent.click(await screen.findByRole("button", { name: "Удалить категорию" }));
    await screen.findByRole("dialog", { name: /Дизайн/ });
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(sent).toHaveLength(0);
    expect(screen.getByText("Логотип")).toBeInTheDocument();
  });

  it("читателю кнопки «⋯» на категории не показывается", async () => {
    renderProject(undefined, { canWrite: false });
    await screen.findByRole("button", { name: /Логотип/ });
    expect(screen.queryByTestId("category-menu-c2-button")).not.toBeInTheDocument();
  });
});
