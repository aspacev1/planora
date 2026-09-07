import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { ApiError } from "../api/client";
import { errorKey } from "../api/errors";
import { getProject, projectQueryKey } from "../api/projects";
import type { Op, ProjectState, Task } from "../api/projects";
import { LiveProvider } from "../live/LiveProvider";
import { server } from "../test/server";
import { newQueryClient } from "../test/utils";
import { useProjectMutation } from "./useProjectMutation";

const STATE: ProjectState = {
  id: "p1",
  name: "Редизайн",
  slug: "redizayn",
  deadline: "2026-06-01",
  project_end: "2026-06-08",
  plan_approved_at: null,
  plan_version: 0,
  undoable: null,
  // Календарный режим: заглушки существующих тестов живут настоящими датами.
  // Относительные проекты собирают своё состояние поверх этого (см. тесты
  // относительной шкалы).
  schedule_mode: "calendar" as const,
  start_date: null,

  calendar: { working_days: 31, holidays: [], extra_workdays: [] },
  categories: [{ id: "c1", name: "Дизайн", color: "#3b82f6", position: 0 }],
  tasks: [
    {
      id: "t1",
      category_id: "c1",
      name: "Логотип",
      start_date: "2026-03-04",
      end_date: "2026-03-10",
      duration_days: 5,
      milestone: false,
      critical: false,
      criticality: "high",
      risk: "green",
      risk_note: "",
      status: "in_progress",
      progress_pct: 40,
      position: 0,
      assignee_ids: [],
      baseline_start: null,
      baseline_duration: null,
      baseline_end: null,
    },
  ],
  dependencies: [],
};

function withTask(state: ProjectState, patch: Partial<Task>): ProjectState {
  return { ...state, tasks: [{ ...state.tasks[0], ...patch }, ...state.tasks.slice(1)] };
}

const MOVE_OP: Op = { type: "move_task", task_id: "t1", start_date: "2026-03-11" };
const MOVE_OP_2: Op = { type: "move_task", task_id: "t1", start_date: "2026-03-18" };

/**
 * Оптимистичное преобразование трогает только старт.
 *
 * Дату окончания оно не считает намеренно: её считает сервер по календарю
 * проекта, и подставить сюда «плюс столько же дней» значило бы завести второй,
 * неверный календарь на клиенте.
 */
const moveTaskLocally = (state: ProjectState) => withTask(state, { start_date: "2026-03-11" });
const moveTaskLocally2 = (state: ProjectState) => withTask(state, { start_date: "2026-03-18" });

/** Состояние, каким его вернёт сервер, приняв MOVE_OP: конец пересчитан им. */
const MOVED = withTask(STATE, { start_date: "2026-03-11", end_date: "2026-03-17" });

const OK = { seq: 1, op: { type: "move_task", task_id: "t1" }, inverse: {} };

let queryClient: QueryClient;

/**
 * Живой подписчик состояния проекта.
 *
 * Без него `invalidateQueries` пометит запись устаревшей и на этом
 * остановится: перезапрашиваются только те запросы, у которых есть
 * наблюдатель. То есть без этого компонента третий тест проверял бы не то, что
 * написано в его названии.
 *
 * `staleTime: Infinity` убирает фоновый поход при монтировании — он бы
 * затирал оптимистичное изменение ответом, которого тест не просил.
 */
function Probe() {
  useQuery({
    queryKey: projectQueryKey("p1"),
    queryFn: () => getProject("p1"),
    staleTime: Infinity,
  });
  return null;
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <Probe />
      {children}
    </QueryClientProvider>
  );
}

/** То же окружение, но связь оборвана. */
function offlineWrapper({ children }: { children: ReactNode }) {
  return <LiveProvider live={{ status: "offline" }}>{wrapper({ children })}</LiveProvider>;
}

function cachedState(): ProjectState {
  return queryClient.getQueryData<ProjectState>(projectQueryKey("p1"))!;
}

beforeEach(() => {
  queryClient = newQueryClient();
  queryClient.setQueryData(projectQueryKey("p1"), STATE);
  // Состояние после принятого переноса: сервер, применивший move_task, отдаёт
  // и новый старт, и пересчитанный им конец.
  server.use(http.get("/api/projects/p1", () => HttpResponse.json(MOVED)));
});

