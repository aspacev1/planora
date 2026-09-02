import { useRef } from "react";
import type { PointerEvent, ReactNode } from "react";

import type { Task } from "../api/projects";
import type { ColumnKey, ColumnLayout } from "./columns";
import { COLUMN_KEYS, MIN_WIDTH, clampWidth } from "./columns";

/**
 * Ячейки закреплённой таблицы — левой части ленты.
 *
 * Одна раскладка на три места: шапку, строку категории и строку задачи. Ширины
 * приходят из неё же, поэтому колонка, потянутая за границу в шапке,
 * сдвигается сразу во всех строках — второго списка ширин, который однажды
 * разойдётся с первым, не существует.
 *
 * Правятся прямо здесь только те поля, которые операции уже умеют менять
 * поодиночке: старт, длительность, процент. Дата окончания — показ и только:
 * её считает сервер по календарю проекта, и поле для правки обещало бы
 * влияние, которого нет (та же причина, что и в карточке задачи).
 *
 * Сама ячейка, которую правят на месте, живёт не здесь, а в components/rows:
 * тем же движением правится строка сметы, и второй такой же ячейкой они
 * разошлись бы на первой правке одной из них.
 */

/**
 * Колонки, которые строка рисует сейчас.
 *
 * У свёрнутой таблицы их нет ни одной: от неё осталась полоса шириной в
 * кнопку (см. COLLAPSED_WIDTH), и ячейки в неё не помещаются — они вылезли бы
 * поверх шкалы. Набор колонок и их ширины при этом целы и ждут разворота:
 * свёртка — это про место на экране, а не про то, что человек выбрал видеть.
 *
 * Правило одно на все три места, где рисуются ячейки таблицы, — шапку, строку
 * категории и строку задачи: три отдельные проверки разошлись бы, и одна из
 * них рисовала бы колонки поверх соседней ленты.
 */
export function shownColumns(layout: ColumnLayout): readonly ColumnKey[] {
  return layout.collapsed ? [] : layout.shown;
}

/** Одна ячейка строки: ширину задаёт раскладка, содержимое — вызывающий. */
export function Cell({
  column,
  layout,
  children,
}: {
  column: ColumnKey;
  layout: ColumnLayout;
  children: ReactNode;
}) {
  return (
    <span
      className={`gantt__cell gantt__cell--${column}`}
      // Имя колонки — в разметке: перенос ищет цель попаданием в точку, и
      // узнать по найденному элементу, что это за колонка, больше не по чему.
      data-column={column}
      style={{ flex: `0 0 ${layout.widths[column]}px`, width: layout.widths[column] }}
    >
      {children}
    </span>
  );
}

/**
 * Шапка таблицы: подписи колонок и границы, за которые их тянут.
 *
 * Граница — отдельный узел поверх стыка, а не `resize` у ячейки: CSS-ресайз
 * тянется только за правый нижний угол и оставляет в нём засечку, которой в
 * шапке таблицы взяться неоткуда.
 */
export function HeadCells({
  layout,
  labels,
  onResize,
  onReorder,
  resizeLabel,
  reorderLabel,
  leading,
}: {
  layout: ColumnLayout;
  labels: Record<ColumnKey, string>;
  /**
   * Что стоит перед заголовком первой колонки — «плюс» новой категории.
   * Внутри ячейки, а не рядом с ней: ячейка названия несёт поле слева
   * (`--gantt-pad`), и узел вне её встал бы либо в это поле, либо за ним,
   * сдвинув заголовок относительно имён задач под ним.
   */
  leading?: ReactNode;
  /** `undefined` — ширины не меняются (у ленты нет памяти, например в тесте). */
  onResize?: (column: ColumnKey, width: number) => void;
  /** `undefined` — колонки не переставляются. */
  onReorder?: (moved: ColumnKey, before: ColumnKey) => void;
  resizeLabel: (column: string) => string;
  reorderLabel?: (column: string) => string;
}) {
  const drag = useColumnDrag(onReorder);

  return (
    <>
      {shownColumns(layout).map((column) => (
        <Cell key={column} column={column} layout={layout}>
          {column === "task" && leading}
          <span
            className={`gantt__corner-label${
              onReorder && column !== "task" ? " gantt__corner-label--movable" : ""
            }`}
            // Имя колонки — и подпись, и ручка переноса: отдельная ручка на
            // заголовок шириной в семьдесят пикселей отняла бы у подписи
            // столько места, что от неё осталось бы многоточие.
            title={onReorder && column !== "task" ? reorderLabel?.(labels[column]) : undefined}
            {...(onReorder && column !== "task" ? drag.handleProps(column) : {})}
          >
            {labels[column]}
          </span>
          {onResize && (
            <ColumnGrip
              width={layout.widths[column]}
              label={resizeLabel(labels[column])}
              onResize={(width) => onResize(column, width)}
            />
          )}
        </Cell>
      ))}
    </>
  );
}

