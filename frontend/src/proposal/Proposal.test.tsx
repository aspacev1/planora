import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import type { ProposalState } from "../api/proposal";
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

function proposalFixtures(state: ProposalState = PROPOSAL) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  server.use(
    http.get("/api/projects/p1/proposal", () => HttpResponse.json(state)),
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
    http.post("/api/projects/p1/proposal/push-to-plan", () => {
      sent.push({ method: "POST", path: "push-to-plan", body: null });
      return HttpResponse.json({ created_tasks: 2 }, { status: 201 });
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

    // Строка работы: роль в карточке, а в таблице — оценка в днях и часах,
    // ставка за день и цена. У «Гайдлайна» цена 600 не совпадает ни с одной
    // ставкой — совпавшая строка прятала бы ошибку.
    expect(await screen.findByText("Логотип")).toBeInTheDocument();
    expect(screen.getByText("Знак")).toBeInTheDocument();
    expect(screen.getByText("2д")).toBeInTheDocument();
    expect(screen.getByText("16ч")).toBeInTheDocument();
    expect(screen.getByText(`${money(100)}/д`)).toBeInTheDocument();
    expect(screen.getByText(money(600))).toBeInTheDocument();

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

    // Оценка в днях — в единицах сметы она же и есть.
    await openCell("2д");
    const effort = screen.getByLabelText("Изменить: Оценка у «Логотип»");
    await userEvent.clear(effort);
    await userEvent.type(effort, "4{Enter}");
    await waitFor(() =>
      expect(sent).toContainEqual({ method: "PATCH", path: "task:pt1", body: { effort: 4 } }),
    );

    // Часы правятся своей колонкой и переводятся обратно в дни сметы: 24 часа
    // при восьмичасовом дне — три дня.
    await openCell("16ч");
    const hours = screen.getByLabelText("Изменить: Часы у «Логотип»");
    await userEvent.clear(hours);
    await userEvent.type(hours, "24{Enter}");
    await waitFor(() =>
      expect(sent).toContainEqual({ method: "PATCH", path: "task:pt1", body: { effort: 3 } }),
    );

    // Ставка.
    await openCell(`${money(100)}/д`);
    const rate = screen.getByLabelText("Изменить: Ставка у «Логотип»");
    await userEvent.clear(rate);
    await userEvent.type(rate, "150{Enter}");
    await waitFor(() =>
      expect(sent).toContainEqual({ method: "PATCH", path: "task:pt1", body: { rate: 150 } }),
    );

    // Цена — произведение, и правка её меняет ставку: 900 за три дня «Гайдлайна»
    // это 300 за день.
    await openCell(money(600));
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

  it("работа заводится строкой в таблице: Enter отправляет и оставляет поле", async () => {
    const sent = proposalFixtures();
    renderProject(undefined, { route: "/projects/p1/proposal" });
    await screen.findByText("Логотип");

    // Кнопка тулбара открывает строку в первом разделе — как в ленте.
    await userEvent.click(screen.getByRole("button", { name: "Новая работа" }));
    const input = screen.getByLabelText("Новая работа в «Дизайн»");
    await userEvent.type(input, "Вёрстка{Enter}");

    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "POST",
        path: "tasks:pc1",
        body: { name: "Вёрстка" },
      }),
    );
    // Enter не закрывает строку: следующую работу пишут сразу.
    expect(screen.getByLabelText("Новая работа в «Дизайн»")).toHaveValue("");

    // «Плюс» на строке раздела открывает ту же строку в этом разделе.
    await userEvent.click(screen.getByRole("button", { name: "Добавить работу в «Дизайн»" }));
    expect(screen.getByLabelText("Новая работа в «Дизайн»")).toBeInTheDocument();
  });

  it("раздел заводится окном из тулбара — как категория в ленте", async () => {
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

  it("кнопка переноса отдаёт смету в план", async () => {
    const sent = proposalFixtures();
    renderProject(undefined, { route: "/projects/p1/proposal" });
    await screen.findByText("Логотип");

    await userEvent.click(screen.getByRole("button", { name: "Добавить в план" }));

    await waitFor(() =>
      expect(sent).toContainEqual({ method: "POST", path: "push-to-plan", body: null }),
    );
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
    // Настройки сметы показываются, но выключены.
    expect(screen.getByLabelText("Налог, %")).toBeDisabled();
  });
});
