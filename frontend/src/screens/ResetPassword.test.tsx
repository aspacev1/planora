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

describe("экран нового пароля", () => {
  it("ставит пароль по токену из ссылки и ведёт ко входу", async () => {
    let sent: unknown = null;
    server.use(
      anonymous(),
      http.post("/api/auth/password/reset", async ({ request }) => {
        sent = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderApp({ route: "/reset-password?token=raw-token-from-letter" });
    await userEvent.type(await screen.findByLabelText(/новый пароль/i), "n3w-secret-pass");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить пароль" }));

    expect(await screen.findByText("Пароль изменён — войдите с новым")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Войти" })).toHaveAttribute("href", "/login");
    // The token leaves the address bar as is: the server checks the hash, and any edit along the way
    // would burn the link for nothing.
    expect(sent).toEqual({ token: "raw-token-from-letter", new_password: "n3w-secret-pass" });
  });

  it("короткий пароль отбивается на месте, без похода на сервер", async () => {
    server.use(anonymous());

    renderApp({ route: "/reset-password?token=raw-token-from-letter" });
    await userEvent.type(await screen.findByLabelText(/новый пароль/i), "short");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить пароль" }));

    expect(
      await screen.findByText("Пароль должен быть не короче 8 символов"),
    ).toBeInTheDocument();
  });

  it("мёртвая ссылка объясняется словами и ведёт за новой", async () => {
    server.use(
      anonymous(),
      http.post("/api/auth/password/reset", () =>
        HttpResponse.json({ detail: "token_expired" }, { status: 400 }),
      ),
    );

    renderApp({ route: "/reset-password?token=stale" });
    await userEvent.type(await screen.findByLabelText(/новый пароль/i), "n3w-secret-pass");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить пароль" }));

    expect(await screen.findByText("Срок действия ссылки истёк")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Запросить новую ссылку" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
  });

  it("без токена в адресе говорит скопировать ссылку целиком", async () => {
    server.use(anonymous());

    renderApp({ route: "/reset-password" });

    expect(
      await screen.findByText("В ссылке нет токена: скопируйте её из письма целиком"),
    ).toBeInTheDocument();
  });
});
