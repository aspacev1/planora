import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import type { ProposalState, PushPreview } from "../api/proposal";
import { projectFixtures, renderProject } from "../test/project";
import { server } from "../test/server";

/**
 * A quote with two lines: 2d × 100 and 3d × 200 — a subtotal of 800, 10% tax —
 * 80, a total of 880, a volume of 5 days and 40 hours (at an eight-hour day).
 * The numbers are chosen so that every total line differs from every other: two
 * matching sums would let the test go green on mixed-up lines.
 */
const PROPOSAL: ProposalState = {
  effort_unit: "days",
  hours_per_day: 8,
  tax_rate_pct: 10,
  currency: "USD",
  notes: "Оценки по текущему объёму.\nСтавки без стоимости лицензий.",
  status: "draft",
  sent_at: null,
  agreed_at: null,
  pushed_count: 0,
  pushable_count: 2,
  role_suggestions: [{ role: "Дизайнер", rate: 100 }],
  plan_facts: { categories: 2, tasks: 1 },
  categories: [
    {
      id: "pc1",
      name: "Дизайн",
      description: "Понять и нарисовать",
      position: 0,
      tasks: [
        {
          id: "pt1",
          category_id: "pc1",
          name: "Логотип",
          description: "Знак",
          details: "Три варианта",
          role: "Дизайнер",
          effort: 2,
          rate: 100,
          notes: "Шрифт покупает клиент",
          risks: "Правки затянутся",
          assumptions: "Брендбук уже есть",
          position: 0,
          comment_count: 1,
          plan_task_id: null,
        },
        {
          id: "pt2",
          category_id: "pc1",
          name: "Гайдлайн",
          description: "",
          details: "",
          role: "",
          effort: 3,
          rate: 200,
          notes: "",
          risks: "",
          assumptions: "",
          position: 1,
          comment_count: 0,
          plan_task_id: null,
        },
      ],
    },
  ],
};

/**
 * A quote that does not exist yet: no sections, no lines — only a plan it can be
 * assembled from. The plan's numbers do not coincide with each other, so the
 * card's caption cannot be assembled from mixed-up counters.
 */
const EMPTY: ProposalState = {
  ...PROPOSAL,
  categories: [],
  plan_facts: { tasks: 3, categories: 2 },
};

/**
 * Money — through the same Intl as the screen: the exact string depends on the
 * ICU environment.
 *
 * A non-breaking space is normalized to an ordinary one: getByText normalizes
 * whitespace in an element's text but not in the string being looked for, and
 * "600,00 $" with a U+00A0 would not find itself.
 */
function money(value: number): string {
  return new Intl.NumberFormat("ru", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  })
    .format(value)
    .replace(/\s/g, " ");
}

/**
 * A transfer preview: "Design" will land in the plan's category of the same
 * name, two lines are estimated, the third ("Animations") has no estimate and by
 * default does not go.
 */
const PREVIEW: PushPreview = {
  categories: [
    {
      id: "pc1",
      name: "Дизайн",
      plan_category: { id: "c1", name: "Дизайн" },
      tasks: [
        {
          id: "pt1",
          name: "Логотип",
          duration_days: 2,
          in_plan: false,
          estimated: true,
        },
        {
          id: "pt2",
          name: "Гайдлайн",
          duration_days: 3,
          in_plan: false,
          estimated: true,
        },
        {
          id: "pt3",
          name: "Анимации",
          duration_days: 1,
          in_plan: false,
          estimated: false,
        },
      ],
    },
  ],
};

