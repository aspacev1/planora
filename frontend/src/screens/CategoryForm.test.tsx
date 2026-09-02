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
      progress_pct: 40,
      position: 0,
      assignee_ids: [],
    },
  ],
  dependencies: [],
};

/**
 * «Плюс» в углу таблицы, а не «+ Новая категория» с низа ленты: у ленты два
 * пути завести категорию — эта форма (с выбором цвета) и короткий путь снизу
 * списка (см. `gantt/BottomActions.tsx`), и у обеих одно и то же имя для
 * читалки, потому что они и делают одно и то же. Различает их только место —
 * угол таблицы рождается вместе с данными проекта, поэтому ищем сначала его.
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
                  // Сервер вернул то, что ему прислали: название категории
                  // уходит прописным.
                  { id: "c2", name: "АНАЛИТИКА", color: "#a855f7", position: 1 },
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
            name: "АНАЛИТИКА",
            color: expect.stringMatching(/^#[0-9a-f]{6}$/i),
          },
        },
      ]),
    );

    // Состояние перезапрашивается, а не дописывается в кэш руками: позицию и
    // идентификатор назначил сервер, и придуманные клиентом разошлись бы с
    // ними в самом неудобном месте.
    expect(await screen.findByText("АНАЛИТИКА")).toBeInTheDocument();
  });

  it("заводит категорию прописными, как её ни набери", async () => {
    // Заголовок группы в ленте набран одинаково у всех категорий: разнобой
    // регистров читался бы как строки разной природы.
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
    expect(sent[0].op.name).toBe("АНАЛИТИКА И ОТЧЁТЫ");
  });

  it("показывает набираемое название прописными, не переписывая набранное", async () => {
    server.use(
      ...sessionHandlers(),
      http.get("/api/projects/p1", () => HttpResponse.json(STATE)),
    );

    renderApp({ route: "/projects/p1", locale: "ru" });
    await userEvent.click(await cornerAddCategoryButton());
    await userEvent.type(screen.getByLabelText(/название/i), "аналитика");

    // Регистр поднимает браузер при выводе, а значение остаётся набранным:
    // переписывать его на каждом символе значило бы уводить курсор в конец
    // строки при всякой правке в середине.
    const field = screen.getByLabelText(/название/i);
    expect(field.closest("p")).toHaveClass("field--upper");
    expect(field).toHaveValue("аналитика");
  });

  it("поднимает регистр по языку, а не инвариантно", async () => {
    // Азербайджанское «i» поднимается в «İ»: инвариантный toUpperCase дал бы
    // «I» — другую букву алфавита, то есть другое слово.
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
    await userEvent.type(screen.getByLabelText("Ad"), "işlər");
    await userEvent.click(screen.getByRole("button", { name: /^yarat$/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op.name).toBe("İŞLƏR");
  });

  it("не шлёт в операции полей, которых нет в публичном контракте", async () => {
    // position и category_id назначает сервер; клиент их не знает и знать не должен
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

    // Выбор — это набор готовых цветов, а не пипетка: произвольный цвет умеет
    // быть неотличимым от соседнего и нечитаемым на доске.
    const swatches = screen.getAllByRole<HTMLInputElement>("radio");
    expect(swatches).toHaveLength(CATEGORY_COLORS.length);
    expect(swatches.map((swatch) => swatch.value)).toEqual(
      CATEGORY_COLORS.map((option) => option.value),
    );

    const chosen = swatches.find((swatch) => swatch.checked);
    // Цвет предлагается по числу уже существующих категорий, а не берётся
    // первым из палитры: иначе две подряд созданные категории неразличимы.
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
    // Кружок назван словом, а не кодом цвета: читалка обязана произнести
    // выбор, а `#ec4899` произнести нечем.
    await userEvent.click(screen.getByRole("radio", { name: "Розовый" }));
    await userEvent.click(screen.getByRole("button", { name: /^создать$/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].op.color).toBe("#ec4899");
  });

  it("на пустой ленте первую категорию заводит кнопка в самой ленте", async () => {
    // Пустой проект — единственный экран, где в ленте нечего нажать, кроме
    // этого. Раньше на этом месте был нарисованный плюс: он выглядел органом
    // управления, не будучи им, и первую категорию заводили, уйдя за ней в
    // тулбар — мимо того самого пятна, на которое человек смотрел.
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
    // Право писать проверяет экран: рисунок, зовущий завести категорию,
    // читателю пришлось бы упереться в отказ — обещание без исполнения.
    server.use(
      // Своя роль идёт первой: msw берёт первый подходящий обработчик, и общий
      // `/api/org` из оснастки перекрыл бы наблюдателя, ради которого тест и
      // написан.
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
