import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import type { ProjectState } from "../api/projects";
import { captureMutations, projectFixtures, renderProject, WITH_DEPENDENCY } from "../test/project";

beforeEach(projectFixtures);

/**
 * Та же пара задач, но «Макет» начат 9 марта — за два дня до конца
 * «Логотипа»: связь нарушена ровно так, как её рисует косая стрелка ленты.
 */
const VIOLATED: ProjectState = {
  ...WITH_DEPENDENCY,
  tasks: WITH_DEPENDENCY.tasks.map((task) =>
    task.id === "t2" ? { ...task, start_date: "2026-03-09", end_date: "2026-03-15" } : task,
  ),
};

/**
 * Статус и связи — то, чем карточка пополнилась при сведении с макетом
 * Planora: статус назначается руками, связи правятся отсюда, а не только
 * рисуются стрелками.
 */
describe("карточка: статус и связи", () => {
  it("смена статуса уходит операцией set_status", async () => {
    const sent = captureMutations();
    renderProject(WITH_DEPENDENCY);

    await userEvent.click(await screen.findByRole("button", { name: /^Логотип, / }));
    await userEvent.selectOptions(screen.getByLabelText("Статус"), "blocked");

    await waitFor(() =>
      expect(sent[0].op).toEqual({ type: "set_status", task_id: "t1", status: "blocked" }),
    );
  });

  it("показывает обе стороны связи и умеет её снять", async () => {
    const sent = captureMutations();
    renderProject(WITH_DEPENDENCY);

    // У приёмника связь видна как «зависит от».
    await userEvent.click(await screen.findByRole("button", { name: /^Макет, / }));
    const depends = screen.getByText("Зависит от").closest(".panel__deps")!;
    expect(within(depends as HTMLElement).getByText("Логотип")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Убрать связь с «Логотип»" }),
    );
    await waitFor(() =>
      expect(sent[0].op).toEqual({
        type: "remove_dependency",
        from_task_id: "t1",
        to_task_id: "t2",
      }),
    );
  });

  it("новая связь добавляется из списка кандидатов", async () => {
    const sent = captureMutations();
    renderProject(WITH_DEPENDENCY);

    await userEvent.click(await screen.findByRole("button", { name: /^Логотип, / }));
    // У «Логотипа» уже есть исходящая связь на «Макет», поэтому кандидат
    // остаётся только в списке «зависит от» — и это не «Макет»: обратная
    // сторона существующей связи была бы циклом.
    const depends = screen.getByText("Зависит от").closest(".panel__deps")!;
    const picker = within(depends as HTMLElement).queryByRole("combobox");
    // Кандидатов нет: единственная другая задача — «Макет», а он исключён.
    expect(picker).toBeNull();

    // Зато со стороны «Макета» связь добавить можно — на самого «Логотипа»
    // она уже есть, значит список пуст и там. Проверяем добавление на третьей
    // задаче не выйдет — её нет; вместо этого снимем и вернём связь.
    await userEvent.click(screen.getByRole("button", { name: /^Макет, / }));
    await userEvent.click(
      screen.getByRole("button", { name: "Убрать связь с «Логотип»" }),
    );
    await waitFor(() => expect(sent).toHaveLength(1));

    const dependsNow = screen.getByText("Зависит от").closest(".panel__deps")!;
    await userEvent.selectOptions(
      within(dependsNow as HTMLElement).getByRole("combobox"),
      "t1",
    );
    await waitFor(() =>
      expect(sent[1].op).toEqual({
        type: "add_dependency",
        from_task_id: "t1",
        to_task_id: "t2",
      }),
    );
  });

  it("помечает нарушенную связь и чинит её со стороны приёмника", async () => {
    const sent = captureMutations();
    renderProject(VIOLATED);

    await userEvent.click(await screen.findByRole("button", { name: /^Макет, / }));
    const depends = screen.getByText("Зависит от").closest(".panel__deps")!;
    // Знак — тот же «!», что на стрелке ленты, и он называет нарушение словами.
    expect(
      within(depends as HTMLElement).getByLabelText("«Макет» начинается до конца «Логотип»"),
    ).toBeInTheDocument();

    // Починка — тем же правилом, что предложение под лентой: последователь
    // встаёт на следующий день после конца предшественника.
    await userEvent.click(
      within(depends as HTMLElement).getByRole("button", { name: /Подвинуть «Макет» на 2 дня/ }),
    );
    await waitFor(() =>
      expect(sent[0].op).toEqual({
        type: "move_task",
        task_id: "t2",
        start_date: "2026-03-11",
      }),
    );
  });

  it("нарушение видно и со стороны источника — двигается всё равно приёмник", async () => {
    const sent = captureMutations();
    renderProject(VIOLATED);

    await userEvent.click(await screen.findByRole("button", { name: /^Логотип, / }));
    const blocks = screen.getByText("Блокирует").closest(".panel__deps")!;
    expect(
      within(blocks as HTMLElement).getByLabelText("«Макет» начинается до конца «Логотип»"),
    ).toBeInTheDocument();

    await userEvent.click(
      within(blocks as HTMLElement).getByRole("button", { name: /Подвинуть «Макет» на 2 дня/ }),
    );
    await waitFor(() =>
      expect(sent[0].op).toEqual({
        type: "move_task",
        task_id: "t2",
        start_date: "2026-03-11",
      }),
    );
  });

  it("связь с запасом пометки не носит", async () => {
    renderProject(WITH_DEPENDENCY);

    await userEvent.click(await screen.findByRole("button", { name: /^Макет, / }));
    screen.getByText("Зависит от");

    expect(document.querySelector(".panel__dep-warn")).toBeNull();
    expect(screen.queryByRole("button", { name: /Подвинуть/ })).toBeNull();
  });

});
