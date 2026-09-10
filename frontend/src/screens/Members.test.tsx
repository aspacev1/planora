import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";

import { server } from "../test/server";
import { ORG, renderApp, sessionHandlers } from "../test/utils";

const ROSTER = [
  { id: "u1", name: "Алексей", email: "a@b.c", role: "owner" },
  { id: "u2", name: "Мария", email: "m@b.c", role: "editor" },
];

const PENDING = {
  id: "i1",
  email: "guest@example.com",
  role: "viewer",
  status: "pending",
  project_ids: [],
  created_at: "2026-08-11T09:00:00+00:00",
  expires_at: "2026-08-18T09:00:00+00:00",
  last_sent_at: null,
  invited_by: "Алексей",
  accepted_at: null,
};

function membersHandlers(
  options: {
    mailEnabled?: boolean;
    invitations?: unknown[];
    role?: string;
    /** Состав организации. Второй владелец снимает защиту последнего. */
    roster?: unknown[];
    /** Список проектов: форма приглашения запрашивает его для любой роли. */
    projects?: unknown[];
  } = {},
) {
  const {
    mailEnabled = false,
    invitations = [PENDING],
    role = "owner",
    roster = ROSTER,
    projects = [],
  } = options;
  // Свои ответы идут первыми: msw берёт первый подходящий обработчик, и
  // общий `/api/org` из sessionHandlers перекрыл бы роль, заданную тестом.
  return [
    http.get("/api/org", () => HttpResponse.json({ ...ORG, role })),
    http.get("/api/org/members", () => HttpResponse.json(roster)),
    http.get("/api/org/invitations", () =>
      HttpResponse.json({ mail_enabled: mailEnabled, invitations }),
    ),
    http.get("/api/projects", () => HttpResponse.json(projects)),
    ...sessionHandlers(),
  ];
}

