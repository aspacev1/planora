import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import type { RevisionEntry } from "../api/revisions";
import { STATE, projectFixtures, renderProject } from "../test/project";
import { server } from "../test/server";

/** A journal entry with sensible defaults. */
function entry(seq: number, over: Partial<RevisionEntry> = {}): RevisionEntry {
  return {
    seq,
    created_at: "2026-03-04T10:00:00+00:00",
    actor: { id: "u2", name: "Мария" },
    reason: null,
    batch_id: null,
    undoes_seq: null,
    op: { type: "move_task", task_id: "t1", from: "2026-03-04", to: "2026-03-11" },
    names: { t1: "Логотип" },
    ...over,
  };
}

/** Every journal request's parameters — the filters are checked against them. */
const requested: URLSearchParams[] = [];

function feedResponds(entries: RevisionEntry[]) {
  server.use(
    http.get("/api/projects/p1/revisions", ({ request }) => {
      requested.push(new URL(request.url).searchParams);
      return HttpResponse.json(entries);
    }),
  );
}

beforeEach(() => {
  projectFixtures();
  requested.length = 0;
  // The approval chronicle is empty by default: a test about milestones declares its own.
  server.use(
    http.get("/api/projects/p1/plan/approvals", () => HttpResponse.json([])),
  );
});

const renderHistory = (state = STATE, options = {}) =>
  renderProject(state, { route: "/projects/p1/history", ...options });

describe("вкладка «История»", () => {
  it("открывается по своему адресу и показывает ленту с именами", async () => {
    feedResponds([entry(2), entry(1, { op: { type: "create_task", task_id: "t1", category_id: "c1" }, names: { t1: "Логотип", c1: "Дизайн" } })]);
    renderHistory();

    // The phrase comes from the journal, the subject is the task's name, the author stands next to it.
    expect(await screen.findByText(/перенёс старт/)).toBeInTheDocument();
    expect(screen.getAllByText("Мария").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Логотип/).length).toBeGreaterThan(0);
  });

  it("по вкладке «История» с диаграммы можно перейти ссылкой", async () => {
    renderProject();
    await screen.findByRole("button", { name: /Логотип/ });

    await userEvent.click(screen.getByRole("link", { name: "История" }));

    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/history");
  });

  it("помечает отменённую запись, не стирая её", async () => {
    feedResponds([
      entry(8, {
        undoes_seq: 7,
        op: { type: "move_task", task_id: "t1", from: "2026-03-11", to: "2026-03-04" },
      }),
      entry(7),
    ]);
    renderHistory();

    // The entry stays in the feed — the history is not rewritten — but reads as undone, with the name of
    // whoever undid it.
    expect(await screen.findByText(/отменено · Мария/)).toBeInTheDocument();
    expect(screen.getByText("отмена")).toBeInTheDocument();
  });

  it("сворачивает пачку в одну строку и раскрывает по просьбе", async () => {
    feedResponds([
      entry(12, { batch_id: "b1", op: { type: "create_task", task_id: "t1", category_id: "c1" } }),
      entry(11, { batch_id: "b1", op: { type: "create_task", task_id: "t1", category_id: "c1" } }),
      entry(10, { batch_id: "b1", op: { type: "create_category", category_id: "c1" }, names: { c1: "Дизайн" } }),
    ]);
    renderHistory();

    expect(await screen.findByText(/пачка изменений · 3/)).toBeInTheDocument();
    // A folded batch does not fall apart into entries.
    expect(screen.queryByText(/создал категорию/)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "развернуть" }));

    expect(screen.getByText(/создал категорию/)).toBeInTheDocument();
  });

  it("ставит кнопку отмены только у записи, которую назвал сервер", async () => {
    feedResponds([entry(7), entry(6, { op: { type: "set_duration", task_id: "t1", from: 3, to: 5 } })]);
    renderHistory({
      ...STATE,
      undoable: {
        seq: 7,
        op: { type: "move_task", task_id: "t1", from: "2026-03-04", to: "2026-03-11" },
        batch_id: null,
      },
    });

    const feed = await screen.findByRole("region", { name: "История" });
    // Exactly one "Undo" button — by the top undoable entry. Older entries have no button at all: the
    // server undoes only the last action.
    expect(within(feed).getAllByRole("button", { name: "Отменить" })).toHaveLength(1);
  });

  it("кнопка в ленте зовёт ту же отмену последнего изменения", async () => {
    let called = 0;
    server.use(
      http.post("/api/projects/p1/undo", () => {
        called += 1;
        return HttpResponse.json({ seq: 8 }, { status: 201 });
      }),
    );
    feedResponds([entry(7)]);
    renderHistory({
      ...STATE,
      undoable: {
        seq: 7,
        op: { type: "move_task", task_id: "t1", from: "2026-03-04", to: "2026-03-11" },
        batch_id: null,
      },
    });

    const feed = await screen.findByRole("region", { name: "История" });
    await userEvent.click(within(feed).getByRole("button", { name: "Отменить" }));

    await waitFor(() => expect(called).toBe(1));
  });

  it("наблюдателю ленту показывает, кнопок отмены — нет", async () => {
    feedResponds([entry(7)]);
    renderHistory(
      {
        ...STATE,
        undoable: {
          seq: 7,
          op: { type: "move_task", task_id: "t1", from: "2026-03-04", to: "2026-03-11" },
          batch_id: null,
        },
      },
      { canWrite: false },
    );

    expect(await screen.findByText(/перенёс старт/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Отменить" })).toBeNull();
  });

  it("фильтр по задаче уходит на сервер параметром, а не отсевом на клиенте", async () => {
    feedResponds([entry(7)]);
    renderHistory();
    await screen.findByText(/перенёс старт/);

    await userEvent.selectOptions(screen.getByLabelText("Задача"), "t1");

    await waitFor(() =>
      expect(requested.some((params) => params.get("task_id") === "t1")).toBe(true),
    );
  });

  it("фильтр по типу разворачивает группу в список типов журнала", async () => {
    feedResponds([entry(7)]);
    renderHistory();
    await screen.findByText(/перенёс старт/);

    await userEvent.selectOptions(screen.getByLabelText("Тип изменения"), "dates");

    await waitFor(() =>
      expect(
        requested.some(
          (params) =>
            params.getAll("types").includes("move_task") &&
            params.getAll("types").includes("set_duration"),
        ),
      ).toBe(true),
    );
  });

  it("вклеивает веху согласования плана по времени", async () => {
    feedResponds([
      entry(7, { created_at: "2026-03-04T10:00:00+00:00" }),
      entry(6, { created_at: "2026-03-01T08:00:00+00:00" }),
    ]);
    server.use(
      http.get("/api/projects/p1/plan/approvals", () =>
        HttpResponse.json([
          {
            version: 1,
            approved_at: "2026-03-02T09:00:00+00:00",
            approved_by: { id: "u1", name: "Алексей" },
            snapshot: {},
          },
        ]),
      ),
    );
    renderHistory();

    expect(await screen.findByText(/План согласован · v1/)).toBeInTheDocument();
  });
});
