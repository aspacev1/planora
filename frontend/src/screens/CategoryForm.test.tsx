import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "../test/server";
import { ORG, renderApp, renderWithProviders, sessionHandlers } from "../test/utils";
import { CATEGORY_COLORS, CategoryForm, suggestColor } from "./CategoryForm";

const STATE = {
  id: "p1",
  name: "Редизайн",
  slug: "redizayn",
  deadline: "2026-06-01",
  project_end: "2026-06-08",
  calendar: { working_days: 31, holidays: ["2026-03-20"], extra_workdays: [] },
  settings: { shift_threshold_days: 2, timezone: "Asia/Baku" },
  categories: [{ id: "c1", name: "Дизайн", color: "#3b82f6", position: 0 }],
  tasks: [
    {
      id: "t1",
      category_id: "c1",
      name: "Логотип",
      description: "",
      start_date: "2026-03-04",
      end_date: "2026-03-10",
      duration_days: 5,
      criticality: "high",
      risk: "green",
      risk_note: "",
      progress_pct: 40,
      position: 0,
      assignee_ids: [],
    },
  ],
  dependencies: [],
};

/**
 * The "plus" in the table's corner rather than "+ New category" at the bottom of the strip: the
 * strip has two ways to create a category — this form (with a colour choice) and the short path
 * at the bottom of the list (see `gantt/BottomActions.tsx`) — and both carry the same name for a
 * screen reader, because they do the same thing. What tells them apart is only the place — the
 * table's corner is born together with the project's data, so we look for it first.
 */
async function cornerAddCategoryButton() {
  return waitFor(() => {
    const corner = document.querySelector(".gantt__corner");
    if (!corner) throw new Error("table head not rendered yet");
    return within(corner as HTMLElement).getByRole("button", { name: /категория/i });
  });
}

async function createCategoryNamed(name: string) {
  await userEvent.click(await cornerAddCategoryButton());
  await userEvent.type(screen.getByLabelText(/название/i), name);
  await userEvent.click(screen.getByRole("button", { name: /^создать$/i }));
}

