# Plan 2: creating a project and tasks — implementation plan

> **Historical.** This is one of the original build plans this codebase
> was built from — every step below has since shipped. It reflects the plan
> as scoped in August 2026, not necessarily today's implementation; for
> current architecture and conventions, see the repo's `CLAUDE.md` and the
> `planora-conventions` skill. Kept as a build-history record, not an active
> task list.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the interface to a state where a person creates a project, creates categories and tasks, and sees them on a real Gantt chart with a daily scale — without dragging and editing for now.

**Architecture:** The chart is the only non-trivial component, and it breaks down into parts with clear boundaries: the time scale converts dates into pixels and back, the rows draw the content, the shell is responsible for the scroll and the pinned left column. All the data arrives in one project-state request; all the changes leave as operations. The client does not compute end dates — the server computes them and sends them ready.

**Tech Stack:** As in plan 1: Vite, React, TypeScript, react-router, TanStack Query, Vitest, Testing Library, MSW, our own CSS.

## Global Constraints

- The end dates come from the server. The client does not reproduce calendar arithmetic under any circumstances: the working-day rules live in one place, and it is not the browser.
- All changes to a project's data go as operations through `POST /api/projects/{id}/mutations`. There are no direct entity updates.
- An operation's public contract does not accept the restoration fields (`task_id`, `category_id` on creation, `position`). They are assigned by the server.
- Languages: `az` by default, `en`, `ru`. The chrome is translated, the user's content never.
- The server answers with machine codes; the client translates a code into text and never shows `detail` as is.
- The non-working days arrive in the project's state and are filled in as a background across the chart's full height.
- The rows' order is drawn by `(position, id)`: positions can coincide in one edge case, and without a second key the order is unstable between repaints.
- Our own CSS with variables and a dark theme through `prefers-color-scheme`.

---

### Task 1: The list of projects and creating a project

**Files:**
- Modify: `frontend/src/screens/Projects.tsx`
- Create: `frontend/src/api/projects.ts`
- Create: `frontend/src/components/Modal.tsx`
- Test: `frontend/src/screens/Projects.test.tsx`

**Interfaces:**
- Produces: `listProjects()`, `createProject(name)`, `getProject(id)`, `applyOp(projectId, op, reason?)`; a reusable modal dialog.

- [ ] **Step 1: Write the failing tests**

```tsx
it("создаёт проект и уводит на него", async () => {
  server.use(
    http.get("/api/projects", () => HttpResponse.json([])),
    http.post("/api/projects", async ({ request }) => {
      expect(await request.json()).toEqual({ name: "Редизайн сайта" });
      return HttpResponse.json({ id: "p1", name: "Редизайн сайта", slug: "redizayn-sayta" },
        { status: 201 });
    }),
  );

  renderApp({ route: "/projects", locale: "ru" });
  await userEvent.click(await screen.findByRole("button", { name: /создать проект/i }));
  await userEvent.type(screen.getByLabelText(/название/i), "Редизайн сайта");
  await userEvent.click(screen.getByRole("button", { name: /создать$/i }));

  await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith("/projects/p1"));
});

it("показывает слаг, который сервер выдал, а не выдуманный клиентом", async () => {
  server.use(
    http.get("/api/projects", () => HttpResponse.json([
      { id: "p1", name: "Şəhər Layihəsi", slug: "seher-layihesi" }])),
  );

  renderApp({ route: "/projects", locale: "ru" });

  expect(await screen.findByText("seher-layihesi")).toBeInTheDocument();
});

it("не даёт отправить пустое название", async () => {
  server.use(http.get("/api/projects", () => HttpResponse.json([])));

  renderApp({ route: "/projects", locale: "ru" });
  await userEvent.click(await screen.findByRole("button", { name: /создать проект/i }));

  expect(screen.getByRole("button", { name: /создать$/i })).toBeDisabled();
});

it("объясняет отказ сервера переведённым текстом", async () => {
  server.use(
    http.get("/api/projects", () => HttpResponse.json([])),
    http.post("/api/projects", () =>
      HttpResponse.json({ detail: "forbidden" }, { status: 403 })),
  );

  renderApp({ route: "/projects", locale: "ru" });
  await createProjectNamed("Тест");

  expect(await screen.findByText(/недостаточно прав/i)).toBeInTheDocument();
});
```