function proposalFixtures(
  state: ProposalState = PROPOSAL,
  preview: PushPreview = PREVIEW,
) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  server.use(
    http.get("/api/projects/p1/proposal", () => HttpResponse.json(state)),
    http.get("/api/projects/p1/proposal/push-plan", () =>
      HttpResponse.json(preview),
    ),
    http.post("/api/projects/p1/proposal/stage", async ({ request }) => {
      sent.push({ method: "POST", path: "stage", body: await request.json() });
      return HttpResponse.json(state);
    }),
    http.post("/api/projects/p1/batches/:batchId/undo", ({ params }) => {
      sent.push({
        method: "POST",
        path: `undo:${params.batchId as string}`,
        body: null,
      });
      return HttpResponse.json({ undone: 2, seq: 3 }, { status: 201 });
    }),
    http.get("/api/projects/p1/proposal/tasks/:taskId/comments", () =>
      HttpResponse.json([
        {
          id: "k1",
          task_id: "pt1",
          body: "Ставку согласовали",
          created_at: "2026-03-05T10:00:00+00:00",
          author: { name: "Мария", guest: false },
        },
      ]),
    ),
    http.post(
      "/api/projects/p1/proposal/categories/:categoryId/tasks",
      async ({ request, params }) => {
        sent.push({
          method: "POST",
          path: `tasks:${params.categoryId as string}`,
          body: await request.json(),
        });
        return HttpResponse.json(
          { id: "pt-new", category_id: params.categoryId, name: "Новая" },
          { status: 201 },
        );
      },
    ),
    http.post("/api/projects/p1/proposal/categories", async ({ request }) => {
      sent.push({
        method: "POST",
        path: "categories",
        body: await request.json(),
      });
      return HttpResponse.json(
        { id: "pc-new", name: "Ещё", position: 1 },
        { status: 201 },
      );
    }),
    http.patch(
      "/api/projects/p1/proposal/tasks/:taskId",
      async ({ request, params }) => {
        sent.push({
          method: "PATCH",
          path: `task:${params.taskId as string}`,
          body: await request.json(),
        });
        return HttpResponse.json(state);
      },
    ),
    http.patch("/api/projects/p1/proposal", async ({ request }) => {
      sent.push({
        method: "PATCH",
        path: "proposal",
        body: await request.json(),
      });
      return HttpResponse.json(state);
    }),
    http.patch(
      "/api/projects/p1/proposal/categories/:categoryId",
      async ({ request, params }) => {
        sent.push({
          method: "PATCH",
          path: `category:${params.categoryId as string}`,
          body: await request.json(),
        });
        return HttpResponse.json({
          id: params.categoryId,
          name: "Дизайн",
          position: 0,
        });
      },
    ),
    http.delete("/api/projects/p1/proposal/tasks/:taskId", ({ params }) => {
      sent.push({
        method: "DELETE",
        path: `task:${params.taskId as string}`,
        body: null,
      });
      return new HttpResponse(null, { status: 204 });
    }),
    http.delete(
      "/api/projects/p1/proposal/categories/:categoryId",
      ({ params }) => {
        sent.push({
          method: "DELETE",
          path: `category:${params.categoryId as string}`,
          body: null,
        });
        return new HttpResponse(null, { status: 204 });
      },
    ),
    http.post("/api/projects/p1/proposal/push-to-plan", async ({ request }) => {
      const body = (await request.json()) as { task_ids: string[] };
      sent.push({ method: "POST", path: "push-to-plan", body });
      return HttpResponse.json(
        { created_tasks: body.task_ids.length, batch_id: "b1" },
        { status: 201 },
      );
    }),
    http.post("/api/projects/p1/proposal/build-from-plan", () => {
      sent.push({ method: "POST", path: "build-from-plan", body: null });
      return HttpResponse.json(
        { created_categories: 1, created_tasks: 2 },
        { status: 201 },
      );
    }),
  );
  return sent;
}

/** Open a row's cell for editing: a click on the value, as in the strip. */
async function openCell(text: string) {
  await userEvent.click(await screen.findByText(text));
}

