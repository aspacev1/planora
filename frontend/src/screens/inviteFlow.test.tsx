/**
 * An invitee's path in full — through a real router and real navigations.
 *
 * Screens taken separately do not catch these scenarios: an invitation is lost not inside a screen
 * but on the transition between two, and that can only be seen by walking the chain the way a person
 * walks it. Both scenarios below are not made up: invitations are sent to work addresses, which have
 * had an account for a long time, and the password to it is not always remembered.
 */

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { server } from "../test/server";
import { ORG, USER, renderApp } from "../test/utils";

const TOKEN = "inv-token-42";

const PREVIEW = {
  org_name: "Şəhər Studiyası",
  role: "editor",
  // The same address as the profile's: otherwise the invitation screen will decide the person signed
  // in under the wrong account and will offer to sign out instead of "Accept".
  email: USER.email,
  inviter_name: "Мария",
  expires_at: "2026-09-01T00:00:00+00:00",
};

/** There is no session until a sign-in: the first `/api/auth/me` must answer with a refusal. */
function anonymousUntilLogin() {
  let signedIn = false;
  server.use(
    http.get("/api/auth/me", () =>
      signedIn
        ? HttpResponse.json(USER)
        : HttpResponse.json({ detail: "not_authenticated" }, { status: 401 }),
    ),
    http.post("/api/auth/login", () => {
      signedIn = true;
      return HttpResponse.json(USER);
    }),
    http.get("/api/org", () => HttpResponse.json(ORG)),
    http.get("/api/projects", () => HttpResponse.json([])),
    http.get(`/api/invitations/${TOKEN}`, () => HttpResponse.json(PREVIEW)),
  );
}

async function logIn() {
  await userEvent.type(screen.getByLabelText(/почта/i), USER.email);
  await userEvent.type(screen.getByLabelText(/пароль/i), "s3cret-pass");
  await userEvent.click(screen.getByRole("button", { name: /^войти$/i }));
}

beforeEach(() => {
  localStorage.clear();
});

describe("путь приглашённого", () => {
  it("у кого аккаунт уже есть: регистрация отказывает, и вход возвращает к приглашению", async () => {
    anonymousUntilLogin();
    server.use(
      http.post("/api/auth/register", () =>
        HttpResponse.json({ detail: "email_taken" }, { status: 409 }),
      ),
    );

    renderApp({ route: `/invite/${TOKEN}` });

    // The invitation screen: you can see what you are being invited to before any sign-in.
    await screen.findByRole("heading", { name: /приглашение/i });
    await userEvent.click(screen.getByRole("link", { name: /зарегистр/i }));

    // The form filled in the invitation's address and locked it.
    await screen.findByRole("heading", { name: /регистрация/i });
    await userEvent.type(screen.getByLabelText(/имя/i), "Алексей");
    await userEvent.type(screen.getByLabelText(/пароль/i), "s3cret-pass");
    await userEvent.click(screen.getByRole("button", { name: /зарегистр/i }));
    expect(await screen.findByText("Этот адрес уже занят")).toBeInTheDocument();

    // The screen offers a sign-out itself — and that sign-out must carry the invitation.
    await userEvent.click(screen.getByRole("link", { name: /^войти$/i }));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        `/login?invite=${TOKEN}`,
      ),
    );

    await logIn();

    // There used to be the former organization's /projects here, while the invitation stayed in
    // "Pending" forever.
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(`/invite/${TOKEN}`),
    );
    expect(
      await screen.findByRole("button", { name: /принять приглашение/i }),
    ).toBeInTheDocument();
  });

  it("кто забыл пароль: приглашение переживает письмо, которое строит сервер", async () => {
    anonymousUntilLogin();
    server.use(
      http.post("/api/auth/password/forgot", () => new HttpResponse(null, { status: 204 })),
      http.post("/api/auth/password/reset", () => new HttpResponse(null, { status: 204 })),
    );

    renderApp({ route: `/invite/${TOKEN}` });
    await screen.findByRole("heading", { name: /приглашение/i });
    await userEvent.click(screen.getByRole("link", { name: /^войти$/i }));

    await screen.findByRole("heading", { name: /^вход$/i });
    await userEvent.click(screen.getByRole("link", { name: /забыли пароль/i }));

    // The invitation got through to the recovery in the query string.
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        `/forgot-password?invite=${TOKEN}`,
      ),
    );
    await userEvent.type(screen.getByLabelText(/почта/i), USER.email);
    await userEvent.click(screen.getByRole("button", { name: /отправить письмо/i }));
    await screen.findByText(/письмо уже в пути/i);

    // After that the person leaves for their mail and comes back by a link the server built: there is
    // no invitation in it and cannot be — only the reset token.
    renderApp({ route: "/reset-password?token=reset-token" });
    await userEvent.type(
      await screen.findByLabelText(/новый пароль/i),
      "brand-new-pass",
    );
    await userEvent.click(screen.getByRole("button", { name: /сохранить пароль/i }));
    await screen.findByText(/пароль изменён/i);

    // The "Sign in" link is bare — the memory picks the invitation up.
    await userEvent.click(screen.getByRole("link", { name: /^войти$/i }));
    await logIn();

    await waitFor(() =>
      expect(screen.getAllByTestId("location").at(-1)).toHaveTextContent(
        `/invite/${TOKEN}`,
      ),
    );
  });

  it("мёртвая ссылка не запоминается и не всплывает при следующем входе", async () => {
    anonymousUntilLogin();
    server.use(
      http.get(`/api/invitations/${TOKEN}`, () =>
        HttpResponse.json({ detail: "invite_expired" }, { status: 409 }),
      ),
    );

    renderApp({ route: `/invite/${TOKEN}` });
    expect(await screen.findByText(/срок ссылки истёк/i)).toBeInTheDocument();

    expect(localStorage.getItem("planora.pending_invite")).toBeNull();
  });
});
