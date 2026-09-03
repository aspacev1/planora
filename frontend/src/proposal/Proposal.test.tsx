import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import type { ProposalState, PushPreview } from "../api/proposal";
import { projectFixtures, renderProject } from "../test/project";
import { server } from "../test/server";

/**
 * Смета с двумя строками: 2д × 100 и 3д × 200 — сумма 800, налог 10% — 80,
 * итого 880, объём 5 дней и 40 часов (по восьмичасовому дню). Числа выбраны
 * так, чтобы каждая строка итогов отличалась от любой другой: совпадение
 * двух сумм позволило бы тесту зеленеть на перепутанных строках.
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
 * Деньги — тем же Intl, что и экран: точная строка зависит от ICU среды.
 *
 * Неразрывный пробел приводится к обычному: getByText нормализует пробелы в
 * тексте элемента, но не в искомой строке, и «600,00 $» с U+00A0 не находил
 * бы сам себя.
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
 * Предпросмотр переноса: «Дизайн» ляжет в одноимённую категорию плана, две
 * строки оценены, третья («Анимации») без оценки и по умолчанию не идёт.
 */
const PREVIEW: PushPreview = {
  categories: [
    {
      id: "pc1",
      name: "Дизайн",
      plan_category: { id: "c1", name: "Дизайн" },
      tasks: [
        { id: "pt1", name: "Логотип", duration_days: 2, in_plan: false, estimated: true },
        { id: "pt2", name: "Гайдлайн", duration_days: 3, in_plan: false, estimated: true },
        { id: "pt3", name: "Анимации", duration_days: 1, in_plan: false, estimated: false },
      ],
    },
  ],
};

function proposalFixtures(state: ProposalState = PROPOSAL, preview: PushPreview = PREVIEW) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  server.use(
    http.get("/api/projects/p1/proposal", () => HttpResponse.json(state)),
    http.get("/api/projects/p1/proposal/push-plan", () => HttpResponse.json(preview)),
    http.post("/api/projects/p1/proposal/stage", async ({ request }) => {
      sent.push({ method: "POST", path: "stage", body: await request.json() });
      return HttpResponse.json(state);
    }),
    http.post("/api/projects/p1/batches/:batchId/undo", ({ params }) => {
      sent.push({ method: "POST", path: `undo:${params.batchId as string}`, body: null });
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
      sent.push({ method: "POST", path: "categories", body: await request.json() });
      return HttpResponse.json({ id: "pc-new", name: "Ещё", position: 1 }, { status: 201 });
    }),
    http.patch("/api/projects/p1/proposal/tasks/:taskId", async ({ request, params }) => {
      sent.push({
        method: "PATCH",
        path: `task:${params.taskId as string}`,
        body: await request.json(),
      });
      return HttpResponse.json(state);
    }),
    http.patch("/api/projects/p1/proposal", async ({ request }) => {
      sent.push({ method: "PATCH", path: "proposal", body: await request.json() });
      return HttpResponse.json(state);
    }),
    http.patch("/api/projects/p1/proposal/categories/:categoryId", async ({ request, params }) => {
      sent.push({
        method: "PATCH",
        path: `category:${params.categoryId as string}`,
        body: await request.json(),
      });
      return HttpResponse.json({ id: params.categoryId, name: "Дизайн", position: 0 });
    }),
    http.delete("/api/projects/p1/proposal/tasks/:taskId", ({ params }) => {
      sent.push({ method: "DELETE", path: `task:${params.taskId as string}`, body: null });
      return new HttpResponse(null, { status: 204 });
    }),
    http.delete("/api/projects/p1/proposal/categories/:categoryId", ({ params }) => {
      sent.push({
        method: "DELETE",
        path: `category:${params.categoryId as string}`,
        body: null,
      });
      return new HttpResponse(null, { status: 204 });
    }),
    http.post("/api/projects/p1/proposal/push-to-plan", async ({ request }) => {
      const body = (await request.json()) as { task_ids: string[] };
      sent.push({ method: "POST", path: "push-to-plan", body });
      return HttpResponse.json(
        { created_tasks: body.task_ids.length, batch_id: "b1" },
        { status: 201 },
      );
    }),
  );
  return sent;
}

