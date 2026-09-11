import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { projectFixtures } from "../test/project";
import { server } from "../test/server";
import { ORG, USER, renderApp } from "../test/utils";

async function fillAndSubmit() {
  await userEvent.type(screen.getByLabelText(/почта/i), "a@b.c");
  await userEvent.type(screen.getByLabelText(/пароль/i), "s3cret-pass");
  await userEvent.click(screen.getByRole("button", { name: /войти/i }));
}

describe("экран входа", () => {
  it("впускает и показывает то, ради чего человек пришёл", async () => {
    server.use(
      http.get("/api/auth/me", () =>
        HttpResponse.json({ detail: "not_authenticated" }, { status: 401 }),
      ),
      http.post("/api/auth/login", () => HttpResponse.json(USER)),
      http.get("/api/org", () => HttpResponse.json(ORG)),
      http.get("/api/projects", () => HttpResponse.json([])),
    );

    renderApp({ route: "/login" });
    await fillAndSubmit();

    expect(await screen.findByRole("heading", { name: "Проекты" })).toBeInTheDocument();
  });

  it("возвращает на присланную ссылку, а не в общий список", async () => {
    projectFixtures();
    server.use(
      // Later than projectFixtures — which means it wins: before the sign-in there is no session.
      http.get("/api/auth/me", () =>
        HttpResponse.json({ detail: "not_authenticated" }, { status: 401 }),
      ),
      http.post("/api/auth/login", () => HttpResponse.json(USER)),
    );

    renderApp({ route: "/projects/p1?tab=plan" });
    // First the session check, and only then the form: before the server's answer there is an indicator
    // on screen rather than fields.
    await screen.findByRole("heading", { name: /вход/i });
    await fillAndSubmit();

    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1?tab=plan"),
    );
  });

  it("объясняет неверную пару переведённым текстом, а не кодом", async () => {
    server.use(
      http.get("/api/auth/me", () =>
        HttpResponse.json({ detail: "not_authenticated" }, { status: 401 }),
      ),
      http.post("/api/auth/login", () =>
        HttpResponse.json({ detail: "bad_credentials" }, { status: 401 }),
      ),
    );

    renderApp({ route: "/login" });
    await fillAndSubmit();

    expect(await screen.findByText("Неверная почта или пароль")).toBeInTheDocument();
    expect(screen.queryByText("bad_credentials")).not.toBeInTheDocument();
  });
});
