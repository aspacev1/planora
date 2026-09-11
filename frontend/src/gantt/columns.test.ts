import { describe, expect, it } from "vitest";

import {
  COLLAPSED_WIDTH,
  COLUMN_KEYS,
  reorderColumns,
  toggleColumn,
  DEFAULT_WIDTH,
  MAX_WIDTH,
  MIN_WIDTH,
  clampWidth,
  defaultLayout,
  layoutWidth,
  rememberLayout,
  storedLayout,
} from "./columns";

describe("раскладка колонок", () => {
  it("на широком экране открывается именем и обеими датами", () => {
    expect(defaultLayout(1440).shown).toEqual(["task", "start", "end"]);
  });

  it("на узком — одним именем: ленте нужно место, ради неё и пришли", () => {
    expect(defaultLayout(520).shown).toEqual(["task"]);
    expect(defaultLayout(520).widths.task).toBeLessThan(DEFAULT_WIDTH.task);
  });

  it("без окна не выдумывает телефон", () => {
    expect(defaultLayout(0).shown).toEqual(["task", "start", "end"]);
  });

  it("ширина колонки — сумма показанных, а не всех", () => {
    const layout = defaultLayout(1440);
    expect(layoutWidth(layout)).toBe(
      DEFAULT_WIDTH.task + DEFAULT_WIDTH.start + DEFAULT_WIDTH.end,
    );
  });

  it("свёрнутая таблица — полоса под кнопку, а не сумма своих колонок", () => {
    expect(layoutWidth({ ...defaultLayout(1440), collapsed: true })).toBe(COLLAPSED_WIDTH);
  });

  it("ширина держится в границах, за которыми колонка перестаёт быть колонкой", () => {
    expect(clampWidth(1)).toBe(MIN_WIDTH);
    expect(clampWidth(9999)).toBe(MAX_WIDTH);
    expect(clampWidth(120.4)).toBe(120);
  });
});

describe("порядок и набор колонок", () => {
  it("переставляет колонку на место соседней", () => {
    expect(reorderColumns(["task", "start", "end", "duration"], "duration", "start")).toEqual([
      "task",
      "duration",
      "start",
      "end",
    ]);
  });

  it("имя задачи с первого места не уходит и на него никого не пускает", () => {
    const shown: ("task" | "start" | "end")[] = ["task", "start", "end"];
    expect(reorderColumns(shown, "task", "end")).toEqual(shown);
    expect(reorderColumns(shown, "end", "task")).toEqual(shown);
  });

  it("бросок колонки на саму себя ничего не меняет", () => {
    const shown: ("task" | "start" | "end")[] = ["task", "start", "end"];
    expect(reorderColumns(shown, "start", "start")).toEqual(shown);
  });

  it("включённая колонка встаёт на своё место по объявленному порядку", () => {
    expect(toggleColumn(["task", "start", "assignee"], "end")).toEqual([
      "task",
      "start",
      "end",
      "assignee",
    ]);
  });

  it("выключенная колонка исчезает, не тронув порядка остальных", () => {
    expect(toggleColumn(["task", "duration", "start"], "duration")).toEqual(["task", "start"]);
  });

  it("имя задачи не выключается", () => {
    expect(toggleColumn(["task", "start"], "task")).toEqual(["task", "start"]);
  });
});

describe("память раскладки", () => {
  it("возвращает то, что положили", () => {
    const layout = {
      shown: ["task" as const, "duration" as const],
      widths: { ...DEFAULT_WIDTH },
      collapsed: false,
    };
    rememberLayout("p1", layout);

    expect(storedLayout("p1")).toEqual(layout);
  });

  it("свёрнутую таблицу помнит: разворачивают её ради одного взгляда, а не одного экрана", () => {
    rememberLayout("p9", { ...defaultLayout(1440), collapsed: true });

    expect(storedLayout("p9")?.collapsed).toBe(true);
  });

  it("свёртка из хранилища читается признаком, а не «чем угодно правдивым»", () => {
    localStorage.setItem(
      "planora.gantt_columns.p10",
      JSON.stringify({ shown: ["task"], widths: {}, collapsed: "нет" }),
    );

    expect(storedLayout("p10")?.collapsed).toBe(false);
  });

  it("возвращает порядок таким, каким его выставили", () => {
    // The order belongs to the person: columns are reordered by their heading, and what is read back must
    // return them in the same order rather than in the declared one.
    localStorage.setItem(
      "planora.gantt_columns.p2",
      JSON.stringify({ shown: ["end", "start"], widths: {} }),
    );

    expect(storedLayout("p2")?.shown).toEqual(["task", "end", "start"]);
  });

  it("имя задачи в прочитанной раскладке всегда первое и всегда есть", () => {
    localStorage.setItem(
      "planora.gantt_columns.p7",
      JSON.stringify({ shown: ["end", "task", "start"], widths: {} }),
    );

    expect(storedLayout("p7")?.shown).toEqual(["task", "end", "start"]);
  });

  it("повтор в записи не двоит колонку", () => {
    localStorage.setItem(
      "planora.gantt_columns.p8",
      JSON.stringify({ shown: ["start", "start", "end"], widths: {} }),
    );

    expect(storedLayout("p8")?.shown).toEqual(["task", "start", "end"]);
  });

  it("кривая запись — это «показать по умолчанию», а не колонка-призрак", () => {
    localStorage.setItem("planora.gantt_columns.p3", "{ не json");
    expect(storedLayout("p3")).toBeNull();

    localStorage.setItem("planora.gantt_columns.p4", JSON.stringify({ shown: "всё" }));
    expect(storedLayout("p4")).toBeNull();
  });

  it("незнакомую колонку из хранилища не пускает в раскладку", () => {
    localStorage.setItem(
      "planora.gantt_columns.p5",
      JSON.stringify({ shown: ["start", "звёздочки"], widths: { звёздочки: 200 } }),
    );

    const layout = storedLayout("p5");
    expect(layout?.shown).toEqual(["task", "start"]);
    expect(Object.keys(layout?.widths ?? {}).sort()).toEqual([...COLUMN_KEYS].sort());
  });

  it("ширину из хранилища прижимает к границам", () => {
    localStorage.setItem(
      "planora.gantt_columns.p6",
      JSON.stringify({ shown: ["task"], widths: { task: 10_000 } }),
    );

    expect(storedLayout("p6")?.widths.task).toBe(MAX_WIDTH);
  });
});