/** Открыть ячейку строки на правку: щелчок по значению, как в ленте. */
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

    // Строка работы: роль, оценка в днях и рядом часы, ставка и цена без
    // валюты — она названа в шапке колонки. У «Гайдлайна» цена 600 не
    // совпадает ни с одной ставкой — совпавшая строка прятала бы ошибку.
    expect(await screen.findByText("Логотип")).toBeInTheDocument();
    expect(screen.getByText("Знак")).toBeInTheDocument();
    expect(screen.getByText("Дизайнер")).toBeInTheDocument();
    expect(screen.getByText("2д")).toBeInTheDocument();
    expect(screen.getByText("16ч")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("600")).toBeInTheDocument();
    expect(screen.getByText("Ставка, USD/д")).toBeInTheDocument();
    // Пустая роль подсказывает, что в неё пишут, а не молчит прочерком.
    expect(screen.getByText("роль")).toBeInTheDocument();
    // Параметры сложены в поповер, но подпись кнопки говорит главное.
    expect(screen.getByRole("button", { name: "Параметры предложения" })).toHaveTextContent(
      "Дни · Налог 10 % · USD",
    );

    // Строка раздела — сводка своих работ и описание.
    expect(screen.getByText("Понять и нарисовать")).toBeInTheDocument();

    const summary = screen.getByRole("complementary", { name: "Итоги предложения" });
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
    // Сводка раздела на месте: свёрнутый раздел — строка с суммой, не дыра.
    expect(screen.getByText("Дизайн")).toBeInTheDocument();
    expect(screen.getAllByText(money(800)).length).toBeGreaterThan(0);
  });

  it("знак «править» на строке открывает карточку с подробностями и обсуждением", async () => {
    proposalFixtures();
    renderProject(undefined, { route: "/projects/p1/proposal" });

    await userEvent.click(
      await screen.findByRole("button", { name: "Править работу «Логотип»" }),
    );
    const panel = await screen.findByRole("complementary", { name: /Логотип/ });

    expect(within(panel).getByLabelText("Подробное описание")).toHaveValue("Три варианта");
    expect(within(panel).getByLabelText("Заметки")).toHaveValue("Шрифт покупает клиент");
    expect(within(panel).getByLabelText("Риски")).toHaveValue("Правки затянутся");
    expect(within(panel).getByLabelText("Допущения")).toHaveValue("Брендбук уже есть");
    expect(await within(panel).findByText("Ставку согласовали")).toBeInTheDocument();
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

    // Имя.
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

    // Описание: пустое — тоже значение, описание стирают.
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

    // Роль — тоже ячейка: пустую подсказывает, заполненную правит.
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

    // Оценка — в единице сметы; часы рядом только для сверки.
    await openCell("2д");
    const effort = screen.getByLabelText("Изменить: Оценка у «Логотип»");
    await userEvent.clear(effort);
    await userEvent.type(effort, "4{Enter}");
    await waitFor(() =>
      expect(sent).toContainEqual({ method: "PATCH", path: "task:pt1", body: { effort: 4 } }),
    );

    // Ставка.
    await openCell("100");
    const rate = screen.getByLabelText("Изменить: Ставка у «Логотип»");
    await userEvent.clear(rate);
    await userEvent.type(rate, "150{Enter}");
    await waitFor(() =>
      expect(sent).toContainEqual({ method: "PATCH", path: "task:pt1", body: { rate: 150 } }),
    );

    // Цена — произведение, и правка её меняет ставку: 900 за три дня «Гайдлайна»
    // это 300 за день.
    await openCell("600");
    const price = screen.getByLabelText("Изменить: Цена у «Гайдлайн»");
    await userEvent.clear(price);
    await userEvent.type(price, "900{Enter}");
    await waitFor(() =>
      expect(sent).toContainEqual({ method: "PATCH", path: "task:pt2", body: { rate: 300 } }),
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
    // Сначала — что именно сломается, и только потом само действие.
    expect(
      screen.getByText("Работа «Логотип» удалится вместе с обсуждением"),
    ).toBeInTheDocument();
    expect(sent).not.toContainEqual({ method: "DELETE", path: "task:pt1", body: null });

    await userEvent.click(screen.getByRole("button", { name: "Удалить работу" }));
    await waitFor(() =>
      expect(sent).toContainEqual({ method: "DELETE", path: "task:pt1", body: null }),
    );

    // Тот же крестик и на строке раздела — со своим предупреждением: раздел
    // уносит с собой все работы.
    await userEvent.click(screen.getByRole("button", { name: "Удалить раздел «Дизайн»" }));
    await userEvent.click(screen.getByRole("button", { name: "Удалить раздел" }));
    await waitFor(() =>
      expect(sent).toContainEqual({ method: "DELETE", path: "category:pc1", body: null }),
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
    await userEvent.type(within(modal).getByLabelText("Описание"), "Смыслы и картинки");
    await userEvent.click(within(modal).getByRole("button", { name: "Сохранить" }));

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

    // «Добавить работу» в конце раздела открывает строку ввода — как в ленте.
    await userEvent.click(screen.getByRole("button", { name: "Добавить работу в «Дизайн»" }));
    const input = screen.getByLabelText("Новая работа в «Дизайн»");
    await userEvent.type(input, "Вёрстка{Enter}");

    // Одного имени по-прежнему достаточно — и уезжает только оно.
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "POST",
        path: "tasks:pc1",
        body: { name: "Вёрстка" },
      }),
    );
    // Enter не закрывает строку: следующую работу пишут сразу.
    expect(screen.getByLabelText("Новая работа в «Дизайн»")).toHaveValue("");

    // Роль подсказывается из справочника организации и тянет за собой ставку.
    await userEvent.type(screen.getByLabelText("Новая работа в «Дизайн»"), "Макет");
    await userEvent.type(screen.getByLabelText("Роль новой работы"), "диз");
    await userEvent.click(await screen.findByRole("option", { name: /Дизайнер/ }));
    expect(screen.getByLabelText("Ставка новой работы, USD/д")).toHaveValue(100);
    await userEvent.type(screen.getByLabelText("Оценка новой работы, д"), "3{Enter}");

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

    // Пройденный этап подписан датой, текущий назван, следующий — кнопкой.
    const stages = screen.getByRole("list", { name: "Этапы предложения" });
    expect(within(stages).getByText("27 авг")).toBeInTheDocument();
    expect(within(stages).getByText("Отправлено").closest("[aria-current]")).toHaveAttribute(
      "aria-current",
      "step",
    );
    await userEvent.click(screen.getByRole("button", { name: "Отметить согласованным" }));
    await waitFor(() =>
      expect(sent).toContainEqual({ method: "POST", path: "stage", body: { stage: "agreed" } }),
    );

    // Назад — щелчком по пройденному этапу.
    await userEvent.click(screen.getByRole("button", { name: "Вернуть на этап «Черновик»" }));
    await waitFor(() =>
      expect(sent).toContainEqual({ method: "POST", path: "stage", body: { stage: "draft" } }),
    );
  });

  it("согласованное предложение зовёт в план прямо с полосы этапов", async () => {
    proposalFixtures({
      ...PROPOSAL,
      status: "agreed",
      sent_at: "2026-08-27T10:00:00+00:00",
      agreed_at: "2026-09-02T10:00:00+00:00",
    });
    renderProject(undefined, { route: "/projects/p1/proposal" });
    await screen.findByText("Логотип");

    const stages = screen.getByRole("list", { name: "Этапы предложения" });
    await userEvent.click(within(stages).getByRole("button", { name: "Перенести в план" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("параметры правятся в поповере и уходят на сервер по одному", async () => {
    const sent = proposalFixtures();
    renderProject(undefined, { route: "/projects/p1/proposal" });
    await screen.findByText("Логотип");

    await userEvent.click(screen.getByRole("button", { name: "Параметры предложения" }));
    // Число уходит на сервер с каждым нажатием, как и всякое число в полях
    // автосохранения, — поэтому одна цифра: заглушка сервера не запоминает
    // правку, и вторая цифра легла бы поверх возвращённого старого значения.
    const tax = screen.getByLabelText("Налог, %");
    await userEvent.clear(tax);
    await userEvent.type(tax, "5");
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
    await userEvent.type(within(modal).getByLabelText("Название"), "Разработка");
    await userEvent.type(within(modal).getByLabelText("Описание"), "Собрать приложение");
    await userEvent.click(within(modal).getByRole("button", { name: "Создать" }));

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

    // Пункт на строку — списком.
    expect(screen.getByText("Оценки по текущему объёму.")).toBeInTheDocument();
    expect(screen.getByText("Ставки без стоимости лицензий.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Править примечания" }));
    // Роль сужает поиск: той же подписью подписана и сама карточка примечаний.
    const editor = screen.getByRole("textbox", { name: "Допущения и примечания" });
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

    await userEvent.click(screen.getByRole("button", { name: "Добавить в план" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Перенести предложение в план")).toBeInTheDocument();
    // Раздел найдёт свою категорию плана, а не заведёт вторую.
    expect(within(dialog).getByText("в категорию «Дизайн»")).toBeInTheDocument();
    // Строка без оценки выключена и названа: спрятанную искали бы.
    const blank = within(dialog).getByRole("checkbox", { name: "Перенести «Анимации»" });
    expect(blank).toBeDisabled();
    expect(within(dialog).getByText("без оценки")).toBeInTheDocument();
    // По умолчанию выбрано всё оценённое: две задачи на пять дней.
    expect(within(dialog).getByText("2 задачи · 5 дней")).toBeInTheDocument();

    // Снять галочку с одной строки: счёт и кнопка пересчитываются.
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Перенести «Гайдлайн»" }));
    expect(within(dialog).getByText("1 задача · 2 дня")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Перенести 1 задачу" }));

    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "POST",
        path: "push-to-plan",
        body: { task_ids: ["pt1"] },
      }),
    );
    // Тост говорит, что случилось, и предлагает две дороги: посмотреть и
    // отменить. «Отменить» снимает ту самую пачку, что назвал сервер.
    expect(await screen.findByText("1 задача добавлена в план")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Открыть диаграмму" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Отменить" }));
    await waitFor(() =>
      expect(sent).toContainEqual({ method: "POST", path: "undo:b1", body: null }),
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

    // Главная кнопка зовёт перенести только новое — счётом.
    expect(screen.getByRole("button", { name: "Перенести 1 новую работу" })).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("link", { name: "«Логотип» уже в плане: открыть задачу" }),
    );
    // Диаграмма открылась с карточкой той самой задачи, параметр из адреса снят.
    expect(await screen.findByRole("complementary", { name: /Логотип/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1"));
    expect(screen.getByTestId("location")).not.toHaveTextContent("task=");
  });

  it("когда всё уже в плане, вместо переноса предлагается диаграмма", async () => {
    proposalFixtures({ ...PROPOSAL, pushed_count: 2, pushable_count: 0 });
    renderProject(undefined, { route: "/projects/p1/proposal" });
    await screen.findByText("Логотип");

    expect(screen.getByRole("link", { name: "Открыть диаграмму" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Добавить в план" })).not.toBeInTheDocument();
  });

  it("клиенту вкладка не показывается, а адрес сметы уводит на диаграмму", async () => {
    proposalFixtures();
    renderProject(undefined, { role: "client", route: "/projects/p1/proposal" });

    // Диаграмма открылась вместо сметы: сервер клиенту смету не отдаёт, и
    // дорога к заведомому отказу никому не нужна.
    expect(await screen.findByRole("link", { name: "Диаграмма" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Предложение" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Итоги предложения" })).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1");
  });

  it("читателю смета видна, а правка — нет", async () => {
    proposalFixtures();
    renderProject(undefined, { canWrite: false, route: "/projects/p1/proposal" });

    // Имя у читателя — по-прежнему кнопка, открывающая карточку: правкой
    // щелчок по нему быть не может, а карточка для чтения открыта и ему.
    expect(await screen.findByRole("button", { name: /Логотип/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Добавить в план" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Новая работа" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Новый раздел" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Править примечания" }),
    ).not.toBeInTheDocument();
    // Знаков правки и удаления на строках нет вовсе: право читать не даёт
    // права менять.
    expect(
      screen.queryByRole("button", { name: "Править работу «Логотип»" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Удалить работу «Логотип»" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Править раздел «Дизайн»" }),
    ).not.toBeInTheDocument();

    // Описание раздела — текстом, не полем: щелчок по нему ничего не открывает.
    expect(screen.getByText("Понять и нарисовать")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Понять и нарисовать"));
    expect(
      screen.queryByLabelText("Описание раздела «Дизайн»"),
    ).not.toBeInTheDocument();
    // Строк заведения нет, полоса этапов без кнопок, параметры выключены.
    expect(
      screen.queryByRole("button", { name: "Добавить работу в «Дизайн»" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Отметить отправленным" }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Параметры предложения" }));
    expect(screen.getByLabelText("Налог, %")).toBeDisabled();
  });
});
