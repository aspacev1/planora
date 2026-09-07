import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import type { ProjectState } from "../api/projects";
import { APPROVED, APPROVED_WITH_EXTRA, projectFixtures, renderProject } from "../test/project";
import { server } from "../test/server";

beforeEach(projectFixtures);

/** Задача уехала на пять дней вперёд — сдвиг, который окно обязано назвать. */
const MOVED: ProjectState = {
  ...APPROVED,
  tasks: [{ ...APPROVED.tasks[0], start_date: "2026-03-09", end_date: "2026-03-13" }],
};

/** Та же задача, растянутая с пяти дней до восьми, но с места не сдвинутая. */
const STRETCHED: ProjectState = {
  ...APPROVED,
  tasks: [{ ...APPROVED.tasks[0], duration_days: 8, end_date: "2026-03-13" }],
};

/** Задача, которую подвинули и растянули одним движением левой грани. */
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

/** Летопись версий: снимок знает задачу, которой в проекте уже нет. */
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

/** Одна запись журнала с причиной — то, из чего окно берёт «почему». */
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

/** Открыть список изменений так, как его открывает человек, — из шапки. */
async function openChanges(state: ProjectState = MOVED) {
  renderProject(state);
  await userEvent.click(await screen.findByRole("button", { name: /изменени/i }));
  return screen.findByRole("complementary", { name: "Изменения после v1" });
}

describe("панель изменений плана", () => {
  it("называет сдвиг парой «было → стало» и величиной", async () => {
    const dialog = await openChanges();

    // Пара дат отвечает на «что именно поехало», бейдж — на «насколько».
    // Порознь ни то ни другое не отвечает ни на один из этих вопросов.
    expect(within(dialog).getByText("4 мар → 9 мар")).toBeInTheDocument();
    expect(within(dialog).getByText("+5 дн.")).toBeInTheDocument();
  });

  it("приближение к сроку не набирается цветом тревоги", async () => {
    const dialog = await openChanges({
      ...APPROVED,
      tasks: [{ ...APPROVED.tasks[0], start_date: "2026-03-02", end_date: "2026-03-06" }],
    });

    // Хорошая новость обязана выглядеть хорошей: у бейджа тот же зелёный, что
    // и у бейджа приближения на полоске ленты.
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

    // Группы делят задачи между собой — иначе сумма подписей тегов разошлась бы
    // с числом на чипе. Умолчать о втором расхождении при этом нельзя: движение
    // одно, а поехало у задачи двое.
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

    // Человек, складывающий подписи тегов, обязан получать то же число, что
    // написано на «Все» и на чипе в шапке.
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

    // Причины уже вводят при сдвиге за порог — здесь они наконец отвечают на
    // «почему», а не только на «что».
    expect(await within(dialog).findByText("Ждали контент от клиента")).toBeInTheDocument();
  });

  it("причина, названная до согласования, к расхождению не приписывается", async () => {
    // Раньше согласования: этот сдвиг сам вошёл в базовый план.
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

    // Ради этого список и не стал окном: подложка гасила бы диаграмму ровно
    // тогда, когда рубильник в шапке панели включает на ней призраки плана.
    expect(screen.queryByTestId("modal-backdrop")).toBeNull();
    expect(within(dialog).getByText("4 мар → 9 мар")).toBeInTheDocument();
    expect(screen.getByTestId("ghost-t1")).toBeInTheDocument();
  });

  it("тумблер призрака включает тот же слой, что и флажок «Вид»", async () => {
    const dialog = await openChanges();

    // Список и диаграмма рассказывают одно и то же двумя языками, и
    // переключатель у них обязан быть один: два одинаковых разошлись бы.
    expect(screen.getByTestId("ghost-t1")).toBeInTheDocument();
    await userEvent.click(
      within(dialog).getByRole("switch", { name: "Показывать утверждённый план на диаграмме" }),
    );

    expect(screen.queryByTestId("ghost-t1")).toBeNull();
  });

  it("имя задачи ведёт в её карточку, а окно уходит с дороги", async () => {
    const dialog = await openChanges();

    await userEvent.click(within(dialog).getByRole("button", { name: "Логотип" }));

    // Увидев расхождение, идут чинить именно эту задачу — и путь туда не должен
    // проходить через закрытие панели и поиск строки глазами. Карточка выезжает
    // на то же место справа, поэтому список ей это место уступает.
    expect(await screen.findByRole("complementary", { name: "Задача «Логотип»" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Изменения после v1" })).toBeNull();
  });

  it("задача, чья карточка уже открыта, из списка не закрывается, а показывается", async () => {
    renderProject(MOVED);
    // Карточка открыта щелчком по полоске — и остаётся, когда открывают список.
    await userEvent.click(await screen.findByRole("button", { name: /Логотип/ }));
    await screen.findByRole("complementary", { name: "Задача «Логотип»" });
    // Кнопка шапки — не одноимённая ссылка внутри карточки задачи.
    const header = screen.getByRole("button", { name: /Логотип/ }).closest("main") as HTMLElement;
    const openers = within(header)
      .getAllByRole("button", { name: /изменени/i })
      .filter((node) => node.closest("[role=complementary]") === null);
    await userEvent.click(openers[0]);
    const dialog = await screen.findByRole("complementary", { name: "Изменения после v1" });

    await userEvent.click(within(dialog).getByRole("button", { name: "Логотип" }));

    // «Повторный щелчок закрывает» — правило строки ленты; выбор из списка —
    // просьба показать, и карточка обязана остаться на экране.
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

    // Не переутверждает молча: подтверждение у действия одно, и второе,
    // заведённое ради второй кнопки, разошлось бы с первым.
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
    // Роль без права на журнал получает отказ, и список расхождений от этого
    // не портится: причины и удалённые — добавка, а не основа.
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

    // Прежде вопрос предупреждал о последствии, но не называл ни размера, ни
    // рода: пять перенесённых задач и пять дописанных — разные новости.
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