describe("вкладка предложения", () => {
  beforeEach(() => {
    projectFixtures();
  });

  it("показывает работы по разделам и считает итоги: объём, сумму, налог, всего", async () => {
    proposalFixtures();
    renderProject(undefined, { route: "/projects/p1/proposal" });

    // A work line: the role, the estimate in days with the hours next to it, the
    // rate and the price without a currency — that is named in the column's
    // heading. The "Guideline" price of 600 matches no rate — a matching line
    // would hide a mistake.
    expect(await screen.findByText("Логотип")).toBeInTheDocument();
    expect(screen.getByText("Знак")).toBeInTheDocument();
    expect(screen.getByText("Дизайнер")).toBeInTheDocument();
    expect(screen.getByText("2д")).toBeInTheDocument();
    expect(screen.getByText("16ч")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("600")).toBeInTheDocument();
    expect(screen.getByText("Ставка, USD/д")).toBeInTheDocument();
    // An empty role hints at what goes in it rather than staying silent with a dash.
    expect(screen.getByText("роль")).toBeInTheDocument();
    // The parameters are folded into a popover, but the button's caption says the main thing.
    expect(
      screen.getByRole("button", { name: "Параметры предложения" }),
    ).toHaveTextContent("Дни · Налог 10 % · USD");

    // A section's row is a summary of its own work items and a description.
    expect(screen.getByText("Понять и нарисовать")).toBeInTheDocument();

    const summary = screen.getByRole("complementary", {
      name: "Итоги предложения",
    });
    expect(within(summary).getByText("40ч")).toBeInTheDocument();
    expect(within(summary).getByText("5д")).toBeInTheDocument();
    expect(within(summary).getByText(money(800))).toBeInTheDocument();
    expect(within(summary).getByText("Налог (10%)")).toBeInTheDocument();
    expect(within(summary).getByText(money(80))).toBeInTheDocument();
    expect(within(summary).getByText(money(880))).toBeInTheDocument();
  });

  it("шеврон сворачивает раздел: работы прячутся, сводка остаётся", async () => {
    proposalFixtures();
    renderProject(undefined, { route: "/projects/p1/proposal" });
    await screen.findByText("Логотип");

    await userEvent.click(
      screen.getByRole("button", { name: "Свернуть раздел «Дизайн»" }),
    );

    expect(screen.queryByText("Логотип")).not.toBeInTheDocument();
    // The section's summary is in place: a collapsed section is a line with a sum, not a hole.
    expect(screen.getByText("Дизайн")).toBeInTheDocument();
    expect(screen.getAllByText(money(800)).length).toBeGreaterThan(0);
  });

  it("знак «править» на строке открывает карточку: поля по адресату, обсуждение внизу", async () => {
    proposalFixtures();
    renderProject(undefined, { route: "/projects/p1/proposal" });

    await userEvent.click(
      await screen.findByRole("button", { name: "Править работу «Логотип»" }),
    );
    const panel = await screen.findByRole("complementary", { name: /Логотип/ });

    // The header: the section, the price formula and the price itself — what the line adds up from.
    expect(within(panel).getByText("Дизайн")).toBeInTheDocument();
    expect(
      within(panel).getByText(`2д × ${money(100)} в день`),
    ).toBeInTheDocument();
    expect(within(panel).getByText(money(200))).toBeInTheDocument();

    // Three panels: what the customer will see, what stays inside, the conversation.
    expect(within(panel).getByText("В документе клиента")).toBeInTheDocument();
    expect(within(panel).getByText("Только для команды")).toBeInTheDocument();
    expect(within(panel).getByText("Обсуждение")).toBeInTheDocument();
    expect(within(panel).getByText("видно только команде")).toBeInTheDocument();

    // The client-facing part: the work, the role, the estimate and the rate with units, the descriptions.
    expect(within(panel).getByLabelText("Работа")).toHaveValue("Логотип");
    expect(within(panel).getByLabelText("Ответственная роль")).toHaveValue(
      "Дизайнер",
    );
    expect(within(panel).getByLabelText("Оценка, дни")).toHaveValue(2);
    expect(within(panel).getByLabelText("Ставка в день")).toHaveValue(100);
    expect(within(panel).getByLabelText("Описание")).toHaveValue("Знак");
    expect(within(panel).getByLabelText("Подробное описание")).toHaveValue(
      "Три варианта",
    );

    // The internal part: notes, risks, assumptions.
    expect(within(panel).getByLabelText("Заметки")).toHaveValue(
      "Шрифт покупает клиент",
    );
    expect(within(panel).getByLabelText("Риски")).toHaveValue(
      "Правки затянутся",
    );
    expect(within(panel).getByLabelText("Допущения")).toHaveValue(
      "Брендбук уже есть",
    );

    expect(
      await within(panel).findByText("Ставку согласовали"),
    ).toBeInTheDocument();
  });

  it("в почасовой смете подписи оценки и ставки — часовые", async () => {
    proposalFixtures({ ...PROPOSAL, effort_unit: "hours" });
    renderProject(undefined, { route: "/projects/p1/proposal" });

    await userEvent.click(
      await screen.findByRole("button", { name: "Править работу «Логотип»" }),
    );
    const panel = await screen.findByRole("complementary", { name: /Логотип/ });

    expect(
      within(panel).getByText(`2ч × ${money(100)} в час`),
    ).toBeInTheDocument();
    expect(within(panel).getByLabelText("Оценка, часы")).toHaveValue(2);
    expect(within(panel).getByLabelText("Ставка в час")).toHaveValue(100);
  });

  it("правка поля в карточке уходит на сервер при потере фокуса", async () => {
    const sent = proposalFixtures();
    renderProject(undefined, { route: "/projects/p1/proposal" });

    await userEvent.click(
      await screen.findByRole("button", { name: "Править работу «Логотип»" }),
    );
    const panel = await screen.findByRole("complementary", { name: /Логотип/ });

    const risks = within(panel).getByLabelText("Риски");
    await userEvent.clear(risks);
    await userEvent.type(risks, "Смена подрядчика");
    await userEvent.tab();

    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "PATCH",
        path: "task:pt1",
        body: { risks: "Смена подрядчика" },
      }),
    );
  });

  it("каждая ячейка работы правится прямо в таблице", async () => {
    const sent = proposalFixtures();
    renderProject(undefined, { route: "/projects/p1/proposal" });

    // The name.
    await openCell("Логотип");
    const name = screen.getByLabelText("Изменить: Работа у «Логотип»");
    await userEvent.clear(name);
    await userEvent.type(name, "Знак фирмы");
    await userEvent.tab();
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "PATCH",
        path: "task:pt1",
        body: { name: "Знак фирмы" },
      }),
    );

    // The description: empty is a value too, descriptions do get erased.
    await openCell("Знак");
    const description = screen.getByLabelText("Изменить: Описание у «Логотип»");
    await userEvent.clear(description);
    await userEvent.tab();
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "PATCH",
        path: "task:pt1",
        body: { description: "" },
      }),
    );

    // The role is a cell too: an empty one hints, a filled one is edited.
    await openCell("Дизайнер");
    const role = screen.getByLabelText("Изменить: Роль у «Логотип»");
    await userEvent.clear(role);
    await userEvent.type(role, "Арт-директор{Enter}");
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "PATCH",
        path: "task:pt1",
        body: { role: "Арт-директор" },
      }),
    );

    // The estimate is in the quote's unit; the hours next to it are only for checking.
    await openCell("2д");
    const effort = screen.getByLabelText("Изменить: Оценка у «Логотип»");
    await userEvent.clear(effort);
    await userEvent.type(effort, "4{Enter}");
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "PATCH",
        path: "task:pt1",
        body: { effort: 4 },
      }),
    );

    // The rate.
    await openCell("100");
    const rate = screen.getByLabelText("Изменить: Ставка у «Логотип»");
    await userEvent.clear(rate);
    await userEvent.type(rate, "150{Enter}");
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "PATCH",
        path: "task:pt1",
        body: { rate: 150 },
      }),
    );

    // The price is a product, and editing it changes the rate: 900 for three days
    // of "Guideline" is 300 per day.
    await openCell("600");
    const price = screen.getByLabelText("Изменить: Цена у «Гайдлайн»");
    await userEvent.clear(price);
    await userEvent.type(price, "900{Enter}");
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "PATCH",
        path: "task:pt2",
        body: { rate: 300 },
      }),
    );
  });

  it("имя и описание раздела правятся в его строке", async () => {
    const sent = proposalFixtures();
    renderProject(undefined, { route: "/projects/p1/proposal" });

    await openCell("Дизайн");
    const name = screen.getByLabelText("Название раздела «Дизайн»");
    await userEvent.clear(name);
    await userEvent.type(name, "Проектирование{Enter}");
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "PATCH",
        path: "category:pc1",
        body: { name: "Проектирование" },
      }),
    );

    await openCell("Понять и нарисовать");
    const description = screen.getByLabelText("Описание раздела «Дизайн»");
    await userEvent.clear(description);
    await userEvent.type(description, "Понять и показать{Enter}");
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "PATCH",
        path: "category:pc1",
        body: { description: "Понять и показать" },
      }),
    );
  });

  it("крестик на строке удаляет работу — после вопроса о последствии", async () => {
    const sent = proposalFixtures();
    renderProject(undefined, { route: "/projects/p1/proposal" });

    await userEvent.click(
      await screen.findByRole("button", { name: "Удалить работу «Логотип»" }),
    );
    // First what exactly will break, and only then the action itself.
    expect(
      screen.getByText("Работа «Логотип» удалится вместе с обсуждением"),
    ).toBeInTheDocument();
    expect(sent).not.toContainEqual({
      method: "DELETE",
      path: "task:pt1",
      body: null,
    });

    await userEvent.click(
      screen.getByRole("button", { name: "Удалить работу" }),
    );
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "DELETE",
        path: "task:pt1",
        body: null,
      }),
    );

    // The same cross on a section's row too — with its own warning: a section
    // takes all its work items with it.
    await userEvent.click(
      screen.getByRole("button", { name: "Удалить раздел «Дизайн»" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Удалить раздел" }),
    );
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "DELETE",
        path: "category:pc1",
        body: null,
      }),
    );
  });

  it("знак «править» на строке раздела открывает окно с его полями", async () => {
    const sent = proposalFixtures();
    renderProject(undefined, { route: "/projects/p1/proposal" });

    await userEvent.click(
      await screen.findByRole("button", { name: "Править раздел «Дизайн»" }),
    );
    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByLabelText("Название")).toHaveValue("Дизайн");

    await userEvent.clear(within(modal).getByLabelText("Описание"));
    await userEvent.type(
      within(modal).getByLabelText("Описание"),
      "Смыслы и картинки",
    );
    await userEvent.click(
      within(modal).getByRole("button", { name: "Сохранить" }),
    );

    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "PATCH",
        path: "category:pc1",
        body: { name: "Дизайн", description: "Смыслы и картинки" },
      }),
    );
  });

  it("работа заводится строкой в конце раздела: имя, роль со ставкой, оценка", async () => {
    const sent = proposalFixtures();
    renderProject(undefined, { route: "/projects/p1/proposal" });
    await screen.findByText("Логотип");

    // "Add work" at the end of a section opens an input row — as in the strip.
    await userEvent.click(
      screen.getByRole("button", { name: "Добавить работу в «Дизайн»" }),
    );
    const input = screen.getByLabelText("Новая работа в «Дизайн»");
    await userEvent.type(input, "Вёрстка{Enter}");

    // A name alone is still enough — and it is the only thing that leaves.
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "POST",
        path: "tasks:pc1",
        body: { name: "Вёрстка" },
      }),
    );
    // Enter does not close the row: the next work item is written straight away.
    expect(screen.getByLabelText("Новая работа в «Дизайн»")).toHaveValue("");

    // The role is suggested from the organization's reference list and pulls the rate along with it.
    await userEvent.type(
      screen.getByLabelText("Новая работа в «Дизайн»"),
      "Макет",
    );
    await userEvent.type(screen.getByLabelText("Роль новой работы"), "диз");
    await userEvent.click(
      await screen.findByRole("option", { name: /Дизайнер/ }),
    );
    expect(screen.getByLabelText("Ставка новой работы, USD/д")).toHaveValue(
      100,
    );
    await userEvent.type(
      screen.getByLabelText("Оценка новой работы, д"),
      "3{Enter}",
    );

    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "POST",
        path: "tasks:pc1",
        body: { name: "Макет", role: "Дизайнер", effort: 3, rate: 100 },
      }),
    );
  });

  it("полоса этапов: следующий шаг уходит на сервер, пройденный снимается щелчком", async () => {
    const sent = proposalFixtures({
      ...PROPOSAL,
      status: "sent",
      sent_at: "2026-08-27T10:00:00+00:00",
    });
    renderProject(undefined, { route: "/projects/p1/proposal" });
    await screen.findByText("Логотип");

    // A passed stage is captioned with a date, the current one is named, the next one is a button.
    const stages = screen.getByRole("list", { name: "Этапы предложения" });
    expect(within(stages).getByText("27 авг")).toBeInTheDocument();
    expect(
      within(stages).getByText("Отправлено").closest("[aria-current]"),
    ).toHaveAttribute("aria-current", "step");
    await userEvent.click(
      screen.getByRole("button", { name: "Отметить согласованным" }),
    );
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "POST",
        path: "stage",
        body: { stage: "agreed" },
      }),
    );

    // Back — by a click on a passed stage.
    await userEvent.click(
      screen.getByRole("button", { name: "Вернуть на этап «Черновик»" }),
    );
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "POST",
        path: "stage",
        body: { stage: "draft" },
      }),
    );
  });

  it("перенос доступен из черновика — тихой кнопкой рядом с шагом сделки", async () => {
    proposalFixtures();
    renderProject(undefined, { route: "/projects/p1/proposal" });
    await screen.findByText("Логотип");

    // Not everyone sends the document to the client: the transfer stands next to
    // the sent mark rather than behind it. But while the deal is not agreed it is
    // quiet — both on the stage bar and in the totals card; there is no primary
    // button in a draft.
    const stages = screen.getByRole("list", { name: "Этапы предложения" });
    expect(
      within(stages).getByRole("button", { name: "Отметить отправленным" }),
    ).toHaveClass("button--quiet");
    const fromStages = within(stages).getByRole("button", {
      name: "Перенести в план…",
    });
    expect(fromStages).toHaveClass("button--quiet");
    expect(fromStages).not.toHaveClass("button--primary");
    const summary = screen.getByRole("complementary", {
      name: "Итоги предложения",
    });
    expect(
      within(summary).getByRole("button", { name: "Перенести в план…" }),
    ).toHaveClass("button--quiet");

    await userEvent.click(fromStages);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("после согласования перенос становится главной кнопкой", async () => {
    proposalFixtures({
      ...PROPOSAL,
      status: "agreed",
      sent_at: "2026-08-27T10:00:00+00:00",
      agreed_at: "2026-09-02T10:00:00+00:00",
    });
    renderProject(undefined, { route: "/projects/p1/proposal" });
    await screen.findByText("Логотип");

    // There is no deal step any more — the transfer is left alone and filled, in
    // both places. The ellipsis stays at that: the same dialog is behind the press.
    const stages = screen.getByRole("list", { name: "Этапы предложения" });
    expect(
      within(stages).queryByRole("button", { name: /Отметить/ }),
    ).not.toBeInTheDocument();
    const fromStages = within(stages).getByRole("button", {
      name: "Перенести в план…",
    });
    expect(fromStages).toHaveClass("button--primary");
    const summary = screen.getByRole("complementary", {
      name: "Итоги предложения",
    });
    expect(
      within(summary).getByRole("button", { name: "Перенести в план…" }),
    ).toHaveClass("button--primary");

    await userEvent.click(fromStages);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("параметры правятся в поповере и уходят на сервер по одному", async () => {
    const sent = proposalFixtures();
    renderProject(undefined, { route: "/projects/p1/proposal" });
    await screen.findByText("Логотип");

    await userEvent.click(
      screen.getByRole("button", { name: "Параметры предложения" }),
    );
    // The number leaves on blur, like every number in autosaving fields: typed
    // whole rather than digit by digit.
    const tax = screen.getByLabelText("Налог, %");
    await userEvent.clear(tax);
    await userEvent.type(tax, "5");
    await userEvent.tab();
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "PATCH",
        path: "proposal",
        body: { tax_rate_pct: 5 },
      }),
    );
  });

  it("раздел заводится окном из строки внизу таблицы — как категория в ленте", async () => {
    const sent = proposalFixtures();
    renderProject(undefined, { route: "/projects/p1/proposal" });
    await screen.findByText("Логотип");

    await userEvent.click(screen.getByRole("button", { name: "Новый раздел" }));
    const modal = await screen.findByRole("dialog");
    await userEvent.type(
      within(modal).getByLabelText("Название"),
      "Разработка",
    );
    await userEvent.type(
      within(modal).getByLabelText("Описание"),
      "Собрать приложение",
    );
    await userEvent.click(
      within(modal).getByRole("button", { name: "Создать" }),
    );

    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "POST",
        path: "categories",
        body: { name: "Разработка", description: "Собрать приложение" },
      }),
    );
  });

  it("примечания предложения показываются пунктами и правятся на месте", async () => {
    const sent = proposalFixtures();
    renderProject(undefined, { route: "/projects/p1/proposal" });
    await screen.findByText("Логотип");

    // One item per line — as a list.
    expect(screen.getByText("Оценки по текущему объёму.")).toBeInTheDocument();
    expect(
      screen.getByText("Ставки без стоимости лицензий."),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Править примечания" }),
    );
    // The role narrows the search: the notes card itself carries the same caption.
    const editor = screen.getByRole("textbox", {
      name: "Допущения и примечания",
    });
    await userEvent.clear(editor);
    await userEvent.type(editor, "Смета действительна месяц.");
    await userEvent.tab();

    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "PATCH",
        path: "proposal",
        body: { notes: "Смета действительна месяц." },
      }),
    );
  });

  it("перенос идёт через окно: что случится, что выбрано, что не переносится", async () => {
    const sent = proposalFixtures();
    renderProject(undefined, { route: "/projects/p1/proposal" });
    await screen.findByText("Логотип");

    const summary = screen.getByRole("complementary", {
      name: "Итоги предложения",
    });
    await userEvent.click(
      within(summary).getByRole("button", { name: "Перенести в план…" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Перенести предложение в план"),
    ).toBeInTheDocument();
    // A section will find its own plan category rather than create a second one.
    expect(
      within(dialog).getByText("в категорию «Дизайн»"),
    ).toBeInTheDocument();
    // A line without an estimate is disabled and named: a hidden one would be looked for.
    const blank = within(dialog).getByRole("checkbox", {
      name: "Перенести «Анимации»",
    });
    expect(blank).toBeDisabled();
    expect(within(dialog).getByText("без оценки")).toBeInTheDocument();
    // By default everything estimated is selected: two tasks over five days.
    expect(within(dialog).getByText("2 работы · 5 дней")).toBeInTheDocument();

    // Unticking one line: the count and the button are recomputed.
    await userEvent.click(
      within(dialog).getByRole("checkbox", { name: "Перенести «Гайдлайн»" }),
    );
    expect(within(dialog).getByText("1 работа · 2 дня")).toBeInTheDocument();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Перенести 1 работу" }),
    );

    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "POST",
        path: "push-to-plan",
        body: { task_ids: ["pt1"] },
      }),
    );
    // The toast says what happened and offers two roads: look and undo. "Undo"
    // removes the very batch the server named.
    expect(
      await screen.findByText("1 работа добавлена в план"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Открыть диаграмму" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Отменить" }));
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "POST",
        path: "undo:b1",
        body: null,
      }),
    );
  });

  it("перенесённая строка помечена и ведёт к своей задаче на диаграмме", async () => {
    proposalFixtures({
      ...PROPOSAL,
      pushed_count: 1,
      pushable_count: 1,
      categories: [
        {
          ...PROPOSAL.categories[0],
          tasks: [
            { ...PROPOSAL.categories[0].tasks[0], plan_task_id: "t1" },
            PROPOSAL.categories[0].tasks[1],
          ],
        },
      ],
    });
    renderProject(undefined, { route: "/projects/p1/proposal" });
    await screen.findByText("Логотип");

    // The transfer button offers to transfer only what is new — by count, in both places.
    expect(
      screen.getAllByRole("button", { name: "Перенести 1 новую работу…" }),
    ).toHaveLength(2);

    await userEvent.click(
      screen.getByRole("link", {
        name: "«Логотип» уже в плане: открыть задачу",
      }),
    );
    // The chart opened with that very task's card, the address parameter removed.
    expect(
      await screen.findByRole("complementary", { name: /Логотип/ }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1"),
    );
    expect(screen.getByTestId("location")).not.toHaveTextContent("task=");
  });

  it("когда всё уже в плане, вместо переноса предлагается диаграмма", async () => {
    proposalFixtures({ ...PROPOSAL, pushed_count: 2, pushable_count: 0 });
    renderProject(undefined, { route: "/projects/p1/proposal" });
    await screen.findByText("Логотип");

    expect(
      screen.getByRole("link", { name: "Открыть диаграмму" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Перенести/ }),
    ).not.toBeInTheDocument();
  });

  it("клиенту вкладка не показывается, а адрес сметы уводит на диаграмму", async () => {
    proposalFixtures();
    renderProject(undefined, {
      role: "client",
      route: "/projects/p1/proposal",
    });

    // The chart opened instead of the quote: the server does not give a client
    // the quote, and nobody needs a road to a certain refusal.
    expect(
      await screen.findByRole("link", { name: "Диаграмма" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Предложение" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("complementary", { name: "Итоги предложения" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1");
  });

  it("документ для клиента — ссылка с download на PDF предложения", async () => {
    proposalFixtures();
    renderProject(undefined, { route: "/projects/p1/proposal" });
    await screen.findByText("Логотип");

    const link = screen.getByRole("link", { name: "Скачать PDF для клиента" });
    // The language is the one the proposal is being looked at in: the document will arrive in it too.
    expect(link).toHaveAttribute(
      "href",
      "/api/projects/p1/proposal/export.pdf?locale=ru",
    );
    // The browser saves the file itself, under the name from the server's response.
    expect(link).toHaveAttribute("download");
    // Before agreement the document is the primary button, the transfer into the
    // plan stays next to it, a quiet button of the same block.
    expect(link).toHaveClass("proposal-summary__pdf");
    const next = screen.getByRole("region", { name: "Дальше" });
    expect(
      within(next).getByRole("button", { name: "Перенести в план…" }),
    ).toHaveClass("button--quiet");
  });

  it("после согласования документ уходит в тихий вид, главной остаётся кнопка переноса", async () => {
    proposalFixtures({
      ...PROPOSAL,
      status: "agreed",
      sent_at: "2026-08-27T10:00:00+00:00",
      agreed_at: "2026-09-02T10:00:00+00:00",
    });
    renderProject(undefined, { route: "/projects/p1/proposal" });
    await screen.findByText("Логотип");

    // The document has already gone and been agreed: the only step left is the
    // transfer, and the one filled button in the "Next" block must be it.
    const next = screen.getByRole("region", { name: "Дальше" });
    expect(
      within(next).getByRole("link", { name: "Скачать PDF для клиента" }),
    ).not.toHaveClass("proposal-summary__pdf");
    expect(
      within(next).getByRole("button", { name: "Перенести в план…" }),
    ).toHaveClass("button--primary");
  });

  it("читателю смета видна, а правка — нет", async () => {
    proposalFixtures();
    renderProject(undefined, {
      canWrite: false,
      route: "/projects/p1/proposal",
    });

    // For a reader the name is still a button that opens the card: a click on it
    // cannot be an edit, while the card is open for them to read too.
    expect(
      await screen.findByRole("button", { name: /Логотип/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Перенести в план…" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Новая работа" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Новый раздел" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Править примечания" }),
    ).not.toBeInTheDocument();
    // There are no edit or delete signs on the rows at all: the right to read
    // does not give the right to change.
    expect(
      screen.queryByRole("button", { name: "Править работу «Логотип»" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Удалить работу «Логотип»" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Править раздел «Дизайн»" }),
    ).not.toBeInTheDocument();

    // A section's description is text, not a field: a click on it opens nothing.
    expect(screen.getByText("Понять и нарисовать")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Понять и нарисовать"));
    expect(
      screen.queryByLabelText("Описание раздела «Дизайн»"),
    ).not.toBeInTheDocument();
    // There are no creation rows, the stage bar has no buttons, the parameters are disabled.
    expect(
      screen.queryByRole("button", { name: "Добавить работу в «Дизайн»" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Отметить отправленным" }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Параметры предложения" }),
    );
    expect(screen.getByLabelText("Налог, %")).toBeDisabled();
  });
});

describe("пустая смета", () => {
  beforeEach(() => {
    projectFixtures();
  });

  it("объясняет назначение, предлагает два старта и собирается из плана одной кнопкой", async () => {
    // The server gives an empty quote until it is assembled and a full one after:
    // a refetch after assembly must show the table rather than the previous emptiness.
    let state = EMPTY;
    const sent = proposalFixtures(EMPTY);
    server.use(
      http.get("/api/projects/p1/proposal", () => HttpResponse.json(state)),
      http.post("/api/projects/p1/proposal/build-from-plan", () => {
        sent.push({ method: "POST", path: "build-from-plan", body: null });
        state = PROPOSAL;
        return HttpResponse.json(
          { created_categories: 1, created_tasks: 2 },
          { status: 201 },
        );
      }),
    );
    renderProject(undefined, { route: "/projects/p1/proposal" });

    expect(
      await screen.findByRole("heading", { name: "Смета проекта до плана" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Новый раздел/ }),
    ).toBeInTheDocument();
    const build = screen.getByRole("button", { name: /Собрать из плана/ });
    expect(build).toBeEnabled();
    // The plan's counters are in the card's caption, inflected by number.
    expect(build).toHaveTextContent("В плане 3 задачи в 2 категориях");
    // The parameters use the same popover button as the table's toolbar.
    expect(
      screen.getByRole("button", { name: "Параметры предложения" }),
    ).toHaveTextContent("Дни · Налог 10 % · USD");
    // Neither a table nor totals: zeros in the card would answer a question nobody asked.
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("complementary", { name: "Итоги предложения" }),
    ).not.toBeInTheDocument();

    await userEvent.click(build);

    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "POST",
        path: "build-from-plan",
        body: null,
      }),
    );
    // An assembled quote is already a table with totals.
    expect(await screen.findByText("Логотип")).toBeInTheDocument();
    expect(
      screen.getByRole("complementary", { name: "Итоги предложения" }),
    ).toBeInTheDocument();
  });

  it("при пустом плане карточка сборки приглушена и объясняет почему", async () => {
    proposalFixtures({ ...EMPTY, plan_facts: { tasks: 0, categories: 0 } });
    renderProject(undefined, { route: "/projects/p1/proposal" });

    const build = await screen.findByRole("button", {
      name: /Собрать из плана/,
    });
    expect(build).toBeDisabled();
    expect(build).toHaveTextContent("В плане пока нет задач");
    // The second start is open: a section is created by hand whatever the plan.
    expect(screen.getByRole("button", { name: /Новый раздел/ })).toBeEnabled();
  });

  it("«Новый раздел» открывает окно раздела, кнопка параметров — поповер сметы", async () => {
    const sent = proposalFixtures(EMPTY);
    renderProject(undefined, { route: "/projects/p1/proposal" });

    await userEvent.click(
      await screen.findByRole("button", { name: /Новый раздел/ }),
    );
    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByLabelText("Название")).toBeInTheDocument();
    await userEvent.click(
      within(modal).getByRole("button", { name: "Отмена" }),
    );

    // The same fields as in the table's toolbar, and the same way of saving.
    await userEvent.click(
      screen.getByRole("button", { name: "Параметры предложения" }),
    );
    const tax = screen.getByLabelText("Налог, %");
    await userEvent.clear(tax);
    await userEvent.type(tax, "5");
    await userEvent.tab();
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "PATCH",
        path: "proposal",
        body: { tax_rate_pct: 5 },
      }),
    );
  });

  it("читателю старты не предлагаются, а параметры видны", async () => {
    proposalFixtures(EMPTY);
    renderProject(undefined, {
      canWrite: false,
      route: "/projects/p1/proposal",
    });

    expect(
      await screen.findByRole("heading", { name: "Смета проекта до плана" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Собрать из плана/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Новый раздел/ }),
    ).not.toBeInTheDocument();
    // The parameters are visible to a reader too: they are entitled to know what
    // the quote is counted in — but the fields inside the popover are disabled for them.
    await userEvent.click(
      screen.getByRole("button", { name: "Параметры предложения" }),
    );
    expect(screen.getByLabelText("Налог, %")).toBeDisabled();
  });
});
