import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { STATE, projectFixtures } from "../test/project";
import { server } from "../test/server";
import { ORG, USER, renderApp, sessionHandlers } from "../test/utils";

/**
 * Экраны настроек уровней 2–4.
 *
 * Проверяется то, что видно человеку: поле уходит на сервер само, занятый слаг
 * подсказывает свободный, а `null` в переопределении означает «наследовать», а
 * не «пусто».
 */

type Patch = Record<string, unknown>;

function orgFixtures(role = "owner", settings: Patch = {}) {
  const patches: Patch[] = [];
  let org = { ...ORG, role, settings: { ...ORG.settings, ...settings } };
  // Без sessionHandlers(): их ставит beforeEach, а внутри одного вызова
  // `server.use` предпочтение получает обработчик, названный раньше, — и
  // общий ответ про организацию перебил бы этот.
  server.use(
    http.get("/api/org", () => HttpResponse.json(org)),
    // Блок подключения LLM живёт на этом же экране: без ответа про ключ он
    // просто не рисуется, но запрос всё равно уходит.
    http.get("/api/ai/credential", () =>
      HttpResponse.json({ provider: "openai", base_url: "", model: "", configured: false }),
    ),
    // Блок подключения Jira — тем же правилом, что и LLM выше.
    http.get("/api/jira/credential", () =>
      HttpResponse.json({ base_url: "", email: "", configured: false }),
    ),
    http.patch("/api/org", async ({ request }) => {
      const patch = (await request.json()) as Patch;
      patches.push(patch);
      org = { ...org, ...patch, settings: { ...org.settings, ...patch } };
      return HttpResponse.json(org);
    }),
  );
  return patches;
}

