import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { server } from "../test/server";
import { renderApp, sessionHandlers } from "../test/utils";

/**
 * Import from Jira through a person's eyes — by the same principle as the AI interview
 * (AiIntake.test.tsx): an unconfigured connection explains where to go rather than hiding the form, and
 * until "Import" is pressed not a single import request goes out.
 */

function jiraFixtures(configured = true) {
  const calls: string[] = [];
  server.use(
    http.get("/api/jira/credential", () =>
      HttpResponse.json({ base_url: "https://acme.atlassian.net", email: "bot@acme.example", configured }),
    ),
    http.get("/api/jira/projects", () => {
      calls.push("list");
      return HttpResponse.json([
        { key: "PROJ", name: "Демо проект" },
        { key: "OPS", name: "Эксплуатация" },
      ]);
    }),
    http.post("/api/jira/import", async ({ request }) => {
      calls.push("import");
      const body = (await request.json()) as { jira_project_key: string; name: string };
      return HttpResponse.json(
        {
          project_id: "p1",
          batch_id: "b1",
          created_categories: 2,
          created_tasks: 5,
          jira_project_key: body.jira_project_key,
        },
        { status: 201 },
      );
    }),
    // After the import the screen leaves for the project: its state has to be answered too.
    http.get("/api/projects/p1", () => HttpResponse.json({ detail: "project_not_found" }, { status: 404 })),
  );
  return calls;
}

beforeEach(() => {
  server.use(...sessionHandlers());
});

describe("импорт из Jira", () => {
  it("без подключения объясняет, куда идти, а не прячет форму", async () => {
    jiraFixtures(false);
    renderApp({ route: "/projects/new/jira" });

    expect(await screen.findByText(/Jira не подключена/)).toBeInTheDocument();
    const main = screen.getByRole("main");
    expect(within(main).getByRole("link", { name: "Организация" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Проект Jira")).toBeNull();
  });

  it("список проектов Jira подгружается и заполняет название по умолчанию", async () => {
    jiraFixtures();
    renderApp({ route: "/projects/new/jira" });

    const select = await screen.findByLabelText("Проект Jira");
    await userEvent.selectOptions(select, "PROJ");

    expect(await screen.findByLabelText("Название проекта в Planora")).toHaveValue("Демо проект");
  });

  it("до нажатия «Импортировать» ничего не импортируется", async () => {
    const calls = jiraFixtures();
    renderApp({ route: "/projects/new/jira" });

    const select = await screen.findByLabelText("Проект Jira");
    await userEvent.selectOptions(select, "PROJ");
    await screen.findByDisplayValue("Демо проект");

    await waitFor(() => expect(calls).toEqual(["list"]));
    expect(screen.getByRole("button", { name: "Импортировать" })).toBeEnabled();
  });

  it("импорт уходит на выбранный проект и переводит на созданный", async () => {
    const calls = jiraFixtures();
    renderApp({ route: "/projects/new/jira" });

    const select = await screen.findByLabelText("Проект Jira");
    await userEvent.selectOptions(select, "OPS");
    await screen.findByDisplayValue("Эксплуатация");

    await userEvent.click(screen.getByRole("button", { name: "Импортировать" }));

    await waitFor(() => expect(calls).toEqual(["list", "import"]));
  });

  it("название проекта можно поправить руками, и выбор другого проекта его не перетирает", async () => {
    jiraFixtures();
    renderApp({ route: "/projects/new/jira" });

    const select = await screen.findByLabelText("Проект Jira");
    await userEvent.selectOptions(select, "PROJ");
    const name = await screen.findByLabelText("Название проекта в Planora");
    await userEvent.clear(name);
    await userEvent.type(name, "Своё название");

    await userEvent.selectOptions(select, "OPS");

    expect(name).toHaveValue("Своё название");
  });
});
