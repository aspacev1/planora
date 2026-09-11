import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectState } from "../api/projects";
import type { Locale } from "../i18n";
import { Providers, renderWithProviders } from "../test/utils";
import { Gantt } from "./Gantt";
import { COLLAPSED_WIDTH, DEFAULT_WIDTH } from "./columns";
import { DAY_WIDTH } from "./scale";
import { useGanttView } from "./useGanttView";

const STATE: ProjectState = {
  id: "p1",
  name: "Редизайн",
  slug: "redizayn",
  deadline: "2026-06-01",
  project_end: "2026-06-08",
  plan_approved_at: null,
  plan_version: 0,
  undoable: null,
  // Calendar mode: the existing tests' fixtures live on real dates. Relative
  // projects build their own state on top of this (see the relative-scale
  // tests).
  schedule_mode: "calendar" as const,
  start_date: null,

  calendar: { working_days: 31, holidays: ["2026-03-20"], extra_workdays: [] },
  categories: [{ id: "c1", name: "Дизайн", color: "#3b82f6", position: 0 }],
  tasks: [
    {
      id: "t1",
      category_id: "c1",
      name: "Логотип",
      start_date: "2026-03-04",
      end_date: "2026-03-10",
      duration_days: 5,
      milestone: false,
      critical: false,
      criticality: "high",
      risk: "green",
      risk_note: "",
      status: "in_progress",
      progress_pct: 40,
      position: 0,
      assignee_ids: [],
      baseline_start: null,
      baseline_duration: null,
      baseline_end: null,
    },
  ],
  dependencies: [],
};

/**
 * The chart reads the language from the provider: the deadline verdict is a
 * phrase, not a picture. So we always render it inside the providers, as in the
 * application.
 *
 * Without `canWrite` and without `onSelectTask` — that is, read-only, as on a
 * public page. In that form a bar is declared an image rather than a button (see
 * Bar in Row.tsx), and the tests below ask for it by the `img` role. What they
 * check is the drawing — width, class, order — and not a control's behaviour.
 */
function draw(state: ProjectState, locale: Locale = "ru") {
  return renderWithProviders(<Gantt projectId="p1" state={state} />, { locale });
}

/**
 * A strip whose view is owned by the screen — as on the project's working
 * screen, where the scale and "View" stand in the header rather than above the
 * strip (see `viewState`).
 */
function Controlled({ state }: { state: ProjectState }) {
  const view = useGanttView("p1");
  return <Gantt projectId="p1" state={state} viewState={view} />;
}

