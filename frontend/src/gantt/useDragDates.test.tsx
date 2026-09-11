import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { drag, dragDays } from "../test/pointer";
import { APPROVED, STATE, captureMutations, projectFixtures, renderProject } from "../test/project";
import { server } from "../test/server";
import { lastSocket } from "../test/socket";
import { DAY_WIDTH } from "./scale";

beforeEach(projectFixtures);

/**
 * A real scroll on the strip: in jsdom elements have no widths and no scrolling, and
 * without a width the edge-scroll layer deliberately degenerates into a stub — so the
 * strip's travel would not enter the gesture at all, that is, there would be nothing
 * to check.
 */
function scrollableTape(): (left: number) => void {
  const box = document.querySelector<HTMLElement>(".gantt__scroll");
  if (box === null) throw new Error("ленты нет");

  Object.defineProperty(box, "clientWidth", { value: 800, configurable: true });
  // The rectangle is real rather than zero: with a zero one any pointer point turns
  // out to be beyond the right edge, and the scrolling would start by itself.
  box.getBoundingClientRect = () =>
    ({ left: 0, right: 800, top: 0, bottom: 400, width: 800, height: 400, x: 0, y: 0 }) as DOMRect;

  let scrollLeft = 0;
  Object.defineProperty(box, "scrollLeft", {
    configurable: true,
    get: () => scrollLeft,
    set(next: number) {
      scrollLeft = next;
      box.dispatchEvent(new Event("scroll"));
    },
  });

  return (left: number) => {
    box.scrollLeft = left;
  };
}


