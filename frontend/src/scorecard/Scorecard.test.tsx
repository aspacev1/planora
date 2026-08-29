import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import type {
  ScorecardMetric,
  ScorecardMetricKey,
  ScorecardState,
} from "../api/scorecard";
import { projectFixtures, renderProject } from "../test/project";
import { server } from "../test/server";

/**
 * Скоркард по фикстуре: просрочка в красном с серией и средней просрочкой
 * (дробь с запятой в ru — её проверяет отдельное утверждение), прирост объёма
 * со знаком, прогноз финиша и ближайшая веха, качество данных чек-листом.
 * События одной метрики (риск + правило) склеены в одну карточку — с дельтой
 * и адресатом.
 */
function metric(
  over: Partial<ScorecardMetric> & { key: ScorecardMetricKey },
): ScorecardMetric {
  return {
    direction: "lte",
    target: 2,
    enabled: true,
    owner: null,
    value: 0,
    status: "ok",
    streak: 1,
    history: [
      { week_start: "2026-08-10", value: 0, status: "ok" },
      { week_start: "2026-08-17", value: over.value ?? 0, status: over.status ?? "ok" },
    ],
    ...over,
  };
}

const SCORECARD: ScorecardState = {
  week: { number: 34, start: "2026-08-17", end: "2026-08-23" },
  computed_at: "2026-08-19T10:00:00+00:00",
  metrics: [
    metric({ key: "overdue_tasks", value: 5, status: "risk", streak: 3, avg_days: 3.5 }),
    metric({ key: "finish_drift", target: 0, value: 6, status: "risk" }),
    metric({
      key: "scope_growth",
      target: 3,
      value: 7,
      status: "risk",
      added_count: 11,
      closed_count: 4,
    }),
    metric({
      key: "date_shifts",
      target: 5,
      value: 1,
      owner: { id: "u2", name: "Мария" },
    }),
    metric({
      key: "close_rate",
      direction: "gte",
      target: 1,
      value: 0.5,
      status: "risk",
      streak: 1,
    }),
    metric({ key: "stale_in_progress", target: 3, value: 0 }),
    metric({ key: "data_quality", direction: "gte", target: 90, value: 80, status: "warn" }),
  ],
  // Обе записи overdue — риск и правило — склеиваются в одну карточку.
  alerts: [
    {
      id: "al1",
      metric_key: "overdue_tasks",
      kind: "metric_risk",
      week_start: "2026-08-17",
      created_at: "2026-08-17T08:00:00+00:00",
      payload: {
        value: 5,
        delta: 3,
        total: 5,
        top_assignee: { name: "Алексей", count: 2 },
        tasks: [
          { id: "t1", name: "Логотип", assignee: "Алексей", days_overdue: 4 },
          { id: "tx", name: "Гайдлайн", assignee: null, days_overdue: 2 },
        ],
      },
    },
    {
      id: "al2",
      metric_key: "overdue_tasks",
      kind: "rule_triggered",
      week_start: "2026-08-17",
      created_at: "2026-08-17T08:00:00+00:00",
      payload: { task_id: "t9", task_name: "Разобрать: Просроченные задачи" },
    },
  ],
  outlook: {
    projected_finish: "2026-10-14",
    milestone: { id: "m1", name: "Бета", date: "2026-09-12", status: "upcoming" },
  },
  data_quality: {
    value: 80,
    total: 10,
    affected: 2,
    both: 0,
    unassigned: 1,
    unreal_deadline: 1,
  },
};

