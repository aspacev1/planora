import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { APPROVED, projectFixtures, renderProject } from "../test/project";
import { server } from "../test/server";

beforeEach(projectFixtures);

/** The plan approvals that went to the server during the test. */
function captureApprovals(): number[] {
  const calls: number[] = [];
  server.use(
    http.post("/api/projects/p1/plan/approvals", () => {
      calls.push(calls.length + 1);
      return HttpResponse.json(
        { version: calls.length, approved_at: "2026-03-01T09:00:00+00:00" },
        { status: 201 },
      );
    }),
  );
  return calls;
}

describe("согласование плана", () => {
  it("черновик предлагает утвердить, и это уходит одним щелчком", async () => {
    const approvals = captureApprovals();
    renderProject();

    await userEvent.click(await screen.findByRole("button", { name: "Согласовать план" }));

    await waitFor(() => expect(approvals).toHaveLength(1));
  });

  it("согласованный план предлагает пересогласовать — и спрашивает подтверждение", async () => {
    const approvals = captureApprovals();
    renderProject(APPROVED);

    await userEvent.click(await screen.findByRole("button", { name: "Пересогласовать" }));

    // One click re-approves nothing: the action moves the baseline all explained shifts are measured from.
    expect(approvals).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Да, пересогласовать" }));
    await waitFor(() => expect(approvals).toHaveLength(1));
  });

  it("отказ в пересогласовании виден там же, где подтверждали", async () => {
    server.use(
      http.post("/api/projects/p1/plan/approvals", () =>
        HttpResponse.json({ detail: "unknown" }, { status: 500 }),
      ),
    );
    renderProject(APPROVED);

    await userEvent.click(await screen.findByRole("button", { name: "Пересогласовать" }));
    await userEvent.click(screen.getByRole("button", { name: "Да, пересогласовать" }));

    // The question's card stays — and the refusal stands in it rather than being lost outside it, where
    // nobody draws it.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/ошибка/i);
    const card = screen.getByRole("button", { name: "Да, пересогласовать" }).closest("[role=group]");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByRole("alert")).toBe(alert);
  });

  it("наблюдателю кнопки не показываются вовсе", async () => {
    renderProject(APPROVED, { canWrite: false });
    await screen.findByRole("button", { name: /Логотип/ });

    expect(screen.queryByRole("button", { name: /Согласовать|Пересогласовать/ })).toBeNull();
  });
});
