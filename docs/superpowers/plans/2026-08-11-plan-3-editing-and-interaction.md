# Plan 3: dragging, editing, cards, animation — implementation plan

> **Historical.** This is one of the original build plans this codebase
> was built from — every step below has since shipped. It reflects the plan
> as scoped in August 2026, not necessarily today's implementation; for
> current architecture and conventions, see the repo's `CLAUDE.md` and the
> `planora-conventions` skill. Kept as a build-history record, not an active
> task list.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the chart from a picture into a tool: the bars move with the mouse, the rows are reordered, a task's card is edited in place, the history is read in the reader's language, and changes do not jerk the screen about.

**Architecture:** All the changes go through one path — an optimistic application to the local state, sending the operation, a rollback on a server refusal. That path is written once and reused by every gesture; otherwise every screen invents a rollback of its own, and they diverge. A task's history is assembled from the revision journal: the server sends an event with parameters, and the client substitutes them into a string in its own language.

**Tech Stack:** As in plans 1 and 2. No new dependencies: dragging is written on pointer events, the animation on CSS transitions.

## Global Constraints

- The end dates are computed by the server. After any change of dates the client takes the dates from the response rather than recomputing them itself.
- All the changes go as operations. The public contract does not accept `task_id` and `position` on creation — they are assigned by the server.
- The history is stored as an event with parameters and assembled into text at display time, in the reader's language. The shift's reason is the user's text and is not translated.
- Dragging a bar horizontally changes the dates, dragging a row by the left column vertically changes the order. One thing, one gesture — otherwise people will knock dates about while trying to reorder a row.
- The internal note is the only field with restricted visibility. Whether to show it is decided by the server: if it is not in the response, the block is not in the interface.
- Languages: `az` by default, `en`, `ru`. Numerals through `Intl.PluralRules`.
- The animation respects `prefers-reduced-motion`: with the setting on the transitions are switched off rather than sped up.
- Our own CSS with variables and a dark theme.

---

### Task 1: Optimistic changes with a rollback

**Files:**
- Create: `frontend/src/project/useProjectMutation.ts`
- Test: `frontend/src/project/useProjectMutation.test.tsx`

**Interfaces:**
- Produces: `useProjectMutation(projectId)` → `{ apply(op, optimistic, options?) }`, where `optimistic` is a function transforming the state locally before the server's answer.

This is the foundation of tasks 2–5. It is written first and separately, because every subsequent gesture uses it, and testing a rollback through mouse dragging is a torment.

- [x] **Step 1: Write the failing tests**

```tsx
it("показывает изменение до ответа сервера", async () => {
  let release: () => void;
  server.use(http.post("/api/projects/p1/mutations", () =>
    new Promise((r) => { release = () => r(HttpResponse.json(OK, { status: 201 })); })));

  const { result } = renderHook(() => useProjectMutation("p1"), { wrapper });
  act(() => { result.current.apply(MOVE_OP, moveTaskLocally); });

  expect(cachedState().tasks[0].start_date).toBe("2026-03-11");
  release!();
});

it("возвращает прежнее состояние, если сервер отказал", async () => {
  server.use(http.post("/api/projects/p1/mutations", () =>
    HttpResponse.json({ detail: "task_not_found" }, { status: 404 })));

  const { result } = renderHook(() => useProjectMutation("p1"), { wrapper });
  await act(async () => { await result.current.apply(MOVE_OP, moveTaskLocally).catch(() => {}); });

  expect(cachedState().tasks[0].start_date).toBe("2026-03-04");
});

it("берёт итоговые данные с сервера, а не оставляет оптимистичные", async () => {
  // сервер посчитал дату окончания по календарю — клиент обязан взять его версию
  server.use(
    http.post("/api/projects/p1/mutations", () => HttpResponse.json(OK, { status: 201 })),
    http.get("/api/projects/p1", () => HttpResponse.json({
      ...STATE, tasks: [{ ...STATE.tasks[0], start_date: "2026-03-11", end_date: "2026-03-17" }],
    })),
  );

  const { result } = renderHook(() => useProjectMutation("p1"), { wrapper });
  await act(async () => { await result.current.apply(MOVE_OP, moveTaskLocally); });

  await waitFor(() => expect(cachedState().tasks[0].end_date).toBe("2026-03-17"));
});

it("два изменения подряд откатываются каждое к своему состоянию", async () => {
  server.use(
    http.post("/api/projects/p1/mutations", () => HttpResponse.json(OK, { status: 201 })),
  );
  const { result } = renderHook(() => useProjectMutation("p1"), { wrapper });

  await act(async () => { await result.current.apply(MOVE_OP, moveTaskLocally); });

  server.use(http.post("/api/projects/p1/mutations", () =>
    HttpResponse.json({ detail: "task_not_found" }, { status: 404 })));
  await act(async () => { await result.current.apply(MOVE_OP_2, moveTaskLocally2).catch(() => {}); });

  // откат второго не должен отменить первое
  expect(cachedState().tasks[0].start_date).toBe("2026-03-11");
});
```