describe("экран участников", () => {
  it("показывает состав организации с ролями", async () => {
    // Не владельцу роли показываются словами: править их он всё равно не
    // может, и выпадающий список обещал бы действие, которого нет.
    server.use(...membersHandlers({ role: "viewer" }));

    renderApp({ route: "/members", locale: "ru" });

    expect(await screen.findByText("Мария")).toBeInTheDocument();
    expect(screen.getByText("Редактор")).toBeInTheDocument();
  });

  it("выпущенная ссылка показывается сразу и с предупреждением, что второй раз её не будет", async () => {
    server.use(
      ...membersHandlers({ invitations: [] }),
      http.post("/api/org/invitations", () =>
        HttpResponse.json(
          [
            {
              id: "i2",
              email: "guest@example.com",
              role: "viewer",
              expires_at: "2026-08-18T09:00:00+00:00",
              url: "http://localhost:8000/invite/секретный-токен",
              sent: false,
              mail_error: null,
            },
          ],
          { status: 201 },
        ),
      ),
    );

    renderApp({ route: "/members", locale: "ru" });

    await userEvent.click(await screen.findByRole("button", { name: /пригласить/i }));
    await userEvent.type(screen.getByLabelText(/адреса/i), "guest@example.com");
    await userEvent.click(screen.getByRole("button", { name: /создать приглашение/i }));

    const link = await screen.findByLabelText(/ссылка приглашения/i);
    expect(link).toHaveValue("http://localhost:8000/invite/секретный-токен");
    expect(screen.getByText(/второй раз её взять негде/i)).toBeInTheDocument();
  });

  it("без настроенной почты кнопки отправки нет вовсе", async () => {
    server.use(...membersHandlers({ mailEnabled: false }));

    renderApp({ route: "/members", locale: "ru" });

    expect(await screen.findByRole("button", { name: /новая ссылка/i })).toBeInTheDocument();
    // Установка без почтового сервера остаётся полноценной: остаётся
    // копирование ссылки, а кнопки, которая всегда ответит отказом, нет.
    expect(screen.queryByRole("button", { name: /отправить ещё раз/i })).not.toBeInTheDocument();
  });

  it("с настроенной почтой отправить приглашение можно ещё раз", async () => {
    server.use(...membersHandlers({ mailEnabled: true }));

    renderApp({ route: "/members", locale: "ru" });

    expect(await screen.findByRole("button", { name: /отправить ещё раз/i })).toBeInTheDocument();
  });

  it("повторный выпуск спрашивает и показывает новую ссылку", async () => {
    let reissued = false;
    server.use(
      ...membersHandlers(),
      http.post("/api/org/invitations/i1/reissue", () => {
        reissued = true;
        return HttpResponse.json({
          id: "i1",
          email: "guest@example.com",
          role: "viewer",
          expires_at: "2026-08-18T09:00:00+00:00",
          url: "http://localhost:8000/invite/новый-токен",
          sent: false,
          mail_error: null,
        });
      }),
    );

    renderApp({ route: "/members", locale: "ru" });
    await userEvent.click(await screen.findByRole("button", { name: /^новая ссылка$/i }));

    // Прежняя ссылка живёт до ответа на вопрос: перевыпуск убивает её, а
    // «новая ссылка» об этом не говорит ни словом.
    expect(reissued).toBe(false);
    expect(screen.getByText(/прежняя ссылка умрёт сразу/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /да, новая ссылка/i }));

    expect(await screen.findByLabelText(/ссылка приглашения/i)).toHaveValue(
      "http://localhost:8000/invite/новый-токен",
    );
  });

  it("отзыв приглашения тоже спрашивает, и от него можно отказаться", async () => {
    let revoked = false;
    server.use(
      ...membersHandlers(),
      http.delete("/api/org/invitations/i1", () => {
        revoked = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderApp({ route: "/members", locale: "ru" });
    await userEvent.click(await screen.findByRole("button", { name: /^отозвать$/i }));
    await userEvent.click(screen.getByRole("button", { name: /^отмена$/i }));

    expect(revoked).toBe(false);
    expect(screen.getByRole("button", { name: /^отозвать$/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^отозвать$/i }));
    await userEvent.click(screen.getByRole("button", { name: /да, отозвать/i }));

    await waitFor(() => expect(revoked).toBe(true));
  });

  it("«отправить ещё раз» предупреждает тем же: это тот же перевыпуск", async () => {
    server.use(...membersHandlers({ mailEnabled: true }));

    renderApp({ route: "/members", locale: "ru" });
    await userEvent.click(await screen.findByRole("button", { name: /отправить ещё раз/i }));

    expect(screen.getByText(/прежняя ссылка умрёт сразу/i)).toBeInTheDocument();
  });

  it("письмо, которое не ушло, названо прямо, а приглашение остаётся", async () => {
    server.use(
      ...membersHandlers({ invitations: [] }),
      http.post("/api/org/invitations", () =>
        HttpResponse.json(
          [
            {
              id: "i3",
              email: "guest@example.com",
              role: "viewer",
              expires_at: "2026-08-18T09:00:00+00:00",
              url: "http://localhost:8000/invite/токен",
              sent: false,
              mail_error: "mail_failed",
            },
          ],
          { status: 201 },
        ),
      ),
    );

    renderApp({ route: "/members", locale: "ru" });

    await userEvent.click(await screen.findByRole("button", { name: /пригласить/i }));
    await userEvent.type(screen.getByLabelText(/адреса/i), "guest@example.com");
    await userEvent.click(screen.getByRole("button", { name: /создать приглашение/i }));

    expect(await screen.findByText(/письмо не ушло/i)).toBeInTheDocument();
    // Действие не откатывается: ссылка на месте и её можно отправить руками.
    expect(screen.getByLabelText(/ссылка приглашения/i)).toBeInTheDocument();
  });

  it("отзыв снимает и «письмо не ушло»: оно было про перевыпуск, которого больше нет", async () => {
    server.use(
      ...membersHandlers({ mailEnabled: true }),
      http.post("/api/org/invitations/i1/reissue", () =>
        HttpResponse.json({
          id: "i1",
          email: "guest@example.com",
          role: "viewer",
          expires_at: "2026-08-18T09:00:00+00:00",
          url: "http://localhost:8000/invite/новый-токен",
          sent: false,
          mail_error: "mail_failed",
        }),
      ),
      http.delete("/api/org/invitations/i1", () => new HttpResponse(null, { status: 204 })),
    );

    renderApp({ route: "/members", locale: "ru" });
    await userEvent.click(await screen.findByRole("button", { name: /отправить ещё раз/i }));
    await userEvent.click(screen.getByRole("button", { name: /да, отправить заново/i }));
    expect(await screen.findByText(/письмо не ушло/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^отозвать$/i }));
    await userEvent.click(screen.getByRole("button", { name: /да, отозвать/i }));

    await waitFor(() => expect(screen.queryByText(/письмо не ушло/i)).toBeNull());
  });

  it("отозванное приглашение действий больше не предлагает", async () => {
    server.use(...membersHandlers({ invitations: [{ ...PENDING, status: "revoked" }] }));

    renderApp({ route: "/members", locale: "ru" });

    expect(await screen.findByText("Отозвано")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /отозвать/i })).not.toBeInTheDocument();
  });

  it("исчерпанный часовой потолок объясняется словами", async () => {
    server.use(
      ...membersHandlers({ invitations: [] }),
      http.post("/api/org/invitations", () =>
        HttpResponse.json({ detail: "invite_rate_limited" }, { status: 429 }),
      ),
    );

    renderApp({ route: "/members", locale: "ru" });

    await userEvent.click(await screen.findByRole("button", { name: /пригласить/i }));
    await userEvent.type(screen.getByLabelText(/адреса/i), "guest@example.com");
    await userEvent.click(screen.getByRole("button", { name: /создать приглашение/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/слишком много приглашений/i);
  });

  it("проекты можно отметить для любой роли, не только «Клиента»", async () => {
    server.use(
      ...membersHandlers({
        invitations: [],
        projects: [{ id: "p1", name: "Şəhər Layihəsi", slug: "seher-layihesi" }],
      }),
    );

    renderApp({ route: "/members", locale: "ru" });
    await userEvent.click(await screen.findByRole("button", { name: /пригласить/i }));

    // Роль по умолчанию — «Наблюдатель», и список проектов уже виден: отметка
    // сужает любую роль, а не только клиента.
    const checkbox = await screen.findByLabelText("Şəhər Layihəsi");
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).not.toBeChecked();

    await userEvent.selectOptions(screen.getByLabelText("Роль"), "client");

    // Тот же список остаётся на месте и для клиента — форма не пересобирает
    // его заново при смене роли.
    expect(screen.getByLabelText("Şəhər Layihəsi")).toBeInTheDocument();
  });

  it("не владельцу приглашения не показываются вовсе", async () => {
    server.use(...membersHandlers({ role: "editor" }));

    renderApp({ route: "/members", locale: "ru" });

    expect(await screen.findByText("Мария")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /пригласить/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Приглашения")).not.toBeInTheDocument();
  });

  it("ссылка кладётся в буфер обмена по кнопке", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    server.use(
      ...membersHandlers(),
      http.post("/api/org/invitations/i1/reissue", () =>
        HttpResponse.json({
          id: "i1",
          email: "guest@example.com",
          role: "viewer",
          expires_at: "2026-08-18T09:00:00+00:00",
          url: "http://localhost:8000/invite/токен",
          sent: false,
          mail_error: null,
        }),
      ),
    );

    renderApp({ route: "/members", locale: "ru" });
    await userEvent.click(await screen.findByRole("button", { name: /^новая ссылка$/i }));
    await userEvent.click(screen.getByRole("button", { name: /да, новая ссылка/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^скопировать$/i }));

    expect(writeText).toHaveBeenCalledWith("http://localhost:8000/invite/токен");
    vi.unstubAllGlobals();
  });
});

