import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/dom";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";

import { server } from "./server";
import { installFakeWebSocket } from "./socket";

// Testing Library's default second is meant for a single component, while a protected screen is
// rendered in two consecutive trips to the server: first the profile, and only after the answer is
// the screen itself mounted and does it request its own state. Under a full build, where a dozen and
// a half files share the cores, this chain took 928 ms — that is, it fell within the allowance every
// other time, and the tests flickered for no reason. A longer wait does not slow a green run down:
// it is only spent where there would otherwise be a failure.
configure({ asyncUtilTimeout: 5000 });

// A request the test did not describe must fail the test rather than go silently nowhere. An
// `onUnhandledRequest: "error"` alone is not enough for that: the application catches a network
// refusal itself and turns it into "server unavailable", so the test goes on staying green on a
// non-existent answer. So such requests accumulate and are reported after the test.
const undeclared: string[] = [];

beforeAll(() =>
  server.listen({
    onUnhandledRequest: (request, print) => {
      undeclared.push(`${request.method} ${request.url}`);
      print.error();
    },
  }),
);

// The socket is replaced with a controllable one before every test rather than once: the list of
// open connections must start empty, otherwise a test sees other tests'. The connection is not
// opened by itself at that — a project screen that does not need a live connection stays in the
// "connecting" state, as it does in life for the first milliseconds.
beforeEach(installFakeWebSocket);

afterEach(() => {
  server.resetHandlers();
  // The language, the strip's scale and a guest's name — what the application remembers between
  // sessions. Not clearing them means failing a neighbouring test with a choice made in this one.
  localStorage.clear();

  const seen = undeclared.splice(0);
  if (seen.length > 0) {
    throw new Error(`the test did not describe these requests: ${seen.join(", ")}`);
  }
});

afterAll(() => server.close());