describe("Scorecard", () => {
  beforeEach(() => {
    projectFixtures();
    server.use(
      http.get("/api/projects/p1/scorecard", () => HttpResponse.json(SCORECARD)),
    );
  });

  it("показывает метрики, прогноз, чек-лист качества и склеенную карточку события", async () => {
    renderProject(undefined, { route: "/projects/p1/scorecard" });

    expect(await screen.findByText("Просроченные задачи")).toBeInTheDocument();
    // Средняя просрочка — второй строкой; дробь с запятой (десятичные в ru
    // приходят от Intl).
    expect(screen.getByText("в среднем 3,5 р.д.")).toBeInTheDocument();
    // Серия в бейдже — с двух недель.
    expect(screen.getByText(/Риск · 3 нед\./)).toBeInTheDocument();
    // Прирост объёма — со знаком, с разбивкой.
    expect(screen.getByText("+7")).toBeInTheDocument();
    expect(screen.getByText("создано 11, закрыто 4")).toBeInTheDocument();
    // Снятой метрики в таблице нет.
    expect(screen.queryByText("Задачи без исполнителя")).not.toBeInTheDocument();
    // Прогноз финиша и ближайшая веха.
    expect(screen.getByText("Прогноз финиша")).toBeInTheDocument();
    expect(screen.getByText(/Бета/)).toBeInTheDocument();
    // Качество данных — чек-листом со сходящейся арифметикой.
    expect(screen.getByText("нужно поправить 2 из 10 задач")).toBeInTheDocument();
    expect(screen.getByText("Нет исполнителя")).toBeInTheDocument();
    // Одна карточка на метрику: фраза риска, дельта, адресат и след правила
    // вместе, а не двумя карточками.
    expect(screen.getByText("«Просроченные задачи» — в риске на этой неделе")).toBeInTheDocument();
    expect(screen.getByText("+3 за неделю")).toBeInTheDocument();
    expect(screen.getByText("больше всех у Алексей (2)")).toBeInTheDocument();
    expect(screen.getByText("Открыть все задачи (5) →")).toBeInTheDocument();
    expect(screen.getByText("Разобрать: Просроченные задачи")).toBeInTheDocument();
    // Карточка одна: фраза риска не задвоилась.
    expect(
      screen.getAllByText("«Просроченные задачи» — в риске на этой неделе"),
    ).toHaveLength(1);
  });

  it("разворачивает список задач недели и ведёт из него в карточку на ленте", async () => {
    server.use(
      http.get("/api/projects/p1/scorecard/metrics/overdue_tasks/tasks", () =>
        HttpResponse.json({
          metric_key: "overdue_tasks",
          week_start: "2026-08-17",
          value: 5,
          details: {
            tasks: [
              {
                id: "t1",
                name: "Логотип",
                status: "in_progress",
                end_date: "2026-08-12",
                assignees: ["Алексей"],
                days_overdue: 4,
              },
            ],
          },
        }),
      ),
    );
    renderProject(undefined, { route: "/projects/p1/scorecard" });

    await userEvent.click(await screen.findByText("Просроченные задачи"));
    // Точнее, чем просто «Логотип»: та же задача стоит ссылкой в карточке
    // события справа, а здесь ищется строка drill-down с припиской метрики.
    const entry = await screen.findByRole("button", { name: /Логотип.*просрочка/ });
    expect(entry).toHaveTextContent("просрочка 4 раб. дн.");

    // Щелчок по задаче — переход на ленту с открытой карточкой: адрес меняется
    // на вкладку диаграммы.
    await userEvent.click(entry);
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(/\/projects\/p1$/),
    );
  });

  it("правит цель и владельца PATCH-ем", async () => {
    const patched: unknown[] = [];
    server.use(
      http.patch(
        "/api/projects/p1/scorecard/metrics/overdue_tasks",
        async ({ request }) => {
          patched.push(await request.json());
          return HttpResponse.json(SCORECARD);
        },
      ),
    );
    renderProject(undefined, { route: "/projects/p1/scorecard" });

    const target = await screen.findByLabelText("Цель метрики «Просроченные задачи»");
    await userEvent.clear(target);
    await userEvent.type(target, "4");
    await userEvent.tab();
    await waitFor(() => expect(patched).toContainEqual({ target_value: 4 }));

    const owner = screen.getByLabelText("Владелец метрики «Просроченные задачи»");
    await userEvent.selectOptions(owner, "u2");
    await waitFor(() => expect(patched).toContainEqual({ owner_user_id: "u2" }));
  });

  it("пересчитывает по кнопке и прячет запись от читателя", async () => {
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

  it("читателю не показывает ни пересчёта, ни правки настроек", async () => {
    renderProject(undefined, { canWrite: false, route: "/projects/p1/scorecard" });

    expect(await screen.findByText("Просроченные задачи")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Пересчитать" })).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Цель метрики «Просроченные задачи»"),
    ).not.toBeInTheDocument();
    // Владелец без права записи — подписью, не списком выбора.
    expect(screen.getByText("Мария")).toBeInTheDocument();
  });

  it("пустая панель событий говорит, что всё в норме", async () => {
    server.use(
      http.get("/api/projects/p1/scorecard", () =>
        HttpResponse.json({ ...SCORECARD, alerts: [] }),
      ),
    );
    renderProject(undefined, { route: "/projects/p1/scorecard" });

    expect(await screen.findByText("Всё в норме")).toBeInTheDocument();
  });
});
