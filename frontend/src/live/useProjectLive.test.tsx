import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONFIG_QUERY_KEY } from "../api/config";
import { getProject, projectQueryKey } from "../api/projects";
import type { ProjectState } from "../api/projects";
import { server } from "../test/server";
import { FakeWebSocket, lastSocket } from "../test/socket";
import { newQueryClient } from "../test/utils";
import { useProjectLive } from "./useProjectLive";

const STATE: ProjectState = {
  id: "p1",
  name: "Редизайн",
  slug: "redizayn",
  deadline: null,
  plan_approved_at: null,
  plan_version: 0,
  undoable: null,
  // Calendar mode: the existing tests' fixtures live on real dates. Relative projects build their
  // own state on top of this (see the relative-scale tests).
  schedule_mode: "calendar" as const,
  start_date: null,

  project_end: "2026-03-10",
  calendar: { working_days: 31, holidays: [], extra_workdays: [] },
  categories: [{ id: "c1", name: "Дизайн", color: "#3b82f6", position: 0 }],
  tasks: [],
  dependencies: [],
};

const REVISION = {
  type: "revision",
  seq: 4,
  created_at: "2026-03-11T09:00:00+00:00",
  actor: { id: "u2", name: "Мария" },
  reason: null,
  op: { type: "move_task", task_id: "t1", from: "2026-03-04", to: "2026-03-11" },
};

let queryClient: QueryClient;
let fetches: number;

/**
 * A live subscriber to the state: without an observer `invalidateQueries` only marks the entry stale
 * and stops there — that is, the test would be checking a function call rather than a refetch.
 */
function Probe() {
  useQuery({ queryKey: projectQueryKey("p1"), queryFn: () => getProject("p1") });
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

beforeEach(() => {
  queryClient = newQueryClient();
  fetches = 0;
  server.use(
    http.get("/api/projects/p1", () => {
      fetches += 1;
      return HttpResponse.json(STATE);
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

/** The first load of the state, after which the trip counter is reset. */
async function settled() {
  await waitFor(() => expect(fetches).toBe(1));
  fetches = 0;
}

describe("живая связь проекта", () => {
  it("не стучится в сокет там, где установка объявила, что его нет", async () => {
    queryClient.setQueryData(CONFIG_QUERY_KEY, {
      mail_enabled: false,
      signup_mode: "open",
      supported_locales: ["ru"],
      default_locale: "ru",
      public_sharing_enabled: true,
      live_enabled: false,
    });
    const { result } = renderHook(() => useProjectLive("p1"), { wrapper });

    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("открывает сокет проекта и сообщает о связи", async () => {
    const { result } = renderHook(() => useProjectLive("p1"), { wrapper });

    expect(result.current.status).toBe("connecting");
    expect(lastSocket().url).toBe("ws://localhost:3000/api/projects/p1/live");

    await act(async () => lastSocket().accept());
    expect(result.current.status).toBe("online");
  });

  it("перезапрашивает состояние, получив ревизию", async () => {
    renderHook(() => useProjectLive("p1"), { wrapper });
    await settled();
    await act(async () => lastSocket().accept());

    await act(async () => lastSocket().emit(REVISION));

    await waitFor(() => expect(fetches).toBe(1));
  });

  it("не ходит за состоянием на постороннем сообщении", async () => {
    // Without this test, "refetches on a revision" would pass for code that goes for the state at
    // every rustle in the socket too.
    renderHook(() => useProjectLive("p1"), { wrapper });
    await settled();
    await act(async () => lastSocket().accept());

    await act(async () => {
      lastSocket().emit({ type: "heartbeat" });
      lastSocket().onmessage?.({ data: "не json вовсе" });
    });

    expect(fetches).toBe(0);
  });

  it("считает связь оборванной, когда сокет закрылся сам", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useProjectLive("p1"), { wrapper });
    act(() => lastSocket().accept());
    expect(result.current.status).toBe("online");

    act(() => lastSocket().drop());

    expect(result.current.status).toBe("offline");
  });

  it("переподключается и перезапрашивает состояние целиком", async () => {
    // §12: on recovery the state is refetched whole rather than replayed from the missed revisions.
    vi.useFakeTimers();
    const { result } = renderHook(() => useProjectLive("p1"), { wrapper });
    await vi.waitFor(() => expect(fetches).toBe(1));
    fetches = 0;

    act(() => lastSocket().accept());
    const first = lastSocket();
    act(() => first.drop());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(lastSocket()).not.toBe(first);

    act(() => lastSocket().accept());
    expect(result.current.status).toBe("online");
    await vi.waitFor(() => expect(fetches).toBe(1));
  });

  it("не перезапрашивает состояние при первом подключении", async () => {
    // The screen has just received the state over HTTP: a second trip for the same thing is an extra
    // request on every opening of a project.
    renderHook(() => useProjectLive("p1"), { wrapper });
    await settled();

    await act(async () => lastSocket().accept());

    expect(fetches).toBe(0);
  });

  it("считает обрывом затянувшееся молчание, а не только закрытие", async () => {
    // A laptop that fell asleep and a changed network do not close the connection — they go quiet.
    // Without a watchdog timeout the screen would go on showing a stale plan with full confidence in
    // its freshness.
    vi.useFakeTimers();
    const { result } = renderHook(() => useProjectLive("p1"), { wrapper });
    act(() => lastSocket().accept());

    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(result.current.status).toBe("online");

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.status).toBe("offline");
  });

  it("напоминание сервера отодвигает сторожевой срок", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useProjectLive("p1"), { wrapper });
    act(() => lastSocket().accept());

    act(() => {
      vi.advanceTimersByTime(50_000);
      lastSocket().emit({ type: "heartbeat" });
      vi.advanceTimersByTime(50_000);
    });

    expect(result.current.status).toBe("online");
  });

  it("сокет, не открывшийся ни разу, не запирает редактирование", async () => {
    // That is how a deployment without WebSocket looks. There will be no live updates, but this is
    // "there is no connection here" rather than "the connection dropped".
    vi.useFakeTimers();
    const { result } = renderHook(() => useProjectLive("p1"), { wrapper });

    act(() => lastSocket().drop());
    expect(result.current.status).toBe("unavailable");

    // The attempts are not endless: a deployment without sockets will not gain them with time.
    await act(async () => {
      for (let round = 0; round < 8; round += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
        lastSocket().drop();
      }
    });
    const attempts = FakeWebSocket.instances.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(FakeWebSocket.instances.length).toBe(attempts);
    expect(result.current.status).toBe("unavailable");
  });

  it("не переподключается после отказа в доступе", async () => {
    // 4401 and 4404 are an answer rather than an obstacle: there is nothing to repeat.
    vi.useFakeTimers();
    renderHook(() => useProjectLive("p1"), { wrapper });
    act(() => lastSocket().accept());
    act(() => lastSocket().drop(4401));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it("закрывает сокет, когда экран уходит, и не считает это обрывом", async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useProjectLive("p1"), { wrapper });
    act(() => lastSocket().accept());
    const socket = lastSocket();

    unmount();

    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(result.current.status).toBe("online");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(FakeWebSocket.instances.length).toBe(1);
  });
});