describe("перетаскивание дат", () => {
  it("двигает полоску с шагом в целый день", async () => {
    const sent = captureMutations();
    renderProject();
    const bar = await screen.findByRole("button", { name: /Логотип/ });

    dragDays(bar, 3);

    await waitFor(() =>
      expect(sent[0].op).toMatchObject({ type: "move_task", start_date: "2026-03-07" }),
    );
  });

  it("не отправляет ничего, если полоску вернули на место", async () => {
    const sent = captureMutations();
    renderProject();
    const bar = await screen.findByRole("button", { name: /Логотип/ });

    drag(bar, { fromX: 100, toX: 100 + 12 }); // less than half a day

    expect(sent).toHaveLength(0);
  });

  it("поднимает полоску над соседями на время жеста, но не от дрожания руки", async () => {
    renderProject();
    const bar = await screen.findByRole("button", { name: /Логотип/ });

    fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 102 });
    // Two pixels is still a click. The gesture flag changes the bar's appearance, and
    // switching it on from a trembling hand means flashing it every time a card is
    // opened.
    expect(bar).not.toHaveClass("is-dragging");

    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 160 });
    expect(bar).toHaveClass("is-dragging");

    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 160 });
    expect(bar).not.toHaveClass("is-dragging");
  });

  it("не открывает карточку по окончании перетаскивания", async () => {
    renderProject();
    const bar = await screen.findByRole("button", { name: /Логотип/ });

    dragDays(bar, 2);

    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("возвращает полоску на место, если сервер отказал", async () => {
    server.use(
      http.post("/api/projects/p1/mutations", () =>
        HttpResponse.json({ detail: "task_not_found" }, { status: 404 }),
      ),
    );

    renderProject();
    const bar = await screen.findByRole("button", { name: /Логотип/ });
    const before = bar.style.left;

    dragDays(bar, 3);

    await waitFor(() => expect(bar.style.left).toBe(before));
  });

  it("держит полоску на месте броска, пока спрашивают причину", async () => {
    // A return before the question would read as a refusal: the person has decided
    // nothing yet while the bar has already travelled back — and after the answer it
    // would travel a second time.
    const sent = captureMutations();
    renderProject(APPROVED);
    const bar = await screen.findByRole("button", { name: /Логотип/ });
    const before = Number.parseFloat(bar.style.left);

    dragDays(bar, 7);

    await screen.findByRole("dialog");
    expect(sent).toHaveLength(0);
    // The place by dates has not changed: the bar is held by an offset rather than by
    // `left` — it is moved only through `transform` (see useBarMotion).
    expect(Number.parseFloat(bar.style.left)).toBe(before);
    expect(bar.style.getPropertyValue("--bar-dx")).toBe(`${7 * DAY_WIDTH.day}px`);
  });

  it("возвращает полоску, когда причину объяснять отказались", async () => {
    renderProject(APPROVED);
    const bar = await screen.findByRole("button", { name: /Логотип/ });
    const before = bar.style.left;

    dragDays(bar, 7);
    await screen.findByRole("dialog");

    await userEvent.click(screen.getByRole("button", { name: "Вернуть" }));

    await waitFor(() => expect(bar.style.left).toBe(before));
  });

  it("после введённой причины полоска стоит на новом месте и не ездит дважды", async () => {
    renderProject(APPROVED);
    const bar = await screen.findByRole("button", { name: /Логотип/ });
    const before = Number.parseFloat(bar.style.left);

    dragDays(bar, 7);
    await screen.findByRole("dialog");

    await userEvent.type(screen.getByLabelText("Причина"), "заказчик молчит");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // The bar stood here before the answer too: a change of dates does not move it —
    // it merely explains the position the bar is already in.
    expect(Number.parseFloat(bar.style.left)).toBe(before + 7 * DAY_WIDTH.day);
  });

  it("клавиатура двигает задачу так же, как мышь", async () => {
    const sent = captureMutations();
    renderProject();
    const bar = await screen.findByRole("button", { name: /Логотип/ });

    bar.focus();
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");

    await waitFor(() =>
      expect(sent[0].op).toMatchObject({ type: "move_task", start_date: "2026-03-05" }),
    );
  });

  it("Esc прерывает начатое перетаскивание", async () => {
    const sent = captureMutations();
    renderProject();
    const bar = await screen.findByRole("button", { name: /Логотип/ });
    const before = bar.style.left;

    fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 100 + 3 * DAY_WIDTH.day });
    // The bar followed the cursor by an offset rather than by its place by dates (see useBarMotion).
    expect(bar.style.getPropertyValue("--bar-dx")).toBe(`${3 * DAY_WIDTH.day}px`);

    await userEvent.keyboard("{Escape}");

    // The bar is home, and a release after Esc no longer sends anything: the gesture
    // was aborted, not paused.
    expect(bar.style.getPropertyValue("--bar-dx")).toBe("0px");
    expect(bar.style.left).toBe(before);
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 100 + 3 * DAY_WIDTH.day });
    fireEvent.click(bar, { clientX: 100 + 3 * DAY_WIDTH.day });

    expect(sent).toHaveLength(0);
    // And an aborted gesture does not open the card: Esc means "do nothing", not "open
    // the task".
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("называет все три сочетания прямо на полоске", async () => {
    // A capability only the source knows about might as well not exist. There are
    // three combinations because the bar has three gestures: the move, the right edge
    // and the left one.
    renderProject();
    const bar = await screen.findByRole("button", { name: /Логотип/ });

    expect(bar).toHaveAttribute(
      "aria-keyshortcuts",
      "Shift+ArrowLeft Shift+ArrowRight Alt+ArrowLeft Alt+ArrowRight Shift+Alt+ArrowLeft Shift+Alt+ArrowRight",
    );
  });

  it("читателю сочетания не обещает", async () => {
    renderProject(STATE, { canWrite: false });
    const bar = await screen.findByRole("button", { name: /Логотип/ });

    // The arrows move nothing for a reader, and an announced combination would send
    // them pressing keys that stay silent.
    expect(bar).not.toHaveAttribute("aria-keyshortcuts");
  });

  it("подтверждённый перенос показывает тост с отменой", async () => {
    // Undo from the toast hits the same /undo as the header button: the toast is a
    // shortcut to it rather than a second undo mechanism. The revision number in the
    // request body is the button's promise: what gets undone is the very move the
    // toast talks about, not whatever ends up on top of the journal by the time of the press.
    const undos: { expected_seq?: number }[] = [];
    server.use(
      http.post("/api/projects/p1/undo", async ({ request }) => {
        undos.push((await request.json()) as { expected_seq?: number });
        return HttpResponse.json({ seq: 2 });
      }),
    );

    renderProject();
    const bar = await screen.findByRole("button", { name: /Логотип/ });

    bar.focus();
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");

    const toast = await screen.findByRole("status");
    expect(toast).toHaveTextContent("Задача перенесена");

    await userEvent.click(screen.getByRole("button", { name: "Отменить" }));
    await waitFor(() => expect(undos).toEqual([{ expected_seq: 1 }]));
    // A pressed undo hides the toast: offering to undo what has been undone is dishonest.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("считает ленту, уехавшую во время жеста, — а не только пальцем пройденное", async () => {
    const sent = captureMutations();
    renderProject();
    const bar = await screen.findByRole("button", { name: /Логотип/ });
    const scrollTo = scrollableTape();

    fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 100 + DAY_WIDTH.day });
    // The finger is still, the strip is moving: two days come from the scroll, one was
    // covered by hand. Without accounting for the scroll the task would land on one day rather than three.
    scrollTo(2 * DAY_WIDTH.day);
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 100 + DAY_WIDTH.day });
    fireEvent.click(bar, { clientX: 100 + DAY_WIDTH.day });

    await waitFor(() =>
      expect(sent[0].op).toMatchObject({ type: "move_task", start_date: "2026-03-07" }),
    );
  });

  it("не двигает задачу, если под неподвижным пальцем доехала лента", async () => {
    renderProject();
    const bar = await screen.findByRole("button", { name: /Логотип/ });
    const scrollTo = scrollableTape();
    const before = bar.style.left;

    // The bar was pressed to open the card while the strip at that moment was still
    // coasting from a scroll started before the press. The pointer never moved — so
    // this is a click, and it does not touch the dates.
    fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientX: 100 });
    scrollTo(5 * DAY_WIDTH.day);
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 100 });
    fireEvent.click(bar, { clientX: 100 });

    // By the bar's place rather than by the emptiness of what was sent: the guess lands
    // in the cache synchronously, while the operation reaches the server later than the
    // check — an empty list would not tell "we did not send" from "it has not arrived
    // yet". The bar, meanwhile, stands still exactly when no operation happened at all:
    // `commit` does the guess and the send in one call.
    expect(bar.style.left).toBe(before);
  });

  it("дроп за горизонтом коммитит показанный день, а не край окна", async () => {
    const sent = captureMutations();
    renderProject();
    const bar = await screen.findByRole("button", { name: /Логотип/ });

    // The fixture's window ends on 30 June (the last date is project_end, rounded up to
    // the end of the month). A hundred and thirty days to the right is far beyond its
    // edge; such a drop used to be clamped to 30 June, and the toast named a day nobody
    // was aiming at.
    dragDays(bar, 130);

    await waitFor(() =>
      expect(sent[0].op).toMatchObject({ type: "move_task", start_date: "2026-07-12" }),
    );
  });

  it("окно дотягивается за жестом и не дёргается на броске", async () => {
    renderProject();
    const bar = await screen.findByRole("button", { name: /Логотип/ });
    const days = () => document.querySelectorAll(".gantt__grid-day").length;
    expect(days()).toBe(122); // March to June: the fixture's window ends on 30 June

    fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 100 + 130 * DAY_WIDTH.day });
    // The bar's end landed on 18 July — the window grew to the end of July with the
    // same rounding the strip builds it with itself. The grid exists everywhere the bar
    // travelled rather than breaking off at the former edge.
    expect(days()).toBe(153);

    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 100 + 130 * DAY_WIDTH.day });
    fireEvent.click(bar, { clientX: 100 + 130 * DAY_WIDTH.day });
    // The drop released the extension, but the guess put the new dates into the state
    // with the same event — the window was recomputed from them and did not change by a day.
    expect(days()).toBe(153);
  });

  it("Esc возвращает и достроенное окно", async () => {
    renderProject();
    const bar = await screen.findByRole("button", { name: /Логотип/ });
    const days = () => document.querySelectorAll(".gantt__grid-day").length;

    fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 100 + 130 * DAY_WIDTH.day });
    expect(days()).toBe(153);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(days()).toBe(122);
  });

  it("гасит отмену в тосте, если верх журнала уехал", async () => {
    // Six seconds of a toast is time enough for a colleague on the project to apply
    // their own edit. Undoing "the last one" would remove it, so the button that
    // promised to revert your own move goes dark together with the promise.
    let undone = 0;
    server.use(
      http.post("/api/projects/p1/undo", () => {
        undone += 1;
        return HttpResponse.json({ seq: 3 });
      }),
    );

    renderProject();
    const bar = await screen.findByRole("button", { name: /Логотип/ });

    bar.focus();
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");

    await screen.findByRole("status");
    const undo = screen.getByRole("button", { name: "Отменить" });
    expect(undo).toBeEnabled();

    // A colleague's edit: it also becomes the top of the journal.
    server.use(
      http.get("/api/projects/p1", () =>
        HttpResponse.json({
          ...STATE,
          undoable: { seq: 2, op: { type: "set_progress", task_id: "t1" }, batch_id: null },
        }),
      ),
    );
    act(() => lastSocket().emit({ type: "revision", seq: 2 }));

    await waitFor(() => expect(undo).toBeDisabled());
    await userEvent.click(undo);
    expect(undone).toBe(0);
  });
});