The second test pins down a rule that is easy to break with the best of intentions: the slug is built from a transliteration table on the server, and that logic must not be repeated in the browser — a divergence would give a link that does not open.

- [ ] **Step 2: Run them and make sure they fail**

```bash
cd frontend && npx vitest run src/screens/Projects.test.tsx
```

- [ ] **Step 3: Implement the projects client**

- [ ] **Step 4: Implement the modal dialog**

Reusable: it closes on Esc and on a click outside, returns the focus where it was opened from, and puts the focus on the first field when opening. All of that is needed both for accessibility and so that the later screens do not reinvent a dialog of their own.

- [ ] **Step 5: Implement the screen**

- [ ] **Step 6: Run the tests and commit**

```bash
cd frontend && npx vitest run
git add frontend/src/
git commit -m "feat: the list of projects and creating a project"
```

---

### Task 2: The time scale

**Files:**
- Create: `frontend/src/gantt/timescale.ts`
- Test: `frontend/src/gantt/timescale.test.ts`

**Interfaces:**
- Produces: `buildScale({from, to, dayWidth}) -> Scale`; a `Scale` has `days`, `months`, `width`, `xOf(date)`, `widthOf(startISO, endISO)`, `dateAt(x)`.

A pure module with no React. It converts dates into pixels and back; everything else in the chart rests on it. A separate module because dragging in plan 3 will ask for `dateAt(x)`, and the conversion logic must be checked without the DOM taking part.

- [ ] **Step 1: Write the failing tests**

```ts
const scale = buildScale({ from: "2026-03-01", to: "2026-06-15", dayWidth: 26 });

it("ширина ленты равна числу дней на ширину дня", () => {
  expect(scale.days.length).toBe(107);
  expect(scale.width).toBe(107 * 26);
});

it("первый день начинается в нуле", () => {
  expect(scale.xOf("2026-03-01")).toBe(0);
});

it("ширина полоски включает оба конца", () => {
  // задача с 4 по 6 марта занимает три дня
  expect(scale.widthOf("2026-03-04", "2026-03-06")).toBe(3 * 26);
});

it("однодневная задача не схлопывается в ноль", () => {
  expect(scale.widthOf("2026-03-04", "2026-03-04")).toBe(26);
});

it("перевод пикселей в дату обратен переводу даты в пиксели", () => {
  for (const iso of ["2026-03-01", "2026-04-15", "2026-06-15"]) {
    expect(scale.dateAt(scale.xOf(iso))).toBe(iso);
  }
});

it("месяцы идут в порядке и покрывают всю ленту", () => {
  expect(scale.months.map((m) => m.key)).toEqual(["2026-03", "2026-04", "2026-05", "2026-06"]);
  expect(scale.months.reduce((sum, m) => sum + m.days, 0)).toBe(scale.days.length);
});

it("день недели считается по календарю, а не по остатку от деления", () => {
  expect(scale.days[0].weekday).toBe(0); // 1 March 2026 is a Sunday
});
```

The last test is not a formality: computing the weekday by an index from the strip's start is a common mistake, and it only shows up when the window's bounds change.

- [ ] **Step 2: Run them and make sure they fail**

- [ ] **Step 3: Implement the module**

The dates inside are ISO strings rather than `Date` objects: an object drags a time zone along with it, and a bar computed in one zone slips by a day in another. The arithmetic runs on UTC midnight, and what goes out are the same strings that came from the server.

- [ ] **Step 4: Run the tests and commit**

