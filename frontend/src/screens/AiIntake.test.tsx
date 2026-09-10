import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, delay, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import type { Draft } from "../api/ai";
import { server } from "../test/server";
import { renderApp, sessionHandlers } from "../test/utils";

/**
 * Ворота глазами человека.
 *
 * Главное обещание продукта — AI ничего не пишет в проект без явного
 * подтверждения. Проверяется именно это: пока не нажата «Применить», ни один
 * запрос на применение не уходит.
 */

const SESSION = {
  id: "s1",
  status: "interview" as const,
  locale: "ru",
  transcript: [{ question: "Какой результат считается успехом?", answer: null, covered: [] }],
  summary: [] as string[],
  draft: {},
  tokens_used: 120,
  project_id: null,
  applied_batch_id: null,
};

const SUMMARY_STATE = {
  ...SESSION,
  status: "summary" as const,
  summary: ["Сайт-визитка к июню", "Дизайн делает подрядчик"],
};

const DRAFT_STATE = {
  ...SESSION,
  status: "draft" as const,
  draft: {
    categories: [
      {
        name: "Дизайн",
        tasks: [{ name: "Логотип", start_date: "2026-03-02", duration_days: 5 }],
      },
    ],
  },
};

function aiFixtures(configured = true) {
  const calls: string[] = [];
  server.use(
    http.get("/api/ai/credential", () =>
      HttpResponse.json({
        provider: "openai",
        base_url: "https://api.example.com/v1",
        model: "gpt-4o-mini",
        configured,
      }),
    ),
    http.post("/api/ai/sessions", () => {
      calls.push("start");
      return HttpResponse.json(SESSION, { status: 201 });
    }),
    http.post("/api/ai/sessions/s1/answers", () => {
      calls.push("answer");
      return HttpResponse.json(SESSION);
    }),
    http.post("/api/ai/sessions/s1/summary", () => {
      calls.push("summary");
      return HttpResponse.json(SUMMARY_STATE);
    }),
    http.put("/api/ai/sessions/s1/summary", () => {
      calls.push("edit-summary");
      return HttpResponse.json(SUMMARY_STATE);
    }),
    http.post("/api/ai/sessions/s1/draft", () => {
      calls.push("draft");
      return HttpResponse.json(DRAFT_STATE);
    }),
    http.put("/api/ai/sessions/s1/draft", () => {
      calls.push("edit-draft");
      return HttpResponse.json(DRAFT_STATE);
    }),
    // После применения экран уходит на проект: его состояние тоже надо
    // ответить, иначе переход выглядит поломкой.
    http.get("/api/projects/p1", () => HttpResponse.json({ detail: "project_not_found" }, { status: 404 })),
    http.post("/api/ai/sessions/s1/apply", () => {
      calls.push("apply");
      return HttpResponse.json(
        { project_id: "p1", batch_id: "b1", session: DRAFT_STATE },
        { status: 201 },
      );
    }),
  );
  return calls;
}

beforeEach(() => {
  server.use(...sessionHandlers());
});