describe("диаграмма", () => {
  afterEach(() => vi.restoreAllMocks());

  it("рисует задачу полоской нужной ширины", () => {
    draw(STATE);
    const bar = screen.getByRole("img", { name: /Логотип/ });
    // 4-10 March is seven calendar days. The width is set as a property rather
    // than as `width`: the bar is stretched by its edge, and the finger's offset
    // is added to it (see --bar-dw in gantt.css).
    expect(bar.style.getPropertyValue("--bar-w")).toBe(`${7 * DAY_WIDTH.day}px`);
  });

  it("ставит полоску в её день, а не в начало ленты", () => {
    const { container } = draw(STATE);
    // The window opens from the first day of the earliest task's month: 4 March
    // is three days away from 1 March.
    expect(container.querySelector<HTMLElement>(".gantt__bar")).toHaveStyle({
      left: `${3 * DAY_WIDTH.day}px`,
    });
  });

  it("заливает выходные и праздники", () => {
    const { container } = draw(STATE);
    expect(container.querySelectorAll(".is-nonworking").length).toBeGreaterThan(0);
    expect(container.querySelector('[data-day="2026-03-20"]')).toHaveClass("is-nonworking");
  });

  it("рабочий день не залит", () => {
    const { container } = draw(STATE);
    // 19 March 2026 is a Thursday and not a holiday.
    expect(container.querySelector('[data-day="2026-03-19"]')).not.toHaveClass("is-nonworking");
  });

  it("рабочая суббота из календаря перебивает выходной", () => {
    const { container } = draw({
      ...STATE,
      calendar: { ...STATE.calendar, extra_workdays: ["2026-03-21"] },
    });
    expect(container.querySelector('[data-day="2026-03-21"]')).not.toHaveClass("is-nonworking");
  });

  it("ведёт линию «сегодня» серединой колонки и подписывает её в шапке", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 11, 9, 0)));
    try {
      const { container } = draw(STATE);
      // 11 March is the tenth day from the window's start (1 March), and the
      // line stands in the middle of its column rather than at its left edge.
      expect(container.querySelector<HTMLElement>(".gantt__today")).toHaveStyle({
        left: `${10 * DAY_WIDTH.day + DAY_WIDTH.day / 2}px`,
      });
      const day = container.querySelector('.gantt__day[data-day="2026-03-11"]');
      expect(day).toHaveClass("is-today");
      expect(day?.querySelector(".gantt__day-today")).toHaveTextContent("Сегодня");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ведёт линию «сегодня» по поясу проекта, а не по UTC", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // 02:30 on the eleventh of March in Baku is still 22:30 on the tenth in UTC.
    // Before the fix the strip showed yesterday's date all night.
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 10, 22, 30)));
    try {
      const { container } = draw({
        ...STATE,
        settings: { shift_threshold_days: 2, timezone: "Asia/Baku" },
      });

      expect(container.querySelector('.gantt__day[data-day="2026-03-11"]')).toHaveClass("is-today");
      expect(container.querySelector('.gantt__day[data-day="2026-03-10"]')).not.toHaveClass(
        "is-today",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("красит задачу, заезжающую за дедлайн", () => {
    draw({ ...STATE, tasks: [{ ...STATE.tasks[0], end_date: "2026-06-05" }] });
    expect(screen.getByRole("img", { name: /Логотип/ })).toHaveClass("is-late");
  });

  it("задача, кончающаяся ровно в день дедлайна, не просрочена", () => {
    draw({ ...STATE, tasks: [{ ...STATE.tasks[0], end_date: "2026-06-01" }] });
    expect(screen.getByRole("img", { name: /Логотип/ })).not.toHaveClass("is-late");
  });

  it("показывает итог по дедлайну на языке читателя", () => {
    draw(STATE, "ru");
    expect(screen.getByText(/на 7 дней позже/i)).toBeInTheDocument();
  });

  it("укладывающийся в дедлайн проект получает свой итог, а не тот же самый", () => {
    draw({ ...STATE, project_end: "2026-05-27" }, "ru");
    expect(screen.getByText(/запас 5 дней/i)).toBeInTheDocument();
  });

  it("сортирует строки по позиции, а при равенстве — по идентификатору", () => {
    draw({
      ...STATE,
      tasks: [
        { ...STATE.tasks[0], id: "t2", name: "Вторая", position: 1 },
        { ...STATE.tasks[0], id: "t1", name: "Первая", position: 1 },
      ],
    });
    // By the accessible name rather than by the content: a task's name lives in
    // the left column and in the bar's aria-label, the text does not belong to
    // the bar itself.
    const names = screen
      .getAllByRole("img", { name: /Первая|Вторая/ })
      .map((node) => node.getAttribute("aria-label"));
    expect(names).toEqual([
      expect.stringContaining("Первая"),
      expect.stringContaining("Вторая"),
    ]);
  });

  it("пустой проект объясняет, что делать", () => {
    draw({ ...STATE, categories: [], tasks: [] }, "ru");
    expect(screen.getByText(/ни одной категории/i)).toBeInTheDocument();
  });

  it("категория без задач всё равно видна", () => {
    // Otherwise a just-created category disappears, and the person decides that
    // the creation did not work.
    draw({ ...STATE, tasks: [] }, "ru");
    expect(screen.getByText("Дизайн")).toBeInTheDocument();
    expect(screen.queryByText(/ни одной категории/i)).not.toBeInTheDocument();
  });

  it("сетка строится один раз, а не по набору дней на каждую строку", () => {
    const many = draw({
      ...STATE,
      tasks: [
        { ...STATE.tasks[0], id: "t1", name: "Раз", position: 0 },
        { ...STATE.tasks[0], id: "t2", name: "Два", position: 1 },
        { ...STATE.tasks[0], id: "t3", name: "Три", position: 2 },
      ],
    });
    const one = draw(STATE);
    // There are as many day cells as with a single task: the grid is shared. A
    // hundred tasks over a hundred days would otherwise give ten thousand nodes.
    expect(many.container.querySelectorAll(".gantt__grid-day").length).toBe(
      one.container.querySelectorAll(".gantt__grid-day").length,
    );
  });

  it("прогресс задачи виден в полоске", () => {
    draw(STATE);
    // The percentage is a property on the bar: both the fill's width and the
    // place of the grip that drags it are computed from it, and a second number
    // here would diverge from the first on the very first edit.
    const bar = screen.getByRole("img", { name: /Логотип/ });
    expect(bar.style.getPropertyValue("--progress")).toBe("40%");
  });

  it("легенда включается через меню «Вид» и расшифровывает статусы", async () => {
    const { container } = draw(STATE, "ru");
    // By default there is no legend — as in the mockup.
    expect(container.querySelector(".gantt__legend")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Вид" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Легенда" }));

    const legend = container.querySelector(".gantt__legend");
    expect(legend).toBeInTheDocument();
    expect(legend).toHaveTextContent("В работе");
    expect(legend).toHaveTextContent("Готово");
    expect(legend).toHaveTextContent("Запланировано");
    expect(legend).toHaveTextContent("Заблокировано");
    expect(legend).toHaveTextContent("Блокер");
  });

  it("«Вид» несёт и колонки таблицы, и слои: двух кнопок об одном в ряду нет", async () => {
    draw(STATE, "ru");

    // There is no separate "Columns" button in the toolbar any more — the row
    // was overloaded, and both buttons answered the one question "what to show".
    expect(screen.queryByRole("button", { name: "Колонки" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Вид" }));

    // Both parts are named with headings: without them a list of nine
    // checkboxes would have to be read through in full for the sake of any one.
    const menu = screen.getByRole("button", { name: "Вид" }).nextElementSibling;
    expect(menu).toHaveTextContent("Колонки");
    expect(menu).toHaveTextContent("Слои");
    expect(screen.getByRole("checkbox", { name: "Длительность" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Легенда" })).toBeInTheDocument();
  });

  it("колонка включается из того же меню, что и слои", async () => {
    const { container } = draw(STATE, "ru");
    const header = () => container.querySelector(".gantt__corner");

    // By default there is no duration in the table — it is one of the columns
    // that have to be asked for.
    expect(header()).not.toHaveTextContent("Длительность");

    await userEvent.click(screen.getByRole("button", { name: "Вид" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Длительность" }));

    expect(header()).toHaveTextContent("Длительность");
  });

  it("статус полоски — хранимое поле, а не вывод из дат", () => {
    // The point of moving to a stored status: "blocked" cannot be derived from
    // dates, and "planned" can also stand on a task already started by its dates.
    draw({
      ...STATE,
      tasks: [
        { ...STATE.tasks[0], id: "t1", name: "Идёт", position: 0, status: "in_progress" },
        {
          ...STATE.tasks[0],
          id: "t2",
          name: "Сделана",
          position: 1,
          status: "done",
          progress_pct: 100,
        },
        { ...STATE.tasks[0], id: "t3", name: "Будет", position: 2, status: "planned" },
        { ...STATE.tasks[0], id: "t4", name: "Встала", position: 3, status: "blocked" },
      ],
    });
    expect(screen.getByRole("img", { name: /Идёт/ })).toHaveAttribute(
      "data-status",
      "in_progress",
    );
    expect(screen.getByRole("img", { name: /Сделана/ })).toHaveAttribute("data-status", "done");
    expect(screen.getByRole("img", { name: /Будет/ })).toHaveAttribute("data-status", "planned");
    expect(screen.getByRole("img", { name: /Встала/ })).toHaveAttribute("data-status", "blocked");
  });

  it("свёрнутая категория прячет свои задачи, развёрнутая возвращает", async () => {
    draw(STATE, "ru");
    expect(screen.getByRole("img", { name: /Логотип/ })).toBeInTheDocument();

    const chevron = screen.getByRole("button", { name: /Свернуть или развернуть «Дизайн»/ });
    await userEvent.click(chevron);
    expect(screen.queryByRole("img", { name: /Логотип/ })).not.toBeInTheDocument();

    await userEvent.click(chevron);
    expect(screen.getByRole("img", { name: /Логотип/ })).toBeInTheDocument();
  });

  it("окно ленты дотягивается до дедлайна, даже если задачи кончились раньше", () => {
    const { container } = draw(STATE);
    // The 1 June deadline and the project's 8 June end must both be on the
    // strip: otherwise the red vertical is drawn beyond the edge and is invisible.
    expect(container.querySelector('[data-day="2026-06-08"]')).toBeInTheDocument();
  });

  it("меню масштаба называет текущий масштаб и меняет его", async () => {
    const { container } = draw(STATE, "ru");
    // A collapsed menu must name the selection itself: otherwise, unlike the
    // former row of segments, the current scale is only visible when unfolded.
    const button = screen.getByRole("button", { name: "Масштаб: День" });
    expect(container.querySelector(".gantt")).toHaveClass("gantt--day");

    await userEvent.click(button);
    await userEvent.click(screen.getByRole("radio", { name: "Месяц" }));

    expect(container.querySelector(".gantt")).toHaveClass("gantt--month");
    expect(screen.getByRole("button", { name: "Масштаб: Месяц" })).toBeInTheDocument();
  });

  it("помнит выбранный масштаб после ухода с экрана и обратно", async () => {
    const first = renderWithProviders(<Gantt projectId="p1" state={STATE} />, { locale: "ru" });
    await userEvent.click(screen.getByRole("button", { name: "Масштаб: День" }));
    await userEvent.click(screen.getByRole("radio", { name: "Неделя" }));
    expect(first.container.querySelector(".gantt")).toHaveClass("gantt--week");

    // Leaving the screen unmounts the strip — exactly what happens when a tab
    // is switched or another screen of the application is opened.
    first.unmount();

    const again = renderWithProviders(<Gantt projectId="p1" state={STATE} />, { locale: "ru" });
    expect(again.container.querySelector(".gantt")).toHaveClass("gantt--week");
    again.unmount();

    // Another project does not inherit someone else's choice: it has its own scale memory.
    const other = renderWithProviders(<Gantt projectId="p2" state={STATE} />, { locale: "ru" });
    expect(other.container.querySelector(".gantt")).toHaveClass("gantt--day");
  });

  it("имя задачи открывает её карточку, как и полоска", async () => {
    const onSelectTask = vi.fn();
    renderWithProviders(
      <Gantt projectId="p1" state={STATE} onSelectTask={onSelectTask} />,
      { locale: "ru" },
    );

    await userEvent.click(screen.getByText("Логотип"));

    expect(onSelectTask).toHaveBeenCalledWith("t1");
  });
});

/**
 * Collapsing the table: half a year of a plan is otherwise only visible in
 * pieces.
 *
 * The table on the left takes a third of the screen from the scale, and on a
 * long project the plan's shape — where it is dense, where it is empty — has to
 * be assembled from two scrolls. At the press of a button it slides away
 * entirely, leaving a strip with that very button, and the chart takes all the
 * freed space.
 */
describe("свёртка таблицы", () => {
  const labelWidth = (container: HTMLElement) =>
    container.querySelector<HTMLElement>(".gantt")?.style.getPropertyValue("--gantt-label");

  it("прячет колонки и отдаёт их место шкале", async () => {
    const { container } = draw(STATE);
    expect(labelWidth(container)).toBe(`${DEFAULT_WIDTH.task + DEFAULT_WIDTH.start + DEFAULT_WIDTH.end}px`);

    await userEvent.click(screen.getByRole("button", { name: "Свернуть таблицу задач" }));

    // Neither task names nor column headings: the strip is a button wide, and
    // cells in it would spill over the scale.
    expect(screen.queryByText("Логотип")).not.toBeInTheDocument();
    expect(screen.queryByText("Начало")).not.toBeInTheDocument();
    expect(labelWidth(container)).toBe(`${COLLAPSED_WIDTH}px`);
    // The bars are in place: it was the table that was collapsed, not the strip.
    expect(screen.getByRole("img", { name: /Логотип/ })).toBeInTheDocument();
  });

  it("возвращает те же колонки, что были: свёртка — про место, а не про выбор", async () => {
    draw(STATE);
    await userEvent.click(screen.getByRole("button", { name: "Свернуть таблицу задач" }));
    await userEvent.click(screen.getByRole("button", { name: "Развернуть таблицу задач" }));

    expect(screen.getByText("Логотип")).toBeInTheDocument();
    expect(screen.getByText("Окончание")).toBeInTheDocument();
  });

  it("помнит свёрнутую таблицу после ухода с экрана и обратно", async () => {
    const first = draw(STATE);
    await userEvent.click(screen.getByRole("button", { name: "Свернуть таблицу задач" }));
    first.unmount();

    const again = draw(STATE);
    expect(labelWidth(again.container)).toBe(`${COLLAPSED_WIDTH}px`);
    again.unmount();

    // A neighbouring project opens expanded: the layout is a choice for this
    // project, not for the whole application.
    const other = renderWithProviders(<Gantt projectId="p2" state={STATE} />, { locale: "ru" });
    expect(labelWidth(other.container)).not.toBe(`${COLLAPSED_WIDTH}px`);
  });

  it("ввод новой задачи разворачивает таблицу: поле живёт в её колонке", async () => {
    const { rerender } = renderWithProviders(
      <Gantt projectId="p1" state={STATE} canWrite newTaskAt={null} />,
      { locale: "ru" },
    );
    await userEvent.click(screen.getByRole("button", { name: "Свернуть таблицу задач" }));

    rerender(
      <Providers locale="ru">
        <Gantt
          projectId="p1"
          state={STATE}
          canWrite
          newTaskAt={{ categoryId: "c1", before: null }}
        />
      </Providers>,
    );

    // A field that cannot be seen reads as the "New task" button doing nothing.
    expect(
      await screen.findByRole("textbox", { name: "Новая задача в «Дизайн»" }),
    ).toBeInTheDocument();
  });
});

/**
 * Scrolling the strip horizontally.
 *
 * The strip scrolls itself exactly twice: to today when the project is opened,
 * and back to the day the person was looking at when the scale was rebuilt under
 * them. The rest of the time the position belongs to the person, and the tests
 * below check exactly that — that the strip does not take it away.
 *
 * The position is read in pixels: jsdom has no layout, `clientWidth` is zero,
 * and the middle of the visible area coincides with its left edge. For the
 * computations that changes nothing — they are the same as in a browser, just
 * with zero width.
 */
describe("прокрутка ленты", () => {
  const scrollerOf = (container: HTMLElement) =>
    container.querySelector<HTMLElement>(".gantt__scroll") as HTMLElement;

  /** Put the strip on a day the way a person would with the mouse wheel. */
  const scrollTo = (element: HTMLElement, x: number) => {
    element.scrollLeft = x;
    fireEvent.scroll(element);
  };

  beforeEach(() => {
    // The scale lives in localStorage and outlives the test — a neighbouring
    // test could have left "week" here, while the computations below are
    // written at the day scale.
    localStorage.clear();
  });

  it("открывает проект на сегодняшнем дне", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 11, 9, 0)));
    try {
      const { container } = renderWithProviders(<Gantt projectId="s1" state={STATE} />, {
        locale: "ru",
      });
      // 11 March is the tenth day from the window's start, and the strip stands
      // so that three days of the past remain on the left: today at the very
      // edge of the screen reads as the project's edge.
      expect(scrollerOf(container).scrollLeft).toBe((10 - 3) * DAY_WIDTH.day);
    } finally {
      vi.useRealTimers();
    }
  });

  it("смена масштаба оставляет на экране тот же день", async () => {
    // Without faking the time: the strip's window stands on the task's dates
    // rather than on today, and none of the numbers below depend on "today".
    const { container } = renderWithProviders(<Gantt projectId="s2" state={STATE} />, {
      locale: "ru",
    });
    const scroller = scrollerOf(container);
    // 25 March is the twenty-fourth day from the window's start.
    scrollTo(scroller, 24 * DAY_WIDTH.day);

    await userEvent.click(screen.getByRole("button", { name: "Масштаб: День" }));
    await userEvent.click(screen.getByRole("radio", { name: "Месяц" }));

    // The same day, a new measure. This used to leave the previous number of
    // pixels here, and the strip travelled half a year forward.
    expect(scroller.scrollLeft).toBe(24 * DAY_WIDTH.month);
  });

  it("правка задачи не возвращает ленту к сегодняшнему дню", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 11, 9, 0)));
    try {
      const { container, rerender } = renderWithProviders(
        <Gantt projectId="s3" state={STATE} />,
        { locale: "ru" },
      );
      const scroller = scrollerOf(container);
      scrollTo(scroller, 24 * DAY_WIDTH.day);

      // The server's answer to a task edit: a different state object and a
      // window stretched to July. The scale is rebuilt — the person is still
      // looking at the end of March.
      rerender(
        <Providers locale="ru">
          <Gantt
            projectId="s3"
            state={{ ...STATE, tasks: [{ ...STATE.tasks[0], end_date: "2026-07-10" }] }}
          />
        </Providers>,
      );

      expect(scroller.scrollLeft).toBe(24 * DAY_WIDTH.day);
    } finally {
      vi.useRealTimers();
    }
  });

  it("другой проект снова открывается на сегодняшнем дне", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 11, 9, 0)));
    try {
      const { container, rerender } = renderWithProviders(
        <Gantt projectId="s4" state={STATE} />,
        { locale: "ru" },
      );
      const scroller = scrollerOf(container);
      scrollTo(scroller, 24 * DAY_WIDTH.day);

      // The project screen does not unmount the strip on navigation — only
      // `projectId` changes. The person has not scrolled the new project yet,
      // and its strip greets them with the same thing the first one did.
      rerender(
        <Providers locale="ru">
          <Gantt projectId="s5" state={STATE} />
        </Providers>,
      );

      expect(scroller.scrollLeft).toBe((10 - 3) * DAY_WIDTH.day);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The relative scale: a plan without dates lives on a "Month 1 / Week 1 / Day 1"
 * axis.
 *
 * The state sits on top of the calendar fixture: the server's coordinates stand
 * at the epoch (2001-01-01, a Monday), the way the serialization of a relative
 * project hands them out.
 */
const RELATIVE: ProjectState = {
  ...STATE,
  schedule_mode: "relative",
  project_end: "2001-01-12",
  calendar: { working_days: 31, holidays: [], extra_workdays: [] },
  tasks: [
    {
      ...STATE.tasks[0],
      start_date: "2001-01-01",
      end_date: "2001-01-12",
      duration_days: 10,
    },
  ],
};

describe("относительная шкала", () => {
  it("подписывает шапку месяцами и неделями проекта, а не датами", () => {
    const { container } = draw(RELATIVE);

    expect(screen.getByText("Месяц 1")).toBeInTheDocument();
    expect(screen.getByText("Неделя 1")).toBeInTheDocument();
    // The project ends on day 12, in the second week; the window is still no
    // shorter than four weeks — one "Month 1" group.
    expect(container.querySelectorAll(".gantt__week")).toHaveLength(4);
    expect(container.querySelectorAll(".gantt__month")).toHaveLength(1);
    // There are no real month names in the header.
    expect(screen.queryByText(/март/i)).not.toBeInTheDocument();
  });

  it("не рисует ни линию сегодня, ни дедлайн: настоящих дат на оси нет", () => {
    const { container } = draw(RELATIVE);

    expect(container.querySelector(".gantt__today")).toBeNull();
    expect(container.querySelector(".gantt__deadline")).toBeNull();
    // The deadline summary stays silent too: there is nothing to compare.
    expect(container.querySelector(".gantt__summary")).toBeNull();
  });

  it("объясняет режим подсказкой бейджа, а не строкой над лентой", () => {
    const { container } = draw(RELATIVE);

    // There is no separate line above the strip any more: it said for the third
    // time what the badge and the button next to it had already said, and cost
    // the strip fifty pixels of height (see the toolbar in Gantt.tsx).
    expect(container.querySelector(".gantt__plan-hint")).toBeNull();
    expect(screen.getByText("Относительный план")).toHaveAttribute(
      "title",
      "Планируйте сроки сейчас. Дату старта назначите, когда проект согласуют.",
    );
  });

  it("называет режим в тулбаре тому, кому назначить дату нечем", () => {
    draw(RELATIVE);
    expect(screen.getByText("Относительный план")).toBeInTheDocument();
  });

  it("ряда над лентой нет, когда видом распоряжается экран", () => {
    const { container } = renderWithProviders(<Controlled state={RELATIVE} />, { locale: "ru" });

    // The scale, "View" and the mode badge then live in the project's header: a
    // second tier above the strip would cost a row of the plan (see ProjectBar).
    expect(container.querySelector(".project-toolbar")).toBeNull();
    expect(screen.queryByRole("button", { name: /Масштаб/ })).toBeNull();
    expect(screen.queryByText("Относительный план")).toBeNull();
  });

  it("рисует по масштабу, который выбрал экран", async () => {
    function Screen() {
      const view = useGanttView("p1");
      return (
        <>
          <button type="button" onClick={() => view.setZoom("month")}>
            месяц снаружи
          </button>
          <Gantt projectId="p1" state={STATE} viewState={view} />
        </>
      );
    }
    const { container } = renderWithProviders(<Screen />, { locale: "ru" });
    expect(container.querySelector(".gantt")).toHaveClass("gantt--day");

    await userEvent.click(screen.getByRole("button", { name: "месяц снаружи" }));

    expect(container.querySelector(".gantt")).toHaveClass("gantt--month");
  });

  it("занимает всю отведённую ширину целыми неделями", () => {
    // jsdom does not compute the strip's width at all — it has to be named. That
    // is also what is being checked: a relative plan's window is derived from
    // nothing but this measure (see weeksAcross in relative.ts).
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    // 2300 = the names column (468 — the name and both dates by default) + 1832
    // for the scale: the strip opens at the day scale, a week is 364 pixels in
    // it, and five whole weeks fit — the remaining 12 pixels do not add up to a
    // week and go under the "beyond the plan" band.
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      value: 2300,
      configurable: true,
    });
    try {
      const { container } = draw(RELATIVE);
      expect(container.querySelectorAll(".gantt__week")).toHaveLength(5);
    // The second "month" is incomplete — that is how relativeMonths cuts the scale.
      expect(container.querySelectorAll(".gantt__month")).toHaveLength(2);
    } finally {
    // HTMLElement has no `clientWidth` of its own — it is declared higher up, on
    // Element, and what was overridden can only be returned by removing the
    // override: `defineProperty` with `undefined` would leave it hanging over
    // all the file's following tests.
      if (original) Object.defineProperty(HTMLElement.prototype, "clientWidth", original);
      else Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    }
  });

  it("остаток за краем плана размечен, а не оставлен белым", () => {
    const { container } = draw(RELATIVE);

    // The band stands twice — in the header and in the body — and both are
    // invisible to a screen reader: this is background, not content (see
    // .gantt__beyond in gantt.css).
    const strips = container.querySelectorAll(".gantt__beyond");
    expect(strips).toHaveLength(2);
    for (const strip of strips) expect(strip).toHaveAttribute("aria-hidden", "true");
    // The scale's width has moved into the styles: the band finds its own start
    // by it. Four weeks of the day scale: 28 days at 52 pixels.
    expect((container.querySelector(".gantt") as HTMLElement).style.getPropertyValue("--gantt-lane"))
      .toBe("1456px");
  });

  it("календарный проект с датой старта не предлагает переключиться в относительный вид", () => {
    // The start is Monday 2 March: a 4-10 March task would land on "Week 1-2" of
    // the relative axis, were it shown — but there is nothing left to show it
    // with: a calendar project has no view switcher in the toolbar.
    const bound: ProjectState = { ...STATE, start_date: "2026-03-02" };
    draw(bound);

    expect(screen.queryByText("Месяц 1")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Относительный" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Календарный" })).not.toBeInTheDocument();
  });

  it("индикатор «Относительный план» гаснет сразу же, как только назначена дата старта", () => {
    const { rerender } = draw(RELATIVE);
    expect(screen.getByText("Относительный план")).toBeInTheDocument();

    // The same prop the strip receives after StartDateDialog is applied
    // successfully: the mutation puts a ready calendar state into the cache, and
    // it arrives downwards with no intermediate frame — the render hits this
    // transition directly rather than through the query cache.
    rerender(
      <Providers locale="ru">
        <Gantt
          projectId="p1"
          state={{ ...RELATIVE, schedule_mode: "calendar", start_date: "2001-01-01", deadline: null }}
        />
      </Providers>,
    );

    expect(screen.queryByText("Относительный план")).not.toBeInTheDocument();
  });
});
