import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { server } from "../test/server";
import { ORG, USER, renderApp } from "../test/utils";

beforeEach(() => {
  server.use(
    http.get("/api/auth/me", () => HttpResponse.json(USER)),
    http.get("/api/org", () => HttpResponse.json(ORG)),
    http.get("/api/projects", () => HttpResponse.json([])),
  );
});

describe("шапка", () => {
  it("подписана названием организации, и оно не переводится", async () => {
    renderApp({ route: "/projects", locale: "ru" });

    expect(await screen.findByText("Şəhər Studiyası")).toBeInTheDocument();
  });

  it("ведёт «Проектами» туда же, куда приводит вход", async () => {
    renderApp({ route: "/projects", locale: "ru" });

    // A sign-in, an invitation and an unknown address all lead to `/projects` — the column's item
    // must lead there too. While it pointed at "/", a click on the only item about projects opened
    // a different screen.
    expect(await screen.findByRole("link", { name: "Проекты" })).toHaveAttribute(
      "href",
      "/projects",
    );
    // There is one item about projects in the column rather than three: the neighbouring
    // "Portfolio" and "Reports" showed the same projects under their own heading, and there was
    // nothing to tell them apart from the outside.
    expect(screen.queryByRole("link", { name: "Портфель" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Отчёты" })).toBeNull();
  });

  it("подсвечивает ровно один раздел — тот, на котором стоит человек", async () => {
    renderApp({ route: "/my-tasks", locale: "ru" });

    expect(await screen.findByRole("link", { name: "Мои задачи" })).toHaveClass("is-current");
    expect(screen.getByRole("link", { name: "Проекты" })).not.toHaveClass("is-current");
  });

  it("держит «Проекты» подсвеченными и внутри проекта", async () => {
    server.use(
      http.get("/api/projects/p1", () =>
        HttpResponse.json({
          id: "p1",
          name: "Редизайн",
          slug: "redizayn",
          deadline: null,
          categories: [],
          tasks: [],
        }),
      ),
      http.get("/api/projects/:projectId/comments", () => HttpResponse.json([])),
      http.get("/api/org/members", () => HttpResponse.json([])),
    );

    renderApp({ route: "/projects/p1", locale: "ru" });

    // A project's page is part of the "Projects" section, and the column must show that:
    // otherwise a person stands on a screen that highlights no item, and the column does not show
    // where they are.
    const projects = await screen.findByRole("link", { name: "Проекты" });
    expect(projects).toHaveClass("is-current");
    expect(screen.getByRole("link", { name: "Мои задачи" })).not.toHaveClass("is-current");
  });

  it("ведёт в настройки одним пунктом, а не тремя шестерёнками подряд", async () => {
    renderApp({ route: "/projects", locale: "ru" });

    expect(await screen.findByRole("link", { name: "Настройки" })).toHaveAttribute(
      "href",
      "/settings",
    );
    // The organization, the members and the profile became tabs inside — they no longer have
    // items of their own in the column.
    expect(screen.queryByRole("link", { name: "Организация" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Профиль" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Команда" })).toBeNull();
  });

  it("переключает язык из самой колонки, над «Настройками»", async () => {
    const patches: Record<string, unknown>[] = [];
    server.use(
      http.patch("/api/auth/me", async ({ request }) => {
        const patch = (await request.json()) as Record<string, unknown>;
        patches.push(patch);
        return HttpResponse.json({ ...USER, ...patch });
      }),
    );

    renderApp({ route: "/projects", locale: "ru" });

    const chooser = await screen.findByRole("group", { name: "Язык интерфейса" });
    const settings = screen.getByRole("link", { name: "Настройки" });
    // Above "Settings" and below the sections of work — in the column's bottom row.
    expect(settings.previousElementSibling).toBe(chooser);

    await userEvent.click(within(chooser).getByRole("button", { name: "AZ" }));

    // The choice went into the profile rather than only into the browser's memory, and the
    // interface switched at once without waiting for the server's answer.
    await waitFor(() => expect(patches).toEqual([{ locale: "az" }]));
    expect(await screen.findByRole("link", { name: "Layihələr" })).toBeInTheDocument();
  });

  it("не здоровается: разделы стоят сразу под названием организации", async () => {
    server.use(
      http.get("/api/auth/me", () => HttpResponse.json({ ...USER, name: "Алексей Смирнов" })),
    );

    renderApp({ route: "/projects", locale: "ru" });

    const projects = await screen.findByRole("link", { name: "Проекты" });
    expect(screen.queryByText(/Привет/)).toBeNull();
    // There is no line with a name left between the logo and the first section: the column starts
    // with the organization and goes straight to the work.
    const sidebar = projects.closest(".sidebar")!;
    expect(sidebar.querySelector(".sidebar__user")).toBeNull();
  });

  it("подписывает выход значком, как и остальные пункты колонки", async () => {
    renderApp({ route: "/projects", locale: "ru" });

    const logout = await screen.findByRole("button", { name: "Выйти" });
    expect(logout.querySelector("svg.sidebar__icon")).not.toBeNull();
  });

  it("сворачивается щелчком по логотипу и запоминает выбор", async () => {
    renderApp({ route: "/projects", locale: "ru" });

    // The logo itself collapses: there is no separate arrow button in the column.
    const logo = await screen.findByRole("button", { name: "Скрыть меню" });
    expect(logo).toContainElement(await screen.findByText("Şəhər Studiyası"));

    await userEvent.click(logo);

    // The button changed its name — the column is collapsed, and the choice would survive a reload.
    expect(screen.getByRole("button", { name: "Показать меню" })).toBeInTheDocument();
    expect(localStorage.getItem("planora.sidebar_collapsed")).toBe("1");

    await userEvent.click(screen.getByRole("button", { name: "Показать меню" }));

    expect(screen.getByRole("button", { name: "Скрыть меню" })).toBeInTheDocument();
    expect(localStorage.getItem("planora.sidebar_collapsed")).toBeNull();
  });

  it("держит подпись каждого пункта отдельным узлом", async () => {
    renderApp({ route: "/projects", locale: "ru" });

    // A collapsed column hides the captions, leaving the icons. A caption can only be hidden when
    // it is its own node: as bare text inside a link it is dimmed along with the icon, and an
    // empty band is all that is left of the rail. That is exactly how the column looked — a lone
    // logo, without a single item.
    for (const name of ["Проекты", "Мои задачи"]) {
      const link = await screen.findByRole("link", { name });
      expect(link.querySelector(".sidebar__label")).toHaveTextContent(name);
      expect(link.querySelector("svg.sidebar__icon")).not.toBeNull();
    }
  });

  it("называет каждый пункт помимо видимой подписи", async () => {
    renderApp({ route: "/projects", locale: "ru" });

    // A collapsed column hides the caption — both from the screen and from the accessibility tree:
    // the icon next to it is `aria-hidden`, and the item would be left with no name at all. So the
    // name is set separately, and set on every item rather than only on the bottom ones.
    await screen.findByRole("link", { name: "Проекты" });
    for (const item of document.querySelectorAll(".sidebar__nav .sidebar__link")) {
      expect(item).toHaveAttribute("aria-label", item.textContent);
    }
  });

  it("объясняет свёрнутую колонку своей подсказкой, а не атрибутом `title`", async () => {
    renderApp({ route: "/projects", locale: "ru" });

    // A native tooltip is drawn by the system: the application knows neither where it will stand
    // nor when it will go out. This one stood on top of the "Projects" item and hung around for
    // another couple of seconds after the cursor left — ours knows about the column.
    const logo = await screen.findByRole("button", { name: "Скрыть меню" });
    expect(logo).not.toHaveAttribute("title");
    expect(logo.querySelector(".sidebar__tip")).toHaveTextContent("Скрыть меню");

    await userEvent.click(logo);

    // The tooltip speaks about the action rather than the state, and changes along with the
    // button's name: in the rail it is the only thing that explains the square.
    const rail = screen.getByRole("button", { name: "Показать меню" });
    expect(rail.querySelector(".sidebar__tip")).toHaveTextContent("Показать меню");
  });

  it("называет `aria-expanded` то, что сворачивает", async () => {
    renderApp({ route: "/projects", locale: "ru" });

    // Without `aria-controls` the screen reader reports "collapsed" without saying what. Both
    // areas are listed: the captions disappear from the sections and from the bottom block alike.
    const logo = await screen.findByRole("button", { name: "Скрыть меню" });
    const controls = logo.getAttribute("aria-controls")?.split(" ") ?? [];

    expect(controls).toHaveLength(2);
    for (const id of controls) expect(document.getElementById(id)).not.toBeNull();
  });

  it("ставит в квадрат первую букву организации, а не продукта", async () => {
    renderApp({ route: "/projects", locale: "ru" });

    // The theme drew a `content: "P"` here on top of the dimmed markup, and for the "Şəhər
    // Studiyası" organization the square identified Planora. In a collapsed column this square is
    // all that is left of it, and it must speak about the place of work.
    await screen.findByText("Şəhər Studiyası");
    expect(document.querySelector(".sidebar__avatar")).toHaveTextContent("Ş");
  });
});