describe("переключатель организаций", () => {
  it("не показывается, пока организация одна", async () => {
    server.use(http.get("/api/org/list", () => HttpResponse.json([ORG])), ...membersHandlers());

    renderApp({ route: "/members", locale: "ru" });

    expect(await screen.findByText("Мария")).toBeInTheDocument();
    expect(screen.queryByLabelText("Организация")).not.toBeInTheDocument();
  });

  it("переключает организацию и перезапрашивает всё, что от неё зависит", async () => {
    const other = { ...ORG, id: "o2", name: "Globex", slug: "globex", role: "viewer" };
    let current = ORG;
    server.use(
      http.get("/api/org", () => HttpResponse.json(current)),
      http.get("/api/org/list", () => HttpResponse.json([ORG, other])),
      http.post("/api/org/switch", () => {
        current = other;
        return HttpResponse.json(other);
      }),
      http.get("/api/org/members", () =>
        HttpResponse.json(
          current.id === ORG.id ? ROSTER : [{ ...ROSTER[1], name: "Кто-то ещё" }],
        ),
      ),
      ...membersHandlers(),
    );

    renderApp({ route: "/members", locale: "ru" });

    const switcher = await screen.findByLabelText("Организация");
    expect(await screen.findByText("Мария")).toBeInTheDocument();

    await userEvent.selectOptions(switcher, "o2");

    // Состав организации — из новой, а не из прежней: экран следует за
    // выбором, а не остаётся на данных, которых в этой организации нет.
    expect(await screen.findByText("Кто-то ещё")).toBeInTheDocument();
    expect(switcher).toHaveValue("o2");
  });
});

