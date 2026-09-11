import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import type { ProjectState } from "../api/projects";
import { APPROVED, APPROVED_WITH_EXTRA, projectFixtures, renderProject } from "../test/project";
import { server } from "../test/server";

beforeEach(projectFixtures);

/** The task travelled five days forward — a shift the panel must name. */
const MOVED: ProjectState = {
  ...APPROVED,
  tasks: [{ ...APPROVED.tasks[0], start_date: "2026-03-09", end_date: "2026-03-13" }],
};

/** The same task stretched from five days to eight, but not moved from its place. */
const STRETCHED: ProjectState = {
  ...APPROVED,
  tasks: [{ ...APPROVED.tasks[0], duration_days: 8, end_date: "2026-03-13" }],
};

/** A task that was moved and stretched in one motion of the left edge. */
const RESIZED: ProjectState = {
  ...APPROVED,
  tasks: [
    {
      ...APPROVED.tasks[0],
      start_date: "2026-03-09",
      end_date: "2026-03-18",
      duration_days: 8,
    },
  ],
};

/** The version chronicle: the snapshot knows a task that is no longer in the project. */
function withApprovals(snapshot: Record<string, unknown>) {
  server.use(
    http.get("/api/projects/p1/plan/approvals", () =>
      HttpResponse.json([
        {
          version: 1,
          approved_at: "2026-03-01T09:00:00+00:00",
          approved_by: { id: "u1", name: "Алексей" },
          snapshot,
        },
      ]),
    ),
  );
}

/** One journal entry with a reason — what the panel takes its "why" from. */
function withReason(op: Record<string, unknown>, reason: string, at = "2026-03-05T10:00:00+00:00") {
  server.use(
    http.get("/api/projects/p1/revisions", () =>
      HttpResponse.json([
        {
          seq: 7,
          created_at: at,
          actor: { id: "u1", name: "Алексей" },
          reason,
          batch_id: null,
          undoes_seq: null,
          op,
          names: { t1: "Логотип" },
        },
      ]),
    ),
  );
}

/** Open the list of changes the way a person opens it — from the header. */
async function openChanges(state: ProjectState = MOVED) {
  renderProject(state);
  await userEvent.click(await screen.findByRole("button", { name: /изменени/i }));
  return screen.findByRole("complementary", { name: "Изменения после v1" });
}

