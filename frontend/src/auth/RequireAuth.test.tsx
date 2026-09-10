import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, delay, http } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "../test/server";
import { ORG, USER, renderApp } from "../test/utils";

describe("защищённые маршруты", () => {
  it("не пускает неаутентифицированного и уводит на вход", async () => {
    server.use(
      http.get("/api/auth/me", () =>
        HttpResponse.json({ detail: "not_authenticated" }, { status: 401 }),
      ),
    );

    renderApp({ route: "/projects" });

    expect(
      await screen.findByRole("heading", { name: /giriş|log in|вход/i }),
    ).toBeInTheDocument();
  });

  it("не мигает экраном входа, пока проверяет сессию", async () => {
    // Ответ не приходит: состояние «проверяю» иначе не поймать.
    server.use(http.get("/api/auth/me", () => delay("infinite")));

    renderApp({ route: "/projects" });

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /вход/i })).not.toBeInTheDocument();
  });

  it("выход возвращает на экран входа и забывает пользователя", async () => {
    server.use(
      http.get("/api/auth/me", () => HttpResponse.json(USER)),
      http.get("/api/org", () => HttpResponse.json(ORG)),
      http.get("/api/projects", () => HttpResponse.json([])),
      http.post("/api/auth/logout", () => new HttpResponse(null, { status: 204 })),
    );

    renderApp({ route: "/projects" });
    await userEvent.click(await screen.findByRole("button", { name: /çıxış|log out|выйти/i }));

    expect(await screen.findByRole("heading", { name: /вход/i })).toBeInTheDocument();
  });

  it("выход состоится и тогда, когда сервер уже не узнаёт сессию", async () => {
    server.use(
      http.get("/api/auth/me", () => HttpResponse.json(USER)),
      http.get("/api/org", () => HttpResponse.json(ORG)),
      http.get("/api/projects", () => HttpResponse.json([])),
      // Сессия просрочена: выход отвечает тем же 401, что и всё остальное.
      http.post("/api/auth/logout", () =>
        HttpResponse.json({ detail: "session_expired" }, { status: 401 }),
      ),
    );

    renderApp({ route: "/projects" });
    await userEvent.click(await screen.findByRole("button", { name: /çıxış|log out|выйти/i }));

    expect(await screen.findByRole("heading", { name: /вход/i })).toBeInTheDocument();
  });

  it("просроченная сессия уводит на вход с первого же отказа, а не держит экран", async () => {
    server.use(
      http.get("/api/auth/me", () => HttpResponse.json(USER)),
      http.get("/api/org", () => HttpResponse.json(ORG)),
      http.get("/api/projects", () =>
        HttpResponse.json({ detail: "session_expired" }, { status: 401 }),
      ),
    );

    renderApp({ route: "/projects" });

    expect(await screen.findByRole("heading", { name: /вход/i })).toBeInTheDocument();
  });
});
