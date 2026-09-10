import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { projectFixtures, renderProject } from "../test/project";
import { server } from "../test/server";

const THREAD = [
  {
    id: "k1",
    task_id: "t1",
    body: "Клиент просит другой знак",
    created_at: "2026-03-05T10:00:00+00:00",
    author: { name: "Мария", guest: false },
  },
  {
    id: "k2",
    task_id: "t1",
    body: "А когда сдача?",
    created_at: "2026-03-06T10:00:00+00:00",
    author: { name: "Нигяр", guest: true },
  },
];

/**
 * Открывает карточку и отдаёт саму ветку обсуждения, а не карточку целиком.
 *
 * Границы важны: имя «Мария» есть и среди исполнителей на той же карточке, и
 * поиск по всей карточке нашёл бы двух — то есть проверял бы не подпись под
 * репликой, а совпадение имён.
 */
async function openCard() {
  renderProject();
  await userEvent.click(await screen.findByRole("button", { name: /Логотип/ }));
  return screen.findByRole("complementary");
}

async function openThread() {
  const panel = await openCard();
  // Обсуждение — на своей вкладке: свойства задачи открываются первыми, а
  // ветка разговора появляется по щелчку.
  await userEvent.click(within(panel).getByRole("tab", { name: "Комментарии" }));
  return within(panel).getByRole("region", { name: "Комментарии" });
}

describe("обсуждение задачи", () => {
  beforeEach(() => {
    projectFixtures();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("показывает реплики с подписями авторов", async () => {
    server.use(http.get("/api/projects/p1/comments", () => HttpResponse.json(THREAD)));

    const thread = await openThread();

    expect(await within(thread).findByText("Клиент просит другой знак")).toBeInTheDocument();
    expect(within(thread).getByText("Мария")).toBeInTheDocument();
  });

  it("датирует реплику по часам читателя, а не по UTC", async () => {
    // Браузер в Баку (UTC+4): реплика в 22:30 по Гринвичу — это уже 6 марта.
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      locale: "ru",
      calendar: "gregory",
      numberingSystem: "latn",
      timeZone: "Asia/Baku",
    });
    server.use(
      http.get("/api/projects/p1/comments", () =>
        HttpResponse.json([{ ...THREAD[0], created_at: "2026-03-05T22:30:00+00:00" }]),
      ),
    );

    const thread = await openThread();
    await within(thread).findByText("Клиент просит другой знак");

    expect(within(thread).getByText(/6 мар/)).toBeInTheDocument();
  });

  it("отличает гостя от участника с аккаунтом", async () => {
    server.use(http.get("/api/projects/p1/comments", () => HttpResponse.json(THREAD)));

    const thread = await openThread();
    const guest = await within(thread).findByText("Нигяр");

    // Пометка рядом с именем, а не вместо него: гостя зовут по имени, но
    // читатель обязан видеть, что аккаунта за ним нет.
    expect(guest.parentElement?.textContent).toMatch(/гость/i);
  });

  it("отправляет реплику и показывает её после ответа сервера", async () => {
    const sent: unknown[] = [];
    // Заглушка помнит отправленное: без этого перезапрос после успеха вернул
    // бы прежнюю ветку, и тест проверял бы не появление реплики, а то, что
    // она успела мелькнуть.
    let stored = [...THREAD];
    server.use(
      http.get("/api/projects/p1/comments", () => HttpResponse.json(stored)),
      http.post("/api/projects/p1/comments", async ({ request }) => {
        const body = await request.json();
        sent.push(body);
        const created = {
          id: "k3",
          task_id: "t1",
          body: (body as { body: string }).body,
          created_at: "2026-03-07T10:00:00+00:00",
          author: { name: "Алексей", guest: false },
        };
        stored = [...stored, created];
        return HttpResponse.json(created, { status: 201 });
      }),
    );

    const thread = await openThread();
    await userEvent.type(within(thread).getByLabelText(/Комментарий/i), "Беру в работу");
    await userEvent.click(within(thread).getByRole("button", { name: /Отправить/i }));

    expect(await within(thread).findByText("Беру в работу")).toBeInTheDocument();
    expect(sent).toEqual([{ body: "Беру в работу", task_id: "t1" }]);
  });

  it("очищает поле после отправки", async () => {
    server.use(
      http.get("/api/projects/p1/comments", () => HttpResponse.json([])),
      http.post("/api/projects/p1/comments", () =>
        HttpResponse.json(
          {
            id: "k3",
            task_id: "t1",
            body: "Готово",
            created_at: "2026-03-07T10:00:00+00:00",
            author: { name: "Алексей", guest: false },
          },
          { status: 201 },
        ),
      ),
    );

    const thread = await openThread();
    const field = within(thread).getByLabelText(/Комментарий/i);
    await userEvent.type(field, "Готово");
    await userEvent.click(within(thread).getByRole("button", { name: /Отправить/i }));

    await waitFor(() => expect(field).toHaveValue(""));
  });

  it("объясняет отказ словами и не теряет набранный текст", async () => {
    server.use(
      http.get("/api/projects/p1/comments", () => HttpResponse.json([])),
      http.post("/api/projects/p1/comments", () =>
        HttpResponse.json({ detail: "comment_too_long" }, { status: 422 }),
      ),
    );

    const thread = await openThread();
    const field = within(thread).getByLabelText(/Комментарий/i);
    await userEvent.type(field, "слишком длинно");
    await userEvent.click(within(thread).getByRole("button", { name: /Отправить/i }));

    expect(await within(thread).findByRole("alert")).toHaveTextContent(/пуст/i);
    // Текст остаётся в поле: отказ — повод исправить реплику, а не набрать
    // её заново.
    expect(field).toHaveValue("слишком длинно");
  });

  it("не рисует ветку, если сервер её не отдал", async () => {
    server.use(
      http.get("/api/projects/p1/comments", () =>
        HttpResponse.json({ detail: "project_not_found" }, { status: 404 }),
      ),
    );

    // Карточка целиком, а не ветка: блока обсуждения здесь нет вовсе, и
    // искать поле внутри него было бы нечем.
    const panel = await openCard();
    await userEvent.click(within(panel).getByRole("tab", { name: "Комментарии" }));

    await waitFor(() =>
      expect(within(panel).queryByRole("region", { name: "Комментарии" })).not.toBeInTheDocument(),
    );
    // Свойства задачи на своей вкладке работают как работали.
    await userEvent.click(within(panel).getByRole("tab", { name: "Свойства" }));
    expect(within(panel).getByLabelText("Название")).toBeInTheDocument();
  });
});
