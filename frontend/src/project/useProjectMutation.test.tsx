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
  // Calendar mode: the existing tests' fixtures live on real dates. Relative projects build their
  // own state on top of this (see the relative-scale tests).
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
 * The optimistic transformation touches only the start.
 *
 * It deliberately does not compute the end date: that is computed by the server from the
 * project's calendar, and substituting "plus the same number of days" here would mean keeping a
 * second, wrong calendar on the client.
 */
const moveTaskLocally = (state: ProjectState) => withTask(state, { start_date: "2026-03-11" });
const moveTaskLocally2 = (state: ProjectState) => withTask(state, { start_date: "2026-03-18" });

/** The state as the server will return it, having accepted MOVE_OP: the end is recomputed by it. */
const MOVED = withTask(STATE, { start_date: "2026-03-11", end_date: "2026-03-17" });

const OK = { seq: 1, op: { type: "move_task", task_id: "t1" }, inverse: {} };

let queryClient: QueryClient;

/**
 * A live subscriber to the project's state.
 *
 * Without it `invalidateQueries` will mark the entry stale and stop there: only queries with an
 * observer are refetched. That is, without this component the third test would be checking
 * something other than what its name says.
 *
 * `staleTime: Infinity` removes the background trip on mount — it would overwrite the optimistic
 * change with an answer the test never asked for.
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

/** The same environment, but with the connection down. */
function offlineWrapper({ children }: { children: ReactNode }) {
  return <LiveProvider live={{ status: "offline" }}>{wrapper({ children })}</LiveProvider>;
}

function cachedState(): ProjectState {
  return queryClient.getQueryData<ProjectState>(projectQueryKey("p1"))!;
}

beforeEach(() => {
  queryClient = newQueryClient();
  queryClient.setQueryData(projectQueryKey("p1"), STATE);
  // The state after an accepted move: the server, having applied move_task, gives both the new
  // start and the end it recomputed.
  server.use(http.get("/api/projects/p1", () => HttpResponse.json(MOVED)));
});

describe("оптимистичные изменения", () => {
  it("показывает изменение до ответа сервера", async () => {
    // The response is prepared in advance rather than inside the handler: the handler is only
    // called after the request leaves, while the test must manage to look at the state before that.
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

    // The response is released and awaited right here: an unfinished change would travel as a state
    // request into a neighbouring test, where nobody declared it.
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
    // the server computed the end date by the calendar — the client must take its version
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
    // Not a single POST handler: the request must not leave at all rather than leave and get a
    // refusal. A request that leaves will fail the test — the network is intercepted in the suite
    // and undeclared requests are reported (see test/setup.ts).
    const { result } = renderHook(() => useProjectMutation("p1"), {
      wrapper: offlineWrapper,
    });

    let refusal: unknown;
    await act(async () => {
      refusal = await result.current.apply(MOVE_OP, moveTaskLocally).catch((error) => error);
    });

    expect((refusal as ApiError).code).toBe("offline");
    expect(errorKey(refusal)).toBe("error.offline");
    // There must be no flash of "shown and removed" either: there is nothing to show.
    expect(cachedState().tasks[0].start_date).toBe("2026-03-04");
  });

  it("не запирает изменения, пока связь просто не открылась", async () => {
    // A deployment without WebSocket is not a drop: there are no live updates there, while HTTP
    // works, and there is nothing to lock editing for.
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

    // rolling back the second must not cancel the first
    expect(cachedState().tasks[0].start_date).toBe("2026-03-11");
  });
});