describe("настройки организации", () => {
  beforeEach(() => {
    server.use(...sessionHandlers());
  });

  it("показывает дефолты, которые наследуют проекты", async () => {
    orgFixtures();
    renderApp({ route: "/settings/organization" });

    expect(await screen.findByLabelText("Часовой пояс")).toHaveValue("Asia/Baku");
    expect(screen.getByLabelText("Порог сдвига, дней")).toHaveValue(2);
    expect(screen.getByLabelText(/Производственный календарь/)).toHaveValue("2026-03-20");
  });

  it("отправляет только изменённое поле, а не форму целиком", async () => {
    const patches = orgFixtures();
    renderApp({ route: "/settings/organization" });

    const threshold = await screen.findByLabelText("Порог сдвига, дней");
    await userEvent.clear(threshold);
    await userEvent.type(threshold, "5");
    await userEvent.tab();

    await waitFor(() => expect(patches).toEqual([{ default_shift_threshold_days: 5 }]));
  });

  it("стёртый порог не уходит на сервер нулём", async () => {
    const patches = orgFixtures();
    renderApp({ route: "/settings/organization" });

    // Ноль — это «объяснять каждый сдвиг»: пустое поле такого не просило.
    await userEvent.clear(await screen.findByLabelText("Порог сдвига, дней"));
    await userEvent.tab();

    expect(patches).toEqual([]);
  });

  it("рабочие дни отправляются маской, где нулевой бит — понедельник", async () => {
    const patches = orgFixtures();
    renderApp({ route: "/settings/organization" });

    const days = await screen.findByRole("group", { name: "Рабочие дни" });
    await userEvent.click(within(days).getByLabelText("сб"));

    // Пн–пт плюс суббота.
    await waitFor(() => expect(patches).toEqual([{ working_days: 0b111111 }]));
  });

  it("последний рабочий день недели снять нельзя", async () => {
    // Организация с одним рабочим днём: следующий щелчок оставил бы неделю
    // вовсе без работы.
    const patches = orgFixtures("owner", { working_days: 0b1 });
    renderApp({ route: "/settings/organization" });

    const days = await screen.findByRole("group", { name: "Рабочие дни" });
    await userEvent.click(within(days).getByLabelText("пн"));

    // Маска 0 не уходит на сервер: вместо отказа «проверьте форму», где ни одно
    // поле не названо, человек читает, чего от него хотят.
    expect(within(days).getByRole("alert")).toHaveTextContent(/хотя бы один день/i);
    expect(patches).toEqual([]);
    expect(within(days).getByLabelText("пн")).toBeChecked();
  });

  it("праздники приводятся к списку дат", async () => {
    const patches = orgFixtures();
    renderApp({ route: "/settings/organization" });

    const holidays = await screen.findByLabelText(/Производственный календарь/);
    await userEvent.clear(holidays);
    await userEvent.type(holidays, "2026-03-20\n2026-03-21");
    await userEvent.tab();

    await waitFor(() =>
      expect(patches).toEqual([{ holiday_calendar: ["2026-03-20", "2026-03-21"] }]),
    );
  });

  it("не отправляет ничего, пока дата написана неверно", async () => {
    const patches = orgFixtures();
    renderApp({ route: "/settings/organization" });

    const holidays = await screen.findByLabelText(/Производственный календарь/);
    await userEvent.clear(holidays);
    await userEvent.type(holidays, "20 марта");
    await userEvent.tab();

    expect(await screen.findByText(/формате ГГГГ-ММ-ДД/)).toBeInTheDocument();
    expect(patches).toEqual([]);
  });

  it("занятый слаг подсказывает свободный вариант, и его можно взять одним щелчком", async () => {
    const patches = orgFixtures();
    server.use(
      http.get("/api/org/slug-check", ({ request }) => {
        const slug = new URL(request.url).searchParams.get("slug") ?? "";
        return HttpResponse.json({
          normalized: slug,
          available: slug !== "globex",
          suggestion: slug === "globex" ? "globex-2" : slug,
        });
      }),
    );
    renderApp({ route: "/settings/organization" });

    const field = await screen.findByLabelText("Адрес (слаг)");
    await userEvent.clear(field);
    await userEvent.type(field, "globex");

    const suggestion = await screen.findByRole("button", { name: "globex-2" }, { timeout: 2000 });
    await userEvent.click(suggestion);

    await waitFor(() => expect(patches).toEqual([{ slug: "globex-2" }]));
  });

  it("сохранённое поле говорит об этом рядом с собой", async () => {
    orgFixtures();
    renderApp({ route: "/settings/organization" });

    const zone = await screen.findByLabelText("Часовой пояс");
    await userEvent.clear(zone);
    await userEvent.type(zone, "Europe/Berlin");
    await userEvent.tab();

    // Кнопки «Сохранить» здесь нет, и молчание после потери фокуса
    // неотличимо от «ничего не отправилось».
    expect(await screen.findByText("Сохранено")).toBeInTheDocument();
  });

  it("отвергнутое поле объясняет отказ у себя и возвращается к правде", async () => {
    orgFixtures();
    server.use(
      http.patch("/api/org", () => HttpResponse.json({ detail: "forbidden" }, { status: 403 })),
    );
    renderApp({ route: "/settings/organization" });

    const zone = await screen.findByLabelText("Часовой пояс");
    await userEvent.clear(zone);
    await userEvent.type(zone, "Europe/Berlin");
    await userEvent.tab();

    const refusal = await screen.findByText("Для этого у вас нет прав");
    // Отказ читается у того поля, о котором он: общий баннер вверху страницы
    // не говорит, какое из десяти полей отвергнуто.
    expect(refusal.closest(".field")).toBe(zone.closest(".field"));
    // И отвергнутое значение в поле не остаётся: там снова то, что на сервере.
    await waitFor(() => expect(zone).toHaveValue("Asia/Baku"));
  });

  it("пустое поле не отправляется, но и не остаётся пустым молча", async () => {
    const patches = orgFixtures();
    renderApp({ route: "/settings/organization" });

    const name = await screen.findByLabelText("Название");
    await userEvent.clear(name);
    await userEvent.tab();

    expect(await screen.findByText("Пустым это поле не бывает")).toBeInTheDocument();
    expect(patches).toEqual([]);
    expect(name).toHaveValue(ORG.name);
  });

  it("редактору поля показываются, но не даются", async () => {
    orgFixtures("editor");
    renderApp({ route: "/settings/organization" });

    expect(await screen.findByLabelText("Часовой пояс")).toBeDisabled();
    expect(screen.getByText(/только владелец/)).toBeInTheDocument();
  });

  it("подключение Jira сохраняется без повторного ввода токена, а после подключения можно отключить", async () => {
    orgFixtures();
    let saved: Record<string, unknown> | null = null;
    server.use(
      http.put("/api/jira/credential", async ({ request }) => {
        saved = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          base_url: "https://acme.atlassian.net",
          email: "bot@acme.example",
          configured: true,
        });
      }),
      http.delete("/api/jira/credential", () => new HttpResponse(null, { status: 204 })),
    );
    renderApp({ route: "/settings/organization" });

    const tokenField = await screen.findByLabelText("API-токен");
    // Форма Jira, а не форма LLM: у обеих одинаковая подпись кнопки
    // «Сохранить подключение», и без сужения запрос находит обе разом.
    const jiraForm = tokenField.closest("form") as HTMLElement;

    await userEvent.type(within(jiraForm).getByLabelText("Адрес сайта (base URL)"), "https://acme.atlassian.net");
    await userEvent.type(within(jiraForm).getByLabelText("Email аккаунта"), "bot@acme.example");
    await userEvent.type(tokenField, "secret-token");
    await userEvent.click(within(jiraForm).getByRole("button", { name: "Сохранить подключение" }));

    await waitFor(() =>
      expect(saved).toEqual({
        base_url: "https://acme.atlassian.net",
        email: "bot@acme.example",
        api_token: "secret-token",
      }),
    );
    // Токен наружу не отдаётся: поле снова пустое, «Токен задан» — рядом.
    await waitFor(() => expect(screen.getByLabelText("API-токен")).toHaveValue(""));
    expect(await screen.findByText(/Токен задан/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Отключить" }));
    await userEvent.click(screen.getByRole("button", { name: "Да, отключить" }));

    expect(await screen.findByText(/Токена пока нет/)).toBeInTheDocument();
  });
});

