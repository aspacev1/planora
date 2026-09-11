import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import type { ProjectState, ScheduleRequest } from "../api/projects";
import { server } from "../test/server";
import { renderWithProviders } from "../test/utils";
import { StartDateDialog } from "./StartDateDialog";

const STATE: ProjectState = {
  id: "p1",
  name: "Редизайн",
  slug: "redizayn",
  deadline: null,
  project_end: "2001-01-12",
  plan_approved_at: null,
  plan_version: 0,
  undoable: null,
  schedule_mode: "relative",
  start_date: null,
  calendar: { working_days: 31, holidays: [], extra_workdays: [] },
  settings: { shift_threshold_days: 2, timezone: "Asia/Baku" },
  categories: [],
  tasks: [],
  dependencies: [],
};

function draw(state: ProjectState = STATE, onClose = () => {}) {
  return renderWithProviders(
    <StartDateDialog projectId="p1" state={state} onClose={onClose} />,
    { locale: "ru" },
  );
}

describe("окно привязки к дате старта", () => {
  it("показывает рассчитанные сервером границы до подтверждения", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/api/projects/p1/schedule/preview", async ({ request }) => {
        const body = (await request.json()) as ScheduleRequest;
        expect(body.working_days).toBeUndefined();
        return HttpResponse.json({ start_date: body.start_date, end_date: "2026-12-18" });
      }),
    );

    draw();
    await user.clear(screen.getByLabelText("Дата старта"));
    await user.type(screen.getByLabelText("Дата старта"), "2026-08-24");

    // "Project dates: 24 August — 18 December" — the server's promise, not the client's.
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("24 августа — 18 декабря"),
    );
  });

  it("применяет даты и отдаёт готовое состояние без второго похода", async () => {
    const user = userEvent.setup();
    let sent: ScheduleRequest | null = null;
    server.use(
      http.post("/api/projects/p1/schedule/preview", () =>
        HttpResponse.json({ start_date: "2026-08-24", end_date: "2026-09-04" }),
      ),
      http.post("/api/projects/p1/schedule", async ({ request }) => {
        sent = (await request.json()) as ScheduleRequest;
        return HttpResponse.json({
          ...STATE,
          schedule_mode: "calendar",
          start_date: sent.start_date,
        });
      }),
    );

    let closed = false;
    draw(STATE, () => {
      closed = true;
    });
    await user.clear(screen.getByLabelText("Дата старта"));
    await user.type(screen.getByLabelText("Дата старта"), "2026-08-24");
    // The working week is chosen right here: 6/1 is a Mon–Sat mask.
    await user.selectOptions(screen.getByLabelText("Рабочая неделя"), "63");
    await user.click(screen.getByRole("button", { name: "Применить даты" }));

    await waitFor(() => expect(closed).toBe(true));
    expect(sent).toMatchObject({ start_date: "2026-08-24", working_days: 63 });
    // The first binding does not offer a "shift or not" choice: the relative coordinates must become
    // dates.
    expect(sent).not.toHaveProperty("shift_tasks");
  });

  it("при переносе уже назначенной даты предлагает судьбу задач", async () => {
    const user = userEvent.setup();
    let sent: ScheduleRequest | null = null;
    server.use(
      http.post("/api/projects/p1/schedule/preview", () =>
        HttpResponse.json({ start_date: "2026-09-01", end_date: "2026-09-11" }),
      ),
      http.post("/api/projects/p1/schedule", async ({ request }) => {
        sent = (await request.json()) as ScheduleRequest;
        return HttpResponse.json({ ...STATE, schedule_mode: "calendar", start_date: "2026-09-01" });
      }),
    );

    const bound: ProjectState = { ...STATE, schedule_mode: "calendar", start_date: "2026-08-24" };
    draw(bound);
    await user.click(screen.getByLabelText("Оставить даты задач как есть"));
    await user.click(screen.getByRole("button", { name: "Применить даты" }));

    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent).toMatchObject({ shift_tasks: false });
  });

  it("отказ календаря показывается до кнопки, а кнопка гаснет", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/api/projects/p1/schedule/preview", () =>
        HttpResponse.json({ detail: "calendar_too_few_working_days" }, { status: 422 }),
      ),
    );

    draw();
    await user.clear(screen.getByLabelText("Дата старта"));
    await user.type(screen.getByLabelText("Дата старта"), "2026-08-24");

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Применить даты" })).toBeDisabled();
  });
});