describe("интервью", () => {
  it("без подключённой модели объясняет, куда идти, а не прячет кнопку", async () => {
    aiFixtures(false);
    renderApp({ route: "/projects/new/ai" });

    expect(await screen.findByText(/LLM не подключён/)).toBeInTheDocument();
    // Ссылка в настройки — на самом экране, а не только в шапке: человек
    // читает объяснение здесь, и отсылать его глазами наверх незачем.
    const main = screen.getByRole("main");
    expect(within(main).getByRole("link", { name: "Организация" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Начать интервью" })).toBeNull();
  });

  it("задаёт вопросы по одному", async () => {
    const calls = aiFixtures();
    renderApp({ route: "/projects/new/ai" });

    await userEvent.click(await screen.findByRole("button", { name: "Начать интервью" }));

    expect(await screen.findByText("Какой результат считается успехом?")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Ваш ответ"), "Сайт-визитка");
    await userEvent.click(screen.getByRole("button", { name: "Ответить" }));

    await waitFor(() => expect(calls).toEqual(["start", "answer"]));
  });

  it("«хватит, генерируй» доступно на любом шаге", async () => {
    const calls = aiFixtures();
    renderApp({ route: "/projects/new/ai" });
    await userEvent.click(await screen.findByRole("button", { name: "Начать интервью" }));

    await userEvent.click(await screen.findByRole("button", { name: "Хватит, генерируй" }));

    await waitFor(() => expect(calls).toContain("summary"));
    expect(await screen.findByText("Вот что я понял про проект")).toBeInTheDocument();
  });

  it("конспект правится до генерации плана", async () => {
    const calls = aiFixtures();
    renderApp({ route: "/projects/new/ai" });
    await userEvent.click(await screen.findByRole("button", { name: "Начать интервью" }));
    await userEvent.click(await screen.findByRole("button", { name: "Хватит, генерируй" }));

    const theses = await screen.findByLabelText(/Тезисы/);
    await userEvent.clear(theses);
    await userEvent.type(theses, "Сайт-визитка к июню");
    await userEvent.tab();

    await waitFor(() => expect(calls).toContain("edit-summary"));
  });

  it("до «Применить» ничего в проект не уходит", async () => {
    const calls = aiFixtures();
    renderApp({ route: "/projects/new/ai" });
    await userEvent.click(await screen.findByRole("button", { name: "Начать интервью" }));
    await userEvent.click(await screen.findByRole("button", { name: "Хватит, генерируй" }));
    await userEvent.click(await screen.findByRole("button", { name: "Сгенерировать план" }));

    // Черновик на экране — и ни одного применения.
    expect(await screen.findByText("Черновик плана")).toBeInTheDocument();
    expect(calls).not.toContain("apply");

    // Кнопка неактивна, пока у проекта нет названия: применять некуда.
    const apply = screen.getByRole("button", { name: "Применить в проект" });
    expect(apply).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Название проекта"), "Сайт");
    await userEvent.click(apply);

    await waitFor(() => expect(calls).toContain("apply"));
  });

  it("отказ на правке конспекта виден, а не проглатывается", async () => {
    aiFixtures();
    server.use(
      http.put("/api/ai/sessions/s1/summary", () =>
        HttpResponse.json({ detail: "wrong_step" }, { status: 409 }),
      ),
    );
    renderApp({ route: "/projects/new/ai" });
    await userEvent.click(await screen.findByRole("button", { name: "Начать интервью" }));
    await userEvent.click(await screen.findByRole("button", { name: "Хватит, генерируй" }));

    const theses = await screen.findByLabelText(/Тезисы/);
    await userEvent.type(theses, "{Enter}Ещё тезис");
    await userEvent.tab();

    expect(await screen.findByRole("alert")).toHaveTextContent("Этот шаг ещё не пройден");
  });

  it("две правки черновика подряд не стирают друг друга", async () => {
    aiFixtures();
    const bodies: Draft[] = [];
    server.use(
      http.put("/api/ai/sessions/s1/draft", async ({ request }) => {
        const { draft } = (await request.json()) as { draft: Draft };
        bodies.push(draft);
        // Ответ задерживается: вторая правка уходит, пока первая ещё летит.
        await delay(60);
        return HttpResponse.json({ ...DRAFT_STATE, draft });
      }),
    );
    renderApp({ route: "/projects/new/ai" });
    await userEvent.click(await screen.findByRole("button", { name: "Начать интервью" }));
    await userEvent.click(await screen.findByRole("button", { name: "Хватит, генерируй" }));
    await userEvent.click(await screen.findByRole("button", { name: "Сгенерировать план" }));
    await screen.findByText("Черновик плана");

    fireEvent.change(screen.getByLabelText("Старт «Логотип»"), { target: { value: "2026-03-09" } });
    const name = screen.getByLabelText("Название «Логотип»");
    await userEvent.type(name, " v2");
    await userEvent.tab();

    await waitFor(() => expect(bodies).toHaveLength(2));
    // Вторая правка построена поверх первой, а не поверх черновика с сервера,
    // в котором первой ещё нет.
    expect(bodies[1].categories[0].tasks[0]).toMatchObject({
      name: "Логотип v2",
      start_date: "2026-03-09",
    });
  });

  it("задача из черновика удаляется до применения", async () => {
    const calls = aiFixtures();
    renderApp({ route: "/projects/new/ai" });
    await userEvent.click(await screen.findByRole("button", { name: "Начать интервью" }));
    await userEvent.click(await screen.findByRole("button", { name: "Хватит, генерируй" }));
    await userEvent.click(await screen.findByRole("button", { name: "Сгенерировать план" }));

    await userEvent.click(await screen.findByRole("button", { name: "Удалить" }));

    await waitFor(() => expect(calls).toContain("edit-draft"));
    expect(calls).not.toContain("apply");
  });
});
