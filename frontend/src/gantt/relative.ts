/**
 * Относительная ось: «Месяц 1 / Неделя 1 / День 1» вместо настоящих дат.
 *
 * Сервер хранит задачи относительного плана координатами на этой оси:
 * день N проекта = RELATIVE_EPOCH + (N − 1) календарных дней. Модуль
 * переводит координаты в номера дней и недель — линейная арифметика, а не
 * календарная: рабочие дни и даты окончания по-прежнему считает сервер.
 *
 * Эпоха — понедельник, поэтому «Неделя 1» начинается с понедельника и маска
 * рабочей недели ложится на колонки сетки без поправок. «Месяц» здесь — не
 * календарный месяц, а визуальная группа из четырёх недель: настоящих месяцев
 * у плана без дат не существует.
 */

import type { ProjectState } from "../api/projects";
import type { Params } from "../i18n";
import { addDays, daysBetween } from "./timescale";
import type { Scale } from "./timescale";

/** Начало относительной оси. То же значение, что RELATIVE_EPOCH на сервере. */
export const RELATIVE_EPOCH = "2001-01-01";

/** Дней в «неделе» и «месяце» относительной шкалы. */
export const WEEK_DAYS = 7;
export const MONTH_WEEKS = 4;

/**
 * Номер дня проекта у координаты, начиная с единицы.
 *
 * `anchor` — начало оси: эпоха у относительного плана, назначенная дата
 * старта у календарного, показанного относительным видом.
 */
export function projectDayNumber(iso: string, anchor: string = RELATIVE_EPOCH): number {
  return daysBetween(anchor, iso) + 1;
}

/** Координата дня проекта: обратный ход projectDayNumber, для форм ввода. */
export function dateOfProjectDay(day: number, anchor: string = RELATIVE_EPOCH): string {
  return addDays(anchor, day - 1);
}

/**
 * Конец недели, в которую попала координата.
 *
 * Этим округлением окно относительной ленты дотягивает свой правый край — и
 * при построении от последней задачи (см. relativeWindow), и когда лента
 * достраивается под жест: полоску держат за краем окна, и сетка обязана
 * дорасти до её недели тем же правилом, каким выросла бы после переноса (см.
 * reach в Gantt). Второе округление, написанное там заново, разошлось бы с
 * этим на первой правке — и окно под жестом кончалось бы не там, где после
 * него.
 */
export function relativeWeekEnd(iso: string, anchor: string = RELATIVE_EPOCH): string {
  return addDays(anchor, Math.ceil(projectDayNumber(iso, anchor) / WEEK_DAYS) * WEEK_DAYS - 1);
}

/**
 * Окно относительной ленты.
 *
 * От якоря до конца последней занятой недели — и не короче четырёх недель:
 * пустой проект всё равно показывает шкалу «Месяц 1». Дедлайн и сегодняшний
 * день в окно не входят намеренно: обе даты настоящие, а на этой оси
 * настоящих дат нет.
 */
export function relativeWindow(
  state: ProjectState,
  anchor: string = RELATIVE_EPOCH,
): { from: string; to: string } {
  const dates = [
    ...state.tasks.map((task) => task.start_date),
    ...state.tasks.map((task) => task.end_date),
    ...(state.project_end ? [state.project_end] : []),
  ].filter((date) => date >= anchor);

  const latest = dates.length === 0 ? anchor : dates.reduce((a, b) => (a > b ? a : b));
  const monthEnd = addDays(anchor, MONTH_WEEKS * WEEK_DAYS - 1);
  const weekEnd = relativeWeekEnd(latest, anchor);
  return { from: anchor, to: weekEnd > monthEnd ? weekEnd : monthEnd };
}

export type RelativeSpan = {
  /** Номер месяца или недели, с единицы. */
  number: number;
  x: number;
  width: number;
};

/** Нарезает дни шкалы на отрезки по `size` дней — недели и «месяцы» шапки. */
function spansOf(scale: Scale, size: number): RelativeSpan[] {
  const spans: RelativeSpan[] = [];
  const total = scale.days.length;
  for (let start = 0; start < total; start += size) {
    const days = Math.min(size, total - start);
    spans.push({
      number: Math.floor(start / size) + 1,
      x: start * scale.dayWidth,
      width: days * scale.dayWidth,
    });
  }
  return spans;
}

export function relativeWeeks(scale: Scale): RelativeSpan[] {
  return spansOf(scale, WEEK_DAYS);
}

type Translate = (key: string, params?: Params) => string;

/** «День 12» — подпись координаты там, где календарный проект показал бы дату. */
export function relativeDayLabel(
  t: Translate,
  iso: string,
  anchor: string = RELATIVE_EPOCH,
): string {
  return t("gantt.relative.day", { number: projectDayNumber(iso, anchor) });
}

export function relativeMonths(scale: Scale): RelativeSpan[] {
  return spansOf(scale, WEEK_DAYS * MONTH_WEEKS);
}