```bash
cd frontend && npx vitest run src/gantt/timescale.test.ts
git add frontend/src/gantt/
git commit -m "feat: the chart's time scale"
```

---

### Task 3: The chart, read-only

**Files:**
- Create: `frontend/src/gantt/Gantt.tsx`, `Header.tsx`, `Row.tsx`, `Grid.tsx`
- Create: `frontend/src/gantt/gantt.css`
- Create: `frontend/src/screens/Project.tsx`
- Test: `frontend/src/gantt/Gantt.test.tsx`

**Interfaces:**
- Consumes: `buildScale`, the project's state from `getProject`.
- Produces: a `<Gantt state={...} />` component drawing the header, the grid, the category rows and the task rows.

- [ ] **Step 1: Write the failing tests**

```tsx
const STATE = {
  id: "p1", name: "Редизайн", deadline: "2026-06-01", project_end: "2026-06-08",
  calendar: { working_days: 31, holidays: ["2026-03-20"], extra_workdays: [] },
  categories: [{ id: "c1", name: "Дизайн", color: "#3b82f6", position: 0 }],
  tasks: [{
    id: "t1", category_id: "c1", name: "Логотип", start_date: "2026-03-04",
    end_date: "2026-03-10", duration_days: 5, criticality: "high",
    progress_pct: 40, position: 0, assignee_ids: [],
  }],
  dependencies: [],
};

it("рисует задачу полоской нужной ширины", () => {
  render(<Gantt state={STATE} />);
  const bar = screen.getByRole("button", { name: /Логотип/ });
  // 4-10 March is seven calendar days
  expect(bar).toHaveStyle({ width: `${7 * 26}px` });
});

it("заливает выходные и праздники", () => {
  const { container } = render(<Gantt state={STATE} />);
  expect(container.querySelectorAll(".is-nonworking").length).toBeGreaterThan(0);
  expect(container.querySelector('[data-day="2026-03-20"]')).toHaveClass("is-nonworking");
});

it("красит задачу, заезжающую за дедлайн", () => {
  const late = { ...STATE, tasks: [{ ...STATE.tasks[0], end_date: "2026-06-05" }] };
  render(<Gantt state={late} />);
  expect(screen.getByRole("button", { name: /Логотип/ })).toHaveClass("is-late");
});

it("показывает итог по дедлайну на языке читателя", () => {
  renderWithLocale(<Gantt state={STATE} />, "ru");
  expect(screen.getByText(/на 7 дней позже/i)).toBeInTheDocument();
});

it("сортирует строки по позиции, а при равенстве — по идентификатору", () => {
  const tied = { ...STATE, tasks: [
    { ...STATE.tasks[0], id: "t2", name: "Вторая", position: 1 },
    { ...STATE.tasks[0], id: "t1", name: "Первая", position: 1 },
  ]};
  render(<Gantt state={tied} />);
  const names = screen.getAllByRole("button", { name: /Первая|Вторая/ }).map((n) => n.textContent);
  expect(names).toEqual(["Первая", "Вторая"]);
});

it("пустой проект объясняет, что делать", () => {
  renderWithLocale(<Gantt state={{ ...STATE, categories: [], tasks: [] }} />, "ru");
  expect(screen.getByText(/ни одной категории/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run them and make sure they fail**

- [ ] **Step 3: Implement the header and the grid**

The header has two levels: the months on top, the days below with the date and the weekday. The non-working days are filled in both in the header and across the rows' full height. The grid is built once and reused by every row — with a hundred tasks, a hundred identical sets of a hundred days each is ten thousand nodes, and the page starts to lag.

- [ ] **Step 4: Implement the rows and the bars**

A bar is a button rather than a `div`: it will be clicked and walked with the keyboard, and that is the only way to get accessibility for free. The progress is drawn as a fill inside the bar. A task ending later than the deadline is painted and gets a flag in the left column.

- [ ] **Step 5: Implement the shell with the scroll**

A horizontal scroll with a pinned left column (`position: sticky`). On opening, the strip scrolls to today.

- [ ] **Step 6: Implement the project screen**

Loading, error and success are three explicit states. A 404 shows "the project was not found" rather than an empty chart: somebody else's project and a non-existent one are indistinguishable, and the interface must not pretend it knows the difference.

- [ ] **Step 7: Run the tests and commit**

```bash
cd frontend && npx vitest run src/gantt
git add frontend/src/gantt/ frontend/src/screens/Project.tsx
git commit -m "feat: the Gantt chart, read-only"
```

---

### Task 4: Creating categories

**Files:**
- Create: `frontend/src/screens/CategoryForm.tsx`
- Modify: `frontend/src/screens/Project.tsx`
- Test: `frontend/src/screens/CategoryForm.test.tsx`

**Interfaces:**
- Produces: a category creation form that sends the `create_category` operation.

- [ ] **Step 1: Write the failing tests**

```tsx
it("отправляет операцию создания категории и обновляет диаграмму", async () => {
  const sent: unknown[] = [];
  server.use(
    http.get("/api/projects/p1", () => HttpResponse.json(STATE)),
    http.post("/api/projects/p1/mutations", async ({ request }) => {
      sent.push(await request.json());
      return HttpResponse.json({ seq: 2, op: {}, inverse: {} }, { status: 201 });
    }),
  );

  renderApp({ route: "/projects/p1", locale: "ru" });
  await userEvent.click(await screen.findByRole("button", { name: /категория/i }));
  await userEvent.type(screen.getByLabelText(/название/i), "Аналитика");
  await userEvent.click(screen.getByRole("button", { name: /создать$/i }));

  await waitFor(() => expect(sent).toEqual([{ op: {
    type: "create_category", name: "Аналитика", color: expect.stringMatching(/^#[0-9a-f]{6}$/i),
  }}]));
});

it("не шлёт в операции полей, которых нет в публичном контракте", async () => {
  // position and category_id are assigned by the server; the client does not know them and should not
  const sent: any[] = [];
  server.use(
    http.get("/api/projects/p1", () => HttpResponse.json(STATE)),
    http.post("/api/projects/p1/mutations", async ({ request }) => {
      sent.push(await request.json());
      return HttpResponse.json({ seq: 2, op: {}, inverse: {} }, { status: 201 });
    }),
  );

  renderApp({ route: "/projects/p1", locale: "ru" });
  await createCategoryNamed("Аналитика");

  expect(sent[0].op).not.toHaveProperty("position");
  expect(sent[0].op).not.toHaveProperty("category_id");
});
```

- [ ] **Step 2: Run them and make sure they fail**

- [ ] **Step 3: Implement the form**

The colour is suggested from the palette by the number of already existing categories, but it is chosen by the person. After a success the project's state is refetched rather than written into the cache by hand: the server may have assigned a position differently from what the client expects, and the divergence would show up later in the most inconvenient place.

- [ ] **Step 4: Run the tests and commit**

```bash
cd frontend && npx vitest run src/screens/CategoryForm.test.tsx
git add frontend/src/screens/
git commit -m "feat: creating categories"
```

---

### Task 5: Creating tasks

**Files:**
- Create: `frontend/src/screens/TaskForm.tsx`
- Modify: `frontend/src/gantt/Row.tsx`
- Test: `frontend/src/screens/TaskForm.test.tsx`

**Interfaces:**
- Produces: a task creation form with fields for the name, the description, the category, the criticality, the start date, the duration and the owners.

- [ ] **Step 1: Write the failing tests**

```tsx
it("подставляет категорию, из строки которой открыли форму", async () => {
  server.use(
    http.get("/api/projects/p1", () => HttpResponse.json(STATE)),
    http.get("/api/org/members", () => HttpResponse.json(MEMBERS)),
  );

  renderApp({ route: "/projects/p1", locale: "ru" });
  await userEvent.click(await screen.findByRole("button", { name: /добавить задачу в «Дизайн»/i }));

  expect(screen.getByLabelText(/категория/i)).toHaveValue("c1");
});

it("отправляет операцию с длительностью в рабочих днях", async () => {
  const sent: any[] = [];
  server.use(
    http.get("/api/projects/p1", () => HttpResponse.json(STATE)),
    http.get("/api/org/members", () => HttpResponse.json(MEMBERS)),
    http.post("/api/projects/p1/mutations", async ({ request }) => {
      sent.push(await request.json());
      return HttpResponse.json({ seq: 3, op: {}, inverse: {} }, { status: 201 });
    }),
  );

  renderApp({ route: "/projects/p1", locale: "ru" });
  await fillTaskForm({ name: "Макеты", start: "2026-03-19", days: 14 });

  expect(sent[0].op).toMatchObject({
    type: "create_task", category_id: "c1", name: "Макеты",
    start_date: "2026-03-19", duration_days: 14,
  });
});

it("переводит отказ сервера по коду, а не показывает detail", async () => {
  server.use(
    http.get("/api/projects/p1", () => HttpResponse.json(STATE)),
    http.get("/api/org/members", () => HttpResponse.json(MEMBERS)),
    http.post("/api/projects/p1/mutations", () =>
      HttpResponse.json({ detail: "too_many_tasks" }, { status: 422 })),
  );

  renderApp({ route: "/projects/p1", locale: "ru" });
  await fillTaskForm({ name: "Макеты", start: "2026-03-19", days: 14 });

  expect(await screen.findByText(/слишком много задач/i)).toBeInTheDocument();
  expect(screen.queryByText("too_many_tasks")).not.toBeInTheDocument();
});

it("не даёт длительность меньше одного дня", async () => {
  server.use(
    http.get("/api/projects/p1", () => HttpResponse.json(STATE)),
    http.get("/api/org/members", () => HttpResponse.json(MEMBERS)),
  );

  renderApp({ route: "/projects/p1", locale: "ru" });
  await openTaskForm();
  await userEvent.clear(screen.getByLabelText(/рабочих дней/i));
  await userEvent.type(screen.getByLabelText(/рабочих дней/i), "0");

  expect(screen.getByRole("button", { name: /создать задачу/i })).toBeDisabled();
});
```

- [ ] **Step 2: Run them and make sure they fail**

- [ ] **Step 3: Implement the owner selection**

The list comes from `GET /api/org/members`. The `client` role does not get this route at all, so on a 403 refusal the owners block is simply not shown — rather than breaking the form.

- [ ] **Step 4: Implement the form and its entry point**

The plus on a category's row opens the form with the category already filled in. The button's caption includes the category's name, otherwise with a dozen categories all the pluses are indistinguishable on a screen reader.

The duration field is captioned "working days" rather than "days": these are different things, and a person who put 5 on a Friday should understand why the task ends on a Thursday.

- [ ] **Step 5: Run the whole suite and build**

```bash
cd frontend && npx vitest run && npm run build
```

- [ ] **Step 6: Check it live**

Against the real backend: create a project, two categories, three tasks with different durations and criticalities. Make sure the end dates match what `GET /api/projects/{id}` shows — and that a task started on a Friday jumps over the weekend.

- [ ] **Step 7: Commit**

```bash
git add frontend/
git commit -m "feat: creating tasks"
```

---

## What this plan does not do

- Dragging, editing in place, the task card, the history and the animation — plan 3.
- The link arrows are drawn by plan 3 together with the rest of the interactivity; in this plan `dependencies` arrive in the state but are not displayed.
- Plan approval, the baseline plan and the threshold with a reason — the next plan after the frontend cycle. The fields are already in the state and are ignored.
- Editing the project's settings: the deadline, the calendar, the threshold. They are displayed but not changed.
