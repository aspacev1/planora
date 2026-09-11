import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import type { ProjectState } from "../api/projects";
import { captureMutations, projectFixtures, renderProject, WITH_DEPENDENCY } from "../test/project";

beforeEach(projectFixtures);

/**
 * The same pair of tasks, but with "Mockup" starting on 9 March — two days before "Logo" ends: the
 * link is violated exactly the way the strip's slanted arrow draws it.
 */
const VIOLATED: ProjectState = {
  ...WITH_DEPENDENCY,
  tasks: WITH_DEPENDENCY.tasks.map((task) =>
    task.id === "t2" ? { ...task, start_date: "2026-03-09", end_date: "2026-03-15" } : task,
  ),
};

/**
 * The status and the links — what the card gained when it was reconciled with the Planora mockup: the
 * status is assigned by hand, the links are edited from here rather than only drawn as arrows.
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

    // On the receiver the link is visible as "depends on".
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
    // "Logo" already has an outgoing link to "Mockup", so the candidate stays only in the "depends on"
    // list — and it is not "Mockup": the reverse side of an existing link would be a cycle.
    const depends = screen.getByText("Зависит от").closest(".panel__deps")!;
    const picker = within(depends as HTMLElement).queryByRole("combobox");
    // There are no candidates: the only other task is "Mockup", and it is excluded.
    expect(picker).toBeNull();

    // From "Mockup"'s side, though, a link can be added — to "Logo" itself it already exists, so the
    // list is empty there too. Checking an addition on a third task will not work — there is none;
    // instead we remove and restore a link.
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
    // The sign is the same "!" as on the strip's arrow, and it names the violation in words.
    expect(
      within(depends as HTMLElement).getByLabelText("«Макет» начинается до конца «Логотип»"),
    ).toBeInTheDocument();

    // The fix follows the same rule as the nudge under the strip: the successor lands on the day after
    // the predecessor's end.
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
