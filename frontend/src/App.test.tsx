import { render, screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { App } from "./App";
import { server } from "./test/server";

describe("App", () => {
  it("рисует каркас приложения", () => {
    // On start the application asks the server who has arrived: without an answer to that request the
    // frame does not come up at all.
    server.use(
      http.get("/api/auth/me", () =>
        HttpResponse.json({ detail: "not_authenticated" }, { status: 401 }),
      ),
    );

    render(<App />);
    expect(screen.getByRole("main")).toBeInTheDocument();
  });
});
