import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

import type { Task } from "../api/projects";
import { useLocale } from "../i18n/LocaleProvider";
import { baselineOf } from "../project/baseline";
import { useToday } from "../time/useToday";

/**
 * Модуль прогресса — над полями, а не строка среди них.
 *
 * Отметка прогресса — единственное, что в карточке делают каждый день, и ей
 * отдано главное место и главная кнопка: «Отметить день» прибавляет дневную
 * норму, не спрашивая цифру. Точная цифра остаётся доступной двумя путями —
 * числом (набрать) и полосой (поставить «на глаз» щелчком или перетаскиванием).
 *
 * Все три пути сводятся к одной и той же операции `set_progress`: у сервера
 * нет понятия «отметил день», есть новая готовность — и это намеренно, иначе
 * три способа ввода дали бы три вида записей об одном и том же. Сама отметка
 * попадает в общий журнал задачи и видна на вкладке «История» — второго,
 * своего списка отметок здесь нарочно нет.
 */

/** Дневная норма: сколько процентов приносит один день работы. */
function dayStep(durationDays: number): number {
  return Math.max(1, Math.round(100 / Math.max(1, durationDays)));
}

/**
 * Где готовность должна быть сегодня по плану, в процентах.
 *
 * По базовому плану, если он есть, иначе по текущим датам: до утверждения
 * плана «план» — это сами даты задачи. Доля календарная, а не по рабочим
 * дням: засечка — ориентир для взгляда, а не второй расчёт сроков, и
 * повторять здесь серверный календарь значило бы однажды с ним разойтись.
 */
function expectedToday(task: Task, today: string): number {
  const baseline = baselineOf(task);
  const start = baseline?.start ?? task.start_date;
  const end = baseline?.end ?? task.end_date;
  if (today <= start) return 0;
  if (today >= end) return 100;
  const span = Date.parse(end) - Date.parse(start);
  return Math.round(((Date.parse(today) - Date.parse(start)) / span) * 100);
}

function clamp(pct: number): number {
  return Math.max(0, Math.min(100, Math.round(pct)));
}