The last test catches a classic mistake: the snapshot for the rollback is taken once at mount time, and rolling back a second change returns the state to the very beginning, erasing the first.

- [x] **Step 2: Run them and make sure they fail**

- [x] **Step 3: Implement**

The snapshot is taken **immediately before every application** rather than in advance. After a success the project's state is refetched: the server may have computed the end date differently from the client's guess, and its version is the only right one.

- [x] **Step 4: Run the tests and commit**

```bash
cd frontend && npx vitest run src/project
git add frontend/src/project/
git commit -m "feat: оптимистичные изменения с честным откатом"
```

---

### Task 2: The task card

**Files:**
- Create: `frontend/src/task/TaskPanel.tsx`
- Modify: `frontend/src/gantt/Gantt.tsx`
- Test: `frontend/src/task/TaskPanel.test.tsx`

**Interfaces:**
- Produces: the task panel, opening on a click and closing with the cross, the Esc key and a repeat click on the same task.

- [x] **Step 1: Write the failing tests**

```tsx
it("по умолчанию скрыта, открывается кликом по задаче", async () => {
  renderProject();
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();

  await userEvent.click(await screen.findByRole("button", { name: /Логотип/ }));
  expect(screen.getByRole("complementary")).toBeInTheDocument();
});

it("закрывается по Esc, крестиком и повторным кликом по той же задаче", async () => {
  renderProject();
  const bar = await screen.findByRole("button", { name: /Логотип/ });

  await userEvent.click(bar);
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();

  await userEvent.click(bar);
  await userEvent.click(screen.getByRole("button", { name: /закрыть/i }));
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();

  await userEvent.click(bar);
  await userEvent.click(bar);
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
});

it("не показывает блок внутренней заметки, если сервер её не прислал", async () => {
  const withoutNote = { ...STATE, tasks: [{ ...STATE.tasks[0] }] };
  delete (withoutNote.tasks[0] as any).internal_note;
  renderProject(withoutNote);

  await userEvent.click(await screen.findByRole("button", { name: /Логотип/ }));
  expect(screen.queryByLabelText(/внутренняя заметка/i)).not.toBeInTheDocument();
});

it("показывает вычисленную сервером дату окончания и не считает её сама", async () => {
  renderProject();
  await userEvent.click(await screen.findByRole("button", { name: /Логотип/ }));
  expect(screen.getByText("10 мар")).toBeInTheDocument();
});
```

The third test is about the same visibility rule as on the server: the interface does not decide whether to show the note, it looks at whether it was sent.

- [x] **Step 2: Run them and make sure they fail**

- [x] **Step 3: Implement the panel**

The chart takes the whole width while the panel is closed. Opening it must not change the strip's horizontal scroll — otherwise the task that was clicked travels out of sight.

- [x] **Step 4: Run the tests and commit**

```bash
cd frontend && npx vitest run src/task
git add frontend/src/task/ frontend/src/gantt/
git commit -m "feat: карточка задачи"
```

---

### Task 3: Editing fields in place

**Files:**
- Modify: `frontend/src/task/TaskPanel.tsx`
- Create: `frontend/src/task/fields.tsx`
- Test: `frontend/src/task/TaskPanel.edit.test.tsx`

**Interfaces:**
- Produces: the panel's editable fields — the description, the category, the start, the duration, the criticality, the progress, the owners, the internal note.

- [x] **Step 1: Write the failing tests**

