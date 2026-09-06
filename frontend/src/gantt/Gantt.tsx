import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties } from "react";

import { TASK_STATUSES } from "../api/projects";
import type { Category, ProjectState, Task } from "../api/projects";
import { endShiftDays, isBeyondPlan } from "../project/baseline";
import { formatDate, formatMonth, weekdayNarrow } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";
import { BarTipProvider } from "./BarTip";
import { AddCategoryRow, AddTaskRow, NewCategoryRow, PendingCategoryRow } from "./BottomActions";
import { HeadCells } from "./Cells";
import { Grid } from "./Grid";
import { Header, RelativeHeader } from "./Header";
import {
  RELATIVE_EPOCH,
  relativeDayLabel,
  relativeWeekEnd,
  relativeWindow,
  weeksAcross,
} from "./relative";
import { Arrows } from "./Arrows";
import { NewTaskRow, PendingRow } from "./NewTaskRow";
import { CategoryRow, TaskRow } from "./Row";
import type { CellLabels, DayFormat } from "./Row";
import { MOTION_MS, usePrefersReducedMotion } from "./motion";
import { useLinkDrag } from "./useLinkDrag";
import { useQuickCategory } from "./useQuickCategory";
import { useQuickTask } from "./useQuickTask";
import { useReorder } from "./useReorder";
import { useLaneWidth } from "./useLaneWidth";
import { useViewportFit } from "./useViewportFit";
import { COLUMN_KEYS, layoutWidth } from "./columns";
import type { ColumnKey } from "./columns";
import { DAY_WIDTH, ROW_HEIGHT, lastOfMonth, projectWindow } from "./scale";
import { addDays, buildScale, daysBetween } from "./timescale";
import { useGanttView } from "./useGanttView";
import type { GanttView } from "./useGanttView";
import { GanttViewControls } from "./ViewControls";
import { useToday } from "../time/useToday";

import "./gantt.css";

/**
 * Точка, за которую лента держится при пересборке шкалы.
 *
 * Дата, а не пиксель: пиксельное смещение осмысленно только внутри той шкалы,
 * в которой его измерили. Один и тот же `scrollLeft` в дневном масштабе
 * показывает март, а в месячном — уже август, поэтому запоминается день в
 * центре видимой области. Доля дня хранится рядом, чтобы возврат не подтягивал
 * ленту к границе дня на каждой пересборке шкалы: без неё каждое обновление
 * состояния сдвигало бы ленту на полделения.
 */
type Focus = { date: string; fraction: number };

/**
 * Порядок строк — по позиции, а при равенстве по идентификатору.
 *
 * Второй ключ не перестраховка: позиции совпадают в одном настоящем случае —
 * строка, восстановленная отменой на место, которое с тех пор занял сосед. Без
 * него порядок между двумя перерисовками неустойчив, и строки прыгают местами
 * сами по себе.
 */
