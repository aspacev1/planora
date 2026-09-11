import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { projectFixtures, renderProject } from "../test/project";
import { server } from "../test/server";

const URL = "https://planora.example.com/p/seher-studiyasi/redizayn?s=sh4re-t0ken";
const ROTATED = "https://planora.example.com/p/seher-studiyasi/redizayn?s=n3w-t0ken";

const PUBLISHED = {
  allowed: true,
  url: URL,
  comments_enabled: true,
  created_at: "2026-03-05T10:00:00+00:00",
};

const UNPUBLISHED = { allowed: true, url: null, comments_enabled: true, created_at: null };

function renderSettings() {
  renderProject(undefined, { route: "/projects/p1/settings" });
}

describe("публичная ссылка в настройках проекта", () => {
  beforeEach(projectFixtures);

  it("перевыпуск идёт отдельным маршрутом, а не повторным выпуском", async () => {
    // A POST /share on a published project answers with a 409 — that is how it protects an address that
    // has been sent out from a retry. If the panel calls it, a reissue never works, and the test catches
    // exactly that: the route rather than the error's text.
    const calls: string[] = [];
    server.use(
      http.get("/api/projects/p1/share", () =>
        HttpResponse.json(calls.length === 0 ? PUBLISHED : { ...PUBLISHED, url: ROTATED }),
      ),
      http.post("/api/projects/p1/share", () => {
        calls.push("issue");
        return HttpResponse.json({ detail: "share_link_exists" }, { status: 409 });
      }),
      http.post("/api/projects/p1/share/rotate", () => {
        calls.push("rotate");
        return HttpResponse.json({ ...PUBLISHED, url: ROTATED }, { status: 201 });
      }),
    );

    renderSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Перевыпустить" }));
    // The button asks first: an address that has been sent out dies instantly.
    await userEvent.click(screen.getByRole("button", { name: "Да, перевыпустить" }));

    await waitFor(() => expect(calls).toEqual(["rotate"]));
    expect(await screen.findByLabelText("Адрес ссылки")).toHaveValue(ROTATED);
  });

  it("первый выпуск остаётся выпуском", async () => {
    const calls: string[] = [];
    server.use(
      http.get("/api/projects/p1/share", () =>
        HttpResponse.json(calls.length === 0 ? UNPUBLISHED : PUBLISHED),
      ),
      http.post("/api/projects/p1/share", () => {
        calls.push("issue");
        return HttpResponse.json(PUBLISHED, { status: 201 });
      }),
    );

    renderSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Опубликовать" }));

    await waitFor(() => expect(calls).toEqual(["issue"]));
    expect(await screen.findByLabelText("Адрес ссылки")).toHaveValue(URL);
  });

  it("неопубликованный проект не показывает ни адреса, ни перевыпуска", async () => {
    // The server answers for an unpublished project too — with an object carrying `url: null`. A panel
    // that treats anything it got an answer for as published would show an empty address field and a
    // reissue button with nothing to reissue.
    server.use(http.get("/api/projects/p1/share", () => HttpResponse.json(UNPUBLISHED)));

    renderSettings();

    expect(await screen.findByRole("button", { name: "Опубликовать" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Адрес ссылки")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Перевыпустить" })).not.toBeInTheDocument();
  });

  it("в закрытой установке не предлагает публикацию вовсе", async () => {
    server.use(
      http.get("/api/projects/p1/share", () =>
        HttpResponse.json({ ...UNPUBLISHED, allowed: false }),
      ),
    );

    renderSettings();

    expect(
      await screen.findByText("Публичные ссылки выключены: установкой или настройкой организации"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Опубликовать" })).not.toBeInTheDocument();
  });

  it("отзыв возвращает проект в неопубликованное состояние", async () => {
    let revoked = false;
    server.use(
      http.get("/api/projects/p1/share", () =>
        HttpResponse.json(revoked ? UNPUBLISHED : PUBLISHED),
      ),
      http.delete("/api/projects/p1/share", () => {
        revoked = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Закрыть ссылку" }));
    await userEvent.click(screen.getByRole("button", { name: "Да, закрыть ссылку" }));

    expect(await screen.findByRole("button", { name: "Опубликовать" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Адрес ссылки")).not.toBeInTheDocument();
  });

  it("опубликованный проект показывает адрес и кнопки управления ссылкой", async () => {
    server.use(http.get("/api/projects/p1/share", () => HttpResponse.json(PUBLISHED)));

    renderSettings();

    expect(await screen.findByLabelText("Адрес ссылки")).toHaveValue(URL);
    expect(screen.getByRole("button", { name: "Перевыпустить" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Опубликовать" })).not.toBeInTheDocument();
  });
});