```tsx
it("сохраняет описание одной операцией, а не тремя", async () => {
  const sent = captureMutations();
  renderProject();
  await openPanel();

  await userEvent.clear(screen.getByLabelText(/описание/i));
  await userEvent.type(screen.getByLabelText(/описание/i), "Знак и логотип");
  await userEvent.tab();

  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0].op.type).toBe("set_task_fields");
});

it("не шлёт операцию, если значение не изменилось", async () => {
  const sent = captureMutations();
  renderProject();
  await openPanel();

  await userEvent.click(screen.getByLabelText(/описание/i));
  await userEvent.tab();

  expect(sent).toHaveLength(0);
});

it("смена даты старта уходит операцией переноса", async () => {
  const sent = captureMutations();
  renderProject();
  await openPanel();

  fireEvent.change(screen.getByLabelText(/старт/i), { target: { value: "2026-03-19" } });

  await waitFor(() => expect(sent[0].op).toMatchObject({
    type: "move_task", start_date: "2026-03-19" }));
});

it("возвращает прежнее значение, если сервер отказал", async () => {
  server.use(http.post("/api/projects/p1/mutations", () =>
    HttpResponse.json({ detail: "progress_out_of_range" }, { status: 422 })));

  renderProject();
  await openPanel();
  fireEvent.change(screen.getByLabelText(/выполнено/i), { target: { value: "150" } });

  expect(await screen.findByText(/от 0 до 100/i)).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText(/выполнено/i)).toHaveValue(40));
});

it("исполнители переключаются по одному и каждый своей операцией", async () => {
  const sent = captureMutations();
  renderProject();
  await openPanel();

  await userEvent.click(screen.getByRole("button", { name: /Мария/ }));
  await waitFor(() => expect(sent[0].op.type).toBe("assign_user"));

  await userEvent.click(screen.getByRole("button", { name: /Мария/ }));
  await waitFor(() => expect(sent[1].op.type).toBe("unassign_user"));
});
```

The second test matters for the history: a field that loses focus without changes must not leave a "changed the description" entry — otherwise the history feed fills with noise and stops being readable.

- [x] **Step 2: Run them and make sure they fail**

- [x] **Step 3: Implement the fields**

The three text fields leave in one `set_task_fields` operation, because a person perceives them as one action. The rest go in their own operations, because they are changed one at a time too.

There is no separate edit mode and no "save" button: a value leaves on blur or on a choice in a list.

- [x] **Step 4: Run the tests and commit**

```bash
cd frontend && npx vitest run src/task
git add frontend/src/task/
git commit -m "feat: правка полей задачи на месте"
```

---

### Task 4: Dragging dates

**Files:**
- Create: `frontend/src/gantt/useDragDates.ts`
- Modify: `frontend/src/gantt/Row.tsx`
- Test: `frontend/src/gantt/useDragDates.test.tsx`

**Interfaces:**
- Consumes: `buildScale`, `useProjectMutation`.
- Produces: dragging a bar horizontally in steps of exactly one day.

- [x] **Step 1: Write the failing tests**

```tsx
it("двигает полоску с шагом в целый день", async () => {
  const sent = captureMutations();
  renderProject();
  const bar = await screen.findByRole("button", { name: /Логотип/ });

  drag(bar, { fromX: 100, toX: 100 + 26 * 3 });

  await waitFor(() => expect(sent[0].op).toMatchObject({
    type: "move_task", start_date: "2026-03-07" }));
});

it("не отправляет ничего, если полоску вернули на место", async () => {
  const sent = captureMutations();
  renderProject();
  const bar = await screen.findByRole("button", { name: /Логотип/ });

  drag(bar, { fromX: 100, toX: 100 + 12 });   // меньше половины дня

  expect(sent).toHaveLength(0);
});

it("не открывает карточку по окончании перетаскивания", async () => {
  renderProject();
  const bar = await screen.findByRole("button", { name: /Логотип/ });

  drag(bar, { fromX: 100, toX: 100 + 26 * 2 });

  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
});

it("возвращает полоску на место, если сервер отказал", async () => {
  server.use(http.post("/api/projects/p1/mutations", () =>
    HttpResponse.json({ detail: "task_not_found" }, { status: 404 })));

  renderProject();
  const bar = await screen.findByRole("button", { name: /Логотип/ });
  const before = bar.style.left;

  drag(bar, { fromX: 100, toX: 100 + 26 * 3 });

  await waitFor(() => expect(bar.style.left).toBe(before));
});

it("клавиатура двигает задачу так же, как мышь", async () => {
  const sent = captureMutations();
  renderProject();
  const bar = await screen.findByRole("button", { name: /Логотип/ });

  bar.focus();
  await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");

  await waitFor(() => expect(sent[0].op).toMatchObject({
    type: "move_task", start_date: "2026-03-05" }));
});
```