describe("настройки проекта", () => {
  beforeEach(projectFixtures);

  function projectSettingsFixtures(overrides = {}) {
    const patches: Patch[] = [];
    let state = {
      ...STATE,
      overrides: {
        timezone: null,
        working_days: null,
        shift_threshold_days: null,
        holidays_extra: [],
        workdays_extra: [],
        ...overrides,
      },
    };
    server.use(
      http.get("/api/projects/p1", () => HttpResponse.json(state)),
      // Панель публичной ссылки живёт на этом же экране. Сервер и тут отвечает
      // объектом: «не опубликован» — это url: null, а не пустой ответ.
      http.get("/api/projects/p1/share", () =>
        HttpResponse.json({ allowed: true, url: null, comments_enabled: false, created_at: null }),
      ),
      http.patch("/api/projects/p1", async ({ request }) => {
        const patch = (await request.json()) as Patch;
        patches.push(patch);
        state = { ...state, ...patch, overrides: { ...state.overrides, ...patch } };
        return HttpResponse.json(state);
      }),
    );
    return patches;
  }

  it("показывает унаследованное значение, а не подставляет его как своё", async () => {
    projectSettingsFixtures();
    renderApp({ route: "/projects/p1/settings" });

    // Порог наследуется: галочка стоит, своего поля нет вовсе.
    const inherit = await screen.findByLabelText(/Наследовать от организации \(2\)/);
    expect(inherit).toBeChecked();
    expect(screen.queryByLabelText("Порог сдвига, дней")).toBeNull();
  });

  it("снятая галочка заводит собственное значение проекта", async () => {
    const patches = projectSettingsFixtures();
    renderApp({ route: "/projects/p1/settings" });

    await userEvent.click(await screen.findByLabelText(/Наследовать от организации \(2\)/));

    await waitFor(() => expect(patches).toEqual([{ shift_threshold_days: 2 }]));
  });

  it("возврат к наследованию отправляет null, а не пустую строку", async () => {
    const patches = projectSettingsFixtures({ shift_threshold_days: 7 });
    renderApp({ route: "/projects/p1/settings" });

    const inherit = await screen.findByLabelText(/Наследовать от организации \(2\)/);
    expect(inherit).not.toBeChecked();
    await userEvent.click(inherit);

    await waitFor(() => expect(patches).toEqual([{ shift_threshold_days: null }]));
  });

  it("стёртый порог проекта не уходит на сервер нулём", async () => {
    const patches = projectSettingsFixtures({ shift_threshold_days: 7 });
    renderApp({ route: "/projects/p1/settings" });

    // Поле порога на этом экране — единственное числовое; своей подписи у него
    // нет, она стоит над переключателем «наследовать».
    await userEvent.clear(await screen.findByRole("spinbutton"));
    await userEvent.tab();

    // Ни нуля, ни NaN: пока числа в поле нет, отправлять нечего — прежнее
    // переопределение остаётся в силе.
    expect(patches).toEqual([]);
  });

  it("целевая дата снимается пустым полем", async () => {
    const patches = projectSettingsFixtures();
    renderApp({ route: "/projects/p1/settings" });

    await userEvent.clear(await screen.findByLabelText("Целевая дата"));

    await waitFor(() => expect(patches).toEqual([{ deadline: null }]));
  });

  it("панель Jira молчит у обычного проекта, не заведённого импортом", async () => {
    projectSettingsFixtures();
    renderApp({ route: "/projects/p1/settings" });

    await screen.findByLabelText("Целевая дата"); // экран точно дорисован
    expect(screen.queryByText("Синхронизировать сейчас")).toBeNull();
  });

  it("у проекта, заведённого из Jira, панель показывает время синхронизации и синхронизирует по кнопке", async () => {
    projectSettingsFixtures();
    server.use(
      http.get("/api/projects/p1/jira", () =>
        HttpResponse.json({
          linked: true,
          jira_project_key: "PROJ",
          jql: 'project = "PROJ" ORDER BY created ASC',
          last_synced_at: "2026-08-19T10:00:00+00:00",
        }),
      ),
      http.post("/api/projects/p1/jira/sync", () =>
        HttpResponse.json(
          { batch_id: "b1", created_categories: 0, created_tasks: 2, updated_tasks: 1 },
          { status: 201 },
        ),
      ),
    );
    renderApp({ route: "/projects/p1/settings" });

    expect(await screen.findByText(/PROJ/)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Синхронизировать сейчас" });

    await userEvent.click(button);

    expect(await screen.findByText(/новых задач.*2.*обновлено.*1/)).toBeInTheDocument();
  });

  it("отправляет сроки в Jira по кнопке и показывает итог", async () => {
    projectSettingsFixtures();
    server.use(
      http.get("/api/projects/p1/jira", () =>
        HttpResponse.json({
          linked: true,
          jira_project_key: "PROJ",
          jql: 'project = "PROJ" ORDER BY created ASC',
          last_synced_at: "2026-08-19T10:00:00+00:00",
        }),
      ),
      http.post("/api/projects/p1/jira/push", () =>
        HttpResponse.json({ pushed: 2, unchanged: 1, failed: [] }, { status: 201 }),
      ),
    );
    renderApp({ route: "/projects/p1/settings" });

    const button = await screen.findByRole("button", { name: "Отправить в Jira" });
    await userEvent.click(button);

    expect(await screen.findByText(/отправлено.*2.*без изменений.*1/)).toBeInTheDocument();
  });

  it("отклонённые Jira задачи остаются на панели, а не исчезают вместе с тостом", async () => {
    projectSettingsFixtures();
    server.use(
      http.get("/api/projects/p1/jira", () =>
        HttpResponse.json({
          linked: true,
          jira_project_key: "PROJ",
          jql: 'project = "PROJ" ORDER BY created ASC',
          last_synced_at: null,
        }),
      ),
      http.post("/api/projects/p1/jira/push", () =>
        HttpResponse.json(
          { pushed: 1, unchanged: 0, failed: [{ issue_key: "PROJ-9", code: "jira_refused" }] },
          { status: 201 },
        ),
      ),
    );
    renderApp({ route: "/projects/p1/settings" });

    await userEvent.click(await screen.findByRole("button", { name: "Отправить в Jira" }));

    expect(await screen.findByText(/PROJ-9/)).toBeInTheDocument();
  });
});

/**
 * Профиль, отвечающий на правки, и список ушедших на сервер полей.
 *
 * Ставится после `sessionHandlers()` из `beforeEach` и потому перебивает их
 * общий ответ про профиль: msw предпочитает обработчик, названный позже.
 */
function profileFixtures(overrides: Partial<typeof USER> = {}) {
  const patches: Patch[] = [];
  let user = { ...USER, ...overrides };
  server.use(
    http.get("/api/auth/me", () => HttpResponse.json(user)),
    http.patch("/api/auth/me", async ({ request }) => {
      const patch = (await request.json()) as Patch;
      patches.push(patch);
      user = { ...user, ...patch };
      return HttpResponse.json(user);
    }),
  );
  return patches;
}

describe("профиль", () => {
  beforeEach(() => {
    server.use(...sessionHandlers());
  });

  it("языка своего не рисует: переключатель один, и он в колонке", async () => {
    renderApp({ route: "/settings/profile" });

    await screen.findByRole("heading", { name: "Профиль" });
    // Ровно один переключатель на окно — тот, что стоит в боковой колонке над
    // «Настройками». Второй здесь означал бы две копии одного выбора рядом.
    const chooser = screen.getByRole("group", { name: "Язык интерфейса" });
    expect(chooser.closest(".sidebar")).not.toBeNull();
  });

  it("имя уходит само и отчитывается о себе у поля", async () => {
    server.use(
      http.patch("/api/auth/me", async ({ request }) => {
        const patch = (await request.json()) as Partial<typeof USER>;
        return HttpResponse.json({ ...USER, ...patch });
      }),
    );
    renderApp({ route: "/settings/profile" });

    const name = await screen.findByLabelText("Имя");
    await userEvent.clear(name);
    await userEvent.type(name, "Алексей Владимирович");
    await userEvent.tab();

    expect(await screen.findByText("Сохранено")).toBeInTheDocument();
    expect(name).toHaveValue("Алексей Владимирович");
  });

  it("адрес показывается, но не правится", async () => {
    renderApp({ route: "/settings/profile" });

    expect(await screen.findByText(USER.email)).toBeInTheDocument();
    expect(screen.queryByLabelText("Почта")).toBeNull();
  });

  it("часовой пояс уходит в профиль выбором из списка", async () => {
    const patches = profileFixtures();
    renderApp({ route: "/settings/profile" });

    await userEvent.selectOptions(await screen.findByLabelText("Часовой пояс"), "Europe/Moscow");

    await waitFor(() => expect(patches).toEqual([{ timezone: "Europe/Moscow" }]));
  });

  it("отвергнутый пояс объясняет отказ у поля, а не молча возвращает прежний", async () => {
    server.use(
      http.patch("/api/auth/me", () =>
        HttpResponse.json({ detail: "unknown" }, { status: 422 }),
      ),
    );
    renderApp({ route: "/settings/profile" });

    await userEvent.selectOptions(await screen.findByLabelText("Часовой пояс"), "Europe/Moscow");

    expect(await screen.findByRole("alert")).toHaveTextContent(/ошибка/i);
  });

  it("«по часам браузера» — это null, а не пустая строка", async () => {
    // Пустая строка не имя пояса, и сервер отказал бы: `null` здесь означает
    // «пояс не выбран», то есть возврат к часам машины.
    const patches = profileFixtures({ timezone: "Europe/Moscow" });
    renderApp({ route: "/settings/profile" });

    await userEvent.selectOptions(await screen.findByLabelText("Часовой пояс"), "");

    await waitFor(() => expect(patches).toEqual([{ timezone: null }]));
  });
});