function byPosition<T extends { position: number; id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Куда открыта строка новой задачи.
 *
 * `before` — задача, над которой встанет новая; `null` — конец категории.
 * Место названо строкой, а не номером: номер задачи меняется от чужой
 * перестановки, а «перед вот этой» остаётся тем же местом и после неё.
 */
export type NewTaskAt = { categoryId: string; before: string | null };

export function Gantt({
  projectId,
  state,
  canWrite = false,
  onAddTask,
  newTaskAt = null,
  onCloseNewTask,
  onAddCategory,
  onDeleteCategory,
  baselineShown,
  onBaselineToggle,
  selectedTaskId = null,
  onSelectTask,
  onOpenComments,
  commentCounts,
  viewState,
  assigneeNames,
}: {
  projectId: string;
  state: ProjectState;
  /** Может ли этот человек менять проект. Гость только смотрит. */
  canWrite?: boolean;
  /**
   * Завести задачу: плюсом на строке категории (в её конец) или плюсом на
   * границе строк (перед названной). Без него диаграмма остаётся на чтение.
   */
  onAddTask?: (at: NewTaskAt) => void;
  /**
   * Где открыта строка новой задачи. `null` — закрыта.
   *
   * Состоянием снаружи, а не внутри ленты: строку закрывает и экран — когда
   * открывает поверх ленты карточку или окно, — и дотянуться до состояния
   * ленты ему было бы нечем.
   */
  newTaskAt?: NewTaskAt | null;
  onCloseNewTask?: () => void;
  /**
   * Завести категорию: «плюсом» в углу таблицы, у заголовка «Задача», и
   * кнопкой посреди пустой ленты.
   *
   * Плюс стоит на том, чему добавляет ребёнка: угол таблицы — корень списка,
   * и его плюс заводит категорию; плюс на строке категории заводит задачу в
   * ней. Прежняя кнопка тулбара «Новая задача» этого правила не знала — она
   * клала задачу в первую категорию, потому что не знала, куда ещё.
   */
  onAddCategory?: () => void;
  /**
   * Крестик на строке категории. Без него категории не удаляются.
   *
   * Зовётся щелчком, а удаляет не сразу: спросить, точно ли уходит этап
   * вместе со своими задачами, обязан экран — он же и применяет операцию.
   * Лента этого вопроса не задаёт: у неё нет ни окна, ни счёта того, что
   * уйдёт вместе с категорией на самом деле (комментарии, назначения), — а
   * вопрос, заданный вполсилы, хуже незаданного.
   */
  onDeleteCategory?: (categoryId: string) => void;
  /** Задача, карточка которой открыта. */
  selectedTaskId?: string | null;
  onSelectTask?: (taskId: string) => void;
  /**
   * Открыть обсуждение задачи — счётчиком реплик на строке.
   *
   * Отдельно от `onSelectTask`, а не вторым доводом к нему: лента не знает, из
   * чего состоит карточка задачи, и называть ей вкладки значило бы завести
   * второе место, где перечислены разделы карточки.
   */
  onOpenComments?: (taskId: string) => void;
  /**
   * Сколько реплик у каждой задачи. Пропсом, как и состав организации:
   * спрашивает экран, лента получает готовое (см. `assigneeNames`).
   */
  commentCounts?: ReadonlyMap<string, number>;
  /**
   * Показывать ли призрак согласованного плана — снаружи.
   *
   * Не передано — лента решает сама своим флажком «Вид». Передано — решает
   * экран, и тот же переключатель стоит в окне изменений.
   */
  baselineShown?: boolean;
  onBaselineToggle?: () => void;
  /**
   * Как смотреть на ленту — масштаб, колонки, слои (см. useGanttView).
   *
   * Передано — органы управления стоят у экрана (в шапке проекта), и лента
   * своего ряда над собой не рисует. Не передано — лента заводит состояние
   * сама и ставит ряд с масштабом и «Видом» над собой: так живёт публичная
   * страница, где шапки проекта нет.
   */
  viewState?: GanttView;
  /**
   * Состав организации: имена по идентификаторам. Ими подписаны исполнители в
   * карточке наведения и в колонке — из них же выбирают новых прямо со строки.
   *
   * Пропсом, а не запросом изнутри: спрашивает экран, лента получает готовое.
   * Признака «это публичная страница» у ленты нет и заводить его не за чем, а
   * гейт по `canWrite` ошибся бы дважды — на читателе внутри организации,
   * который состав видит, и в офлайне, где право есть, а связи нет.
   */
  assigneeNames?: ReadonlyMap<string, string>;
}) {
  const { t } = useLocale();
  const scroller = useRef<HTMLDivElement>(null);
  // Лента прокручивается сама — и по вертикали тоже. Без этого закреплённая
  // шапка шкалы уезжает вместе со страницей (см. `useViewportFit`).
  useViewportFit(scroller);
  const reorder = useReorder({ projectId, state, canWrite });
  const link = useLinkDrag({ projectId, state, canWrite });
  const quick = useQuickTask({ projectId, state });
  const quickCategory = useQuickCategory({ projectId, state });
  const reducedMotion = usePrefersReducedMotion();
  // Масштаб, колонки и слои. Своё состояние заводится всегда — правило хуков
  // не даёт заводить его условно, — но в дело идёт только когда экран не дал
  // своего: на рабочем экране органы управления стоят в его шапке, и лента
  // лишь читает то, что там выбрали (см. `viewState`).
  const ownView = useGanttView(projectId, { baselineShown, onBaselineToggle });
  const ganttView = viewState ?? ownView;
  const { zoom, layout, setLayout, toggleTable, resizeColumn, moveColumn } = ganttView;
  const baselineOn = ganttView.flag("baseline");
  const view = {
    legend: ganttView.flag("legend"),
    summary: ganttView.flag("summary"),
    caption: ganttView.flag("caption"),
    critical: ganttView.flag("critical"),
  };

  // Свёрнутые категории. Состояние экрана, а не проекта: сосед по проекту не
  // должен получать чужие свёртки, поэтому оно не уходит на сервер.
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const toggleCategory = (id: string) =>
    setClosed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Задачу заводят и в свёрнутой категории: «плюс» на её строке никуда не
  // девается, да и кнопка тулбара целится в первую по счёту, свёрнута она или
  // нет. Строка, открытая внутри свёрнутого, не видна вовсе — а поле, которого
  // не видно, читается как бездействие. Тот же набор возвращается неизменным,
  // когда разворачивать нечего: новый объект здесь тянул бы перерисовку ленты
  // на каждом ответе сервера.
  const newTaskIn = newTaskAt?.categoryId ?? null;
  useEffect(() => {
    if (newTaskIn === null) return;
    setClosed((current) => {
      if (!current.has(newTaskIn)) return current;
      const next = new Set(current);
      next.delete(newTaskIn);
      return next;
    });
  }, [newTaskIn]);

  // По той же причине разворачивается и свёрнутая таблица: имя новой задачи
  // пишут в её колонке, и у свёрнутой этой колонки нет — кнопка «Новая
  // задача» открывала бы поле, которого не видно.
  useEffect(() => {
    if (newTaskIn === null || !layout.collapsed) return;
    setLayout({ ...layout, collapsed: false });
  }, [newTaskIn, layout, setLayout]);

  // Строка ввода новой категории — с самого низа ленты (см. «+ Новая
  // категория» ниже). Состояние экрана, как и свёртка категорий: соседу по
  // проекту чужое открытое поле ни к чему, и на сервер оно не уходит.
  const [composingCategory, setComposingCategory] = useState(false);

  // По той же причине, что и у задачи чуть выше: имя категории пишут в
  // колонке, которой у свёрнутой таблицы нет.
  useEffect(() => {
    if (!composingCategory || !layout.collapsed) return;
    setLayout({ ...layout, collapsed: false });
  }, [composingCategory, layout, setLayout]);

  // Относительная ось: план ещё не привязан к датам, шкала считает недели
  // проекта от эпохи. Свойство проекта, а не экрана — приходит с сервера.
  // Календарный проект относительным видом больше не притворяется: как
  // только назначена дата старта, лента показывает только настоящие даты.
  const relativeAxis = state.schedule_mode === "relative";
  // Якорь относительной оси — всегда эпоха: у плана без дат других координат
  // не бывает.
  const anchor = RELATIVE_EPOCH;

  // Сегодня — в поясе проекта, а не по UTC: линия сегодняшнего дня обязана
  // стоять там, где у читателя сегодня, и в поясе восточнее Гринвича по UTC
  // она каждую ночь до утра стояла на вчерашнем числе.
  const today = useToday(state.settings?.timezone);
  // Докуда дотянул начатый жест: полоску задачи или полосу категории держат за
  // правым краем окна. Пока жест идёт, окно дотягивается до этой даты — тем же
  // округлением, каким лента строит его сама, — и сетка существует всюду, куда
  // доехала полоска. Без этого последнюю задачу нельзя утащить дальше пары
  // дней: окно кончается почти сразу за ней, полоска выезжает в белую пустоту
  // без единой даты, а прокрутиться туда лента позволяет — вынесенная
  // транслейтом полоска расширяет прокручиваемую область.
  //
  // Пока жест идёт, окно не убывает: жест зовёт сюда только даты за нынешним
  // краем (см. track в useDragDates), поэтому сетка, отросшая за полоской, не
  // отрастает назад при движении обратно — иначе она дёргала бы прокрутку под
  // рукой. Бросок передаёт закоммиченный конец, отменённый жест — `null`.
  // Цена достройки — один пересчёт шкалы на каждый пересечённый день, а не на
  // каждый пиксель: одинаковая дата повторную отрисовку не будит.
  const [reach, setReach] = useState<string | null>(null);
  const onReach = useCallback((endISO: string | null) => setReach(endISO), []);

  const dayWidth = DAY_WIDTH[zoom];
  // Сколько места остаётся шкале справа от таблицы. Знает об этом только
  // относительное окно: у плана без дат правый край не выведен ни из чего, и
  // без поправки на ширину экрана он всегда один и тот же — четыре недели,
  // после которых до края шло белое поле (см. `weeksAcross`).
  const laneSpace = useLaneWidth(scroller) - layoutWidth(layout);

  // Зависимость — границы окна, а не само состояние: после каждого изменения
  // сервер присылает новый объект состояния, и шкала, привязанная к его
  // тождеству, пересобиралась бы всякий раз — вместе со всеми делениями и
  // месяцами, которые от правки одной задачи не изменились.
  const base = relativeAxis
    ? relativeWindow(state, anchor, weeksAcross(laneSpace, dayWidth))
    : projectWindow(state, today);
  const from = base.from;
  // Достройка меняет только правый край: `from` и ширина дня стоят на месте,
  // поэтому `Scale.key` не меняется и координаты всех полосок остаются теми
  // же — жест посреди достройки не сбивается (см. `Scale.key`).
  const to =
    reach === null || reach <= base.to
      ? base.to
      : relativeAxis
        ? relativeWeekEnd(reach, anchor)
        : lastOfMonth(reach);
  const scale = useMemo(() => buildScale({ from, to, dayWidth }), [dayWidth, from, to]);

  // Подтверждённый перенос накрыл достройку своим окном — её можно снять, не
  // меняя геометрии ленты. Снимать прямо на броске нельзя: догадка ложится в
  // кэш, но её уведомление React Query шлёт микрозадачей, и между сбросом и
  // догадкой холст на мгновение сжался бы до прежнего окна. Слой высоты в тот
  // же момент меряет ленту (см. useViewportFit) и этим заставляет браузер
  // пересчитать раскладку — прокрутка, стоявшая в достроенной части, прижалась
  // бы к прежнему краю, и вид прыгнул бы под рукой ровно в момент броска.
  useEffect(() => {
    if (reach !== null && reach <= base.to) setReach(null);
  }, [reach, base.to]);

  // В относительном представлении вместо дат — дни проекта: настоящей даты у
  // плана без назначенного старта ещё нет.
  const formatDay = (iso: string) =>
    relativeAxis ? relativeDayLabel(t, iso, anchor) : formatDate(t, iso);

  // Как строки показывают даты и как принимают их обратно. Ввод зеркален
  // показу: там, где строка показала «День 8», она и принимает восьмой день.
  const format: DayFormat = { label: formatDay, relative: relativeAxis, anchor };

  // Подписи ячеек — один раз на ленту, а не по словарю в каждой строке: на
  // сотне задач это сотня одинаковых обращений за теми же шестью строками.
  const cellLabels: CellLabels = {
    columns: Object.fromEntries(
      COLUMN_KEYS.map((key) => [key, t(`gantt.col.${key}`)]),
    ) as Record<ColumnKey, string>,
    edit: (column, name) => t("gantt.col.edit", { column, name }),
  };

  // Куда лента смотрит сейчас и для какого проекта её уже показали.
  //
  // Прокрутка к сегодняшнему дню — приветствие при открытии проекта, а не
  // ответ на каждую пересборку шкалы. Шкала пересобирается и от смены
  // масштаба, и от правки задачи, раздвинувшей окно проекта, и привязанная к
  // ней прокрутка отбирала бы у человека март, на который он смотрел, всякий
  // раз, когда он трогает ленту.
  const shownFor = useRef<string | null>(null);
  const focus = useRef<Focus | null>(null);

  /**
   * Запомнить день в центре видимой области — в мерках текущей шкалы.
   *
   * Обёрнуто, чтобы не пересоздаваться на каждой перерисовке: иначе прокрутка
   * ниже, которой эта функция нужна, срабатывала бы от любого чужого
   * изменения — от наведения на полоску до свёртки категории.
   */
  const rememberFocus = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const center = (element.scrollLeft + element.clientWidth / 2) / scale.dayWidth;
    const index = Math.floor(center);
    focus.current = { date: addDays(scale.from, index), fraction: center - index };
  }, [scale]);

  // Слой ниже — единственное место, где лента прокручивается сама.
  //
  // Раскладка уже посчитана, но кадр ещё не показан: `useEffect` здесь дал бы
  // видимый прыжок с прежнего места на новое.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;

    // Первый показ проекта: проект длиной в квартал иначе открывается на своём
    // начале, то есть на том, что уже сделано. Дальше — только возврат к
    // запомненному дню.
    if (shownFor.current !== projectId) {
      shownFor.current = projectId;
      // Сегодняшнего дня в окне может и не быть — у проекта, целиком
      // спланированного на прошлую весну. Тогда лента остаётся на своём начале:
      // прокручивать её некуда.
      if (today >= scale.from && today <= scale.to) {
        element.scrollLeft = Math.max(0, scale.xOf(today) - scale.dayWidth * 3);
      }
      // Смена проекта заодно возвращает его масштаб (эффект выше), и шкала
      // пересоберётся ещё раз. Без этой отметки лента осталась бы на пикселе,
      // отмеренном по прежнему масштабу.
      rememberFocus();
      return;
    }

    const held = focus.current;
    if (!held) return;
    element.scrollLeft = Math.max(
      0,
      scale.xOf(held.date) + held.fraction * scale.dayWidth - element.clientWidth / 2,
    );
  }, [projectId, rememberFocus, scale, today]);

  const categories = byPosition(state.categories);
  const tasksByCategory = new Map<string, Task[]>();
  for (const task of byPosition(state.tasks)) {
    tasksByCategory.set(task.category_id, [...(tasksByCategory.get(task.category_id) ?? []), task]);
  }
  // Сколько задач уже в каждой категории — знает пункт «Переместить» в меню
  // строки: перенесённая задача встаёт в конец, а конец — это и есть текущее
  // число строк там, куда её кладут.
  const taskCountByCategory = new Map<string, number>(
    categories.map((category) => [category.id, tasksByCategory.get(category.id)?.length ?? 0]),
  );

  /**
   * Категория, чья пустая полоса объяснит, что с ней делать, — самая верхняя
   * из пустых, и только она одна.
   *
   * Категории есть, задач нет — обычное состояние только что заведённого
   * проекта, и до сих пор оно не объяснялось ничем: пустой экран лента
   * объясняет, только пока нет ни одной категории (см. `gantt.empty` ниже), а
   * дальше остаётся пустая сетка. Подсказка в каждой пустой полосе была бы
   * тремя одинаковыми строками подряд: приём, понятый на первой, работает и на
   * остальных — тем более что «плюс» на строке у пустых категорий с этой же
   * правкой перестал прятаться до наведения.
   *
   * Категория со строкой ожидания или с открытым полем ввода пустой не
   * считается: задача в неё уже идёт, и «задач пока нет» спорило бы с
   * набранным именем, стоящим строкой ниже.
   */
  const hintedCategoryId =
    categories.find(
      (category) =>
        (tasksByCategory.get(category.id)?.length ?? 0) === 0 &&
        quick.pendingIn(category.id).length === 0 &&
        newTaskAt?.categoryId !== category.id,
    )?.id ?? null;

  const isLate = (task: Task) => state.deadline !== null && task.end_date > state.deadline;

  /** Подпись бейджа отклонения. Ноль дней бейджа не получает: он ни о чём.
      Единица — короткая («дн.»), как в макете: подпись стоит вплотную к
      полоске, и полное слово толкало бы соседнюю. */
  const deviationLabel = (task: Task) => {
    const shift = endShiftDays(task);
    if (shift === null || shift === 0) return undefined;
    const days = t("common.days_short", { count: Math.abs(shift) });
    return shift > 0 ? t("gantt.deviation_late", { days }) : t("gantt.deviation_early", { days });
  };

  const baselineLabel = (task: Task) =>
    task.baseline_start && task.baseline_end
      ? t("gantt.baseline", {
          from: formatDay(task.baseline_start),
          to: formatDay(task.baseline_end),
        })
      : undefined;

  // Заводить задачи может только тот, кто может писать: строка ввода у
  // читателя обещала бы отказ сервера. Признак считается один раз — по нему
  // строка и рисуется, и занимает место в счёте строк ниже.
  const newTaskShown = canWrite && newTaskAt !== null;

  /**
   * Задача, над которой в этой категории открыта строка ввода. `null` — ввод
   * идёт в конец категории или не в неё вовсе.
   *
   * Названной задачи может уже не быть: её удалили в соседней вкладке, пока
   * поле было открыто. Тогда строка ввода не пропадает вместе с ней, а
   * съезжает в конец категории — написанное в поле дороже точности места.
   */
  const draftBefore = (category: Category): string | null => {
    if (!newTaskShown || newTaskAt.categoryId !== category.id || newTaskAt.before === null) {
      return null;
    }
    const target = newTaskAt.before;
    return (tasksByCategory.get(category.id) ?? []).some((task) => task.id === target)
      ? target
      : null;
  };

  // Номера строк в том же порядке, в каком они ниже и рисуются: строка
  // категории, затем её задачи. Нужны стрелкам — им неоткуда узнать, на какой
  // высоте оказалась задача.
  const rowOf = new Map<string, number>();
  let rowCount = 0;
  for (const category of categories) {
    rowCount += 1;
    const open = !closed.has(category.id);
    const draftIn = newTaskShown && newTaskAt.categoryId === category.id;
    // Строки ожидания — тоже строки: они стоят в середине ленты, и стрелки
    // к задачам всех категорий ниже уехали бы на строку вверх, не будь они
    // здесь сосчитаны. Считаются вместе со строкой ввода: они и рисуются
    // вместе с ней — там, куда вставляют.
    const draftRows =
      (open ? quick.pendingIn(category.id).length : 0) + (draftIn ? 1 : 0);
    const before = draftBefore(category);
    // Задачи свёрнутой категории строк не занимают, и стрелка к ним не
    // рисуется — ей просто не с чем совпасть (см. Arrows).
    if (open) {
      for (const task of tasksByCategory.get(category.id) ?? []) {
        if (task.id === before) rowCount += draftRows;
        rowOf.set(task.id, rowCount);
        rowCount += 1;
      }
    }
    // Строка ввода видна и в свёрнутой категории — потому и сосчитана вне
    // условия: категорию сворачивают и посреди набора, а поле, исчезнувшее
    // из-под курсора, унесло бы с собой написанное.
    if (before === null) rowCount += draftRows;
  }

  /**
   * Номер, на который ляжет новая задача, — или `undefined` для конца списка.
   *
   * `sent` — сколько задач эта же строка ввода уже отправила: «а», «б», «в»
   * подряд обязаны лечь в набранном порядке, а каждая предыдущая сдвигает
   * названную строку на единицу вниз (см. NewTaskRow).
   */
  const insertPosition = (before: string | null, sent: number): number | undefined => {
    if (before === null) return undefined;
    const target = state.tasks.find((task) => task.id === before);
    return target === undefined ? undefined : target.position + sent;
  };

  return (
    // Карточка наведения живёт рядом с лентой, а не внутри неё: она стоит по
    // координатам окна, и полоса прокрутки ленты не должна её обрезать.
    <BarTipProvider
      names={assigneeNames}
      formatDay={relativeAxis ? (iso) => relativeDayLabel(t, iso, anchor) : undefined}
    >
    <div
      // `can-reorder` — не косметика: колонка названий держит поле под ручку
      // перестановки этапа, и держать его у того, кто ничего не переставляет,
      // значило бы отодвинуть имена от края ради невидимой кнопки.
      className={`gantt gantt--${zoom}${reorder.enabled ? " can-reorder" : ""}${
        reorder.active ? " is-reordering" : ""
      }${link.active ? " is-linking" : ""}${view.critical ? " show-critical" : ""}${
        reducedMotion ? " motion-off" : ""
      }`}
      // Высота строки, ширина закреплённой колонки и длительность переходов
      // задаются отсюда по одной и той же причине: все три величины знает не
      // только CSS. По высоте строки стрелки считают вертикальные координаты,
      // по ширине колонки встают сетка и слой стрелок, по длительности код
      // ведёт переезд полоски. Вторые такие же числа в стилях однажды
      // разошлись бы с ними.
      style={
        {
          "--gantt-row": `${ROW_HEIGHT}px`,
          "--gantt-label": `${layoutWidth(layout)}px`,
          // Ширина шкалы — стилям: по ней встаёт полоса «вне плана», а она
          // рисуется двумя узлами на всю ленту, а не по одному в строке.
          "--gantt-lane": `${scale.width}px`,
          "--motion": `${MOTION_MS}ms`,
        } as CSSProperties
      }
    >
      {/* Ряд над лентой — только когда органы управления не отданы экрану
          (публичная страница). На рабочем экране они стоят в шапке проекта
          справа от вкладок, и второго яруса над лентой нет: каждые 46
          пикселей над ней — это строка плана, которой не видно. Ряд видит и
          читатель: масштаб и состав слоёв — способы смотреть, а не менять. */}
      {viewState === undefined && (
        <div className="project-toolbar" aria-label={t("gantt.toolbar.label")}>
          <span className="project-toolbar__spacer" />

          {/* Индикатор режима: пока план относительный, об этом сказано
              словами, а не только шкалой без месяцев. Дата старта назначена —
              индикатор гаснет вместе с относительным режимом: у календарного
              проекта переключателя обратно в «Месяц 1 / Неделя 1» больше нет,
              назначенная дата старта окончательна. Подробность — подсказкой
              самого бейджа, а не строкой над лентой: та стоила ленте полсотни
              пикселей высоты при каждом открытии проекта. */}
          {relativeAxis && (
            <span className="project-toolbar__mode" title={t("gantt.relative.hint")}>
              {t("gantt.relative.badge")}
            </span>
          )}

          <GanttViewControls view={ganttView} />
        </div>
      )}

      {/* Сводка сравнивает конец проекта с дедлайном — двумя настоящими
          датами; у относительной оси её не бывает. */}
      {view.summary && !relativeAxis && <Summary state={state} formatDay={formatDay} />}

      {view.legend && categories.length > 0 && <Legend />}

      {categories.length === 0 ? (
        /* Пустая лента предлагает единственное, что здесь вообще можно
           сделать, — завести первую категорию: без неё задаче некуда лечь.
           Предлагает кнопкой, а не рисунком: нарисованный плюс из `.empty`
           обещал действие, но не выполнял его, и человеку оставалось искать
           «Новую категорию» в тулбаре. Названа кнопка так же, как та, — одно
           действие, одно имя. Без права на запись остаётся одна строка:
           обещать гостю действие, которого у него нет, не за чем. */
        <div className={`empty gantt__empty${onAddCategory ? " gantt__empty--action" : ""}`}>
          {onAddCategory && (
            <button
              type="button"
              className="button--primary gantt__empty-add"
              onClick={onAddCategory}
            >
              <span className="gantt__empty-plus" aria-hidden="true">
                +
              </span>
              {t("category.create")}
            </button>
          )}
          <p>{t("gantt.empty")}</p>
        </div>
      ) : (
        <>
        <div className="gantt__scroll" ref={scroller} onScroll={rememberFocus}>
          <div className="gantt__canvas">
            <div className="gantt__head-row">
              <div className="gantt__label gantt__corner">
                <HeadCells
                  layout={layout}
                  labels={cellLabels.columns}
                  onResize={resizeColumn}
                  onReorder={moveColumn}
                  resizeLabel={(column) => t("gantt.col.resize", { column })}
                  reorderLabel={(column) => t("gantt.col.reorder", { column })}
                  leading={
                    /* «Плюс» у заголовка списка заводит категорию — то
                       единственное, что можно добавить в корень плана, не
                       выбирая родителя. Значок без подписи: рядом стоит
                       слово «Задача», и подпись «Новая категория» под ним
                       читалась бы как заголовок второй колонки. Имя при
                       кнопке остаётся для читалки и подсказки. Гостю и
                       читателю кнопки нет — как и остальных «плюсов» ленты. */
                    onAddCategory && (
                      <button
                        type="button"
                        className="gantt__corner-add"
                        aria-label={t("category.create")}
                        title={t("category.create")}
                        onClick={onAddCategory}
                      >
                        <span aria-hidden="true">+</span>
                      </button>
                    )
                  }
                />
                {/* Кнопка свёртки — в углу таблицы, на границе со шкалой: она
                    двигает эту границу, и стоять обязана там же. В шапке
                    проекта, к которой её просилось бы отнести, она оказалась
                    бы в ряду настроек показа — среди «Масштаба» и «Вида», то
                    есть в списке того, что открывают, чтобы что-то настроить.
                    Здесь её видно сразу и целиться в неё не надо. */}
                <button
                  type="button"
                  className="gantt__fold"
                  aria-expanded={!layout.collapsed}
                  aria-label={t(layout.collapsed ? "gantt.table.expand" : "gantt.table.collapse")}
                  title={t(layout.collapsed ? "gantt.table.expand" : "gantt.table.collapse")}
                  onClick={toggleTable}
                >
                  <FoldIcon open={!layout.collapsed} />
                </button>
              </div>
              {relativeAxis ? (
                <RelativeHeader
                  scale={scale}
                  calendar={state.calendar}
                  monthLabel={(number) => t("gantt.relative.month", { number })}
                  weekLabel={(number) => t("gantt.relative.week", { number })}
                />
              ) : (
                <Header
                  scale={scale}
                  calendar={state.calendar}
                  today={today}
                  todayLabel={t("gantt.today")}
                  monthLabel={(iso) => formatMonth(t, iso)}
                  weekdayLabel={(weekday) => weekdayNarrow(t, weekday)}
                />
              )}
              {/* Пустое поле за правым краем шкалы. Лента идёт во всю ширину
                  экрана, а план — только до своего конца, и без этой полосы
                  разница между «здесь ничего не запланировано» и «здесь
                  оборвалась вёрстка» видна не была: сетка просто кончалась
                  белым швом. Двумя узлами на всю ленту, а не по одному в
                  строке: поле одинаково во всех строках — тот же довод, по
                  которому одна на всех и сама сетка (см. Grid). */}
              <div className="gantt__beyond gantt__beyond--head" aria-hidden="true" />
            </div>

            <div className="gantt__body">
              <div className="gantt__beyond" aria-hidden="true" />
              <Grid
                scale={scale}
                calendar={state.calendar}
                deadline={state.deadline}
                // Пустая строка вместо даты: линии «сегодня» в относительном
                // представлении нет — настоящих дат на этой шкале не рисуют.
                today={relativeAxis ? "" : today}
                deadlineLabel={
                  state.deadline ? t("gantt.deadline", { date: formatDay(state.deadline) }) : ""
                }
                todayLabel={t("gantt.today")}
              />

              <Arrows
                scale={scale}
                tasks={state.tasks}
                dependencies={state.dependencies}
                rowOf={rowOf}
                rows={rowCount}
              />

              {link.enabled && (
                // Линия связи под пальцем. Слой стоит всегда, а не только на
                // время жеста: его координаты нужны уже в момент нажатия — с
                // них линия и начинается, — а узел, созданный тем же кадром,
                // к этому моменту ещё не смонтирован. Видимость снимает CSS
                // по признаку на корне ленты.
                <svg
                  className="gantt__link-layer"
                  ref={link.layerRef}
                  width={scale.width}
                  height={rowCount * ROW_HEIGHT}
                  aria-hidden="true"
                >
                  <line ref={link.lineRef} className="gantt__link-line" />
                </svg>
              )}

              <div className="gantt__rows">
                {categories.map((category: Category, categoryIndex: number) => {
                  const tasks = tasksByCategory.get(category.id) ?? [];
                  const open = !closed.has(category.id);
                  const before = draftBefore(category);
                  // Строки ожидания и поле ввода — одним куском: они стоят там,
                  // куда вставляют, а не всегда в конце категории. Иначе имя,
                  // только что отправленное, мигало бы внизу списка, чтобы через
                  // мгновение оказаться посередине.
                  const draft = (
                    <>
                      {open &&
                        quick.pendingIn(category.id).map((row) => (
                          <PendingRow
                            key={row.id}
                            layout={layout}
                            scale={scale}
                            name={row.name}
                            title={t("task.new.creating")}
                          />
                        ))}
                      {newTaskShown && newTaskAt.categoryId === category.id && (
                        <NewTaskRow
                          layout={layout}
                          scale={scale}
                          label={t("task.new.aria", { category: category.name })}
                          placeholder={t("task.new.placeholder")}
                          onCreate={(name, sent) =>
                            quick.create(category.id, name, insertPosition(before, sent))
                          }
                          onClose={() => onCloseNewTask?.()}
                        />
                      )}
                    </>
                  );
                  // Этап, который держат в руке, гаснет весь — вместе со
                  // своими задачами: переезжает он целиком, и погашенный
                  // один заголовок обещал бы, что задачи останутся здесь.
                  const held =
                    reorder.dragging?.kind === "category" &&
                    reorder.dragging.id === category.id;
                  return (
                    <div
                      key={category.id}
                      className={`gantt__group${held ? " is-dragged" : ""}`}
                    >
                      <CategoryRow
                        projectId={projectId}
                        category={category}
                        tasks={tasks}
                        scale={scale}
                        onReach={onReach}
                        layout={layout}
                        format={format}
                        canWrite={canWrite}
                        moveLabel={t("gantt.move_category", { name: category.name })}
                        reorderLabel={t("gantt.reorder_category", { name: category.name })}
                        addLabel={t("task.add_to", { category: category.name })}
                        // Подсказка в пустой полосе — только у одной категории
                        // и только тому, кто может писать (см.
                        // hintedCategoryId выше).
                        emptyHint={
                          onAddTask && category.id === hintedCategoryId
                            ? t("gantt.category_empty")
                            : undefined
                        }
                        // Плюс на строке категории кладёт задачу в её конец:
                        // место в середине выбирают плюсом на границе строк.
                        onAddTask={
                          onAddTask && ((categoryId) => onAddTask({ categoryId, before: null }))
                        }
                        deleteLabel={t("category.delete", { name: category.name })}
                        // Крестик есть у всякой категории, а не только у
                        // пустой: этап отменяют целиком, и разбирать его по
                        // задаче ради того, чтобы избавиться от заголовка, —
                        // столько удалений, сколько в нём строк. Что уйдёт
                        // вместе с категорией, экран говорит вслух и ждёт
                        // подтверждения (см. onDeleteCategory).
                        onDelete={onDeleteCategory}
                        reorder={reorder}
                        open={open}
                        onToggle={() => toggleCategory(category.id)}
                        toggleLabel={t("gantt.toggle_category", { name: category.name })}
                        index={categoryIndex}
                        categoriesCount={categories.length}
                      />
                      {open &&
                        tasks.map((task) => (
                          <Fragment key={task.id}>
                            {/* Поле ввода стоит над той строкой, перед которой
                                вставляют, а не в конце категории. */}
                            {task.id === before && draft}
                            <TaskRow
                              projectId={projectId}
                              task={task}
                              scale={scale}
                              onReach={onReach}
                              calendar={state.calendar}
                              layout={layout}
                              cellLabels={cellLabels}
                              format={format}
                              canWrite={canWrite}
                              late={isLate(task)}
                              lateLabel={t("gantt.late")}
                              title={
                                task.milestone
                                  ? `${t("gantt.milestone.short")}, ${formatDay(task.start_date)}`
                                  : `${formatDay(task.start_date)} — ${formatDay(task.end_date)}`
                              }
                              selected={task.id === selectedTaskId}
                              onSelect={onSelectTask}
                              onOpenComments={onOpenComments}
                              commentCount={commentCounts?.get(task.id) ?? 0}
                              // Плюс на границе строк заводит задачу перед этой.
                              // Только тому, кто может писать: у читателя он
                              // обещал бы отказ сервера.
                              onInsertBefore={
                                canWrite && onAddTask
                                  ? () => onAddTask({ categoryId: category.id, before: task.id })
                                  : undefined
                              }
                              reorder={reorder}
                              link={link}
                              assigneeNames={assigneeNames}
                              categories={categories}
                              taskCountByCategory={taskCountByCategory}
                              handleLabel={t("gantt.reorder", { name: task.name })}
                              beyondPlan={isBeyondPlan(state, task)}
                              beyondPlanLabel={t("gantt.beyond_plan")}
                              // Та же фраза, что и в карточке задачи: одно
                              // объяснение на оба места, где о нём спрашивают.
                              beyondPlanHint={t("plan.beyond_plan_explained")}
                              baselineLabel={baselineLabel(task)}
                              deviationLabel={deviationLabel(task)}
                              statusLabel={t(`task.status.${task.status}`)}
                              showBaseline={baselineOn}
                            />
                          </Fragment>
                        ))}

                      {/* В конце категории — то, что не встало посередине:
                          строки ожидания и поле ввода, если вставляют не перед
                          названной задачей, а просто в эту категорию. */}
                      {before === null && draft}
                    </div>
                  );
                })}

                {/* Низ ленты — продолжение списка, а не его край: строки ниже
                    стоят один раз, после самой последней категории, и едут
                    вниз вместе с новым содержимым сами — потому что стоят
                    после него в том же потоке разметки (см. BottomActions.tsx
                    и Grid.tsx о том, почему сетка Ганта справа растягивается
                    вместе с ними). */}
                {onAddTask && (
                  <AddTaskRow
                    scale={scale}
                    // Одна подпись на глаз и на слух: та же строка, что и у
                    // «плюса» на строке этой категории, — одно действие, одно
                    // имя. Прежде видимый текст называл действие, а имя
                    // категории знала только читалка (см. AddTaskRow).
                    label={t("task.add_to", {
                      category: categories[categories.length - 1].name,
                    })}
                    onClick={() =>
                      onAddTask({
                        categoryId: categories[categories.length - 1].id,
                        before: null,
                      })
                    }
                  />
                )}
                {canWrite && (
                  <>
                    {quickCategory.pending.map((row) => (
                      <PendingCategoryRow
                        key={row.id}
                        scale={scale}
                        name={row.name}
                        title={t("category.quick.creating")}
                      />
                    ))}
                    {composingCategory && (
                      <NewCategoryRow
                        scale={scale}
                        label={t("category.quick.aria")}
                        placeholder={t("category.quick.placeholder")}
                        onCreate={(name) => quickCategory.create(name)}
                        onClose={() => setComposingCategory(false)}
                      />
                    )}
                    {/* Кнопка остаётся на месте и тогда, когда поле над ней
                        уже открыто: ею заводят следующую категорию, когда
                        эта сохранится, — по тому же приёму, что и у «плюса»
                        задачи на строке категории. */}
                    <AddCategoryRow
                      scale={scale}
                      label={t("category.create")}
                      onClick={() => setComposingCategory(true)}
                    />
                  </>
                )}

                {/* Воздух после последней строки: конец списка читается как
                    место, где проект продолжают, а не как обрыв таблицы у
                    нижней границы экрана. */}
                <div className="gantt__bottom-space" aria-hidden="true" />
              </div>
            </div>
          </div>
        </div>
        {/* Сноска под лентой: расшифровка засечки и стрелки — двух знаков,
            которые не объясняются легендой из плашек. Включается в «Виде». */}
        {view.caption && <p className="gantt__caption">{t("gantt.caption")}</p>}
        </>
      )}

      {/* Призрак переносимой строки — то, что сейчас в руке.

          Без него о переносе говорила одна линия вставки: сама строка
          оставалась стоять, где стояла, и на длинном списке, где взятая строка
          уже уехала за край экрана, человек вёл курсор, не помня, что именно
          он ведёт. Поэтому имя едет за курсором, а строка-источник гаснет:
          полупрозрачность и там, и там означает «это ещё не случилось».

          Стоит по координатам окна и событий не ловит (`pointer-events: none`
          в стилях): цель броска ищут попаданием в точку, и призрак под
          курсором закрывал бы собой ровно ту строку, в которую целятся. */}
      {reorder.ghost && (
        <div className="gantt__drag-ghost" ref={reorder.ghostRef} aria-hidden="true">
          <span className="gantt__drag-ghost-grip">⠿</span>
          {reorder.ghost.color && (
            <i className="gantt__drag-ghost-dot" style={{ background: reorder.ghost.color }} />
          )}
          <span className="gantt__drag-ghost-name">{reorder.ghost.name}</span>
        </div>
      )}
    </div>
    </BarTipProvider>
  );
}

