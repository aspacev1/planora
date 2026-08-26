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
 * Настоящая прокрутка у ленты: в jsdom ширины и прокрутки у элементов нет, а
 * без ширины слой подкачки сознательно вырождается в пустышку — и ход ленты в
 * жест не попадал бы вовсе, то есть проверять было бы нечего.
 */
function scrollableTape(): (left: number) => void {
  const box = document.querySelector<HTMLElement>(".gantt__scroll");
  if (box === null) throw new Error("ленты нет");

  Object.defineProperty(box, "clientWidth", { value: 800, configurable: true });
  // Прямоугольник настоящий, а не нулевой: с нулевым любая точка указателя
  // оказывается за правым краем, и подкачка поехала бы сама.
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

    drag(bar, { fromX: 100, toX: 100 + 12 }); // меньше половины дня

    expect(sent).toHaveLength(0);
  });

  it("поднимает полоску над соседями на время жеста, но не от дрожания руки", async () => {
    renderProject();
    const bar = await screen.findByRole("button", { name: /Логотип/ });

    fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 102 });
    // Два пикселя — это ещё щелчок. Признак жеста меняет вид полоски, и
    // включать его на дрожании руки значит мигать им на каждом открытии
    // карточки.
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
    // Возврат до вопроса читался бы как отказ: человек ещё ничего не решил, а
    // полоска уже съездила обратно — и после ответа поехала бы второй раз.
    const sent = captureMutations();
    renderProject(APPROVED);
    const bar = await screen.findByRole("button", { name: /Логотип/ });
    const before = Number.parseFloat(bar.style.left);

    dragDays(bar, 7);

    await screen.findByRole("dialog");
    expect(sent).toHaveLength(0);
    // Место по датам не менялось: полоску держит сдвиг, а не `left` — двигают
    // её только через `transform` (см. useBarMotion).
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
    // Полоска и до ответа стояла здесь: смена дат её не двигает — она лишь
    // объясняет положение, в котором полоска уже стоит.
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
    // Полоска ушла за курсором сдвигом, а не местом по датам (см. useBarMotion).
    expect(bar.style.getPropertyValue("--bar-dx")).toBe(`${3 * DAY_WIDTH.day}px`);

    await userEvent.keyboard("{Escape}");

    // Полоска дома, и отпускание после Esc уже ничего не отправляет: жест
    // прерван, а не приостановлен.
    expect(bar.style.getPropertyValue("--bar-dx")).toBe("0px");
    expect(bar.style.left).toBe(before);
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 100 + 3 * DAY_WIDTH.day });
    fireEvent.click(bar, { clientX: 100 + 3 * DAY_WIDTH.day });

    expect(sent).toHaveLength(0);
    // И карточку прерванный жест не открывает: Esc означает «ничего не
    // делать», а не «открыть задачу».
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("называет все три сочетания прямо на полоске", async () => {
    // Возможность, о которой знает только исходник, всё равно что её нет.
    // Сочетаний три, потому что и жестов у полоски три: перенос, правая грань
    // и левая.
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

    // Стрелки у читателя ничего не двигают, и объявленное сочетание отправило
    // бы его нажимать клавиши, которые молчат.
    expect(bar).not.toHaveAttribute("aria-keyshortcuts");
  });

  it("подтверждённый перенос показывает тост с отменой", async () => {
    // Отмена из тоста бьёт в тот же /undo, что и кнопка в шапке: тост — это
    // короткий путь к ней, а не второй механизм отмены. Номер ревизии в теле
    // запроса — обещание кнопки: отменяется тот самый перенос, о котором тост
    // говорит, а не то, что окажется наверху журнала к моменту нажатия.
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
    // Нажатая отмена прячет тост: предлагать отменить отменённое нечестно.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("считает ленту, уехавшую во время жеста, — а не только пальцем пройденное", async () => {
    const sent = captureMutations();
    renderProject();
    const bar = await screen.findByRole("button", { name: /Логотип/ });
    const scrollTo = scrollableTape();

    fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 100 + DAY_WIDTH.day });
    // Палец стоит, лента едет: два дня приезжают из прокрутки, один пройден
    // рукой. Без учёта прокрутки задача легла бы на день, а не на три.
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

    // Нажали на полоску, чтобы открыть карточку, а лента в этот момент ещё
    // доезжала по инерции прокрутки, начатой до нажатия. Указатель не сдвинулся
    // ни разу — значит это щелчок, и сроков он не трогает.
    fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientX: 100 });
    scrollTo(5 * DAY_WIDTH.day);
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 100 });
    fireEvent.click(bar, { clientX: 100 });

    // По месту полоски, а не по пустоте отправленного: догадка ложится в кэш
    // синхронно, а до сервера операция доходит позже проверки — пустой список
    // не отличил бы «не отправляли» от «ещё не дошло». Полоска же стоит ровно
    // тогда, когда операции не случилось вовсе: догадку и отправку `commit`
    // делает одним вызовом.
    expect(bar.style.left).toBe(before);
  });

  it("гасит отмену в тосте, если верх журнала уехал", async () => {
    // Шесть секунд тоста — достаточный срок, чтобы сосед по проекту применил
    // свою правку. Отмена «последнего» сняла бы её, поэтому кнопка, обещавшая
    // вернуть свой перенос, гаснет вместе с обещанием.
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

    // Правка соседа: она же становится верхом журнала.
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
