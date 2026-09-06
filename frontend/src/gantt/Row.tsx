import { useId, useState } from "react";
import type { CSSProperties, HTMLAttributes, ReactNode, RefCallback } from "react";

import type { Calendar, Category, Task } from "../api/projects";
import { Avatar } from "../components/Avatar";
import { CommentIcon, EditableCell, PencilIcon, RowBadge, RowIcon } from "../components/rows";
import { useLocale } from "../i18n/LocaleProvider";
import { baselineOf, endShiftDays } from "../project/baseline";
import {
  deleteTask,
  patchProgress,
  patchTask,
  renameCategory,
  reorderCategory,
  reorderTask,
} from "../project/optimistic";
import { useProjectMutation } from "../project/useProjectMutation";
import { AssignMenu, PeopleIcon } from "./AssignMenu";
import { useBarTip } from "./BarTip";
import { Cell, rollUp, shownColumns } from "./Cells";
import type { ColumnKey, ColumnLayout } from "./columns";
import { dateOfProjectDay, projectDayNumber } from "./relative";
import { MenuAction, MenuBack, MenuSeparator, RowMenu } from "./RowMenu";
import { workingDaysBetween } from "./scale";
import { useBarMotion } from "./useBarMotion";
import { useDragCategory } from "./useDragCategory";
import { useDragDates } from "./useDragDates";
import type { LinkDrag } from "./useLinkDrag";
import { halfOf } from "./useReorder";
import type { Reorder } from "./useReorder";
import { useTruncatedTitle } from "./useTruncatedTitle";
import type { Scale } from "./timescale";

/**
 * Как строка показывает даты и как их принимает обратно.
 *
 * Приходит из ленты, а не собирается здесь: у относительного плана настоящих
 * дат нет, и «14 августа» на его шкале — это выдумка. Ввод зеркален показу —
 * там, где строка показала «День 8», она и принимает восьмой день, а не дату.
 */
export type DayFormat = {
  /** Дата в том виде, в каком её читают глазами. */
  label: (iso: string) => string;
  /** Ось относительная: правка старта идёт номером дня проекта, а не датой. */
  relative: boolean;
  /** Начало относительной оси: эпоха либо назначенный старт. */
  anchor: string;
};

/**
 * Подписи ячеек. Собраны лентой один раз и переданы вниз, а не взяты словарём
 * в каждой строке: на сотне задач это сотня одинаковых обращений к словарю за
 * теми же шестью строками.
 */
export type CellLabels = {
  columns: Record<ColumnKey, string>;
  /** «Изменить {что} у {задачи}» — подпись поля, открытого на месте. */
  edit: (column: string, name: string) => string;
};

/**
 * Ячейки закреплённой колонки для одной строки.
 *
 * Первая колонка отдана содержимым — в ней живут шеврон, ручка, имя и флажки;
 * остальные раскладываются одинаково и потому собираются здесь по списку.
 */
function LabelCells({
  layout,
  task,
  cells,
}: {
  layout: ColumnLayout;
  /** Содержимое колонки названия: у категории и задачи оно разное. */
  task: ReactNode;
  /** Готовое содержимое остальных колонок. Пустая — прочерк. */
  cells: Partial<Record<ColumnKey, ReactNode>>;
}) {
  return (
    <>
      {shownColumns(layout).map((column) => (
        <Cell key={column} column={column} layout={layout}>
          {column === "task" ? task : (cells[column] ?? <span className="muted">—</span>)}
        </Cell>
      ))}
    </>
  );
}

/**
 * Строка-заголовок категории: шеврон и название.
 *
 * Полоса рисуется по крайним датам содержимого, а не по отдельно хранимым
 * границам категории: вторых не существует, и заводить их значило бы держать
 * значение, которое обязано совпадать с задачами, но однажды разойдётся.
 *
 * За эту же полосу категорию и двигают: этап целиком уезжает на неделю —
 * обычное дело, и до этого оно означало перетащить каждую полоску по очереди
 * (см. useDragCategory).
 */
