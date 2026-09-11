import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "../test/server";
import { renderApp } from "../test/utils";

function anonymous() {
  return http.get("/api/auth/me", () =>
    HttpResponse.json({ detail: "not_authenticated" }, { status: 401 }),
  );
}

describe("экран восстановления пароля", () => {
  it("открывается по ссылке со входа — дорога в один клик", async () => {
    server.use(anonymous());

    renderApp({ route: "/login" });
    await userEvent.click(await screen.findByRole("link", { name: "Забыли пароль?" }));

    expect(
      await screen.findByRole("heading", { name: "Восстановление пароля" }),
    ).toBeInTheDocument();
  });

  it("после отправки обещает письмо только «если адрес зарегистрирован»", async () => {
    server.use(
      anonymous(),
      http.post("/api/auth/password/forgot", () => new HttpResponse(null, { status: 204 })),
    );

    renderApp({ route: "/forgot-password" });
    await userEvent.type(await screen.findByLabelText(/почта/i), "a@b.c");
    await userEvent.click(screen.getByRole("button", { name: "Отправить письмо" }));

    expect(
      await screen.findByText(
        "Если этот адрес зарегистрирован, письмо уже в пути — проверьте почту",
      ),
    ).toBeInTheDocument();
    // The form is hidden: a repeat submission goes through the pause rather than a double click.
    expect(screen.queryByRole("button", { name: "Отправить письмо" })).not.toBeInTheDocument();
  });

  it("объясняет предел частоты переведённым текстом, а не кодом", async () => {
    server.use(
      anonymous(),
      http.post("/api/auth/password/forgot", () =>
        HttpResponse.json({ detail: "too_many_requests" }, { status: 429 }),
      ),
    );

    renderApp({ route: "/forgot-password" });
    await userEvent.type(await screen.findByLabelText(/почта/i), "a@b.c");
    await userEvent.click(screen.getByRole("button", { name: "Отправить письмо" }));

    expect(
      await screen.findByText("Слишком часто: подождите минуту и попробуйте снова"),
    ).toBeInTheDocument();
    expect(screen.queryByText("too_many_requests")).not.toBeInTheDocument();
  });
});
