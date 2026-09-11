import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { commentsQueryKey } from "../api/comments";
import { CONFIG_QUERY_KEY, installConfig } from "../api/config";
import { projectQueryKey } from "../api/projects";
import { proposalQueryKey } from "../api/proposal";

/**
 * The state of the live connection to a project.
 *
 * Four values rather than two, and the difference between the last two is not
 * pedantry:
 *
 * - `connecting` — the socket is still opening, the state has just arrived over
 *   HTTP and is fresh; there is nothing to block here;
 * - `online` — revisions arrive on their own;
 * - `offline` — there was a connection and it dropped. Only here is the strip shown
 *   and editing locked: the data on screen is stale by an unknown amount;
 * - `unavailable` — there never was a connection. That is how a deployment without
 *   WebSocket looks (serverless on Vercel, a proxy cutting the upgrade). There will
 *   be no live updates there, but there is nothing to lock editing for either: HTTP
 *   works, and a person must not get a read-only application because of a missing
 *   convenience.
 */
export type LiveStatus = "connecting" | "online" | "offline" | "unavailable";

export type Live = { status: LiveStatus };

/**
 * The pause before the next attempt. It grows, because the cause of a drop usually
 * outlives the first second: a server is being restarted, a tunnel is coming up, a
 * train is leaving a tunnel. Hammering the server every second at that time is the
 * worst thing a dozen open tabs can do.
 */
const RECONNECT_DELAYS = [1000, 2000, 5000, 15000, 30000];

/**
 * How much silence counts as a drop. The server reminds of itself every 25 seconds
 * (HEARTBEAT_SECONDS), so the margin is two missed reminders in a row.
 *
 * Without this watchdog half the drops go unnoticed: a laptop that fell asleep and a
 * changed network do not close the connection but go quiet, and the screen goes on
 * showing yesterday's plan with full confidence in its freshness.
 */
const SILENCE_LIMIT = 60_000;

/** The codes from app/api/live_routes.py. A refusal, not a drop: there is nothing to repeat. */
const CLOSE_UNAUTHENTICATED = 4401;
const CLOSE_NOT_FOUND = 4404;

function liveUrl(projectId: string): string {
  const url = new URL(`/api/projects/${encodeURIComponent(projectId)}/live`, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function messageType(data: unknown): string | null {
  if (typeof data !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null && "type" in parsed
      ? String((parsed as { type: unknown }).type)
      : null;
  } catch {
    // Junk in the socket is no reason to crash: the connection is alive, the message
    // is simply not ours. We skip it silently.
    return null;
  }
}

/**
 * A project's live feed.
 *
 * A revision from the socket is a "the state has changed" signal rather than a
 * patch: the client re-requests the project whole. A second, "client-side" applier
 * of operations would diverge from the server on the very first holiday — the end
 * dates are computed by the server, and there is nothing and no reason to repeat its
 * arithmetic here.
 */
export function useProjectLive(projectId: string): Live {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>("connecting");
  // The install says itself whether it has a live connection (`live_enabled` in
  // /api/config). Read from the cache rather than asked for: the protected screens'
  // frame requests the install's settings anyway, and without them the cached answer
  // is "it has one": not opening a socket where there is one is worse than opening
  // one where there is none.
  const config = useQuery({ queryKey: CONFIG_QUERY_KEY, queryFn: installConfig, enabled: false });
  const liveEnabled = config.data?.live_enabled ?? true;

  useEffect(() => {
    // A deployment without WebSocket (serverless): the install knows this in advance,
    // and knocking on the socket six times in a row to find out the same thing is
    // almost a minute of wasted attempts on every project opening.
    if (typeof WebSocket === "undefined" || !liveEnabled) {
      setStatus("unavailable");
      return;
    }

    let socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    // Whether there was ever a connection. Tells a drop from "that does not happen here".
    let established = false;
    let stopped = false;

    // The project's key is a prefix of the journal's key (see api/revisions.ts), so an
    // open card's history is refreshed by the same invalidation, without a separate
    // list of keys that someone will one day forget to extend.
    const refetch = () => {
      void queryClient.invalidateQueries({ queryKey: projectQueryKey(projectId) });
    };

    const listen = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => socket?.close(), SILENCE_LIMIT);
    };

    const retry = () => {
      // There is nothing to wait forever for from a socket that never opened: a
      // deployment without WebSocket will not gain one with time. The attempts end,
      // and the application stays workable without live updates.
      if (!established && attempt >= RECONNECT_DELAYS.length) return;
      const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
      attempt += 1;
      reconnect = setTimeout(open, delay);
    };

    function open() {
      if (stopped) return;
      socket = new WebSocket(liveUrl(projectId));

      socket.onopen = () => {
        listen();
        setStatus("online");
        // Recovery re-requests the whole state rather than replaying the missed
        // revisions (§12). On the first connection there is nothing to re-request: the
        // state has just arrived over HTTP.
        if (established) refetch();
        established = true;
        attempt = 0;
      };

      socket.onmessage = (message: MessageEvent) => {
        listen();
        const type = messageType(message.data);
        if (type === "revision") refetch();
        // A reply event carries only the fact that "there is something new in the
        // feed" — the client reads the text over HTTP, where the internal-reply filter applies.
        if (type === "comment") {
          void queryClient.invalidateQueries({ queryKey: commentsQueryKey(projectId) });
        }
        // The quote is edited without revisions, so it has an event of its own — like
        // the replies: the fact that it "changed", with the client reading the text over HTTP.
        if (type === "proposal") {
          void queryClient.invalidateQueries({ queryKey: proposalQueryKey(projectId) });
        }
      };

      socket.onclose = (event: CloseEvent) => {
        clearTimeout(watchdog);
        if (stopped) return;
        setStatus(established ? "offline" : "unavailable");
        // "Did not introduce itself" and "no such project" are an answer rather than an
        // obstacle: reconnecting will give the same refusal. A person learns about an
        // expired session from the very first HTTP request, and there is no need to say
        // it twice.
        if (event.code === CLOSE_UNAUTHENTICATED || event.code === CLOSE_NOT_FOUND) return;
        retry();
      };
    }

    open();

    return () => {
      stopped = true;
      clearTimeout(reconnect);
      clearTimeout(watchdog);
      // onclose is removed before closing: unmounting is not a dropped connection, and
      // there is no point assigning a "no connection" status to a screen that is leaving.
      if (socket) socket.onclose = null;
      socket?.close();
    };
  }, [projectId, queryClient, liveEnabled]);

  // The object is assembled anew on every render of the screen, and half the tree
  // reads it through context: without this every repaint of the project would drag a
  // repaint of all the consumers along with it.
  return useMemo(() => ({ status }), [status]);
}
