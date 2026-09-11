import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { STATE, captureMutations, projectFixtures, renderProject } from "../test/project";
import { server } from "../test/server";

beforeEach(projectFixtures);

/** Open the card with a click on the bar. */
async function openPanel() {
  await userEvent.click(await screen.findByRole("button", { name: /Логотип/ }));
}

describe("быстрый прогресс в карточке", () => {
  it("«Записать прогресс» прибавляет дневную норму одной операцией и гаснет", async () => {
    const sent = captureMutations();
    renderProject();
    await openPanel();

    // Five working days — a daily quota of 20%: 40 → 60.
    await userEvent.click(screen.getByRole("button", { name: "Записать прогресс · +20%" }));
    await waitFor(() =>
      expect(sent).toEqual([
        { op: { type: "set_progress", task_id: "t1", progress_pct: 60 } },
      ]),
    );

    // The disabled button guards against a double tap: a second "day" is not recorded in one visit.
    expect(screen.getByRole("button", { name: "День отмечен" })).toBeDisabled();
  });

  it("кнопка загорается снова, если сервер отказал", async () => {
    server.use(
      http.post("/api/projects/p1/mutations", () =>
        HttpResponse.json({ detail: "progress_out_of_range" }, { status: 422 }),
      ),
    );

    renderProject();
    await openPanel();
    await userEvent.click(screen.getByRole("button", { name: "Записать прогресс · +20%" }));

    // The progress was not written — so the day is not marked: the main daily button has no right to
    // stay dark until the end of the visit.
    const day = await screen.findByRole("button", { name: "Записать прогресс · +20%" });
    await waitFor(() => expect(day).toBeEnabled());
  });

  it("число прогресса тоже можно ввести напрямую", async () => {
    const sent = captureMutations();
    renderProject();
    await openPanel();

    await userEvent.clear(screen.getByLabelText(/выполнено/i));
    await userEvent.type(screen.getByLabelText(/выполнено/i), "75");
    // The number leaves on blur rather than on every key: otherwise "75" would leave two entries in the
    // task's history — about 7 and about 75.
    expect(sent).toHaveLength(0);
    await userEvent.tab();

    await waitFor(() =>
      expect(sent).toEqual([{ op: { type: "set_progress", task_id: "t1", progress_pct: 75 } }]),
    );
  });

  it("читателю прогресс виден, но кнопки отметки и правки числа нет", async () => {
    renderProject(STATE, { canWrite: false });
    await openPanel();

    expect(screen.getByLabelText(/выполнено/i)).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Записать прогресс/ })).not.toBeInTheDocument();
  });
});
