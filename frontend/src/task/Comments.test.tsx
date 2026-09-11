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
 * Opens the card and gives back the discussion thread itself rather than the whole card.
 *
 * The bounds matter: the name "Мария" is also among the assignees on the same card, and a search
 * across the whole card would find two — that is, it would be checking a coincidence of names rather
 * than the signature under a reply.
 */
async function openCard() {
  renderProject();
  await userEvent.click(await screen.findByRole("button", { name: /Логотип/ }));
  return screen.findByRole("complementary");
}

async function openThread() {
  const panel = await openCard();
  // The discussion is on its own tab: the task's properties open first, and the conversation thread
  // appears on a click.
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
    // The browser is in Baku (UTC+4): a reply at 22:30 Greenwich is already 6 March.
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

    // The mark is next to the name rather than instead of it: a guest is called by name, but a reader
    // must see that there is no account behind them.
    expect(guest.parentElement?.textContent).toMatch(/гость/i);
  });

  it("отправляет реплику и показывает её после ответа сервера", async () => {
    const sent: unknown[] = [];
    // The stub remembers what was sent: without that a refetch after a success would return the
    // previous thread, and the test would be checking not that the reply appeared but that it managed
    // to flash by.
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
    // The text stays in the field: a refusal is a reason to correct the reply rather than to type it
    // anew.
    expect(field).toHaveValue("слишком длинно");
  });

  it("не рисует ветку, если сервер её не отдал", async () => {
    server.use(
      http.get("/api/projects/p1/comments", () =>
        HttpResponse.json({ detail: "project_not_found" }, { status: 404 }),
      ),
    );

    // The whole card rather than the thread: there is no discussion block here at all, and there would
    // be nothing to look for a field inside.
    const panel = await openCard();
    await userEvent.click(within(panel).getByRole("tab", { name: "Комментарии" }));

    await waitFor(() =>
      expect(within(panel).queryByRole("region", { name: "Комментарии" })).not.toBeInTheDocument(),
    );
    // The task's properties on their own tab work as they worked.
    await userEvent.click(within(panel).getByRole("tab", { name: "Свойства" }));
    expect(within(panel).getByLabelText("Название")).toBeInTheDocument();
  });
});