The third test closes an irritating detail: without it every drag ends with a card being opened, because after the button is released the browser sends a click.

The fifth is not a luxury: the bar is declared a button, and a person working from the keyboard must have a way to move a task.

- [x] **Step 2: Run them and make sure they fail**

- [x] **Step 3: Implement**

Pointer events (`pointerdown`/`pointermove`/`pointerup`) with pointer capture rather than mouse ones: the capture guarantees that a drag is not lost if the cursor leaves the strip's edge, and it works on a tablet as a bonus.

The offset in days is computed through the scale rather than by dividing by a "day's width" by hand. Zero days — we send nothing.

- [x] **Step 4: Run the tests and commit**

```bash
cd frontend && npx vitest run src/gantt/useDragDates.test.tsx
git add frontend/src/gantt/
git commit -m "feat: перетаскивание дат"
```

---

### Task 5: Reordering rows

**Files:**
- Create: `frontend/src/gantt/useReorder.ts`
- Modify: `frontend/src/gantt/Row.tsx`
- Test: `frontend/src/gantt/useReorder.test.tsx`

**Interfaces:**
- Produces: dragging a row by the left column with an insertion line; a drop on a category's heading moves the task into it.

- [x] **Step 1: Write the failing tests**

```tsx
it("перетаскивание за левую колонку меняет порядок, а не даты", async () => {
  const sent = captureMutations();
  renderProject(THREE_TASKS);

  dragRow("Третья", { over: "Первая", half: "top" });

  await waitFor(() => expect(sent[0].op).toMatchObject({
    type: "reorder_task", position: 0 }));
  expect(sent[0].op).not.toHaveProperty("start_date");
});

it("бросок на заголовок категории переносит задачу в неё", async () => {
  const sent = captureMutations();
  renderProject(TWO_CATEGORIES);

  dragRow("Логотип", { over: "Разработка", isCategory: true });

  await waitFor(() => expect(sent[0].op).toMatchObject({
    type: "reorder_task", category_id: "c2" }));
});

it("показывает линию вставки сверху или снизу в зависимости от курсора", () => {
  renderProject(THREE_TASKS);

  hoverRowWhileDragging("Третья", { over: "Первая", half: "top" });
  expect(rowOf("Первая")).toHaveClass("drop-before");

  hoverRowWhileDragging("Третья", { over: "Первая", half: "bottom" });
  expect(rowOf("Первая")).toHaveClass("drop-after");
});

it("перетаскивание полоски не меняет порядок", async () => {
  const sent = captureMutations();
  renderProject(THREE_TASKS);

  drag(await screen.findByRole("button", { name: /Третья/ }), { fromX: 100, toX: 152 });

  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0].op.type).toBe("move_task");
});

it("в гостевом режиме строки не перетаскиваются", () => {
  renderProject(THREE_TASKS, { canWrite: false });
  expect(rowHandle("Первая")).not.toBeInTheDocument();
});
```

The first and fourth tests together pin down the separation of the gestures — the very thing it was introduced for.

- [x] **Step 2: Run them and make sure they fail**

- [x] **Step 3: Implement**

The drag handle appears on hovering a row. The server pushes the neighbours apart itself and writes their shifts into the journal — the client sends only the target position and category.

- [x] **Step 4: Run the tests and commit**

```bash
cd frontend && npx vitest run src/gantt/useReorder.test.tsx
git add frontend/src/gantt/
git commit -m "feat: перестановка строк перетаскиванием"
```

---

### Task 6: A task's history

**Files:**
- Create: `frontend/src/task/History.tsx`
- Create: `frontend/src/task/formatEvent.ts`
- Create: `frontend/src/api/revisions.ts`
- Test: `frontend/src/task/formatEvent.test.ts`

**Interfaces:**
- Consumes: the revision journal filtered by task.
- Produces: `formatEvent(op, locale) -> string`; the history block in the card.

This is where the decision to store an event with parameters rather than a ready phrase pays off: one and the same entry is read in three languages.

