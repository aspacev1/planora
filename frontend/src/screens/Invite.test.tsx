import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "../test/server";
import { ORG, USER, renderApp, sessionHandlers } from "../test/utils";

const TOKEN = "s3cret-token";
const ROUTE = `/invite/${TOKEN}`;

const PREVIEW = {
  org_name: "Şəhər Studiyası",
  role: "viewer",
  email: "a@b.c",
  inviter_name: "Мария",
  expires_at: "2026-08-18T09:00:00+00:00",
};

/** Nobody is signed in: the invitation was opened from an email, in a different browser. */
function anonymous() {
  return http.get("/api/auth/me", () => HttpResponse.json({ detail: "not_authenticated" }, { status: 401 }));
}

function preview(body: object, status = 200) {
  return http.get(`/api/invitations/${TOKEN}`, () => HttpResponse.json(body, { status }));
}

describe("экран приглашения", () => {
  it("говорит, куда и кем зовут, ещё до входа", async () => {
    server.use(preview(PREVIEW), anonymous());

    renderApp({ route: ROUTE, locale: "ru" });

    expect(await screen.findByText(/Şəhər Studiyası/)).toBeInTheDocument();
    expect(screen.getByText(/Наблюдатель/)).toBeInTheDocument();
    expect(screen.getByText(/Приглашает Мария/)).toBeInTheDocument();
  });

  it("не вошедшему предлагает и регистрацию, и вход — с сохранением ссылки", async () => {
    server.use(preview(PREVIEW), anonymous());

    renderApp({ route: ROUTE, locale: "ru" });

    const register = await screen.findByRole("link", { name: /зарегистрироваться/i });
    expect(register).toHaveAttribute("href", `/register?invite=${encodeURIComponent(TOKEN)}`);
    expect(screen.getByRole("link", { name: /войти/i })).toHaveAttribute(
      "href",
      `/login?invite=${encodeURIComponent(TOKEN)}`,
    );
  });

  it("вошедшему даёт принять приглашение и уводит к проектам", async () => {
    server.use(
      preview(PREVIEW),
      ...sessionHandlers(),
      http.post(`/api/invitations/${TOKEN}/accept`, () =>
        HttpResponse.json({ id: "o2", name: "Şəhər Studiyası", slug: "s", role: "viewer" }),
      ),
      http.get("/api/projects", () => HttpResponse.json([])),
    );

    renderApp({ route: ROUTE, locale: "ru" });

    await userEvent.click(await screen.findByRole("button", { name: /принять приглашение/i }));

    // Not findByTestId: the element with the address exists from the first frame, so findBy locates it
    // instantly — before the mutation finishes and the navigation happens — and a one-off assert
    // flickered under the load of a full run. What has to be waited for is a change of content, and
    // waitFor does that.
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/projects"));
  });

  it("вошедшему не под тем аккаунтом говорит, кому приглашение адресовано", async () => {
    server.use(preview({ ...PREVIEW, email: "someone@else.com" }), ...sessionHandlers());

    renderApp({ route: ROUTE, locale: "ru" });

    expect(await screen.findByRole("alert")).toHaveTextContent("someone@else.com");
    // A sign-out is offered rather than a bare refusal: otherwise it is unclear what to do.
    expect(screen.getByRole("button", { name: /выйти/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /принять приглашение/i })).not.toBeInTheDocument();
  });

  it("приглашение по ссылке прямо говорит, что достанется предъявителю", async () => {
    server.use(preview({ ...PREVIEW, email: null }), ...sessionHandlers());

    renderApp({ route: ROUTE, locale: "ru" });

    expect(await screen.findByText(/для того, кто её открыл/i)).toBeInTheDocument();
  });

  it.each([
    ["invite_expired", /срок ссылки истёк/i],
    ["invite_revoked", /отозвано/i],
    ["invite_accepted", /уже принято/i],
  ])("состояние %s объясняется своим сообщением, а не общим отказом", async (code, expected) => {
    server.use(preview({ detail: code }, 409), anonymous());

    renderApp({ route: ROUTE, locale: "ru" });

    expect(await screen.findByRole("alert")).toHaveTextContent(expected);
  });

  it("незнакомая ссылка не притворяется просроченной", async () => {
    server.use(preview({ detail: "invite_not_found" }, 404), anonymous());

    renderApp({ route: ROUTE, locale: "ru" });

    expect(await screen.findByRole("alert")).toHaveTextContent(/проверьте ссылку/i);
  });
});

describe("регистрация по приглашению", () => {
  it("подставляет адрес приглашения и не даёт его править", async () => {
    server.use(preview(PREVIEW), anonymous());

    renderApp({ route: `/register?invite=${TOKEN}`, locale: "ru" });

    const email = await screen.findByDisplayValue("a@b.c");
    expect(email).toHaveAttribute("readonly");
  });

  it("отправляет токен вместе с формой и уводит внутрь организации", async () => {
    let sent: Record<string, unknown> | null = null;
    server.use(
      preview(PREVIEW),
      // The profile answers as after a successful registration: the cookie is already set by this
      // moment, and a protected route lets you through with it. Otherwise the check would run into a
      // redirect to the sign-in — into the sign-in's behaviour rather than registration by invitation's.
      ...sessionHandlers(),
      http.post("/api/auth/register", async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(USER, { status: 201 });
      }),
      http.get("/api/org", () => HttpResponse.json(ORG)),
      http.get("/api/projects", () => HttpResponse.json([])),
    );

    renderApp({ route: `/register?invite=${TOKEN}`, locale: "ru" });

    // First we wait for the invitation: before it arrives the form is not submitted — the address in it
    // is still empty, and the person cannot fill it in.
    await screen.findByDisplayValue("a@b.c");
    // The organization already exists — there is nothing to create a second one with, and its field is not shown.
    expect(screen.queryByLabelText(/компани/i)).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/имя/i), "Гость");
    await userEvent.type(screen.getByLabelText(/пароль/i), "s3cret-pass");
    await userEvent.click(screen.getByRole("button", { name: /зарегистрироваться/i }));

    // See the comment on the same wait above: waitFor rather than findByTestId.
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/projects"));
    expect(sent).toMatchObject({ email: "a@b.c", invite_token: TOKEN });
    expect(sent).not.toHaveProperty("company_name");
  });

  it("мёртвая ссылка объясняется до того, как человек заполнит форму", async () => {
    server.use(preview({ detail: "invite_expired" }, 409), anonymous());

    renderApp({ route: `/register?invite=${TOKEN}`, locale: "ru" });

    expect(await screen.findByRole("alert")).toHaveTextContent(/срок ссылки истёк/i);
  });
});