/**
 * Знак кнопки, двигающей границу таблицы: черта и стрелка к ней.
 *
 * Стрелка показывает, куда уедет граница, а не то, что сейчас: у развёрнутой
 * таблицы она смотрит влево — «убрать таблицу», у свёрнутой вправо — «вернуть».
 * Знак рисунком, а не ««» и «»»: типографские кавычки читаются с экрана как
 * знаки препинания, а в ряду тонких линий таблицы выглядят опечаткой.
 */
function FoldIcon({ open }: { open: boolean }) {
  return (
    <svg className="glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {open ? (
        <>
          <path d="M11.5 3v10" />
          <path d="M9 8H3.5M6 5 3 8l3 3" />
        </>
      ) : (
        <>
          <path d="M4.5 3v10" />
          <path d="M7 8h5.5M10 5l3 3-3 3" />
        </>
      )}
    </svg>
  );
}

/**
 * Легенда — строка условных обозначений над лентой.
 *
 * Перечисляет не один набор, а два, потому что и полоска говорит двумя
 * способами. Заливка означает статус, и статусов ровно четыре — они
 * взаимоисключающие. Просрочка и критичность заливкой не бывают: это флаги
 * поверх любого статуса, и в легенде они показаны тем же, чем рисуются на
 * ленте, — контуром и левой гранью на нейтральной заливке. Сплошным цветом
 * они обещали бы пятый и шестой статус, которых не существует.
 */