export function TaskProgress({
  task,
  canWrite,
  timeZone,
  resetToken,
  meta,
  onCommit,
}: {
  task: Task;
  canWrite: boolean;
  /** Пояс проекта: в нём же посчитаны его сроки (см. useToday). */
  timeZone?: string;
  /** Меняется, когда сервер отказал: поле обязано вернуться к правде. */
  resetToken: unknown;
  /**
   * Статус и период задачи — в одну строку с процентом, как в макете. Их
   * рисует карточка: модулю прогресса они не принадлежат, но строка у них
   * общая, и разложить её по двум компонентам значило бы выравнивать два
   * флекса друг под друга.
   */
  meta?: ReactNode;
  onCommit: (pct: number) => void;
}) {
  const { t } = useLocale();
  const pct = clamp(task.progress_pct);
  const step = dayStep(task.duration_days);
  // Засечка плана стоит на «сколько должно быть сегодня», и «сегодня» здесь
  // то же, что на ленте: по UTC засечка ночью показывала вчерашнюю норму, то
  // есть объявляла отставанием то, чего ещё не должно быть сделано.
  const expected = expectedToday(task, useToday(timeZone));

  // Черновик на время перетаскивания: полоса следует за курсором, а операция
  // уходит одна — при отпускании. Слать по движению значило бы писать в
  // историю десяток записей об одном жесте.
  const [dragPct, setDragPct] = useState<number | null>(null);

  // «День отмечен» живёт до закрытия карточки: гашёная кнопка защищает от
  // двойного тапа сейчас, а не ведёт учёт по календарю — учёт виден в
  // журнале, на вкладке «История».
  //
  // Отметка ставится до ответа сервера — как и всё в карточке, — и по отказу
  // обязана вернуться к правде вместе с полями: прогресс не записан, значит
  // день не отмечен, и главная дневная кнопка не имеет права остаться
  // погасшей. Зависимость одна, `resetToken`: успех меняет `pct`, но гасить
  // кнопку на весь заход — это и есть её работа.
  const [markedDay, setMarkedDay] = useState(false);
  useEffect(() => setMarkedDay(false), [resetToken]);

  // Число — то же поле, что и раньше: черновик, отправка по уходу фокуса
  // или Enter, возврат к правде по отказу сервера (см. fields.tsx про
  // resetToken). Не по каждой клавише: набор «75» слал бы сперва «7», и в
  // истории задачи от одного ввода оставались бы две записи.
  const [draft, setDraft] = useState(String(pct));
  useEffect(() => setDraft(String(pct)), [pct, resetToken]);
  const commitDraft = () => {
    // Пустое поле — середина набора, а не значение: возвращается к правде.
    if (draft === "") {
      setDraft(String(pct));
      return;
    }
    // Границы не проверяются здесь намеренно: их проверяет сервер, и отказ
    // вернёт поле к правде, объяснив словами.
    if (Number(draft) !== pct) onCommit(Number(draft));
  };

  const barRef = useRef<HTMLDivElement | null>(null);
  const shown = dragPct ?? pct;

  const pctAt = (clientX: number): number | null => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    return clamp(((clientX - rect.left) / rect.width) * 100);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!canWrite) return;
    // Захват держит жест, даже если курсор ушёл с полосы: отпускание за её
    // пределами — обычное окончание перетаскивания, а не отмена.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const next = pctAt(event.clientX);
    if (next !== null) setDragPct(next);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragPct === null) return;
    const next = pctAt(event.clientX);
    if (next !== null) setDragPct(next);
  };

  const onPointerUp = () => {
    if (dragPct === null) return;
    if (dragPct !== pct) onCommit(dragPct);
    setDragPct(null);
  };

  return (
    <div className="panel__progress">
      {/* Строка «статус | период | процент» — как в макете. Процент остаётся
          полем: полосой ставят «на глаз», а точную цифру вводят цифрами. */}
      <div className="panel__meta">
        {meta}
        <span className="panel__progress-pct">
          <input
            id="panel-progress"
            name="panel-progress"
            type="number"
            min={0}
            max={100}
            value={draft}
            disabled={!canWrite}
            aria-label={t("task.panel.progress")}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
          <span aria-hidden="true">%</span>
        </span>
        <span className="panel__progress-plan">
          {t("task.panel.plan_expected", { pct: expected })}
        </span>
      </div>

      {/* Полоса и кнопка записи — одной строкой, как в макете: полоса забирает
          ширину, кнопка стоит справа от неё. */}
      <div className="panel__progress-row">
        {/* Полоса — орган для мыши и пальца; для чтения и клавиатуры есть число
            выше. role="img" с подписью — как у прежней полосы: доля видна и на
            слух, а вторым слайдером с фокусом она дублировала бы поле числа. */}
        <div
          ref={barRef}
          className={canWrite ? "panel__progress-bar" : "panel__progress-bar is-static"}
          role="img"
          aria-label={t("task.panel.progress_aria", { pct: shown })}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <i style={{ width: `${shown}%` }} />
          {/* Засечка плана: опережение и отставание видны без арифметики. */}
          <b
            style={{ left: `${expected}%` }}
            title={t("task.panel.plan_expected", { pct: expected })}
            aria-hidden="true"
          />
        </div>

        {canWrite && (
          <button
            type="button"
            className={markedDay ? "panel__progress-day is-done" : "panel__progress-day"}
            disabled={markedDay || pct >= 100}
            onClick={() => {
              onCommit(Math.min(100, pct + step));
              setMarkedDay(true);
            }}
          >
            {markedDay
              ? t("task.panel.day_marked")
              : t("task.panel.mark_day", { pct: step })}
          </button>
        )}
      </div>
    </div>
  );
}
