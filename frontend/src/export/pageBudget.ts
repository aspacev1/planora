/**
 * Сколько страниц займёт лента — тот же расчёт, что и на сервере.
 *
 * Повтор здесь не по недосмотру: окно пишет число страниц прямо на кнопке
 * масштаба, и спрашивать его запросом на каждое нажатие значило бы моргающие
 * кнопки. Эталон — `backend/app/export/budget.py`; тесты по обе стороны
 * сверяют одну таблицу ожиданий, и разойтись молча им не дадут.
 */

export type Zoom = "day" | "week" | "month";
export type Period = "all" | "next_4w" | "next_3m" | "from_today";
export type Orientation = "landscape" | "portrait";

export const ZOOMS: readonly Zoom[] = ["day", "week", "month"];
export const PERIODS: readonly Period[] = ["all", "next_4w", "next_3m", "from_today"];

/** Периоды, у которых нет смысла без настоящих дат: ось «День N» не знает «сегодня». */
export const DATED_PERIODS: readonly Period[] = ["next_4w", "next_3m", "from_today"];

/**
 * Дней в единице колонки. «Месяц» здесь ровно тридцать дней, а не календарный:
 * ёмкость страницы — оценка, а не разметка, и календарная арифметика дала бы
 * разное число страниц у проекта, сдвинутого на неделю.
 */
const DAYS_PER_UNIT: Record<Zoom, number> = { day: 1, week: 7, month: 30 };

/** Ширина колонки в пунктах — минимум, при котором подпись шкалы читается. */
const UNIT_WIDTH_PT: Record<Zoom, number> = { day: 8, week: 20, month: 40 };

/** Ширина страницы A4 в пунктах. */
const PAGE_WIDTH_PT: Record<Orientation, number> = { landscape: 841.89, portrait: 595.28 };
const MARGIN_PT = 39.69; // 14 мм
const LABEL_COLUMN_PT = 168;

/** Сколько страниц ленты считается приличным умолчанием. */
export const COMFORTABLE_PAGES = 2;

/** Потолок: сверх него масштаб не предлагается и сервером не принимается. */
export const MAX_PAGES = 6;

export function daysPerPage(zoom: Zoom, orientation: Orientation): number {
  const chart = PAGE_WIDTH_PT[orientation] - 2 * MARGIN_PT - LABEL_COLUMN_PT;
  return Math.max(1, Math.floor(chart / UNIT_WIDTH_PT[zoom])) * DAYS_PER_UNIT[zoom];
}

/** Пустой проект — одна страница с шапкой, а не ноль. */
export function pageCount(days: number, zoom: Zoom, orientation: Orientation): number {
  if (days <= 0) return 1;
  return Math.ceil(days / daysPerPage(zoom, orientation));
}

export type ZoomOption = { zoom: Zoom; pages: number; allowed: boolean };

/**
 * Укладывается ли масштаб в потолок.
 *
 * Самый крупный разрешён всегда, сколько бы страниц ни вышло: потолок
 * существует, чтобы человек не выбрал ненужную подробность, а у месяца менее
 * подробного соседа нет. Отказать на нём значило бы, что десятилетний
 * портфель не выгружается вовсе.
 */
export function zoomAllowed(zoom: Zoom, days: number, orientation: Orientation): boolean {
  if (zoom === ZOOMS[ZOOMS.length - 1]) return true;
  return pageCount(days, zoom, orientation) <= MAX_PAGES;
}

/**
 * Масштабы с их ценой — ровно то, что окно пишет на кнопках.
 *
 * Недоступный масштаб остаётся в списке с числом страниц: человек должен
 * понять, чего стоит подробность, а не гадать, куда делась кнопка.
 */
export function zoomOptions(days: number, orientation: Orientation): ZoomOption[] {
  return ZOOMS.map((zoom) => ({
    zoom,
    pages: pageCount(days, zoom, orientation),
    allowed: zoomAllowed(zoom, days, orientation),
  }));
}

/**
 * Самый подробный масштаб, укладывающийся в приличное число страниц.
 *
 * Если не укладывается ни один — самый крупный: месяц на любом мыслимом
 * проекте даёт единицы страниц, и отдать вместо файла отказ было бы
 * неуважением к тому, кто просто нажал «Скачать».
 */
export function defaultZoom(days: number, orientation: Orientation): Zoom {
  return (
    ZOOMS.find((zoom) => pageCount(days, zoom, orientation) <= COMFORTABLE_PAGES) ??
    ZOOMS[ZOOMS.length - 1]
  );
}

const DAY = 86_400_000;

function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY);
}

/** Длина окна в днях — по тем же правилам, что `resolve_window` на сервере. */
export function windowDays(
  period: Period,
  projectStart: string,
  projectEnd: string,
  today: string,
): number {
  const whole = dayDiff(projectStart, projectEnd) + 1;
  if (period === "all") return Math.max(whole, 1);

  const start = Date.parse(today) > Date.parse(projectStart) ? today : projectStart;
  const offset = dayDiff(start, projectEnd) + 1;
  if (offset <= 0) return 1; // проект целиком в прошлом: показываем его конец

  if (period === "from_today") return offset;
  return Math.min(offset, period === "next_4w" ? 28 : 90);
}