describe("создание категории", () => {
  it("отправляет операцию создания категории и обновляет диаграмму", async () => {
    const sent: unknown[] = [];
    let reread = 0;
    server.use(
      ...sessionHandlers(),
      http.get("/api/projects/p1", () => {
        reread += 1;
        return HttpResponse.json(
          reread === 1
            ? STATE
            : {
                ...STATE,
                categories: [
                  ...STATE.categories,
                  // The server returned what was sent to it.
                  { id: "c2", name: "Аналитика", color: "#a855f7", position: 1 },
                ],
              },
        );
      }),
      http.post("/api/projects/p1/mutations", async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.json({ seq: 2, op: {}, inverse: {} }, { status: 201 });
      }),
    );

    renderApp({ route: "/projects/p1", locale: "ru" });
    await createCategoryNamed("Аналитика");

    await waitFor(() =>
      expect(sent).toEqual([
        {
          op: {
            type: "create_category",
            name: "Аналитика",
            color: expect.stringMatching(/^#[0-9a-f]{6}$/i),
          },
        },
      ]),
    );

    // The state is refetched rather than written into the cache by hand: the position and the id
    // were assigned by the server, and ones invented by the client would diverge from them in the
    // most inconvenient place.
    expect(await screen.findByText("Аналитика")).toBeInTheDocument();
  });

  it("отправляет название как набрано, только без краевых пробелов", async () => {
    // The case is not touched: uniformity is given to a group's heading by the row's typeface in
    // the strip rather than by capitals, which inflated the row and truncated long names
    // prematurely.
    const sent: { op: { name?: string } }[] = [];
    server.use(
      ...sessionHandlers(),
      http.get("/api/projects/p1", () => HttpResponse.json(STATE)),
      http.post("/api/projects/p1/mutations", async ({ request }) => {
        sent.push((await request.json()) as { op: { name?: string } });
        return HttpResponse.json({ seq: 2, op: {}, inverse: {} }, { status: 201 });
      }),
    );

    renderApp({ route: "/projects/p1", locale: "ru" });
    await createCategoryNamed("  аналитика и Отчёты  ");

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op.name).toBe("аналитика и Отчёты");
  });

  it("не поднимает регистр ни в поле, ни при отправке", async () => {
    // The Azerbaijani "işlər" travels as is — the form used to turn it into "İŞLƏR", and that was
    // checked separately; now the opposite matters.
    const sent: { op: { name?: string } }[] = [];
    server.use(
      http.post("/api/projects/p1/mutations", async ({ request }) => {
        sent.push((await request.json()) as { op: { name?: string } });
        return HttpResponse.json({ seq: 2, op: {}, inverse: {} }, { status: 201 });
      }),
    );

    renderWithProviders(<CategoryForm projectId="p1" suggested="#3b82f6" onClose={() => {}} />, {
      locale: "az",
    });
    const field = screen.getByLabelText("Ad");
    await userEvent.type(field, "işlər");
    expect(field.closest("p")).not.toHaveClass("field--upper");
    await userEvent.click(screen.getByRole("button", { name: /^yarat$/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op.name).toBe("işlər");
  });

  it("не шлёт в операции полей, которых нет в публичном контракте", async () => {
    // position and category_id are assigned by the server; the client does not know them and should not
    const sent: { op: Record<string, unknown> }[] = [];
    server.use(
      ...sessionHandlers(),
      http.get("/api/projects/p1", () => HttpResponse.json(STATE)),
      http.post("/api/projects/p1/mutations", async ({ request }) => {
        sent.push((await request.json()) as { op: Record<string, unknown> });
        return HttpResponse.json({ seq: 2, op: {}, inverse: {} }, { status: 201 });
      }),
    );

    renderApp({ route: "/projects/p1", locale: "ru" });
    await createCategoryNamed("Аналитика");

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op).not.toHaveProperty("position");
    expect(sent[0].op).not.toHaveProperty("category_id");
  });

  it("предлагает цвет из готовой палитры, но оставляет выбор человеку", async () => {
    server.use(
      ...sessionHandlers(),
      http.get("/api/projects/p1", () => HttpResponse.json(STATE)),
    );

    renderApp({ route: "/projects/p1", locale: "ru" });
    await userEvent.click(await cornerAddCategoryButton());

    // The choice is a set of ready colours rather than an eyedropper: an arbitrary colour can be
    // indistinguishable from its neighbour and unreadable on the board.
    const swatches = screen.getAllByRole<HTMLInputElement>("radio");
    expect(swatches).toHaveLength(CATEGORY_COLORS.length);
    expect(swatches.map((swatch) => swatch.value)).toEqual(
      CATEGORY_COLORS.map((option) => option.value),
    );

    const chosen = swatches.find((swatch) => swatch.checked);
    // The colour is suggested by the number of already existing categories rather than taken as the
    // first from the palette: otherwise two categories created in a row are indistinguishable.
    expect(chosen?.value).toBe(suggestColor(STATE.categories.length));
    expect(chosen?.value).not.toBe(STATE.categories[0].color);
  });

  it("отправляет выбранный в палитре цвет", async () => {
    const sent: { op: { color?: string } }[] = [];
    server.use(
      ...sessionHandlers(),
      http.get("/api/projects/p1", () => HttpResponse.json(STATE)),
      http.post("/api/projects/p1/mutations", async ({ request }) => {
        sent.push((await request.json()) as { op: { color?: string } });
        return HttpResponse.json({ seq: 2, op: {}, inverse: {} }, { status: 201 });
      }),
    );

    renderApp({ route: "/projects/p1", locale: "ru" });
    await userEvent.click(await cornerAddCategoryButton());
    await userEvent.type(screen.getByLabelText(/название/i), "Аналитика");
    // The circle is named by a word rather than by a colour code: a screen reader must speak the
    // choice, and there is nothing to speak `#ec4899` with.
    await userEvent.click(screen.getByRole("radio", { name: "Розовый" }));
    await userEvent.click(screen.getByRole("button", { name: /^создать$/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op.color).toBe("#ec4899");
  });

  it("на пустой ленте первую категорию заводит кнопка в самой ленте", async () => {
    // An empty project is the only screen where there is nothing to press in the strip except this.
    // There used to be a drawn plus in this place: it looked like a control without being one, and
    // the first category was created by going for it into the toolbar — past the very spot the
    // person was looking at.
    server.use(
      ...sessionHandlers(),
      http.get("/api/projects/p1", () =>
        HttpResponse.json({ ...STATE, categories: [], tasks: [] }),
      ),
    );

    renderApp({ route: "/projects/p1", locale: "ru" });

    const empty = (await screen.findByText(/ни одной категории/i)).closest(".empty");
    await userEvent.click(within(empty as HTMLElement).getByRole("button", { name: /категория/i }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText(/название/i)).toBeInTheDocument();
  });

  it("гостю пустая лента кнопки не обещает", async () => {
    // The right to write is checked by the screen: a drawing inviting you to create a category would
    // leave a reader running into a refusal — a promise without fulfilment.
    server.use(
      // Its own role comes first: msw takes the first matching handler, and the shared `/api/org`
      // from the harness would override the observer the test is written for.
      http.get("/api/org", () => HttpResponse.json({ ...ORG, role: "viewer" })),
      http.get("/api/projects/p1", () =>
        HttpResponse.json({ ...STATE, categories: [], tasks: [] }),
      ),
      ...sessionHandlers(),
    );

    renderApp({ route: "/projects/p1", locale: "ru" });

    const empty = (await screen.findByText(/ни одной категории/i)).closest(".empty");
    expect(within(empty as HTMLElement).queryByRole("button")).not.toBeInTheDocument();
  });

  it("не даёт отправить пустое название", async () => {
    server.use(
      ...sessionHandlers(),
      http.get("/api/projects/p1", () => HttpResponse.json(STATE)),
    );

    renderApp({ route: "/projects/p1", locale: "ru" });
    await userEvent.click(await cornerAddCategoryButton());

    expect(screen.getByRole("button", { name: /^создать$/i })).toBeDisabled();
  });

  it("объясняет отказ сервера переведённым текстом, а не кодом", async () => {
    server.use(
      ...sessionHandlers(),
      http.get("/api/projects/p1", () => HttpResponse.json(STATE)),
      http.post("/api/projects/p1/mutations", () =>
        HttpResponse.json({ detail: "forbidden" }, { status: 403 }),
      ),
    );

    renderApp({ route: "/projects/p1", locale: "ru" });
    await createCategoryNamed("Аналитика");

    expect(await screen.findByText(/у вас нет прав/i)).toBeInTheDocument();
    expect(screen.queryByText("forbidden")).not.toBeInTheDocument();
  });
});