/**
 * Перенос колонки за её заголовок.
 *
 * Колонку роняют на соседнюю, и она встаёт перед ней. Цель ищется попаданием
 * в точку, а не адресатом события, по той же причине, что и у перестановки
 * строк: пальцем указатель после нажатия захвачен заголовком, с которого начали,
 * и соседние о движении не узнают (см. `targetAt` в useReorder).
 *
 * Подсветка цели идёт классом прямо в DOM, мимо состояния React: цель меняется
 * на каждом пересечении границы, а перерисовка шапки тянет за собой всю ленту.
 */
function useColumnDrag(onReorder?: (moved: ColumnKey, before: ColumnKey) => void) {
  const from = useRef<{ pointerId: number; column: ColumnKey } | null>(null);
  const hovered = useRef<HTMLElement | null>(null);

  const markTarget = (element: HTMLElement | null) => {
    if (hovered.current === element) return;
    hovered.current?.classList.remove(COLUMN_TARGET_CLASS);
    element?.classList.add(COLUMN_TARGET_CLASS);
    hovered.current = element;
  };

  const cellAt = (clientX: number, clientY: number): HTMLElement | null => {
    const under = document.elementFromPoint?.(clientX, clientY) ?? null;
    const cell = under?.closest<HTMLElement>("[data-column]") ?? null;
    // Своя же колонка целью не подсвечивается: бросок на себя ничего не
    // меняет, и обещать перестановку там, где её не будет, не за чем. Имя
    // задачи целью не бывает вовсе — оно всегда первое.
    const key = cell?.dataset.column;
    if (key === undefined || key === "task" || key === from.current?.column) return null;
    return cell;
  };

  const finish = () => {
    from.current = null;
    markTarget(null);
  };

  return {
    handleProps(column: ColumnKey) {
      return {
        onPointerDown(event: PointerEvent<HTMLElement>) {
          if (event.button !== 0) return;
          // Без этого нажатие начинает выделение текста заголовка вместо
          // переноса — то же, что и у граней полоски.
          event.preventDefault();
          from.current = { pointerId: event.pointerId, column };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        },
        onPointerMove(event: PointerEvent<HTMLElement>) {
          if (from.current?.pointerId !== event.pointerId) return;
          markTarget(cellAt(event.clientX, event.clientY));
        },
        onPointerUp(event: PointerEvent<HTMLElement>) {
          const start = from.current;
          if (start?.pointerId !== event.pointerId) return;
          const target = cellAt(event.clientX, event.clientY)?.dataset.column;
          finish();
          if (isColumnKey(target)) onReorder?.(start.column, target);
        },
        onPointerCancel: finish,
      };
    },
  };
}

const COLUMN_TARGET_CLASS = "is-column-target";

function isColumnKey(value: string | undefined): value is ColumnKey {
  return value !== undefined && (COLUMN_KEYS as readonly string[]).includes(value);
}

/**
 * Граница колонки: тянется указателем, ходит стрелками с клавиатуры.
 *
 * Стрелки здесь не формальность ради доступности: попасть указателем в полосу
 * в четыре пикселя трудно и мышью, а ширина — единственное свойство таблицы,
 * которое иначе не настроить вовсе.
 */
function ColumnGrip({
  width,
  label,
  onResize,
}: {
  width: number;
  label: string;
  onResize: (width: number) => void;
}) {
  const from = useRef<{ pointerId: number; x: number; width: number } | null>(null);

  return (
    <span
      className="gantt__col-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={MIN_WIDTH}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        // Граница лежит в том же заголовке, за который колонку переносят: без
        // этого одно нажатие начинало бы оба жеста разом.
        event.stopPropagation();
        from.current = { pointerId: event.pointerId, x: event.clientX, width };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = from.current;
        if (start === null || start.pointerId !== event.pointerId) return;
        onResize(clampWidth(start.width + (event.clientX - start.x)));
      }}
      onPointerUp={() => {
        from.current = null;
      }}
      onPointerCancel={() => {
        from.current = null;
      }}
      onKeyDown={(event) => {
        const step = event.key === "ArrowRight" ? 8 : event.key === "ArrowLeft" ? -8 : 0;
        if (step === 0) return;
        event.preventDefault();
        onResize(clampWidth(width + step));
      }}
    />
  );
}

/** Сводка по группе строк — то, что показывает строка категории. */
export function rollUp(tasks: Task[]): { start: string; end: string; progress: number } | null {
  if (tasks.length === 0) return null;
  // Процент группы — средний по длительностям, а не по числу строк: неделя,
  // сделанная наполовину, весит больше, чем сделанный целиком однодневный
  // созвон, и «50 %» по головам говорило бы обратное.
  const work = tasks.reduce((total, task) => total + task.duration_days, 0);
  const done = tasks.reduce((total, task) => total + task.duration_days * task.progress_pct, 0);
  return {
    start: tasks.reduce((a, t) => (t.start_date < a ? t.start_date : a), tasks[0].start_date),
    end: tasks.reduce((a, t) => (t.end_date > a ? t.end_date : a), tasks[0].end_date),
    progress: work === 0 ? 0 : Math.round(done / work),
  };
}