- [x] **Step 1: Write the failing tests**

```ts
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
    type: "set_task_fields", task_id: "t1",
    from: { name: "Лого", description: "", internal_note: "" },
    to: { name: "Лого", description: "Знак", internal_note: "" },
  };
  expect(formatEvent(op, "ru")).toBe("изменил описание");
});

it("не падает на неизвестном типе события", () => {
  expect(formatEvent({ type: "invented_later", task_id: "t1" }, "ru")).toBe("изменил задачу");
});
```

The last test is about compatibility: the journal will outlive the application's versions, and an entry made by a new version must not bring the card down in an old tab.

- [x] **Step 2: Run them and make sure they fail**

- [x] **Step 3: Implement**

The shift's reason is printed as is, without translation: it is the user's text.

- [x] **Step 4: Implement the history block**

The new entries on top. The date and the author stand next to the event.

- [x] **Step 5: Run the tests and commit**

```bash
cd frontend && npx vitest run src/task
git add frontend/src/task/ frontend/src/api/revisions.ts
git commit -m "feat: история задачи на языке читателя"
```

---

### Task 7: Motion and the link arrows

**Files:**
- Modify: `frontend/src/gantt/gantt.css`
- Create: `frontend/src/gantt/Arrows.tsx`
- Test: `frontend/src/gantt/Arrows.test.tsx`, `frontend/src/gantt/motion.test.tsx`

**Interfaces:**
- Produces: the link arrows layer; transitions on a bar appearing, disappearing and moving.

- [x] **Step 1: Write the failing tests**

```tsx
it("рисует стрелку между связанными задачами", () => {
  const { container } = renderProject(WITH_DEPENDENCY);
  expect(container.querySelectorAll("svg.arrows polyline")).toHaveLength(1);
});

it("перерисовывает стрелки при открытии карточки", async () => {
  const { container } = renderProject(WITH_DEPENDENCY);
  const before = container.querySelector("polyline")!.getAttribute("points");

  await userEvent.click(screen.getByRole("button", { name: /Логотип/ }));

  await waitFor(() => {
    expect(container.querySelector("polyline")!.getAttribute("points")).not.toBe(before);
  });
});

it("отключает переходы, если человек просил меньше движения", () => {
  matchMediaMock("(prefers-reduced-motion: reduce)", true);
  const { container } = renderProject();
  expect(container.querySelector(".gantt")).toHaveClass("motion-off");
});
```

The second test catches a mistake that has already happened in the prototype: the arrows are computed from the bars' positions, and when the area's width changes they drift off unless they are recomputed.

- [x] **Step 2: Run them and make sure they fail**

- [x] **Step 3: Implement the arrows**

An SVG layer on top of the strip, with the coordinates computed from the bars' real positions after the render.

- [x] **Step 4: Implement the transitions**

What is animated: a bar appearing and disappearing, a bar moving after the server's confirmation, the task panel sliding out, the insertion line during a drag.

What is **not** animated: the bar under the cursor during a drag — it must follow the finger without delay, otherwise the gesture feels viscous.

With `prefers-reduced-motion: reduce` the transitions are switched off entirely.

- [x] **Step 5: Run the whole suite and build**

```bash
cd frontend && npx vitest run && npm run build
```

- [x] **Step 6: Check it live**

Against the real backend, the full scenario: create a project with two categories and four tasks, link two with an arrow, move the bars with the mouse and the keyboard, reorder the rows, move a task into another category, edit the fields in the card, read the history in all three languages in turn. Separately, check that everything survived a page reload — that is, that the operations really reached the server rather than staying an optimistic illusion.

- [x] **Step 7: Commit**

```bash
git add frontend/
git commit -m "feat: стрелки связей и движение интерфейса"
```

---

## What this plan does not do

- Plan approval, the baseline plan, the threshold with a mandatory reason and the ghost under the bar — the next plan. The `baseline_start` and `baseline_duration` fields arrive in the state and are not displayed yet.
- Live updates over WebSocket, public links and comments — the plan after that.
- Undoing an action. The mechanism exists on the server, the route does not; the button will appear together with rolling back an AI batch.
- The chart's scale (week, month). The scale is parameterized by the day's width, so a switcher will be added cheaply, but it is not part of this plan.
- Editing the project's settings: the deadline, the calendar, the shift threshold.
