import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { noteVerificationSent } from "../auth/verificationNotice";
import { server } from "../test/server";
import { USER, renderApp, sessionHandlers } from "../test/utils";

const UNVERIFIED = { ...USER, email_verified: false };

/** The list of projects — the most ordinary screen under the frame; the strip lives above it. */
function openProjects(user: typeof USER = UNVERIFIED) {
  server.use(
    // The profile first: within one call the one declared earlier wins, and the environment set already
    // has a profile where the address is confirmed.
    http.get("/api/auth/me", () => HttpResponse.json(user)),
    ...sessionHandlers(),
    http.get("/api/projects", () => HttpResponse.json([])),
  );
  return renderApp({ route: "/projects", locale: "ru" });
}

describe("полоска «адрес не подтверждён»", () => {
  it("висит в раме приложения, а не на отдельном экране", async () => {
    openProjects();

    expect(await screen.findByText(/адрес a@b\.c не подтверждён/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /отправить письмо ещё раз/i }),
    ).toBeEnabled();
  });

  it("не показывается тому, кто адрес уже подтвердил", async () => {
    openProjects(USER);

    // The screen has finished rendering — which means the profile's answer has arrived and the strip has
    // decided.
    await screen.findByRole("heading", { name: /проекты/i });
    expect(screen.queryByText(/не подтверждён/i)).not.toBeInTheDocument();
  });

  it("молчит в установке без почты: подтверждать адрес там нечем", async () => {
    server.use(
      http.get("/api/config", () =>
        HttpResponse.json({
          mail_enabled: false,
          signup_mode: "open",
          supported_locales: ["ru"],
          default_locale: "ru",
          public_sharing_enabled: true,
          live_enabled: true,
        }),
      ),
    );

    openProjects();

    await screen.findByRole("heading", { name: /проекты/i });
    expect(screen.queryByText(/не подтверждён/i)).not.toBeInTheDocument();
  });

  it("отправляет письмо ещё раз и говорит, на какой адрес", async () => {
    let asked = 0;
    server.use(
      http.post("/api/auth/verify-email/resend", () => {
        asked += 1;
        return HttpResponse.json({ sent: true });
      }),
    );

    openProjects();
    await userEvent.click(
      await screen.findByRole("button", { name: /отправить письмо ещё раз/i }),
    );

    expect(await screen.findByText(/письмо отправлено на a@b\.c/i)).toBeInTheDocument();
    expect(asked).toBe(1);
    // The pause has begun: the button says itself how long to wait instead of answering "too often" to a
    // second press.
    expect(screen.getByRole("button", { name: /ещё раз через/i })).toBeDisabled();
  });

  it("не обещает письмо, которое не ушло, и оставляет кнопку живой", async () => {
    server.use(
      http.post("/api/auth/verify-email/resend", () => HttpResponse.json({ sent: false })),
    );

    openProjects();
    await userEvent.click(
      await screen.findByRole("button", { name: /отправить письмо ещё раз/i }),
    );

    expect(await screen.findByText(/не удалось отправить/i)).toBeInTheDocument();
    expect(screen.queryByText(/письмо отправлено на/i)).not.toBeInTheDocument();
    // There is no pause: there is nothing to wait for, there was no email.
    expect(
      screen.getByRole("button", { name: /отправить письмо ещё раз/i }),
    ).toBeEnabled();
  });

  it("после регистрации не предлагает нажать то, что ответит «слишком часто»", async () => {
    // Exactly what the registration screen leaves behind: an email has just gone out and to this address.
    noteVerificationSent(UNVERIFIED.email);

    openProjects();

    expect(await screen.findByText(/письмо отправлено на a@b\.c/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ещё раз через/i })).toBeDisabled();
  });

  it("встречает зарегистрировавшегося строкой «письмо отправлено на …»", async () => {
    // The real path in full: the registration form, the server's answer, the navigation inside. The email
    // is sent by the server itself right after the answer, and the strip is the only place a person
    // learns about it.
    server.use(
      http.get("/api/auth/me", () => HttpResponse.json(UNVERIFIED)),
      ...sessionHandlers(),
      http.get("/api/projects", () => HttpResponse.json([])),
      http.post("/api/auth/register", () => HttpResponse.json(UNVERIFIED, { status: 201 })),
    );

    renderApp({ route: "/register", locale: "ru" });
    await userEvent.type(await screen.findByLabelText(/имя/i), "Алексей");
    await userEvent.type(screen.getByLabelText(/компани/i), "Acme");
    await userEvent.type(screen.getByLabelText(/почта/i), UNVERIFIED.email);
    await userEvent.type(screen.getByLabelText(/пароль/i), "s3cret-pass");
    await userEvent.click(screen.getByRole("button", { name: /зарегистрироваться/i }));

    expect(await screen.findByText(/письмо отправлено на a@b\.c/i)).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/projects");
  });

  it("не показывает чужое письмо следующему вошедшему", async () => {
    noteVerificationSent("someone-else@example.com");

    openProjects();

    expect(await screen.findByText(/адрес a@b\.c не подтверждён/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /отправить письмо ещё раз/i })).toBeEnabled();
  });

  it("объясняет отказ сервера словами, а не кодом", async () => {
    server.use(
      http.post("/api/auth/verify-email/resend", () =>
        HttpResponse.json({ detail: "too_many_requests" }, { status: 429 }),
      ),
    );

    openProjects();
    await userEvent.click(
      await screen.findByRole("button", { name: /отправить письмо ещё раз/i }),
    );

    await waitFor(() =>
      expect(screen.getByText(/слишком часто/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/too_many_requests/)).not.toBeInTheDocument();
  });
});