describe("роль в форме приглашения", () => {
  it("владельца приглашением не выдают: отыграть это назад нечем", async () => {
    server.use(...membersHandlers());

    renderApp({ route: "/members", locale: "ru" });
    await userEvent.click(await screen.findByRole("button", { name: /пригласить/i }));

    const select = screen.getByLabelText("Роль");
    const values = within(select)
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value);

    expect(values).toEqual(["editor", "viewer", "client"]);
    expect(values).not.toContain("owner");
  });

  it("под выбором роли написано, что она даёт", async () => {
    server.use(
      ...membersHandlers(),
      // Выбор «Клиента» спрашивает проекты: отмечать нечего, но запрос уходит.
      http.get("/api/projects", () => HttpResponse.json([])),
    );

    renderApp({ route: "/members", locale: "ru" });
    await userEvent.click(await screen.findByRole("button", { name: /пригласить/i }));

    // «Наблюдатель» и «Клиент» отличаются не словом, а тем, что видит первый:
    // все проекты организации против отмеченных поимённо. Узнать это после
    // отправки приглашения поздно.
    expect(screen.getByText(/читает проекты организации/i)).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Роль"), "client");

    expect(screen.getByText(/только те проекты, куда его позвали/i)).toBeInTheDocument();
  });

  it("позвать того, кто уже внутри, нельзя — и сказано словами", async () => {
    server.use(
      ...membersHandlers({ invitations: [] }),
      http.post("/api/org/invitations", () =>
        HttpResponse.json({ detail: "already_member" }, { status: 409 }),
      ),
    );

    renderApp({ route: "/members", locale: "ru" });

    await userEvent.click(await screen.findByRole("button", { name: /пригласить/i }));
    await userEvent.type(screen.getByLabelText(/адреса/i), "m@b.c");
    await userEvent.click(screen.getByRole("button", { name: /создать приглашение/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/уже в организации/i);
  });
});

describe("управление составом", () => {
  it("владелец меняет роль участника прямо в строке", async () => {
    let sent: unknown = null;
    server.use(
      ...membersHandlers(),
      http.patch("/api/org/members/u2", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ ...ROSTER[1], role: "viewer" });
      }),
    );

    renderApp({ route: "/members", locale: "ru" });

    await userEvent.selectOptions(await screen.findByLabelText("Роль: Мария"), "viewer");

    await waitFor(() => expect(sent).toEqual({ role: "viewer" }));
    // Тост, а не молчание: строка меняется на одно слово, и без подтверждения
    // непонятно, дошло ли действие до сервера.
    expect(await screen.findByText(/Мария теперь Наблюдатель/i)).toBeInTheDocument();
  });

  it("владельца назначают здесь — приглашением его не выдают", async () => {
    server.use(...membersHandlers());

    renderApp({ route: "/members", locale: "ru" });

    const values = within(await screen.findByLabelText("Роль: Мария"))
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value);

    expect(values).toEqual(["owner", "editor", "viewer", "client"]);
  });

  it("единственного владельца не разжаловать, и объяснено почему", async () => {
    server.use(...membersHandlers());

    renderApp({ route: "/members", locale: "ru" });

    expect(await screen.findByLabelText("Роль: Алексей")).toBeDisabled();
    expect(screen.getByText(/организация без владельца заперта/i)).toBeInTheDocument();
  });

  it("второй владелец снимает запрет с первого", async () => {
    server.use(...membersHandlers({ roster: [ROSTER[0], { ...ROSTER[1], role: "owner" }] }));

    renderApp({ route: "/members", locale: "ru" });

    expect(await screen.findByLabelText("Роль: Алексей")).toBeEnabled();
    expect(screen.queryByText(/организация без владельца заперта/i)).not.toBeInTheDocument();
  });

  it("вывод из организации спрашивает, и от него можно отказаться", async () => {
    let removed = false;
    server.use(
      ...membersHandlers(),
      http.delete("/api/org/members/u2", () => {
        removed = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderApp({ route: "/members", locale: "ru" });

    await userEvent.click(await screen.findByRole("button", { name: /^убрать$/i }));
    expect(screen.getByText(/Мария потеряет доступ/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^отмена$/i }));
    expect(removed).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: /^убрать$/i }));
    await userEvent.click(screen.getByRole("button", { name: /да, убрать/i }));

    await waitFor(() => expect(removed).toBe(true));
  });

  it("себя из списка не убирают: для этого есть «Покинуть организацию»", async () => {
    server.use(...membersHandlers({ roster: [ROSTER[0], { ...ROSTER[1], role: "owner" }] }));

    renderApp({ route: "/members", locale: "ru" });

    // Вошедший — u1: кнопки «убрать» в его собственной строке нет, а уход
    // стоит отдельным разделом и назван своими словами.
    const mine = (await screen.findByText("a@b.c")).closest("li") as HTMLElement;
    expect(within(mine).queryByRole("button", { name: /убрать/i })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /покинуть организацию/i }),
    ).toBeInTheDocument();
  });
});