function Legend() {
  const { t } = useLocale();
  return (
    <p className="gantt__legend">
      {TASK_STATUSES.map((status) => (
        <span key={status} className="gantt__legend-item">
          <i className="gantt__swatch" data-status={status} aria-hidden="true" />
          {t(`task.status.${status}`)}
        </span>
      ))}
      <span className="gantt__legend-item">
        <i className="gantt__swatch" data-overlay="late" aria-hidden="true" />
        {t("gantt.late")}
      </span>
      <span className="gantt__legend-item">
        <i className="gantt__swatch" data-overlay="critical" aria-hidden="true" />
        {t("gantt.legend.blocker")}
      </span>
      <span className="gantt__legend-item">
        <i className="gantt__swatch gantt__swatch--critical" aria-hidden="true" />
        {t("gantt.legend.critical")}
      </span>
      <span className="gantt__legend-item">
        <i className="gantt__swatch gantt__swatch--line gantt__swatch--deadline" aria-hidden="true" />
        {t("gantt.legend.late")}
      </span>
      <span className="gantt__legend-item">
        <i className="gantt__swatch gantt__swatch--line gantt__swatch--today" aria-hidden="true" />
        {t("gantt.today")}
      </span>
    </p>
  );
}

/**
 * Плашка с итогом по дедлайну.
 *
 * Единственная цифра, которая по-настоящему интересует заказчика, поэтому она
 * висит постоянно, а не появляется по наведению. Без дедлайна плашки нет:
 * писать «успеваем» там, где успевать не к чему, — это выдумывать смысл.
 */
function Summary({
  state,
  formatDay,
}: {
  state: ProjectState;
  formatDay: (iso: string) => string;
}) {
  const { t } = useLocale();
  if (state.deadline === null || state.project_end === null) return null;

  const overrun = daysBetween(state.deadline, state.project_end);
  const params = {
    end: formatDay(state.project_end),
    deadline: formatDay(state.deadline),
    days: t("common.days", { count: Math.abs(overrun) }),
  };

  return (
    <p className={`gantt__summary${overrun > 0 ? " is-late" : " is-fine"}`}>
      {overrun > 0 ? t("gantt.summary.late", params) : t("gantt.summary.fits", params)}
    </p>
  );
}