describe("панель изменений плана", () => {
  it("называет сдвиг парой «было → стало» и величиной", async () => {
    const dialog = await openChanges();

    // The pair of dates answers "what exactly moved", the badge answers "by how much". Apart,
    // neither answers either of these questions.
    expect(within(dialog).getByText("4 мар → 9 мар")).toBeInTheDocument();
    expect(within(dialog).getByText("+5 дн.")).toBeInTheDocument();
  });

  it("приближение к сроку не набирается цветом тревоги", async () => {
    const dialog = await openChanges({
      ...APPROVED,
      tasks: [{ ...APPROVED.tasks[0], start_date: "2026-03-02", end_date: "2026-03-06" }],
    });

    // Good news must look good: the badge has the same green as the "ahead" badge on a strip's bar.
    expect(within(dialog).getByText("−2 дн.")).toHaveClass("is-early");
  });

  it("растянутая задача попадает в свою группу, а не в сдвиги", async () => {
    const dialog = await openChanges(STRETCHED);

    expect(within(dialog).getByText("Длительность")).toBeInTheDocument();
    expect(within(dialog).queryByText("Сдвиги дат")).toBeNull();
    expect(within(dialog).getByText("5 дн. → 8 дн.")).toBeInTheDocument();
  });

  it("подвинутая и растянутая задача стоит в одной группе, но называет оба расхождения", async () => {
    const dialog = await openChanges(RESIZED);

    // The groups divide the tasks between themselves — otherwise the sum of the tags' captions
    // would diverge from the number on the chip. Passing over the second divergence will not do at
    // that: the motion is one, but two things moved for the task.
    expect(within(dialog).getByText("Сдвиги дат")).toBeInTheDocument();
    expect(within(dialog).queryByText("Длительность")).toBeNull();
    expect(within(dialog).getByText("4 мар → 9 мар")).toBeInTheDocument();
    expect(within(dialog).getByText("длительность: 5 дн. → 8 дн.")).toBeInTheDocument();
  });

  it("сумма групп сходится с общим счётом", async () => {
    const dialog = await openChanges({
      ...APPROVED_WITH_EXTRA,
      tasks: [
        { ...APPROVED.tasks[0], start_date: "2026-03-09", end_date: "2026-03-13" },
        ...APPROVED_WITH_EXTRA.tasks.slice(1),
      ],
    });

    // A person adding up the tags' captions must get the same number that is written on "All" and
    // on the chip in the header.
    expect(within(dialog).getByRole("button", { name: "Все · 2" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Сдвиги · 1" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Новые · 1" })).toBeInTheDocument();
  });

  it("работу сверх плана показывает отдельно: сравнивать её не с чем", async () => {
    const dialog = await openChanges(APPROVED_WITH_EXTRA);

    expect(within(dialog).getByText("Новые задачи · вне плана")).toBeInTheDocument();
    expect(within(dialog).getByText("вне плана")).toBeInTheDocument();
  });

  it("удалённую задачу знает по снимку версии — в состоянии её уже нет", async () => {
    withApprovals({
      t1: { name: "Логотип", start_date: "2026-03-04", duration_days: 5 },
      gone: { name: "Согласование бюджета", start_date: "2026-03-04", duration_days: 2 },
    });
    const dialog = await openChanges();

    expect(await within(dialog).findByText("Согласование бюджета")).toBeInTheDocument();
    expect(within(dialog).getByText("Удалённые задачи")).toBeInTheDocument();
  });

  it("показывает причину сдвига там, где о ней спрашивали", async () => {
    withReason(
      { type: "move_task", task_id: "t1", start_date: "2026-03-09" },
      "Ждали контент от клиента",
    );
    const dialog = await openChanges();

    // The reasons are already entered at a shift past the threshold — here they finally answer
    // "why" rather than only "what".
    expect(await within(dialog).findByText("Ждали контент от клиента")).toBeInTheDocument();
  });

  it("причина, названная до согласования, к расхождению не приписывается", async () => {
    // Earlier than the approval: this shift itself went into the baseline plan.
    withReason(
      { type: "move_task", task_id: "t1", start_date: "2026-03-04" },
      "Старое объяснение",
      "2026-02-20T10:00:00+00:00",
    );
    const dialog = await openChanges();

    await within(dialog).findByText("4 мар → 9 мар");
    expect(within(dialog).queryByText("Старое объяснение")).toBeNull();
  });

  it("фильтр по группе оставляет только её", async () => {
    const dialog = await openChanges({
      ...APPROVED_WITH_EXTRA,
      tasks: [
        { ...APPROVED.tasks[0], start_date: "2026-03-09", end_date: "2026-03-13" },
        ...APPROVED_WITH_EXTRA.tasks.slice(1),
      ],
    });

    expect(within(dialog).getByText("Новые задачи · вне плана")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Сдвиги · 1" }));

    expect(within(dialog).getByText("Сдвиги дат")).toBeInTheDocument();
    expect(within(dialog).queryByText("Новые задачи · вне плана")).toBeNull();
  });

  it("не накрывает ленту подложкой: список читают вместе с диаграммой", async () => {
    const dialog = await openChanges();

    // It is for this that the list did not become a dialog: a backdrop would dim the chart exactly
    // when the switch in the panel's header turns the plan's ghosts on in it.
    expect(screen.queryByTestId("modal-backdrop")).toBeNull();
    expect(within(dialog).getByText("4 мар → 9 мар")).toBeInTheDocument();
    expect(screen.getByTestId("ghost-t1")).toBeInTheDocument();
  });

  it("тумблер призрака включает тот же слой, что и флажок «Вид»", async () => {
    const dialog = await openChanges();

    // The list and the chart tell the same thing in two languages, and they must have one toggle:
    // two identical ones would diverge.
    expect(screen.getByTestId("ghost-t1")).toBeInTheDocument();
    await userEvent.click(
      within(dialog).getByRole("switch", { name: "Показывать утверждённый план на диаграмме" }),
    );

    expect(screen.queryByTestId("ghost-t1")).toBeNull();
  });

  it("имя задачи ведёт в её карточку, а окно уходит с дороги", async () => {
    const dialog = await openChanges();

    await userEvent.click(within(dialog).getByRole("button", { name: "Логотип" }));

    // Having seen a divergence, people go to fix that very task — and the way there must not run
    // through closing the panel and hunting for the row by eye. The card slides out into the same
    // place on the right, so the list gives that place up to it.
    expect(await screen.findByRole("complementary", { name: "Задача «Логотип»" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Изменения после v1" })).toBeNull();
  });

  it("задача, чья карточка уже открыта, из списка не закрывается, а показывается", async () => {
    renderProject(MOVED);
    // The card was opened by a click on the bar — and stays when the list is opened.
    await userEvent.click(await screen.findByRole("button", { name: /Логотип/ }));
    await screen.findByRole("complementary", { name: "Задача «Логотип»" });
    // The header's button — not the identically named link inside the task's card.
    const header = screen.getByRole("button", { name: /Логотип/ }).closest("main") as HTMLElement;
    const openers = within(header)
      .getAllByRole("button", { name: /изменени/i })
      .filter((node) => node.closest("[role=complementary]") === null);
    await userEvent.click(openers[0]);
    const dialog = await screen.findByRole("complementary", { name: "Изменения после v1" });

    await userEvent.click(within(dialog).getByRole("button", { name: "Логотип" }));

    // "A repeat click closes" is a strip row's rule; a choice from the list is a request to show,
    // and the card must stay on screen.
    expect(await screen.findByRole("complementary", { name: "Задача «Логотип»" })).toBeInTheDocument();
  });

  it("закрывается крестиком", async () => {
    const dialog = await openChanges();

    await userEvent.click(within(dialog).getByRole("button", { name: "Закрыть" }));

    expect(screen.queryByRole("complementary", { name: "Изменения после v1" })).toBeNull();
  });

  it("переутверждение отсюда ведёт к тому же вопросу, что и кнопка в шапке", async () => {
    const dialog = await openChanges();

    await userEvent.click(within(dialog).getByRole("button", { name: "Переутвердить…" }));

    // It does not re-approve silently: an action has one confirmation, and a second one created for
    // the sake of a second button would diverge from the first.
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Изменения после v1" })).toBeNull(),
    );
    expect(
      await screen.findByText("Переутвердить план как v2?"),
    ).toBeInTheDocument();
  });

  it("не владельцу переутверждения не предлагает вовсе", async () => {
    renderProject(MOVED, { canWrite: false });
    await userEvent.click(await screen.findByRole("button", { name: /изменени/i }));

    const dialog = await screen.findByRole("complementary", { name: "Изменения после v1" });
    expect(within(dialog).queryByRole("button", { name: /Переутвердить/ })).toBeNull();
  });

  it("отказ журнала и летописи окно не ломает", async () => {
    // A role without the right to the journal gets a refusal, and the divergence list is none the
    // worse for it: the reasons and the deleted are an addition rather than the basis.
    server.use(
      http.get("/api/projects/p1/revisions", () => new HttpResponse(null, { status: 403 })),
      http.get("/api/projects/p1/plan/approvals", () => new HttpResponse(null, { status: 403 })),
    );
    const dialog = await openChanges();

    expect(within(dialog).getByText("4 мар → 9 мар")).toBeInTheDocument();
  });
});

describe("подтверждение переутверждения", () => {
  it("называет число и перечисляет виды того, что станет новой базой", async () => {
    renderProject({
      ...APPROVED_WITH_EXTRA,
      tasks: [
        { ...APPROVED.tasks[0], start_date: "2026-03-09", end_date: "2026-03-13" },
        ...APPROVED_WITH_EXTRA.tasks.slice(1),
      ],
    });

    await userEvent.click(await screen.findByRole("button", { name: "Пересогласовать" }));

    // The question used to warn about the consequence but name neither its size nor its kind: five
    // moved tasks and five added ones are different news.
    expect(await screen.findByText("Переутвердить план как v2?")).toBeInTheDocument();
    expect(
      screen.getByText(/Будут зафиксированы 2 изменения: 1 сдвиг, 1 новая задача\./),
    ).toBeInTheDocument();
  });

  it("из подтверждения можно посмотреть, что именно фиксируется", async () => {
    renderProject(MOVED);

    await userEvent.click(await screen.findByRole("button", { name: "Пересогласовать" }));
    await userEvent.click(screen.getByRole("button", { name: "Посмотреть изменения" }));

    const dialog = await screen.findByRole("complementary", { name: "Изменения после v1" });
    expect(within(dialog).getByText("4 мар → 9 мар")).toBeInTheDocument();
  });

  it("подтверждение доводит переутверждение до сервера", async () => {
    const approvals: number[] = [];
    server.use(
      http.post("/api/projects/p1/plan/approvals", () => {
        approvals.push(1);
        return HttpResponse.json(
          { version: 2, approved_at: "2026-03-10T09:00:00+00:00" },
          { status: 201 },
        );
      }),
    );
    renderProject(MOVED);

    await userEvent.click(await screen.findByRole("button", { name: "Пересогласовать" }));
    await userEvent.click(screen.getByRole("button", { name: "Да, пересогласовать" }));

    await waitFor(() => expect(approvals).toHaveLength(1));
  });
});
