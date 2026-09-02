import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectState } from "../api/projects";
import type { Locale } from "../i18n";
import { Providers, renderWithProviders } from "../test/utils";
import { Gantt } from "./Gantt";
import { COLLAPSED_WIDTH, DEFAULT_WIDTH } from "./columns";
import { DAY_WIDTH } from "./scale";

const STATE: ProjectState = {
  id: "p1",
  name: "Редизайн",
  slug: "redizayn",
  deadline: "2026-06-01",
  project_end: "2026-06-08",
  plan_approved_at: null,
  plan_version: 0,
  undoable: null,
  // Календарный режим: заглушки существующих тестов живут настоящими датами.
  // Относительные проекты собирают своё состояние поверх этого (см. тесты
  // относительной шкалы).
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
 * Диаграмма читает язык из провайдера: итог по дедлайну — это фраза, а не
 * картинка. Поэтому рисуем её всегда внутри провайдеров, как в приложении.
 *
 * Без `canWrite` и без `onSelectTask` — то есть на чтение, как на публичной
 * странице. В этом виде полоска объявляется картинкой, а не кнопкой (см. Bar
 * в Row.tsx), и тесты ниже спрашивают её по роли `img`. Проверяют они рисунок
 * — ширину, класс, порядок, — а не поведение органа управления.
 */
function draw(state: ProjectState, locale: Locale = "ru") {
  return renderWithProviders(<Gantt projectId="p1" state={state} />, { locale });
}

function drawWithToolbar(locale: Locale = "ru") {
  return renderWithProviders(
    <Gantt projectId="p1" state={STATE} toolbarAction={<button type="button">New task</button>} />,
    { locale },
  );
}

describe("диаграмма", () => {
  afterEach(() => vi.restoreAllMocks());

  it("рисует задачу полоской нужной ширины", () => {
    draw(STATE);
    const bar = screen.getByRole("img", { name: /Логотип/ });
    // 4-10 марта — семь календарных дней. Ширина стоит свойством, а не
    // `width`: полоску растягивают за грань, и к ней прибавляется сдвиг
    // пальца (см. --bar-dw в gantt.css).
    expect(bar.style.getPropertyValue("--bar-w")).toBe(`${7 * DAY_WIDTH.day}px`);
  });

  it("ставит полоску в её день, а не в начало ленты", () => {
    const { container } = draw(STATE);
    // Окно открывается с первого числа месяца самой ранней задачи: 4 марта
    // отстоит от 1 марта на три дня.
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
    // 19 марта 2026 — четверг и не праздник.
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
      // 11 марта — десятый день от начала окна (1 марта), и линия стоит
      // посередине его колонки, а не по её левому краю.
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
    // 02:30 одиннадцатого марта в Баку — это ещё 22:30 десятого по UTC. До
    // починки лента всю ночь показывала вчерашнее число.
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
    // По доступному имени, а не по содержимому: имя задачи живёт в левой
    // колонке и в aria-label полоски, самой полоске текст не принадлежит.
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
    // Иначе только что созданная категория исчезает, и человек решает, что
    // создание не сработало.
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
    // Клеток дня столько же, сколько при одной задаче: сетка общая. Сотня
    // задач на сотне дней иначе дала бы десять тысяч узлов.
    expect(many.container.querySelectorAll(".gantt__grid-day").length).toBe(
      one.container.querySelectorAll(".gantt__grid-day").length,
    );
  });

  it("прогресс задачи виден в полоске", () => {
    draw(STATE);
    // Процент — свойством на полоске: по нему считается и ширина заливки, и
    // место ручки, которой её тянут, и второе число здесь разошлось бы с
    // первым при первой же правке.
    const bar = screen.getByRole("img", { name: /Логотип/ });
    expect(bar.style.getPropertyValue("--progress")).toBe("40%");
  });

  it("легенда включается через меню «Вид» и расшифровывает статусы", async () => {
    const { container } = draw(STATE, "ru");
    // По умолчанию легенды нет — как в макете.
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

  it("статус полоски — хранимое поле, а не вывод из дат", () => {
    // Смысл переезда на хранимый статус: «заблокировано» из дат не выводится,
    // а «запланировано» может стоять и на уже начатой по датам задаче.
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
    // Дедлайн 1 июня и окончание проекта 8 июня обязаны быть на ленте: иначе
    // красная вертикаль рисуется за краем и её не видно.
    expect(container.querySelector('[data-day="2026-06-08"]')).toBeInTheDocument();
  });

  it("меню масштаба называет текущий масштаб и меняет его", async () => {
    const { container } = drawWithToolbar("ru");
    // Свёрнутое меню обязано называть выбранное само: иначе, в отличие от
    // прежнего ряда сегментов, текущий масштаб виден только раскрытым.
    const button = screen.getByRole("button", { name: "Масштаб: День" });
    expect(container.querySelector(".gantt")).toHaveClass("gantt--day");

    await userEvent.click(button);
    await userEvent.click(screen.getByRole("radio", { name: "Месяц" }));

    expect(container.querySelector(".gantt")).toHaveClass("gantt--month");
    expect(screen.getByRole("button", { name: "Масштаб: Месяц" })).toBeInTheDocument();
  });

  it("помнит выбранный масштаб после ухода с экрана и обратно", async () => {
    const first = renderWithProviders(
      <Gantt projectId="p1" state={STATE} toolbarAction={<button type="button">New task</button>} />,
      { locale: "ru" },
    );
    await userEvent.click(screen.getByRole("button", { name: "Масштаб: День" }));
    await userEvent.click(screen.getByRole("radio", { name: "Неделя" }));
    expect(first.container.querySelector(".gantt")).toHaveClass("gantt--week");

    // Уход с экрана размонтирует ленту — ровно то, что происходит при
    // переключении вкладки или уходе на другой экран приложения.
    first.unmount();

    const again = renderWithProviders(<Gantt projectId="p1" state={STATE} />, { locale: "ru" });
    expect(again.container.querySelector(".gantt")).toHaveClass("gantt--week");
    again.unmount();

    // Другой проект не наследует чужой выбор: у него своя память масштаба.
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
 * Свёртка таблицы: полгода плана иначе видно только кусками.
 *
 * Таблица слева отнимает у шкалы треть экрана, и на длинном проекте форму
 * плана — где густо, где пусто — приходится собирать из двух прокруток. По
 * кнопке она уезжает целиком, оставляя полосу с самой этой кнопкой, а лента
 * занимает всё освободившееся место.
 */
describe("свёртка таблицы", () => {
  const labelWidth = (container: HTMLElement) =>
    container.querySelector<HTMLElement>(".gantt")?.style.getPropertyValue("--gantt-label");

  it("прячет колонки и отдаёт их место шкале", async () => {
    const { container } = draw(STATE);
    expect(labelWidth(container)).toBe(`${DEFAULT_WIDTH.task + DEFAULT_WIDTH.start + DEFAULT_WIDTH.end}px`);

    await userEvent.click(screen.getByRole("button", { name: "Свернуть таблицу задач" }));

    // Ни имени задачи, ни заголовков колонок: полоса шириной в кнопку, и
    // ячейки в ней вылезали бы поверх шкалы.
    expect(screen.queryByText("Логотип")).not.toBeInTheDocument();
    expect(screen.queryByText("Начало")).not.toBeInTheDocument();
    expect(labelWidth(container)).toBe(`${COLLAPSED_WIDTH}px`);
    // Полоски на месте: свернули таблицу, а не ленту.
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

    // Соседний проект открывается развёрнутым: раскладка — выбор для этого
    // проекта, а не для всего приложения.
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

    // Поле, которого не видно, читается как бездействие кнопки «Новая задача».
    expect(
      await screen.findByRole("textbox", { name: "Новая задача в «Дизайн»" }),
    ).toBeInTheDocument();
  });
});

/**
 * Прокрутка ленты по горизонтали.
 *
 * Сама лента прокручивается ровно дважды: к сегодняшнему дню, когда проект
 * открыли, и обратно к тому дню, на который человек смотрел, когда шкала
 * пересобралась под ним. Всё остальное время положение принадлежит человеку, и
 * тесты ниже проверяют именно это — что лента его не отбирает.
 *
 * Положение читается в пикселях: в jsdom нет раскладки, `clientWidth` равен
 * нулю, и середина видимой области совпадает с её левым краем. Для расчётов
 * это ничего не меняет — они те же, что в браузере, просто с нулевой шириной.
 */
describe("прокрутка ленты", () => {
  const scrollerOf = (container: HTMLElement) =>
    container.querySelector<HTMLElement>(".gantt__scroll") as HTMLElement;

  /** Поставить ленту на день так, как это сделал бы человек колесом мыши. */
  const scrollTo = (element: HTMLElement, x: number) => {
    element.scrollLeft = x;
    fireEvent.scroll(element);
  };

  beforeEach(() => {
    // Масштаб живёт в localStorage и переживает тест — соседний тест мог
    // оставить здесь «неделю», а расчёты ниже написаны в дневном масштабе.
    localStorage.clear();
  });

  it("открывает проект на сегодняшнем дне", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 11, 9, 0)));
    try {
      const { container } = renderWithProviders(<Gantt projectId="s1" state={STATE} />, {
        locale: "ru",
      });
      // 11 марта — десятый день от начала окна, и лента встаёт так, чтобы
      // слева осталось три дня прошлого: сегодня у самого края экрана читается
      // как край проекта.
      expect(scrollerOf(container).scrollLeft).toBe((10 - 3) * DAY_WIDTH.day);
    } finally {
      vi.useRealTimers();
    }
  });

  it("смена масштаба оставляет на экране тот же день", async () => {
    // Без подмены времени: окно ленты стоит на датах задачи, а не на
    // сегодняшнем дне, и все числа ниже от «сегодня» не зависят.
    const { container } = renderWithProviders(<Gantt projectId="s2" state={STATE} />, {
      locale: "ru",
    });
    const scroller = scrollerOf(container);
    // 25 марта — двадцать четвёртый день от начала окна.
    scrollTo(scroller, 24 * DAY_WIDTH.day);

    await userEvent.click(screen.getByRole("button", { name: "Масштаб: День" }));
    await userEvent.click(screen.getByRole("radio", { name: "Месяц" }));

    // Тот же день, новая мерка. Раньше здесь оставалось прежнее число
    // пикселей, и лента уезжала на полгода вперёд.
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

      // Ответ сервера на правку задачи: другой объект состояния и окно,
      // растянутое до июля. Шкала пересобирается — человек по-прежнему
      // смотрит на конец марта.
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

      // Экран проекта не размонтирует ленту при переходе — меняется только
      // `projectId`. Новый проект человек ещё не листал, и его лента
      // здоровается тем же, чем и первая.
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
 * Относительная шкала: план без дат живёт на оси «Месяц 1 / Неделя 1 / День 1».
 *
 * Состояние — поверх календарной заглушки: серверные координаты стоят у эпохи
 * (2001-01-01, понедельник), как их отдаёт сериализация относительного проекта.
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
    // Конец проекта — день 12, вторая неделя; окно всё равно не короче
    // четырёх недель — одной группы «Месяц 1».
    expect(container.querySelectorAll(".gantt__week")).toHaveLength(4);
    expect(container.querySelectorAll(".gantt__month")).toHaveLength(1);
    // Названий настоящих месяцев в шапке нет.
    expect(screen.queryByText(/март/i)).not.toBeInTheDocument();
  });

  it("не рисует ни линию сегодня, ни дедлайн: настоящих дат на оси нет", () => {
    const { container } = draw(RELATIVE);

    expect(container.querySelector(".gantt__today")).toBeNull();
    expect(container.querySelector(".gantt__deadline")).toBeNull();
    // Сводка по дедлайну тоже молчит: сравнивать нечего.
    expect(container.querySelector(".gantt__summary")).toBeNull();
  });

  it("объясняет режим подсказкой бейджа, а не строкой над лентой", () => {
    const { container } = draw(RELATIVE);

    // Отдельной строки над лентой больше нет: она говорила третий раз то же,
    // что уже сказали бейдж и кнопка рядом, и стоила ленте полсотни пикселей
    // высоты (см. тулбар в Gantt.tsx).
    expect(container.querySelector(".gantt__plan-hint")).toBeNull();
    expect(screen.getByText("Относительный план")).toHaveAttribute(
      "title",
      "Планируйте сроки сейчас. Дату старта назначите, когда проект согласуют.",
    );
  });

  it("называет режим в тулбаре", () => {
    draw(RELATIVE);
    expect(screen.getByText("Относительный план")).toBeInTheDocument();
  });

  it("занимает всю отведённую ширину целыми неделями", () => {
    // Ширину ленты jsdom не считает вовсе — её приходится назвать. Заодно это
    // и есть проверяемое: окно относительного плана не выведено ни из чего,
    // кроме этой меры (см. weeksAcross в relative.ts).
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    // 2300 = колонка названий (468 — имя и обе даты по умолчанию) + 1832 под
    // шкалу: лента открывается в дневном масштабе, неделя в нём 364 пикселя,
    // и целых недель помещается пять — остаток в 12 пикселей на неделю не
    // тянет и уходит под полосу «вне плана».
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      value: 2300,
      configurable: true,
    });
    try {
      const { container } = draw(RELATIVE);
      expect(container.querySelectorAll(".gantt__week")).toHaveLength(5);
      // Второй «месяц» неполный — так шкалу и режет relativeMonths.
      expect(container.querySelectorAll(".gantt__month")).toHaveLength(2);
    } finally {
      // Своего `clientWidth` у HTMLElement нет — он объявлен выше, на Element,
      // и вернуть подменённое можно только сняв подмену: `defineProperty` с
      // `undefined` оставил бы её висеть на всех следующих тестах файла.
      if (original) Object.defineProperty(HTMLElement.prototype, "clientWidth", original);
      else Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    }
  });

  it("остаток за краем плана размечен, а не оставлен белым", () => {
    const { container } = draw(RELATIVE);

    // Полоса стоит дважды — в шапке и в теле — и обе невидимы для чтения с
    // экрана: это фон, а не содержимое (см. .gantt__beyond в gantt.css).
    const strips = container.querySelectorAll(".gantt__beyond");
    expect(strips).toHaveLength(2);
    for (const strip of strips) expect(strip).toHaveAttribute("aria-hidden", "true");
    // Ширина шкалы уехала в стили: по ней полоса и находит своё начало.
    // Четыре недели дневного масштаба: 28 дней по 52 пикселя.
    expect((container.querySelector(".gantt") as HTMLElement).style.getPropertyValue("--gantt-lane"))
      .toBe("1456px");
  });

  it("календарный проект с датой старта не предлагает переключиться в относительный вид", () => {
    // Старт — понедельник 2 марта: задача 4–10 марта легла бы во «Неделю 1-2»
    // относительной оси, будь она показана, — но показывать её больше нечем:
    // у календарного проекта переключателя представления в тулбаре нет.
    const bound: ProjectState = { ...STATE, start_date: "2026-03-02" };
    draw(bound);

    expect(screen.queryByText("Месяц 1")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Относительный" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Календарный" })).not.toBeInTheDocument();
  });

  it("индикатор «Относительный план» гаснет сразу же, как только назначена дата старта", () => {
    const { rerender } = draw(RELATIVE);
    expect(screen.getByText("Относительный план")).toBeInTheDocument();

    // Тот же пропс, что лента получает после успешного применения
    // StartDateDialog: мутация кладёт в кэш готовое календарное состояние, и
    // вниз оно приходит без промежуточного кадра — рендер бьёт этот переход
    // напрямую, а не через кэш запроса.
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
