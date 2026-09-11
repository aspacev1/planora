import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // In development the frontend and the backend live on different ports. The
  // proxy removes CORS and at the same time keeps the session cookie
  // same-origin — otherwise the browser will not store it. The backend address
  // is overridable through an environment variable: port 8000 is sometimes
  // already taken by a running container, and the only alternative then is to
  // edit the config by hand and remember to revert it.
  // `ws: true` is not a detail: the project's live feed goes through the same
  // /api prefix, and without it the proxy does not pass the upgrade request
  // through. The socket then fails to open only in development, while the
  // built version behind Caddy works — a discrepancy that takes a long time to
  // track down, and in the wrong place.
  server: {
    proxy: {
      "/api": { target: process.env.API_TARGET ?? "http://localhost:8000", ws: true },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    // Three times what Testing Library waits (see src/test/setup.ts). The
    // default five seconds matched its timeout exactly, and under a full run,
    // where a couple of dozen files share the cores, a test died on timeout
    // before the wait had a chance to say what exactly it never got: instead of
    // a clear "could not find such an element" — "test timed out" on the line
    // with the test's name. On a green run the headroom costs nothing.
    testTimeout: 15_000,
  },
});