describe("покинуть организацию", () => {
  it("спрашивает, уводит на проекты и подтверждает уход", async () => {
    let left = false;
    server.use(
      ...membersHandlers({ roster: [ROSTER[0], { ...ROSTER[1], role: "owner" }] }),
      http.delete("/api/org/members/u1", () => {
        left = true;
        return new HttpResponse(null, { status: 204 });
      }),
      // Уход уводит на список проектов — тот сразу же за ними и идёт.
      http.get("/api/projects", () => HttpResponse.json([])),
    );

    renderApp({ route: "/members", locale: "ru" });

    await userEvent.click(
      await screen.findByRole("button", { name: /покинуть организацию/i }),
    );
    expect(screen.getByText(/доступ к проектам этой организации пропадёт сразу/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /да, покинуть/i }));

    await waitFor(() => expect(left).toBe(true));
    expect(await screen.findByTestId("location")).toHaveTextContent("/projects");
  });

  it("последний владелец не уходит, и ему сказано, что сделать сначала", async () => {
    server.use(...membersHandlers());

    renderApp({ route: "/members", locale: "ru" });

    expect(await screen.findByText(/сначала назначьте владельцем кого-то ещё/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /покинуть организацию/i }),
    ).not.toBeInTheDocument();
  });

  it("роль «Клиент» состава не видит, но уйти может", async () => {
    // Сервер отвечает ей отказом на состав: без раздела ухода позванный
    // однажды остался бы внутри навсегда.
    server.use(
      ...membersHandlers({ role: "client" }),
      http.get("/api/org/members", () => HttpResponse.json({ detail: "forbidden" }, { status: 403 })),
    );

    renderApp({ route: "/members", locale: "ru" });

    expect(
      await screen.findByRole("button", { name: /покинуть организацию/i }),
    ).toBeInTheDocument();
  });

  it("отказ сервера доходит до человека словами", async () => {
    server.use(
      ...membersHandlers({ roster: [ROSTER[0], { ...ROSTER[1], role: "owner" }] }),
      http.delete("/api/org/members/u1", () =>
        HttpResponse.json({ detail: "last_owner" }, { status: 409 }),
      ),
    );

    renderApp({ route: "/members", locale: "ru" });

    await userEvent.click(
      await screen.findByRole("button", { name: /покинуть организацию/i }),
    );
    await userEvent.click(screen.getByRole("button", { name: /да, покинуть/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/хотя бы один владелец/i);
  });
});
