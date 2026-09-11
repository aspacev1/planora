import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import type { ScorecardState, TeamMember } from "../api/scorecard";
import { projectFixtures, renderProject } from "../test/project";
import { server } from "../test/server";

/**
 * The scorecard by the fixture: three project figures in the header and the per-person pace. Alexey
 * missed a date silently (a red signal), Maria is keeping pace with a task beyond the plan. The signal
 * arrives only with the right to assessment — without it the column is absent entirely.
 */
function member(over: Partial<TeamMember> & { user: TeamMember["user"] }): TeamMember {
  return {
    planned: 0,
    done: 0,
    extra: 0,
    on_time: 0,
    trend: [
      { week_start: "2026-06-29", closed: null },
      { week_start: "2026-07-06", closed: 2 },
      { week_start: "2026-07-13", closed: 1 },
      { week_start: "2026-07-20", closed: 3 },
      { week_start: "2026-07-27", closed: 0 },
      { week_start: "2026-08-03", closed: 2 },
      { week_start: "2026-08-10", closed: 2 },
      { week_start: "2026-08-17", closed: 1 },
    ],
    tasks: [],
    ...over,
  };
}

const ALEXEY = member({
  user: { id: "u1", name: "Алексей" },
  planned: 4,
  done: 1,
  on_time: 0,
  signal: "red",
  reason: { kind: "overdue_silent", count: 2 },
  tasks: [
    {
      id: "t1",
      name: "Логотип",
      status: "in_progress",
      due: "2026-08-19",
      risk: "green",
      state: "late",
      late_days: 2,
      warned: false,
      warned_kind: null,
    },
    {
      id: "t2",
      name: "Гайдлайн",
      status: "done",
      due: "2026-08-18",
      risk: "green",
      state: "done",
      late_days: 1,
    },
  ],
});

const MARIA = member({
  user: { id: "u2", name: "Мария" },
  planned: 2,
  done: 2,
  extra: 1,
  on_time: 2,
  signal: "green",
  reason: { kind: "in_pace" },
});

const SCORECARD: ScorecardState = {
  week: { number: 34, start: "2026-08-17", end: "2026-08-23" },
  computed_at: "2026-08-19T10:00:00+00:00",
  metrics: [],
  alerts: [],
  outlook: { projected_finish: "2026-10-14", milestone: null },
  data_quality: null,
  summary: {
    planned: 6,
    done: 3,
    overdue: { value: 3, status: "warn", avg_days: 2.5 },
    blocked: {
      value: 2,
      status: "warn",
      longest: { id: "t7", name: "Auth API", days: 3 },
    },
    finish_drift: { value: 2, status: "risk", projected_finish: "2026-10-14" },
  },
  team: { assessment: true, members: [ALEXEY, MARIA], unassigned_planned: 1 },
};

describe("Scorecard", () => {
  beforeEach(() => {
    projectFixtures();
    server.use(
      http.get("/api/projects/p1/scorecard", () => HttpResponse.json(SCORECARD)),
    );
  });

  it("показывает три числа проекта и темп по людям с сигналом владельцу", async () => {
    renderProject(undefined, { route: "/projects/p1/scorecard" });

    expect(await screen.findByText(/Команда: 3 из 6 задач недели сделано/)).toBeInTheDocument();
    // Three tiles: overdueness with its average (a fraction with a comma in ru), blocked with the longest
    // task, the finish shift with a sign and a forecast.
    expect(screen.getByText("в среднем 2,5 р.д.")).toBeInTheDocument();
    expect(screen.getByText("дольше всех: Auth API, 3 р.д.")).toBeInTheDocument();
    expect(screen.getByText("+2 р.д.")).toBeInTheDocument();
    expect(screen.getByText("прогноз 14 окт")).toBeInTheDocument();

    // The pace: done out of the plan, "beyond" as a chip, on time out of what was done.
    const alexey = screen.getByText("Алексей").closest("tr")!;
    expect(within(alexey).getByText("1 / 4")).toBeInTheDocument();
    expect(within(alexey).getByText("сорвано 2, без предупреждения")).toBeInTheDocument();
    const maria = screen.getByText("Мария").closest("tr")!;
    expect(within(maria).getByText("2 / 2")).toBeInTheDocument();
    expect(within(maria).getByText("+1 сверх")).toBeInTheDocument();
    expect(within(maria).getByText("в темпе")).toBeInTheDocument();

    expect(screen.getByRole("columnheader", { name: "Сигнал" })).toBeInTheDocument();
    expect(screen.getByText("Без исполнителя: 1 задача")).toBeInTheDocument();
    expect(screen.getByText("Сигнал видит только владелец проекта")).toBeInTheDocument();
  });

  it("без права на оценку колонки сигнала нет", async () => {
    server.use(
      http.get("/api/projects/p1/scorecard", () =>
        HttpResponse.json({
          ...SCORECARD,
          team: {
            ...SCORECARD.team,
            assessment: false,
            members: SCORECARD.team!.members.map(({ signal: _s, reason: _r, ...rest }) => rest),
          },
        }),
      ),
    );
    renderProject(undefined, { route: "/projects/p1/scorecard" });

    expect(await screen.findByText("Алексей")).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Сигнал" })).not.toBeInTheDocument();
    expect(screen.queryByText("сорвано 2, без предупреждения")).not.toBeInTheDocument();
    expect(screen.getByText("Оценку людей видит только владелец проекта")).toBeInTheDocument();
  });

  it("клиенту без разреза по людям показывает только шапку", async () => {
    server.use(
      http.get("/api/projects/p1/scorecard", () =>
        HttpResponse.json({ ...SCORECARD, team: null }),
      ),
    );
    renderProject(undefined, { route: "/projects/p1/scorecard" });

    expect(await screen.findByText("дольше всех: Auth API, 3 р.д.")).toBeInTheDocument();
    expect(screen.queryByText("Алексей")).not.toBeInTheDocument();
  });

  it("раскрывает задачи недели и ведёт из них в карточку на ленте", async () => {
    renderProject(undefined, { route: "/projects/p1/scorecard" });

    await userEvent.click(await screen.findByText("Алексей"));
    const late = await screen.findByRole("button", { name: /Логотип/ });
    expect(late).toHaveTextContent("просрочена 2 р.д.");
    expect(late).toHaveTextContent("без предупреждения");
    const done = screen.getByRole("button", { name: /Гайдлайн/ });
    expect(done).toHaveTextContent("сделана");
    expect(done).toHaveTextContent("с опозданием на 1 р.д.");

    await userEvent.click(late);
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(/\/projects\/p1$/),
    );
  });

  it("пересчитывает по кнопке и прячет её от читателя", async () => {
    let recalculated = 0;
    server.use(
      http.post("/api/projects/p1/scorecard/recalculate", () => {
        recalculated += 1;
        return HttpResponse.json(SCORECARD);
      }),
    );
    renderProject(undefined, { route: "/projects/p1/scorecard" });
    await userEvent.click(await screen.findByRole("button", { name: "Пересчитать" }));
    await waitFor(() => expect(recalculated).toBe(1));
  });

  it("читателю не показывает пересчёт", async () => {
    renderProject(undefined, { canWrite: false, route: "/projects/p1/scorecard" });

    expect(await screen.findByText("Алексей")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Пересчитать" })).not.toBeInTheDocument();
  });
});
