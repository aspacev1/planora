import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { projectFixtures, renderProject } from "../test/project";
import { server } from "../test/server";
import { ORG } from "../test/utils";

beforeEach(projectFixtures);

// Publishing hangs on this same screen: a test about deletion must not fail on a request it has
// nothing to do with. Not published.
beforeEach(() => {
  server.use(
    http.get("/api/projects/p1/share", () =>
      HttpResponse.json({ allowed: true, url: null, comments_enabled: true, created_at: null }),
    ),
  );
});

describe("удаление проекта", () => {
  it("владелец удаляет проект после подтверждения и попадает к списку", async () => {
    let deleted = false;
    server.use(
      // The list the screen leads to after a deletion. Empty: the project has just been deleted, and
      // there are no others in the harness.
      http.get("/api/projects", () => HttpResponse.json([])),
      http.delete("/api/projects/p1", () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderProject(undefined, { route: "/projects/p1/settings" });

    await userEvent.click(await screen.findByRole("button", { name: "Удалить проект" }));
    // The first press deletes nothing — it unfolds the confirmation.
    expect(deleted).toBe(false);
    expect(screen.getByText(/отменить это будет нельзя/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Да, удалить проект" }));

    await waitFor(() => expect(deleted).toBe(true));
    // The navigation is checked by the address as a person sees it rather than by a navigate call (see
    // LocationProbe in test/utils).
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/projects"),
    );
  });

  it("подтверждение можно передумать", async () => {
    renderProject(undefined, { route: "/projects/p1/settings" });

    await userEvent.click(await screen.findByRole("button", { name: "Удалить проект" }));
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));

    expect(screen.getByRole("button", { name: "Удалить проект" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Да, удалить проект" }),
    ).not.toBeInTheDocument();
  });

  it("редактору кнопка удаления не показывается", async () => {
    // Later than the harness — which means it overrides its owner-role handler: msw prefers the one
    // registered last.
    server.use(http.get("/api/org", () => HttpResponse.json({ ...ORG, role: "editor" })));
    renderProject(undefined, { route: "/projects/p1/settings" });

    // The screen has loaded: the settings are already visible.
    await screen.findByLabelText("Название");
    expect(screen.queryByRole("button", { name: "Удалить проект" })).not.toBeInTheDocument();
  });
});

describe("публичная ссылка в настройках проекта", () => {
  const PUBLISHED = {
    allowed: true,
    url: "https://planora.example.com/p/seher-studiyasi/redizayn?s=t0ken",
    comments_enabled: false,
    created_at: "2026-03-05T10:00:00+00:00",
  };

  it("перевыпуск спрашивает и уходит на свой маршрут, а не повторяет выпуск", async () => {
    const calls: string[] = [];
    server.use(
      http.get("/api/projects/p1/share", () => HttpResponse.json(PUBLISHED)),
      // The server meets a repeat POST /share with a 409: issuing and reissuing are different
      // decisions, and they stay different routes.
      http.post("/api/projects/p1/share", () => {
        calls.push("issue");
        return HttpResponse.json({ detail: "share_link_exists" }, { status: 409 });
      }),
      http.post("/api/projects/p1/share/rotate", () => {
        calls.push("rotate");
        return HttpResponse.json({ ...PUBLISHED, url: `${PUBLISHED.url}-new` }, { status: 201 });
      }),
    );
    renderProject(undefined, { route: "/projects/p1/settings" });

    await userEvent.click(await screen.findByRole("button", { name: "Перевыпустить" }));
    expect(calls).toEqual([]);
    expect(screen.getByText(/уже отправленный адрес перестанет открываться/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Да, перевыпустить" }));

    await waitFor(() => expect(calls).toEqual(["rotate"]));
  });

  it("закрытие ссылки без ответа на вопрос не случается", async () => {
    let revoked = false;
    server.use(
      http.get("/api/projects/p1/share", () => HttpResponse.json(PUBLISHED)),
      http.delete("/api/projects/p1/share", () => {
        revoked = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderProject(undefined, { route: "/projects/p1/settings" });

    await userEvent.click(await screen.findByRole("button", { name: "Закрыть ссылку" }));
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));

    expect(revoked).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Закрыть ссылку" }));
    await userEvent.click(screen.getByRole("button", { name: "Да, закрыть ссылку" }));

    await waitFor(() => expect(revoked).toBe(true));
  });
});