describe("оптимистичные изменения", () => {
  it("показывает изменение до ответа сервера", async () => {
    // Ответ готовится заранее, а не внутри обработчика: обработчик вызовется
    // только после того, как запрос уйдёт, а тест обязан успеть посмотреть на
    // состояние до этого.
    let release!: () => void;
    const answered = new Promise<Response>((resolve) => {
      release = () => resolve(HttpResponse.json(OK, { status: 201 }));
    });
    server.use(http.post("/api/projects/p1/mutations", () => answered));

    const { result } = renderHook(() => useProjectMutation("p1"), { wrapper });
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.apply(MOVE_OP, moveTaskLocally);
    });

    expect(cachedState().tasks[0].start_date).toBe("2026-03-11");

    // Ответ отпускается и дожидается здесь же: незавершённое изменение уехало
    // бы запросом состояния в соседний тест, где его никто не объявлял.
    await act(async () => {
      release!();
      await pending;
    });
  });

  it("возвращает прежнее состояние, если сервер отказал", async () => {
    server.use(
      http.post("/api/projects/p1/mutations", () =>
        HttpResponse.json({ detail: "task_not_found" }, { status: 404 }),
      ),
    );

    const { result } = renderHook(() => useProjectMutation("p1"), { wrapper });
    await act(async () => {
      await result.current.apply(MOVE_OP, moveTaskLocally).catch(() => {});
    });

    expect(cachedState().tasks[0].start_date).toBe("2026-03-04");
  });

  it("берёт итоговые данные с сервера, а не оставляет оптимистичные", async () => {
    // сервер посчитал дату окончания по календарю — клиент обязан взять его версию
    server.use(
      http.post("/api/projects/p1/mutations", () => HttpResponse.json(OK, { status: 201 })),
      http.get("/api/projects/p1", () =>
        HttpResponse.json({
          ...STATE,
          tasks: [{ ...STATE.tasks[0], start_date: "2026-03-11", end_date: "2026-03-17" }],
        }),
      ),
    );

    const { result } = renderHook(() => useProjectMutation("p1"), { wrapper });
    await act(async () => {
      await result.current.apply(MOVE_OP, moveTaskLocally);
    });

    await waitFor(() => expect(cachedState().tasks[0].end_date).toBe("2026-03-17"));
  });

  it("при обрыве связи не отправляет ничего и не трогает состояние", async () => {
    // Ни одного обработчика POST: запрос обязан не уйти вовсе, а не уйти и
    // получить отказ. Ушедший запрос уронит тест — сеть в наборе перехвачена
    // и необъявленные запросы предъявляются (см. test/setup.ts).
    const { result } = renderHook(() => useProjectMutation("p1"), {
      wrapper: offlineWrapper,
    });

    let refusal: unknown;
    await act(async () => {
      refusal = await result.current.apply(MOVE_OP, moveTaskLocally).catch((error) => error);
    });

    expect((refusal as ApiError).code).toBe("offline");
    expect(errorKey(refusal)).toBe("error.offline");
    // Мигания «показали и убрали» тоже быть не должно: показывать нечего.
    expect(cachedState().tasks[0].start_date).toBe("2026-03-04");
  });

  it("не запирает изменения, пока связь просто не открылась", async () => {
    // Раскладка без WebSocket — не обрыв: живых обновлений там нет, а HTTP
    // работает, и запирать редактирование не за что.
    server.use(http.post("/api/projects/p1/mutations", () => HttpResponse.json(OK, { status: 201 })));

    const { result } = renderHook(() => useProjectMutation("p1"), {
      wrapper: ({ children }) => (
        <LiveProvider live={{ status: "unavailable" }}>{wrapper({ children })}</LiveProvider>
      ),
    });

    await act(async () => {
      await result.current.apply(MOVE_OP, moveTaskLocally);
    });

    expect(cachedState().tasks[0].start_date).toBe("2026-03-11");
  });

  it("два изменения подряд откатываются каждое к своему состоянию", async () => {
    server.use(http.post("/api/projects/p1/mutations", () => HttpResponse.json(OK, { status: 201 })));
    const { result } = renderHook(() => useProjectMutation("p1"), { wrapper });

    await act(async () => {
      await result.current.apply(MOVE_OP, moveTaskLocally);
    });

    server.use(
      http.post("/api/projects/p1/mutations", () =>
        HttpResponse.json({ detail: "task_not_found" }, { status: 404 }),
      ),
    );
    await act(async () => {
      await result.current.apply(MOVE_OP_2, moveTaskLocally2).catch(() => {});
    });

    // откат второго не должен отменить первое
    expect(cachedState().tasks[0].start_date).toBe("2026-03-11");
  });
});
