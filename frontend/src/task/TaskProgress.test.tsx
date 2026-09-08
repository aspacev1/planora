import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { STATE, captureMutations, projectFixtures, renderProject } from "../test/project";
import { server } from "../test/server";

beforeEach(projectFixtures);

/** Открыть карточку щелчком по полоске. */
async function openPanel() {
  await userEvent.click(await screen.findByRole("button", { name: /Логотип/ }));
}

describe("быстрый прогресс в карточке", () => {
  it("«Записать прогресс» прибавляет дневную норму одной операцией и гаснет", async () => {
    const sent = captureMutations();
    renderProject();
    await openPanel();

    // Пять рабочих дней — дневная норма 20%: 40 → 60.
    await userEvent.click(screen.getByRole("button", { name: "Записать прогресс · +20%" }));
    await waitFor(() =>
      expect(sent).toEqual([
        { op: { type: "set_progress", task_id: "t1", progress_pct: 60 } },
      ]),
    );

    // Погасшая кнопка защищает от двойного тапа: второй «день» за один заход
    // не записывается.
    expect(screen.getByRole("button", { name: "День отмечен" })).toBeDisabled();
  });

  it("кнопка загорается снова, если сервер отказал", async () => {
    server.use(
      http.post("/api/projects/p1/mutations", () =>
        HttpResponse.json({ detail: "progress_out_of_range" }, { status: 422 }),
      ),
    );

    renderProject();
    await openPanel();
    await userEvent.click(screen.getByRole("button", { name: "Записать прогресс · +20%" }));

    // Прогресс не записан — значит день не отмечен: главная дневная кнопка не
    // имеет права остаться погасшей до конца захода.
    const day = await screen.findByRole("button", { name: "Записать прогресс · +20%" });
    await waitFor(() => expect(day).toBeEnabled());
  });

  it("число прогресса тоже можно ввести напрямую", async () => {
    const sent = captureMutations();
    renderProject();
    await openPanel();

    await userEvent.clear(screen.getByLabelText(/выполнено/i));
    await userEvent.type(screen.getByLabelText(/выполнено/i), "75");
    // Число уходит по уходу из поля, а не по каждой клавише: иначе «75»
    // оставляло бы в истории задачи две записи — про 7 и про 75.
    expect(sent).toHaveLength(0);
    await userEvent.tab();

    await waitFor(() =>
      expect(sent).toEqual([{ op: { type: "set_progress", task_id: "t1", progress_pct: 75 } }]),
    );
  });

  it("читателю прогресс виден, но кнопки отметки и правки числа нет", async () => {
    renderProject(STATE, { canWrite: false });
    await openPanel();

    expect(screen.getByLabelText(/выполнено/i)).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Записать прогресс/ })).not.toBeInTheDocument();
  });
});
