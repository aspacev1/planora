import { createContext, useContext } from "react";
import type { ReactNode } from "react";

import type { Live } from "./useProjectLive";

/**
 * The live connection defaults to `unavailable` rather than `offline`.
 *
 * Outside the project screen there is no socket at all: the connection did not drop, nobody opened it.
 * The default value must name precisely that, otherwise some future screen without a provider would be
 * silently locked to reading.
 */
const LiveContext = createContext<Live>({ status: "unavailable" });

export function LiveProvider({ live, children }: { live: Live; children: ReactNode }) {
  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}

/**
 * The connection's state where it is asked about deep in the tree: by the task card, by a bar on the
 * strip, by the shared change path.
 */
export function useLive(): Live {
  return useContext(LiveContext);
}

/** Whether editing is locked by a dropped connection. */
export function useLiveBlocksEditing(): boolean {
  return useLive().status === "offline";
}
