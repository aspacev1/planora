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
      risk: "green",
      risk_note: "",
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
    // The project's name is user content, it is not translated.
    expect(screen.getByRole("heading", { name: "Редизайн" })).toBeInTheDocument();
  });

  it("считает «сегодня» по поясу из профиля, а не по поясу проекта", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // 01:00 on the eleventh of March in UTC: in Baku, where the plan lives, that is already the
    // morning of the eleventh, while for a reader in New York it is still the evening of the
    // tenth. The person's choice wins: the line must stand on their day.
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 11, 1, 0)));
    try {
      server.use(
        // Earlier than the harness: of one call's handlers msw takes the first matching one, and
        // the shared profile would override this one.
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
      // Earlier than the harness: of one call's handlers msw takes the first matching one, and an
      // empty roster declared after it would have stayed empty.
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

    // The names come from the working screen: the strip does not go for the roster itself.
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
    // An empty chart instead of an explanation would read as "the project is empty".
    expect(screen.queryByRole("button", { name: /Логотип/ })).not.toBeInTheDocument();
  });

  it("пока состояние не пришло, диаграмма не рисуется", async () => {
    server.use(...sessionHandlers(), http.get("/api/projects/p1", () => HttpResponse.json(STATE)));

    renderApp({ route: "/projects/p1", locale: "ru" });

    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
    await screen.findByRole("button", { name: /Логотип/ });
  });

  it("настройки проекта — под «⋯» в шапке проекта, а не в общем меню", async () => {
    server.use(...sessionHandlers(), http.get("/api/projects/p1", () => HttpResponse.json(STATE)));

    renderApp({ route: "/projects/p1", locale: "ru" });

    await screen.findByRole("heading", { name: "Редизайн" });
    // The kebab is now drawn and holds four actions: as permanent buttons they cost a tier of
    // height above every project screen.
    await userEvent.click(screen.getByRole("button", { name: "Ещё действия" }));

    // The caption is one word while what is said aloud is the subject: the entrance to the
    // workspace settings in the column nearby carries the same word, and by eye they are told
    // apart by a place that is invisible to someone listening to the screen.
    const settings = screen.getByRole("link", { name: "Настройки проекта" });
    expect(settings).toHaveTextContent(/^Настройки$/);
    expect(settings).toHaveAttribute("href", "/projects/p1/settings");
    expect(settings.closest(".project-bar")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Настройки" })).toHaveAttribute("href", "/settings");
  });

  it("действия шапки — со значками, все четыре под «⋯»", async () => {
    server.use(...sessionHandlers(), http.get("/api/projects/p1", () => HttpResponse.json(STATE)));

    renderApp({ route: "/projects/p1", locale: "ru" });

    await screen.findByRole("heading", { name: "Редизайн" });
    await userEvent.click(screen.getByRole("button", { name: "Ещё действия" }));
    const actions = document.querySelector(".project-bar__actions");
    expect(actions).not.toBeNull();
    // Every action has its own icon, and all of them are hidden from being read aloud: a word
    // stands next to each, and a spoken icon would repeat it.
    // Four: share, export, invite, settings.
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
      // The invitation form requests the list of projects for any role, not only for "Client" —
      // the project ticked by it is what pre-fills the form.
      http.get("/api/projects", () => HttpResponse.json([])),
    );

    renderApp({ route: "/projects/p1", locale: "ru" });

    await screen.findByRole("heading", { name: "Редизайн" });
    await userEvent.click(screen.getByRole("button", { name: "Ещё действия" }));
    const actions = document.querySelector(".project-bar__actions");
    const invite = screen.getByRole("button", { name: "Пригласить" });
    // In the same menu as publishing: both answer "let someone look".
    expect(invite.closest(".project-bar__actions")).toBe(actions);
    expect(screen.getByRole("button", { name: "Поделиться" }).closest(".project-bar__actions"))
      .toBe(actions);

    await userEvent.click(invite);

    // The same dialog as on the roster screen: people are invited into the organization wherever
    // they are called from — and it is what hands out the role with its permissions.
    expect(await screen.findByRole("dialog")).toHaveTextContent("Пригласить в организацию");
  });

  it("не владельцу приглашать нечем: сервер такую попытку отклонит", async () => {
    server.use(
      // Earlier than the harness: of one call's handlers msw takes the first matching one, and the
      // shared organization would override this one. An editor can change a project but not invite
      // people into the organization.
      http.get("/api/org", () => HttpResponse.json({ ...ORG, role: "editor" })),
      ...sessionHandlers(),
      http.get("/api/projects/p1", () => HttpResponse.json(STATE)),
    );

    renderApp({ route: "/projects/p1", locale: "ru" });

    await screen.findByRole("heading", { name: "Редизайн" });
    await userEvent.click(screen.getByRole("button", { name: "Ещё действия" }));
    // The other actions are in place at that: an editor does have the right to write.
    expect(screen.getByRole("button", { name: "Поделиться" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Пригласить" })).not.toBeInTheDocument();
  });
});

describe("удаление категории", () => {
  beforeEach(projectFixtures);

  /** A category row's "⋯" menu by its id (see RowMenu). */
  async function openCategoryMenu(categoryId: string) {
    await userEvent.click(await screen.findByTestId(`category-menu-${categoryId}-button`));
  }

  it("пустая категория уходит после подтверждения, что терять нечего", async () => {
    const sent = captureMutations();
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });

    await openCategoryMenu("c2");
    await userEvent.click(await screen.findByRole("button", { name: "Удалить категорию" }));

    // The question is asked about an empty one too: missing a neighbouring row is an ordinary
    // thing, and the name in the dialog's heading is the only way to see it.
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

    // A number rather than "are you sure?": "delete the category" sounds like parting with a
    // heading, while the whole stage goes with it.
    expect(await screen.findByRole("dialog", { name: /Дизайн/ })).toHaveTextContent("1 задача");

    await userEvent.click(screen.getByRole("button", { name: "Да, удалить" }));

    await waitFor(() =>
      expect(sent).toEqual([{ op: { type: "delete_category", category_id: "c1" } }]),
    );
    // The tasks went with the category — the same as the server will do.
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
