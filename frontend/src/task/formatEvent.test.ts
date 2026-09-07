import { describe, expect, it } from "vitest";

import { formatEvent } from "./formatEvent";

describe("запись истории", () => {
  it("собирает фразу переноса на языке читателя", () => {
    const op = { type: "move_task", task_id: "t1", from: "2026-03-12", to: "2026-03-19" };
    expect(formatEvent(op, "ru")).toBe("перенёс старт с 12 мар на 19 мар");
    expect(formatEvent(op, "az")).toBe("başlanğıcı 12 mar → 19 mar dəyişdi");
  });

  it("склоняет длительность по правилам языка", () => {
    const op = { type: "set_duration", task_id: "t1", from: 14, to: 21 };
    expect(formatEvent(op, "ru")).toBe("изменил длительность с 14 дней на 21 день");
  });

  it("перечисляет только изменившиеся поля", () => {
    const op = {
      type: "set_task_fields",
      task_id: "t1",
      from: { name: "Лого", description: "", internal_note: "" },
      to: { name: "Лого", description: "Знак", internal_note: "" },
    };
    expect(formatEvent(op, "ru")).toBe("изменил описание");
  });

  it("называет, сколько задач ушло вместе с категорией", () => {
    // «Удалил категорию» об удалённом вместе с ней этапе умалчивает, а в
    // ленте истории это единственное место, где видно, что именно исчезло.
    expect(formatEvent({ type: "delete_category", category_id: "c1", tasks: 3 }, "ru")).toBe(
      "удалил категорию вместе с задачами: 3 задачи",
    );
    expect(formatEvent({ type: "delete_category", category_id: "c1" }, "ru")).toBe(
      "удалил категорию",
    );
  });

  it("отличает возвращённую отменой категорию от только что созданной", () => {
    const restored = {
      type: "create_category",
      category_id: "c1",
      tasks: [{ type: "create_task", task_id: "t1" }],
    };
    expect(formatEvent(restored, "ru")).toBe("вернул категорию с задачами: 1 задача");
    expect(formatEvent({ type: "create_category", category_id: "c1" }, "ru")).toBe(
      "создал категорию",
    );
  });

  it("не падает на неизвестном типе события", () => {
    expect(formatEvent({ type: "invented_later", task_id: "t1" }, "ru")).toBe("изменил задачу");
  });

  it("называет риск словами исполнителя и приводит причину как есть", () => {
    const op = {
      type: "set_risk",
      task_id: "t1",
      from: { risk: "green", note: "" },
      to: { risk: "yellow", note: "жду доступ к API" },
    };
    expect(formatEvent(op, "ru")).toBe(
      "изменил риск с «По плану» на «Есть риск»: жду доступ к API",
    );
    // Причина не менялась — фраза без неё: повторять старый текст незачем.
    const back = { ...op, from: op.to, to: { risk: "green", note: "жду доступ к API" } };
    expect(formatEvent(back, "ru")).toBe("изменил риск с «Есть риск» на «По плану»");
  });
});