export function CategoryRow({
  projectId,
  category,
  tasks,
  scale,
  onReach,
  layout,
  format,
  addLabel,
  emptyHint,
  onAddTask,
  deleteLabel,
  onDelete,
  reorder,
  canWrite = false,
  moveLabel,
  reorderLabel,
  open = true,
  onToggle,
  toggleLabel,
  index = 0,
  categoriesCount = 1,
}: {
  projectId: string;
  category: Category;
  tasks: Task[];
  scale: Scale;
  /** Полосу держат за краем окна — лента достраивает его (см. reach в Gantt). */
  onReach?: (endISO: string | null) => void;
  layout: ColumnLayout;
  /** Строка категории — сводка, а не правка: её ячейки только показывают. */
  format: DayFormat;
  addLabel: string;
  /**
   * Что написать в пустой полосе категории вместо пустоты. Не передано —
   * полоса остаётся пустой.
   *
   * Решает лента, а не строка: подсказку показывают одной категории на весь
   * экран, а строка знает только про себя (см. `hintedCategoryId` в Gantt).
   */
  emptyHint?: string;
  onAddTask?: (categoryId: string) => void;
  deleteLabel?: string;
  /** Крестик удаления. Спрашивает подтверждение не он, а экран: вместе с
      категорией уходят её задачи, и назвать их число строка не может — она
      знает только свои (см. onDeleteCategory в Gantt). */
  onDelete?: (categoryId: string) => void;
  reorder?: Reorder;
  /** Может ли этот человек двигать категорию целиком. */
  canWrite?: boolean;
  moveLabel?: string;
  /** Подпись ручки перестановки этапов. */
  reorderLabel?: string;
  /** Развёрнута ли категория: свёрнутая прячет свои строки задач. */
  open?: boolean;
  onToggle?: () => void;
  toggleLabel?: string;
  /** Место категории в списке этапов — знает пункт «Переместить» в меню. */
  index?: number;
  categoriesCount?: number;
}) {
  const { t } = useLocale();
  const { apply } = useProjectMutation(projectId);
  // Узел с названием категории: им описана кнопка «⋯» — так же, как у строки
  // задачи (см. nameId в TaskRow и describedBy в RowMenu).
  const categoryNameId = useId();
  const span = rollUp(tasks);
  // Пустая категория говорит о себе разметкой: по этому признаку «плюс» на
  // строке перестаёт прятаться до наведения (см. .gantt__row--category.is-empty
  // в gantt.css). Пока в категории есть задачи, знаки строки ведут себя как
  // везде — молчат, пока на строку не навели.
  const empty = tasks.length === 0;
  const drag = useDragCategory({
    projectId,
    category,
    scale,
    // Конец сводной полосы: от него жест считает, докуда дотянул весь этап,
    // когда полосу держат за краем окна (см. `onReach`).
    spanEnd: span?.end ?? null,
    onReach,
    // Пустую категорию двигать нечем: сервер откажет, полосы на ленте и так нет.
    enabled: canWrite && tasks.length > 0,
  });

  // Открывает поле названия не щелчком по нему, а пунктом «Переименовать
  // категорию» в меню «⋯». Число, а не признак: второй выбор того же пункта
  // подряд (передумал, отменил, выбрал снова) обязан открыть поле заново, а
  // неизменный `true` для эффекта — не повод.
  const [renameToken, setRenameToken] = useState(0);
  // Вложенный вид меню — список этапов у пункта «Переместить». Живёт здесь, а
  // не внутри RowMenu: панель не помнит своего содержимого, и `onClose` ниже
  // возвращает вид в корень при любом способе закрытия.
  const [menuView, setMenuView] = useState<"root" | "move">("root");

  const duplicate = () => {
    void apply(
      { type: "create_category", name: `${category.name} ${t("gantt.row_menu.copy_suffix")}`, color: category.color },
      (state) => state,
    ).catch(() => {});
  };

  const moveBy = (delta: number) => {
    const position = index + delta;
    void apply(
      { type: "reorder_category", category_id: category.id, position },
      (state) => reorderCategory(state, category.id, position),
    ).catch(() => {});
  };

  return (
    <div
      className={`gantt__row gantt__row--category${empty ? " is-empty" : ""} ${
        reorder?.markFor("category", category.id) ?? ""
      }`.trimEnd()}
      // Заголовок категории — тоже цель броска: перенести задачу в другую
      // категорию иначе можно было бы только через список в карточке.
      //
      // Чем строка приходится броску, сказано прямо в разметке: пальцем
      // события до неё не доходят вовсе, и ручка ищет её попаданием в точку —
      // по найденному элементу узнать строку больше не по чему (см. `targetAt`
      // в useReorder).
      data-drop-kind="category"
      data-drop-id={category.id}
      // Половина строки названа настоящая, а не всегда нижняя: задаче она не
      // нужна вовсе (бросок на заголовок кладёт её в конец этапа), но
      // категория именно ею и выбирает, встать до этого этапа или после.
      onPointerMove={(event) =>
        reorder?.over({
          kind: "category",
          id: category.id,
          half: halfOf(event.currentTarget, event.clientY),
        })
      }
      onPointerUp={() => reorder?.drop()}
    >
      <div className="gantt__label">
        <LabelCells
          layout={layout}
          cells={{
            start: span && <span className="cell-value">{format.label(span.start)}</span>,
            end: span && <span className="cell-value">{format.label(span.end)}</span>,
            progress: span && <span className="cell-value">{span.progress}%</span>,
          }}
          task={
            <>
              {reorder?.enabled && (
                // Этапы переставляют тем же жестом, что и задачи: ручка,
                // ведущая себя по-разному на заголовке и на строке под ним,
                // была бы двумя вещами, выглядящими как одна.
                //
                // Стоит левее шеврона — в поле, которое колонка держит под
                // ручки (см. --gantt-pad в gantt.css): у задачи ручка занимает
                // столбец шеврона, у категории он занят самим шевроном, и
                // единственное место, где они не наезжают друг на друга, — на
                // ступеньку левее. Заодно это читается как вложенность: этап
                // берут за край, задачу — изнутри него.
                //
                // Не кнопка и скрыта от чтения с экрана — как и у задачи, и по
                // той же причине: перестановка строк с клавиатуры в этот план
                // не входит (см. TaskRow ниже).
                <span
                  className="gantt__handle gantt__handle--category"
                  aria-hidden="true"
                  title={reorderLabel}
                  {...reorder.handleProps("category", category.id)}
                >
                  ⠿
                </span>
              )}
              {onToggle && (
                // Шеврон — кнопка сворачивания, как в макете: свёрнутая категория
                // остаётся строкой с полосой охвата, её задачи прячутся.
                <button
                  type="button"
                  className="row-chevron"
                  aria-expanded={open}
                  aria-label={toggleLabel}
                  title={toggleLabel}
                  onClick={onToggle}
                >
                  {open ? "▾" : "▸"}
                </button>
              )}
              <EditableCell
                type="text"
                value={category.name}
                display={category.name}
                disabled={!canWrite}
                className="gantt__label-name"
                id={categoryNameId}
                editTrigger={renameToken}
                label={t("category.rename", { name: category.name })}
                onCommit={(value) => {
                  const name = value.trim();
                  if (name === "" || name === category.name) return;
                  void apply(
                    { type: "rename_category", category_id: category.id, name },
                    (state) => renameCategory(state, category.id, name),
                  ).catch(() => {});
                }}
              />
              {/* Быстрое добавление задачи остаётся своим знаком рядом с
                  именем — категория заводит задачи чаще, чем всё остальное,
                  что есть в меню «⋯», и просить два щелчка там, где хватало
                  одного, было бы шагом назад. Остальные действия — в меню. */}
              {onAddTask && (
                <span className="row-icons">
                  <RowIcon label={addLabel} onClick={() => onAddTask(category.id)}>
                    +
                  </RowIcon>
                </span>
              )}
              {(onAddTask || onDelete || canWrite) && (
                <RowMenu
                  label={t("gantt.row_menu.category_label")}
                  describedBy={categoryNameId}
                  onClose={() => setMenuView("root")}
                  testId={`category-menu-${category.id}`}
                >
                  {(close) =>
                    menuView === "move" ? (
                      <>
                        <MenuBack label={t("gantt.row_menu.move")} onClick={() => setMenuView("root")} />
                        <MenuAction
                          icon={<span aria-hidden="true">↑</span>}
                          disabled={index <= 0}
                          onClick={() => {
                            moveBy(-1);
                            close();
                          }}
                        >
                          {t("gantt.row_menu.move_up")}
                        </MenuAction>
                        <MenuAction
                          icon={<span aria-hidden="true">↓</span>}
                          disabled={index >= categoriesCount - 1}
                          onClick={() => {
                            moveBy(1);
                            close();
                          }}
                        >
                          {t("gantt.row_menu.move_down")}
                        </MenuAction>
                      </>
                    ) : (
                      <>
                        {onAddTask && (
                          <MenuAction
                            icon={<span aria-hidden="true">+</span>}
                            onClick={() => {
                              onAddTask(category.id);
                              close();
                            }}
                          >
                            {t("gantt.row_menu.add_task")}
                          </MenuAction>
                        )}
                        {canWrite && (
                          <MenuAction
                            icon={<PencilIcon />}
                            onClick={() => {
                              setRenameToken((current) => current + 1);
                              close();
                            }}
                          >
                            {t("gantt.row_menu.rename_category")}
                          </MenuAction>
                        )}
                        {canWrite && (
                          <MenuAction
                            icon={<span aria-hidden="true">⧉</span>}
                            onClick={() => {
                              duplicate();
                              close();
                            }}
                          >
                            {t("gantt.row_menu.duplicate")}
                          </MenuAction>
                        )}
                        {canWrite && categoriesCount > 1 && (
                          <MenuAction
                            icon={<span aria-hidden="true">↔</span>}
                            onClick={() => setMenuView("move")}
                          >
                            {t("gantt.row_menu.move")}
                          </MenuAction>
                        )}
                        {onDelete && deleteLabel !== undefined && (
                          <>
                            <MenuSeparator />
                            <MenuAction
                              icon={<span aria-hidden="true">×</span>}
                              tone="danger"
                              onClick={() => {
                                // Сам пункт ничего не удаляет: он открывает
                                // вопрос «вместе с этими задачами?», который
                                // задаёт экран (см. onDeleteCategory в Gantt).
                                onDelete(category.id);
                                close();
                              }}
                            >
                              {t("gantt.row_menu.delete_category")}
                            </MenuAction>
                          </>
                        )}
                      </>
                    )
                  }
                </RowMenu>
              )}
            </>
          }
        />
      </div>

      <div className="gantt__lane" style={{ width: scale.width }}>
        {span && (
          <div
            ref={drag.spanRef}
            className={`gantt__span${drag.handlers ? " is-draggable" : ""}${
              drag.dragging ? " is-dragging" : ""
            }`}
            style={{
              left: scale.xOf(span.start),
              width: scale.widthOf(span.start, span.end),
              background: category.color,
              // Тем же цветом красятся засечки-стрелки по краям полосы: они
              // рисуются рамкой на псевдоэлементах и берут его через
              // `currentColor` — второго места с цветом категории не заводим.
              color: category.color,
            }}
            title={drag.handlers ? moveLabel : undefined}
            // Полоса не орган управления даже когда её тащат: перенос этапа
            // мышью — ускорение, а не единственный путь, и с клавиатуры те же
            // задачи двигаются каждая своей полоской. Кнопка здесь обещала бы
            // действие по Enter, которого нет.
            aria-hidden="true"
            {...drag.handlers}
          />
        )}
        {empty && emptyHint !== undefined && onAddTask && (
          // Подсказка стоит в полосе, а не отдельной строкой: полоса пустой
          // категории всё равно ничем не занята, и объяснение, вставшее в неё,
          // не двигает вниз ни одной строки ленты и исчезает с первой же
          // задачей само.
          //
          // Кнопка, а не надпись: она предлагает действие и обязана его
          // выполнять — нарисованное приглашение, которое не нажимается,
          // отправляло бы искать «плюс» глазами (тот же довод, что у кнопки
          // посреди пустой ленты, см. gantt__empty-add).
          //
          // Имя категории — описанием, а не подписью: видимый текст один и тот
          // же на любой категории, и подменять им произносимое значило бы
          // рассказывать читалке не то, что написано (см. describedBy у «⋯»).
          <button
            type="button"
            className="gantt__lane-hint"
            aria-describedby={categoryNameId}
            onClick={() => onAddTask(category.id)}
          >
            <span className="gantt__lane-hint-plus" aria-hidden="true">
              +
            </span>
            {emptyHint}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Строка задачи.
 *
 * Полоска — кнопка, а не `div` с обработчиком, везде, где по ней кликают или
 * ходят с клавиатуры: кнопка приносит фокус, роль и реакцию на Enter даром,
 * `div` пришлось бы доводить до того же руками и забыть половину. Там, где она
 * не делает ни того ни другого — на публичной странице, — она объявляется
 * картинкой; см. `Bar` ниже.
 */
export function TaskRow({
  projectId,
  task,
  scale,
  onReach,
  calendar,
  layout,
  cellLabels,
  format,
  late,
  lateLabel,
  title,
  canWrite = false,
  selected = false,
  onSelect,
  reorder,
  link,
  handleLabel,
  beyondPlan = false,
  beyondPlanLabel,
  beyondPlanHint,
  baselineLabel,
  deviationLabel,
  statusLabel,
  showBaseline = true,
  assigneeNames,
  commentCount = 0,
  onOpenComments,
  onInsertBefore,
  categories,
  taskCountByCategory,
}: {
  projectId: string;
  task: Task;
  scale: Scale;
  /** Полоску держат за краем окна — лента достраивает его (см. reach в Gantt). */
  onReach?: (endISO: string | null) => void;
  /** Рабочий календарь: им правая грань переводит день в длительность. */
  calendar: Calendar;
  layout: ColumnLayout;
  cellLabels: CellLabels;
  format: DayFormat;
  late: boolean;
  lateLabel: string;
  title: string;
  canWrite?: boolean;
  /** Открыта ли карточка этой задачи. */
  selected?: boolean;
  onSelect?: (taskId: string) => void;
  reorder?: Reorder;
  /** Протягивание связи от кружка на краю полоски. У гостя его нет. */
  link?: LinkDrag;
  handleLabel?: string;
  /** Задача добавлена после согласования плана — см. isBeyondPlan. */
  beyondPlan?: boolean;
  /** Короткая подпись метки у полоски: «Сверх плана». */
  beyondPlanLabel?: string;
  /** Подсказка метки: почему у задачи нет призрака базового плана. */
  beyondPlanHint?: string;
  /** Подпись призрака: даты утверждённого плана. */
  baselineLabel?: string;
  /** Готовая подпись бейджа отклонения, например «+7 дней». */
  deviationLabel?: string;
  /** Подпись плашки статуса — нужна только полоске «заблокировано». */
  statusLabel?: string;
  /** Рисовать ли призрак и засечку базового плана — флажок меню «Вид». */
  showBaseline?: boolean;
  /**
   * Состав организации: имена по идентификаторам. Им подписаны исполнители
   * задачи — и из него же выбирают новых (см. AssignMenu). `undefined` —
   * состава не знаем вовсе (публичная страница, роль без права на список), и
   * тогда колонка исполнителей молчит, а назначать некого.
   */
  assigneeNames?: ReadonlyMap<string, string>;
  /** Сколько реплик у задачи. Ноль числа не показывает — показывать нечего. */
  commentCount?: number;
  /** Открыть обсуждение задачи. `undefined` — карточки нет (гость). */
  onOpenComments?: (taskId: string) => void;
  /** Завести задачу прямо над этой строкой. `undefined` — читателю. */
  onInsertBefore?: () => void;
  /** Все категории проекта — знает пункт «Переместить» в меню строки. */
  categories?: Category[];
  /** Сколько задач уже в каждой категории — туда, куда переносят, задача
      встаёт в конец, а конец и есть текущее число строк. */
  taskCountByCategory?: ReadonlyMap<string, number>;
}) {
  const { t } = useLocale();
  const { apply } = useProjectMutation(projectId);
  // Узел с названием задачи: им подписана кнопка исполнителей — она называет
  // себя «Исполнители», а какой задачи, говорит описанием (см. AssignMenu).
  const nameId = useId();
  // Полное имя тултипом — но только когда оно и правда обрезано многоточием
  // (см. useTruncatedTitle). Ширина колонки — во втором параметре: её тянут
  // за границу, и обрезка меняется без единой правки самого имени.
  const nameTitle = useTruncatedTitle<HTMLSpanElement>(task.name, layout.widths.task);
  // Место полоски по датам. Считается здесь, а не в разметке ниже, потому что
  // его знать нужно двоим: самой разметке и слою движения — тот сравнивает его
  // с местом на прошлом рендере и по разнице показывает переезд.
  const left = scale.xOf(task.start_date);
  // Веха занимает один день независимо от того, что лежит в длительности:
  // ромб стоит в своём дне, а не растягивается по нему.
  const width = task.milestone
    ? scale.dayWidth
    : scale.widthOf(task.start_date, task.end_date);
  const motion = useBarMotion({ left, scaleKey: scale.key });
  const { dragging, handlers, gripHandlers } = useDragDates({
    projectId,
    task,
    scale,
    calendar,
    enabled: canWrite,
    motion,
    onReach,
  });
  const tip = useBarTip(task, canWrite);
  const baseline = baselineOf(task);
  const shift = endShiftDays(task);

  // Правки прямо в таблице. Каждая — та же операция, что и в карточке задачи:
  // ячейка не заводит своего способа менять срок, она вызывает уже
  // существующий. Отказ откатывает `apply`, и ячейка возвращается к правде
  // сама — своего состояния «не сохранилось» у неё нет.
  const edit = {
    start: (value: string) => {
      const start = format.relative ? dateOfProjectDay(Number(value), format.anchor) : value;
      if (start === task.start_date) return;
      void apply({ type: "move_task", task_id: task.id, start_date: start }, (state) =>
        patchTask(state, task.id, { start_date: start }),
      ).catch(() => {});
    },
    end: (value: string) => {
      const finish = format.relative ? dateOfProjectDay(Number(value), format.anchor) : value;
      if (finish < task.start_date) return;
      const duration_days = Math.max(1, workingDaysBetween(task.start_date, finish, calendar));
      if (duration_days === task.duration_days) return;
      void apply({ type: "set_duration", task_id: task.id, duration_days }, (state) =>
        patchTask(state, task.id, { duration_days }),
      ).catch(() => {});
    },
    duration: (value: string) => {
      const duration_days = Number(value);
      if (!Number.isInteger(duration_days) || duration_days < 1) return;
      void apply({ type: "set_duration", task_id: task.id, duration_days }, (state) =>
        patchTask(state, task.id, { duration_days }),
      ).catch(() => {});
    },
    progress: (value: string) => {
      const pct = Math.min(100, Math.max(0, Math.round(Number(value))));
      if (!Number.isFinite(pct) || pct === task.progress_pct) return;
      void apply({ type: "set_progress", task_id: task.id, progress_pct: pct }, (state) =>
        patchProgress(state, task.id, pct),
      ).catch(() => {});
    },
  };

  const assignees = task.assignee_ids
    .map((id) => assigneeNames?.get(id))
    .filter((name): name is string => name !== undefined);

  // Раздаёт исполнителей своя колонка, когда она показана (её кнопка там не
  // меняется — см. AssignMenu), и меню «⋯», когда её нет или для того, кто ей
  // не заглядывал. Признак доступности один на оба места: назначать некого,
  // если состав организации не пришёл вовсе или пуст.
  const assignAvailable = canWrite && assigneeNames !== undefined && assigneeNames.size > 0;
  const assignInColumn = assignAvailable && layout.shown.includes("assignee");
  // Рядом с именем, когда колонки нет, — не кнопка, а метка: кто уже назначен,
  // а не приглашение назначить. Приглашение и сама раздача — в меню «⋯» (см.
  // ниже), а здесь остаётся то, что действием никогда не было: состояние.
  const assignIndicator =
    !assignInColumn && assignees.length > 0 ? (
      <span className="gantt__row-indicator" title={assignees.join(", ")}>
        <Avatar name={assignees[0]} size={18} />
        {assignees.length > 1 && <span>+{assignees.length - 1}</span>}
      </span>
    ) : null;

  // Счётчик обсуждения — только когда есть что считать: у задачи без реплик
  // это не приглашение начать разговор (оно теперь в меню «⋯»), а состояние —
  // и нулю показывать нечего.
  const commentsLabel = t("comments.aria", { name: task.name, count: commentCount });
  const comments =
    commentCount === 0 ? null : (
      <RowBadge
        label={commentsLabel}
        set
        onClick={onOpenComments ? () => onOpenComments(task.id) : undefined}
      >
        <CommentIcon />
        {commentCount}
      </RowBadge>
    );

  // Каждый исполнитель — своя операция, как и в панели у колонки: снимают их
  // по одному, и в истории они читаются как отдельные события.
  const toggleAssignee = (userId: string) => {
    const assigned = task.assignee_ids.includes(userId);
    void apply(
      { type: assigned ? "unassign_user" : "assign_user", task_id: task.id, user_id: userId },
      (state) =>
        patchTask(state, task.id, {
          assignee_ids: assigned
            ? task.assignee_ids.filter((id) => id !== userId)
            : [...task.assignee_ids, userId],
        }),
    ).catch(() => {});
  };

  const duplicateTask = () => {
    void apply(
      {
        type: "create_task",
        category_id: task.category_id,
        name: `${task.name} ${t("gantt.row_menu.copy_suffix")}`,
        start_date: task.start_date,
        duration_days: task.duration_days,
        description: task.description ?? "",
        criticality: task.criticality,
        status: task.status,
        progress_pct: task.progress_pct,
        milestone: task.milestone,
      },
      (state) => state,
    ).catch(() => {});
  };

  const moveToCategory = (categoryId: string) => {
    const position = taskCountByCategory?.get(categoryId) ?? 0;
    void apply(
      { type: "reorder_task", task_id: task.id, category_id: categoryId, position },
      (state) => reorderTask(state, task.id, categoryId, position),
    ).catch(() => {});
  };

  const removeTask = () => {
    void apply({ type: "delete_task", task_id: task.id }, (state) => deleteTask(state, task.id)).catch(
      () => {},
    );
  };

  const otherCategories = (categories ?? []).filter((category) => category.id !== task.category_id);

  // Вложенный вид меню «⋯»: роспись по исполнителям, список категорий у
  // «Переместить», подтверждение удаления. Живёт здесь, а не внутри RowMenu —
  // у панели своего состояния нет, и `onClose` ниже возвращает вид в корень
  // при любом способе закрытия (Esc, щелчок мимо, потеря прокрутки).
  const [menuView, setMenuView] = useState<"root" | "assign" | "move" | "delete">("root");
  // Кнопка «⋯» появляется, только если в ней есть хоть одно действие: у
  // публичной страницы без карточки и обсуждения меню было бы пустой рамкой.
  const showMenu = canWrite || Boolean(onSelect) || Boolean(onOpenComments);

  return (
    <div
      className={`gantt__row${selected ? " is-selected" : ""} ${
        reorder?.markFor("task", task.id) ?? ""
      }`.trimEnd()}
      data-drop-kind="task"
      data-drop-id={task.id}
      onPointerMove={(event) =>
        reorder?.over({
          kind: "task",
          id: task.id,
          half: halfOf(event.currentTarget, event.clientY),
        })
      }
      onPointerUp={() => reorder?.drop()}
    >
      <div className="gantt__label">
        <LabelCells
          layout={layout}
          cells={{
            start: (
              <EditableCell
                type={format.relative ? "number" : "date"}
                value={
                  format.relative
                    ? String(projectDayNumber(task.start_date, format.anchor))
                    : task.start_date
                }
                display={format.label(task.start_date)}
                disabled={!canWrite}
                min={format.relative ? 1 : undefined}
                label={cellLabels.edit(cellLabels.columns.start, task.name)}
                onCommit={edit.start}
              />
            ),
            // Дата окончания правится не собой, а длительностью: сервер
            // считает её по рабочему календарю, и записать её напрямую нельзя
            // — но «эта задача кончается такого-то числа» человек говорит
            // именно так. Ячейка переводит названный день в число рабочих
            // дней ровно тем же счётом, каким это делает правая грань полоски,
            // и шлёт ту же операцию. Сервер пересчитает конец сам и пришлёт
            // свой — если календарь у вкладки устарел, ячейка встанет по его
            // ответу, а не по догадке.
            end: (
              <EditableCell
                type={format.relative ? "number" : "date"}
                value={
                  format.relative
                    ? String(projectDayNumber(task.end_date, format.anchor))
                    : task.end_date
                }
                display={format.label(task.end_date)}
                disabled={!canWrite || task.milestone}
                min={format.relative ? 1 : undefined}
                label={cellLabels.edit(cellLabels.columns.end, task.name)}
                onCommit={edit.end}
              />
            ),
            duration: (
              <EditableCell
                type="number"
                value={String(task.duration_days)}
                display={
                  // У вехи длительности нет — есть день, в который она
                  // случается. Показать «1 дн.» значило бы назвать отрезком то,
                  // что нарисовано точкой.
                  task.milestone
                    ? t("gantt.milestone.short")
                    : t("common.days_short", { count: task.duration_days })
                }
                disabled={!canWrite || task.milestone}
                min={1}
                label={cellLabels.edit(cellLabels.columns.duration, task.name)}
                onCommit={edit.duration}
              />
            ),
            progress: (
              <EditableCell
                type="number"
                value={String(task.progress_pct)}
                display={`${task.progress_pct}%`}
                disabled={!canWrite}
                min={0}
                max={100}
                label={cellLabels.edit(cellLabels.columns.progress, task.name)}
                onCommit={edit.progress}
              />
            ),
            // Тернарник, а не `&&`: пустой список обязан дойти до ячейки как
            // «нечего показать» (прочерк), а `false` от неё неотличим от
            // намеренно пустого содержимого и стёр бы прочерк.
            // Кнопка выбора занимает эту ячейку целиком, когда назначать
            // можно: она же и показывает назначенных — аватарами. `!` — не
            // догадка: `assignInColumn` сам собой означает, что состав
            // организации пришёл и не пуст (см. `assignAvailable` выше).
            assignee: assignInColumn
              ? (
                  <AssignMenu
                    projectId={projectId}
                    task={task}
                    roster={assigneeNames!}
                    describedBy={nameId}
                  />
                )
              : assignees.length > 0
                ? (
                    <span className="cell-value" title={assignees.join(", ")}>
                      {assignees.join(", ")}
                    </span>
                  )
                : undefined,
          }}
          task={
            <>
              {reorder?.enabled && (
                // Ручка отдельно от полоски: за неё меняют порядок, за полоску —
                // даты.
                //
                // Не кнопка и скрыта от чтения с экрана намеренно. Кнопка обещала бы
                // работу с клавиатуры, а перестановка строк с клавиатуры в этот план
                // не входит: объявить десять кнопок, ни одна из которых не
                // срабатывает по Enter, хуже, чем не объявлять их вовсе. Полоска
                // задачи при этом остаётся кнопкой и по-прежнему двигается стрелками.
                <span
                  className="gantt__handle"
                  aria-hidden="true"
                  title={handleLabel}
                  // Весь жест — на ручке, а не только его начало: пальцем
                  // указатель захвачен ею до самого броска, и строки под
                  // пальцем событий не получают (см. useReorder).
                  {...reorder.handleProps("task", task.id)}
                >
                  ⠿
                </span>
              )}
              {/* Имя — тоже открывает карточку, не только полоска: его читают
                  раньше полоски и по нему кликают первым, особенно когда
                  полоска обрезана краем ленты. Кнопкой имя не становится —
                  полоска уже даёт то же действие с клавиатуры и для чтения с
                  экрана, а вторая кнопка с тем же именем на строке была бы для
                  них лишним, неотличимым от первой шагом Tab. Клик остаётся
                  доступен указателем и не обещает того, чего не выполняет. */}
              <span
                id={nameId}
                ref={nameTitle.ref}
                title={nameTitle.title}
                className={`gantt__label-name${onSelect ? " gantt__label-name--clickable" : ""}`}
                onClick={onSelect ? () => onSelect(task.id) : undefined}
              >
                {task.name}
              </span>
              {late && (
                <span className="gantt__flag" title={lateLabel} role="img" aria-label={lateLabel}>
                  !
                </span>
              )}

              {/* Хвост колонки имени: то, что у задачи уже есть, — не то, что с
                  ней можно сделать. Число реплик и метка исполнителя — это
                  состояние, и оно не молчит до наведения: молчать, пока на
                  строку не навели, свойственно органам управления, а не
                  значениям (тот же довод у назначенного исполнителя в
                  колонке). Само действие — назначить, обсудить, вставить,
                  удалить — теперь одно и то же место: меню «⋯» справа. */}
              {(comments !== null || assignIndicator !== null) && (
                <span className="row-icons">
                  {comments}
                  {assignIndicator}
                </span>
              )}
              {showMenu && (
                <RowMenu
                  label={t("gantt.row_menu.task_label")}
                  describedBy={nameId}
                  onClose={() => setMenuView("root")}
                  testId={`row-menu-${task.id}`}
                >
                  {(close) => {
                    if (menuView === "assign") {
                      return (
                        <>
                          <MenuBack label={t("gantt.assign.label")} onClick={() => setMenuView("root")} />
                          {[...(assigneeNames ?? [])].map(([id, name]) => (
                            <MenuAction
                              key={id}
                              icon={<Avatar name={name} size={18} />}
                              pressed={task.assignee_ids.includes(id)}
                              onClick={() => toggleAssignee(id)}
                            >
                              {name}
                            </MenuAction>
                          ))}
                        </>
                      );
                    }
                    if (menuView === "move") {
                      return (
                        <>
                          <MenuBack label={t("gantt.row_menu.move")} onClick={() => setMenuView("root")} />
                          {otherCategories.map((category) => (
                            <MenuAction
                              key={category.id}
                              onClick={() => {
                                moveToCategory(category.id);
                                close();
                              }}
                            >
                              {category.name}
                            </MenuAction>
                          ))}
                        </>
                      );
                    }
                    if (menuView === "delete") {
                      return (
                        <div className="gantt__more-confirm">
                          <p>{t("task.panel.delete_warning")}</p>
                          <div className="gantt__more-confirm-actions">
                            <button
                              type="button"
                              className="button--quiet"
                              onClick={() => setMenuView("root")}
                            >
                              {t("common.cancel")}
                            </button>
                            <button
                              type="button"
                              className="button--danger"
                              onClick={() => {
                                removeTask();
                                close();
                              }}
                            >
                              {t("task.panel.delete_confirm")}
                            </button>
                          </div>
                        </div>
                      );
                    }
                    return (
                      <>
                        {onSelect && (
                          <MenuAction
                            icon={<span aria-hidden="true">↗</span>}
                            onClick={() => {
                              onSelect(task.id);
                              close();
                            }}
                          >
                            {t("gantt.row_menu.open")}
                          </MenuAction>
                        )}
                        {onInsertBefore && (
                          <MenuAction
                            icon={<span aria-hidden="true">+</span>}
                            onClick={() => {
                              onInsertBefore();
                              close();
                            }}
                          >
                            {t("gantt.row_menu.add_task")}
                          </MenuAction>
                        )}
                        {assignAvailable && (
                          <MenuAction icon={<PeopleIcon />} onClick={() => setMenuView("assign")}>
                            {t("gantt.row_menu.assign")}
                          </MenuAction>
                        )}
                        {onOpenComments && (
                          <MenuAction
                            icon={<CommentIcon />}
                            onClick={() => {
                              onOpenComments(task.id);
                              close();
                            }}
                          >
                            {t("gantt.row_menu.comment")}
                          </MenuAction>
                        )}
                        {canWrite && (
                          <>
                            <MenuSeparator />
                            <MenuAction
                              icon={<span aria-hidden="true">⧉</span>}
                              onClick={() => {
                                duplicateTask();
                                close();
                              }}
                            >
                              {t("gantt.row_menu.duplicate")}
                            </MenuAction>
                            {otherCategories.length > 0 && (
                              <MenuAction
                                icon={<span aria-hidden="true">↔</span>}
                                onClick={() => setMenuView("move")}
                              >
                                {t("gantt.row_menu.move")}
                              </MenuAction>
                            )}
                            <MenuSeparator />
                            <MenuAction
                              icon={<span aria-hidden="true">×</span>}
                              tone="danger"
                              onClick={() => setMenuView("delete")}
                            >
                              {t("gantt.row_menu.delete")}
                            </MenuAction>
                          </>
                        )}
                      </>
                    );
                  }}
                </RowMenu>
              )}
            </>
          }
        />
      </div>

      <div className="gantt__lane" style={{ width: scale.width }}>
        {showBaseline && baseline && (
          // Призрак базового плана — тонкая серая полоска под текущей.
          //
          // Именно под, а не продлением текущей: залить разрыв между плановым
          // и фактическим окончанием прямо в полоске выглядит нагляднее, но
          // тогда её начало означает плановую дату, а конец — фактическую, и
          // полоска перестаёт означать реальные даты задачи.
          <div
            className="gantt__ghost"
            style={{
              left: scale.xOf(baseline.start),
              width: scale.widthOf(baseline.start, baseline.end),
            }}
            title={baselineLabel}
            data-testid={`ghost-${task.id}`}
            aria-hidden="true"
          />
        )}

        {showBaseline && baseline && shift !== null && shift > 0 && (
          // Засечка первоначального дедлайна, как в макете: вертикальная
          // красная черта там, где задача должна была кончиться по плану.
          <i
            className="gantt__mark"
            style={{ left: scale.xOf(baseline.end) + scale.dayWidth }}
            title={baselineLabel}
            data-testid={`mark-${task.id}`}
            aria-hidden="true"
          />
        )}

        {shift !== null && shift !== 0 && deviationLabel && (
          // Бейдж отклонения справа от полоски. Отсчитывается от окончания:
          // оно одно отвечает на вопрос «когда это будет готово» и вбирает в
          // себя и перенос начала, и растяжение срока.
          <span
            className={`gantt__deviation${shift > 0 ? " is-late" : " is-early"}`}
            style={{ left: scale.xOf(task.end_date) + scale.dayWidth }}
            data-testid={`deviation-${task.id}`}
          >
            {deviationLabel}
          </span>
        )}

        {beyondPlan && beyondPlanLabel && (
          // «Сверх плана»: задача добавлена после согласования и базового плана
          // не имеет. Метка нужна не как украшение — без неё отсутствие
          // призрака под полоской читается как «задача никуда не уехала», а на
          // деле сравнивать её просто не с чем.
          //
          // Справа от полоски, на месте бейджа отклонения: обе метки отвечают
          // на один вопрос — как задача соотносится с согласованным планом, —
          // а у задачи без базового плана отклонения быть не может, так что
          // место свободно. Раньше это был «плюс» в колонке имени, вплотную к
          // меню «⋯», и его принимали за кнопку: «+» во всей ленте означает
          // «добавить», а этот знак не нажимался.
          <span
            className="gantt__beyond-plan"
            style={{ left: scale.xOf(task.end_date) + scale.dayWidth }}
            title={beyondPlanHint}
            data-testid={`beyond-${task.id}`}
          >
            {beyondPlanLabel}
          </span>
        )}

        {/* Кнопка — только когда полоска действительно что-то делает: открывает
            карточку или двигается. На публичной странице она не делает ни
            того, ни другого, и кнопка там обещала бы действие, которого нет, —
            забирала бы фокус с клавиатуры и читалась бы с экрана как
            нажимаемая. Тогда это картинка с подписью, а не орган управления. */}
        <Bar
          interactive={Boolean(onSelect) || canWrite}
          barRef={motion.ref}
          className={`gantt__bar${task.milestone ? " gantt__bar--milestone" : ""}${
            late ? " is-late" : ""
          }${canWrite ? " is-draggable" : ""}${dragging !== null ? " is-dragging" : ""}`}
          data-criticality={task.criticality}
          data-status={task.status}
          // Признак, а не класс: критичность — свойство расчёта, и рисуется
          // она только когда слой включён (см. `.gantt.show-critical`).
          data-critical={task.critical ? "" : undefined}
          data-testid={`bar-${task.id}`}
          style={
            {
              // Место по датам, и только по ним: `left` и `width` выставляются
              // на рендер и дальше не меняются никем. И сдвиг под пальцем, и
              // ожидание ответа на месте броска, и переезд после ответа
              // сервера идут через `transform` и `--bar-dw` — см. useBarMotion,
              // там же и о том, почему не через эти два.
              left,
              "--bar-w": `${width}px`,
              "--progress": `${task.progress_pct}%`,
            } as CSSProperties
          }
          {...handlers}
          // Наведение и жест живут на одних и тех же событиях, поэтому
          // обработчики сложены руками, а не наложены спредом: спред оставил бы
          // от каждой пары только последнюю.
          onPointerEnter={tip.onPointerEnter}
          onPointerMove={(event) => {
            handlers.onPointerMove(event);
            tip.onPointerMove(event);
          }}
          onPointerDown={(event) => {
            handlers.onPointerDown(event);
            tip.onPointerDown();
          }}
          onPointerUp={(event) => {
            handlers.onPointerUp(event);
            tip.onPointerUp();
          }}
          onPointerCancel={() => {
            handlers.onPointerCancel();
            tip.onPointerCancel();
          }}
          onPointerLeave={tip.onPointerLeave}
          onFocus={tip.onFocus}
          onBlur={tip.onBlur}
          // Имя названо явно вместе с датами, а не оставлено содержимому
          // кнопки: у полоски есть обрезаемый по ширине текст, и браузеры
          // расходятся в том, что из этого станет доступным именем. Живая
          // проверка показала полоску, которая читается с экрана как
          // «14 августа — 20 августа» — без названия задачи вовсе.
          //
          // Нативного `title` у полоски нет намеренно: поверх карточки
          // наведения через секунду вылезала бы вторая, браузерная, и об одном
          // и том же говорили бы два разных окна.
          aria-label={`${task.name}, ${title}`}
          // Сочетания названы вслух: сдвинуть задачу с клавиатуры можно было и
          // раньше, но узнать об этом — только из исходников. Читателю здесь
          // пусто: стрелки у него ничего не двигают, и обещать их значило бы
          // отправить его нажимать клавиши, которые молчат.
          aria-keyshortcuts={
            canWrite
              ? task.milestone
                // У вехи граней нет: тянуть нечего, и обещать сочетание,
                // которое молчит, значило бы отправить человека нажимать
                // клавиши впустую.
                ? "Shift+ArrowLeft Shift+ArrowRight"
                : "Shift+ArrowLeft Shift+ArrowRight Alt+ArrowLeft Alt+ArrowRight Shift+Alt+ArrowLeft Shift+Alt+ArrowRight"
              : undefined
          }
          aria-expanded={onSelect ? selected : undefined}
          onClick={() => onSelect?.(task.id)}
        >
          {task.milestone ? (
            // Веха — ромб в своём дне. Повёрнутый квадрат внутри полоски, а не
            // сама полоска: её `transform` занят движением, и второй поворот
            // на том же узле стёр бы сдвиг под пальцем.
            <span className="gantt__diamond" aria-hidden="true" />
          ) : (
            <>
              {/* Заливка внутри полоски, а не отдельная полоска рядом: прогресс —
                  это часть задачи, а не вторая задача под ней. */}
              <span className="gantt__progress" aria-hidden="true" />
              {/* Галочка готовой задачи — как в макете: знак «сделано» виден с
                  расстояния, на котором плашка статуса уже не читается. */}
              {task.status === "done" && (
                <span className="gantt__check" aria-hidden="true">
                  ✓
                </span>
              )}
              {/* Заблокированная называет своё состояние прямо на полоске: это
                  редкое и требующее действия состояние, и цвета одного мало. */}
              {task.status === "blocked" && statusLabel && (
                <span className="gantt__bar-blocked" aria-hidden="true">
                  <span>⚠</span>
                  {statusLabel}
                </span>
              )}

              {canWrite && (
                // Грани полоски: левая двигает начало, не трогая конца, правая
                // растягивает срок. Отдельными узлами, а не зонами внутри
                // общего обработчика: у каждой свой курсор, и зонами его
                // пришлось бы решать в момент нажатия — когда курсор уже
                // показал что-то одно.
                //
                // От чтения с экрана скрыты: то же, что они делают, доступно с
                // клавиатуры полями «Начало» и «Длительность» — и в таблице
                // слева, и в карточке задачи. Две ручки, ни одна из которых не
                // работает по Enter, были бы лишними шагами Tab на каждой из
                // сотни строк.
                <>
                  <span
                    className="gantt__grip gantt__grip--start"
                    aria-hidden="true"
                    {...gripHandlers("start")}
                  />
                  <span
                    className="gantt__grip gantt__grip--end"
                    aria-hidden="true"
                    {...gripHandlers("end")}
                  />
                </>
              )}

              {canWrite && task.status === "in_progress" && (
                // Ручка выполненного — только там, где заливка вообще видна.
                // У запланированной её нет: процент лёг бы в поле, а на
                // полоске не отразился, и жест выглядел бы сорвавшимся.
                <span
                  className="gantt__grip gantt__grip--progress"
                  aria-hidden="true"
                  {...gripHandlers("progress")}
                />
              )}
            </>
          )}
        </Bar>

        {link?.enabled && dragging === null && (
          // Кружки связи — снаружи полоски, а не внутри: у полоски обрезается
          // содержимое (иначе подпись вылезала бы за её края), и кружок на
          // границе срезало бы пополам.
          //
          // Пока полоску тащат, кружков нет: они стоят по датам задачи, а
          // полоска в этот момент идёт за пальцем, и кружки отставали бы от
          // неё, показывая связь не оттуда, откуда её тянут.
          <>
            <LinkDot
              side="start"
              task={task}
              link={link}
              x={left}
              label={t("gantt.link.from", { name: task.name })}
            />
            <LinkDot
              side="end"
              task={task}
              link={link}
              x={left + width}
              label={t("gantt.link.to", { name: task.name })}
            />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Кружок, от которого тянут связь.
 *
 * Не кнопка: связь заводится перетаскиванием, а нажатие Enter на ней не значит
 * ничего. Тот же путь с клавиатуры даёт список связей в карточке задачи —
 * поэтому кружок скрыт и от чтения с экрана, а подпись остаётся подсказкой
 * указателю.
 */
function LinkDot({
  side,
  task,
  link,
  x,
  label,
}: {
  side: "start" | "end";
  task: Task;
  link: LinkDrag;
  x: number;
  label: string;
}) {
  return (
    <span
      className={`gantt__link-dot gantt__link-dot--${side}`}
      style={{ left: x }}
      title={label}
      aria-hidden="true"
      {...link.handleProps(task.id, side)}
    />
  );
}

/**
 * Полоска задачи: орган управления или картинка с подписью.
 *
 * Различие не косметическое. Кнопка забирает фокус с клавиатуры и читается с
 * экрана как нажимаемая; на публичной странице, где карточки задачи нет и
 * даты не двигаются, это обещание действия, которого не существует. Тогда
 * полоска объявляется картинкой — `role="img"` с тем же именем: она
 * по-прежнему называет задачу и её даты, но не притворяется кнопкой.
 */
function Bar({
  interactive,
  children,
  barRef,
  ...rest
}: {
  interactive: boolean;
  children: ReactNode;
  /**
   * Ссылка на узел полоски для слоя движения.
   *
   * Отдельным пропсом, а не `ref`: `Bar` рисует то кнопку, то `div`, и `ref`
   * пришлось бы объявлять сразу для обоих — а он всё равно нужен не самому
   * `Bar`, а тому, кто в этот узел пишет.
   */
  barRef?: RefCallback<HTMLElement>;
} & HTMLAttributes<HTMLElement>) {
  if (interactive) {
    return (
      <button type="button" ref={barRef} {...rest}>
        {children}
      </button>
    );
  }
  // aria-expanded и onClick сюда не доходят: без onSelect они пусты, а пустой
  // обработчик на неинтерактивном элементе — след, который читается как забытая
  // возможность.
  const { onClick, "aria-expanded": expanded, ...plain } = rest;
  void onClick;
  void expanded;
  return (
    <div role="img" ref={barRef} {...plain}>
      {children}
    </div>
  );
}
