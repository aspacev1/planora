import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";

import { ApiError } from "../api/client";
import { errorKey } from "../api/errors";
import { projectQueryKey, undoLast } from "../api/projects";
import type { Calendar, Op, ProjectState, Task } from "../api/projects";
import { useToast } from "../components/toast";
import { formatShortDate } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";
import { patchProgress, patchTask } from "../project/optimistic";
import type { Optimistic } from "../project/useProjectMutation";
import { useAskShiftReason } from "../project/ShiftReason";
import { useProjectMutation } from "../project/useProjectMutation";
import { UndoMove } from "./UndoMove";
import { edgeScroll } from "./edgeScroll";
import { relativeDayLabel } from "./relative";
import { workingDaysBetween } from "./scale";
import { addDays } from "./timescale";
import type { BarMotion } from "./useBarMotion";
import type { Scale } from "./timescale";

/**
 * Жесты по самой полоске: перенос, две её грани и заливка выполненного.
 *
 * Указательные события, а не мышиные: захват указателя удерживает жест, даже
 * когда курсор ушёл за край ленты, — а он уходит постоянно, потому что тащат до
 * конца видимой области и дальше. Мышиные события в этот момент достаются
 * элементу под курсором, и полоска замирает на полпути. Заодно то же самое
 * работает пальцем на планшете.
 *
 * Смещение переводится в дни через шкалу, а не делением на ширину дня: шкала
 * знает, где кончается день, и знает это в одном месте.
 *
 * Саму полоску жест не двигает — он только называет сдвиг, а двигает
 * `useBarMotion`, записывая его прямо в узел. Раньше сдвиг лежал в состоянии
 * React, и каждое движение указателя перерисовывало строку целиком; на сотне
 * задач это десятки перерисовок в секунду ради одного числа, которое дальше
 * стиля никуда не идёт.
 *
 * Начатый жест прерывается по Esc: передумать посреди перетаскивания — обычное
 * дело, и единственным выходом иначе было бы дотащить полоску обратно на глаз,
 * то есть попасть точно в тот же день, откуда её взяли.
 *
 * ## Почему четыре жеста в одном месте
 *
 * У них общего больше, чем различий: захват указателя, порог в пару пикселей,
 * отмена по Esc, подкачка ленты у края, ожидание ответа на месте броска, тост
 * с отменой. Различаются они ровно двумя вещами — что считать из сдвига и
 * какую операцию отправить, — и это здесь единственное, что написано для
 * каждого отдельно (см. `PLAN`).
 */

/** За что взялись: тело полоски, её грань или граница заливки. */
export type BarGrip = "move" | "start" | "end" | "progress";

/** Что жест насчитал из своего сдвига: операция и её оптимистичная догадка. */
type Plan = {
  op: Op;
  optimistic: Optimistic;
  /** Подпись тоста. Пусто — тост не показывается вовсе (жест ничего не изменил). */
  toast?: string;
};

/**
 * Насколько полоска выглядит иначе, пока её держат.
 *
 * Перенос двигает её целиком, левая грань двигает начало и на столько же
 * укорачивает, правая меняет одну ширину, заливка не трогает ни того ни
 * другого — у неё своя граница (см. `holdProgress`). Одно место вместо четырёх
 * обработчиков с одинаковой обвязкой.
 */
function heldShape(grip: BarGrip, dx: number): { dx: number; dw: number } {
  if (grip === "move") return { dx, dw: 0 };
  if (grip === "start") return { dx, dw: -dx };
  if (grip === "end") return { dx: 0, dw: dx };
  return { dx: 0, dw: 0 };
}

/**
 * Граница выполненного под пальцем — свойством прямо в узел полоски, как и
 * сдвиг самой полоски: заливка обязана идти за пальцем без задержки, а
 * перерисовывать ради этого строку значит платить рендером за одно число.
 */
function holdProgress(bar: HTMLElement | undefined, dx: number) {
  bar?.style.setProperty("--progress-dx", `${dx}px`);
}

export function useDragDates({
  projectId,
  task,
  scale,
  calendar,
  enabled,
  motion,
}: {
  projectId: string;
  task: Task;
  scale: Scale;
  /**
   * Рабочий календарь проекта — им правая грань переводит день, до которого
   * её дотянули, в длительность (см. `workingDaysBetween`). Пропсом, а не
   * запросом изнутри: состояние уже спросил экран, и второй поход к серверу
   * ради маски рабочих дней означал бы жест, который не начинается, пока не
   * ответит сеть.
   */
  calendar: Calendar;
  /** Гость полоски не двигает. */
  enabled: boolean;
  motion: BarMotion;
}) {
  const { apply } = useProjectMutation(projectId);
  const { t } = useLocale();
  const showToast = useToast();
  const askReason = useAskShiftReason();
  const queryClient = useQueryClient();
  // Ось проекта — из кэша, без запроса: экран, который держит эту ленту, уже
  // спросил состояние. Тост о переносе обязан говорить на языке шкалы:
  // «на День 8», а не настоящей датой, которой у относительного плана нет.
  const relativeAxis =
    queryClient.getQueryData<ProjectState>(projectQueryKey(projectId))?.schedule_mode ===
    "relative";

  const from = useRef<{
    pointerId: number;
    x: number;
    bar: HTMLElement;
    grip: BarGrip;
    scroll: ReturnType<typeof edgeScroll>;
  } | null>(null);
  // Последняя точка указателя: качалка ленты пересчитывает жест без новых
  // событий — палец стоит, едет лента, — и брать точку ей больше неоткуда.
  const lastX = useRef(0);
  // Было ли движение. Живёт в ref, а не в состоянии: значение читается в
  // обработчике клика сразу после отпускания, и перерисовка тут не нужна.
  const dragged = useRef(false);
  // Двигался ли указатель за этот жест вообще — отдельно от порога в пару
  // пикселей выше.
  //
  // Сдвиг жеста считает и ход самой ленты (см. `edgeScroll.scrolled`), а лента
  // умеет ехать под неподвижным пальцем: инерция прокрутки, начатой перед
  // самым нажатием, доезжает уже после него. Без этого признака такое нажатие
  // выходило бы переносом сроков на всё докатившееся — вместо того, чтобы
  // открыть карточку, за чем на полоску и нажимали.
  const pointerMoved = useRef(false);
  // Два состояния, потому что вопроса два, и отвечают на них в разное время.
  //
  // `started` — палец на полоске: с этого мгновения жест можно передумать, и
  // слушатель Esc заводится здесь. Ref для него не годится — слушатель ставится
  // в эффекте, и ref его не разбудит.
  //
  // `dragging` — полоску действительно тащат: она поднимается над соседями и
  // меняет курсор. Это уже после порога в пару пикселей, иначе вид полоски
  // мигал бы на каждом открытии карточки. Хранится за что именно взялись:
  // строке нужно показать, какой жест идёт.
  //
  // Сам сдвиг в состояние не попадает ни в каком виде: его пишет слой движения
  // прямо в узел.
  const [started, setStarted] = useState(false);
  const [dragging, setDragging] = useState<BarGrip | null>(null);

  /**
   * Насколько далеко можно утащить грань, не схлопнув полоску.
   *
   * Задача короче одного дня не бывает, и грань, доведённая за противоположную,
   * означала бы отрицательную длительность. Упор ставится здесь, а не при
   * отправке: полоска обязана перестать сжиматься под пальцем ровно там, где
   * перестаёт меняться то, что уйдёт на сервер.
   */
  const clampGrip = (grip: BarGrip, dx: number): number => {
    const width = scale.widthOf(task.start_date, task.end_date);
    const limit = width - scale.dayWidth;
    if (grip === "start") return Math.min(dx, limit);
    if (grip === "end") return Math.max(dx, -limit);
    return dx;
  };

  /**
   * Что уйдёт на сервер, если жест закончить здесь.
   *
   * `null` — жест ничего не изменил: полоску вернули на тот же день, грань — в
   * ту же дату, заливку — на тот же процент. Такое не отправляется вовсе:
   * запись в истории обещала бы изменение, которого не было.
   */
  const planFor = (grip: BarGrip, dx: number): Plan | null => {
    if (grip === "progress") {
      const width = scale.widthOf(task.start_date, task.end_date);
      const filled = (width * task.progress_pct) / 100 + dx;
      const pct = progressStep(width === 0 ? 0 : (filled / width) * 100);
      if (pct === task.progress_pct) return null;
      return {
        op: { type: "set_progress", task_id: task.id, progress_pct: pct },
        optimistic: (state) => patchProgress(state, task.id, pct),
        toast: t("gantt.progress_set", { name: task.name, percent: pct }),
      };
    }

    if (grip === "move") {
      // Половина дня прибавляется, чтобы день менялся посередине ячейки, а не
      // на её краю: иначе полоска перескакивает на новый день от дрожания руки
      // в один пиксель.
      const start = scale.dateAt(scale.xOf(task.start_date) + dx + scale.dayWidth / 2);
      if (start === task.start_date) return null;
      return {
        op: { type: "move_task", task_id: task.id, start_date: start },
        optimistic: (state) => patchTask(state, task.id, { start_date: start }),
        toast: t("gantt.moved", {
          date: relativeAxis ? relativeDayLabel(t, start) : formatShortDate(t, start),
        }),
      };
    }

    if (grip === "start") {
      const start = scale.dateAt(scale.xOf(task.start_date) + dx + scale.dayWidth / 2);
      if (start === task.start_date) return null;
      // Конец стоит на месте — это и есть смысл левой грани, — поэтому
      // длительность считается до него. Рабочими днями, потому что в них она и
      // задана; догадка сверяется с ответом сервера (см. `workingDaysBetween`).
      const duration = Math.max(1, workingDaysBetween(start, task.end_date, calendar));
      return {
        op: { type: "resize_task", task_id: task.id, start_date: start, duration_days: duration },
        optimistic: (state) =>
          patchTask(state, task.id, { start_date: start, duration_days: duration }),
        toast: t("gantt.resized", { name: task.name, days: t("common.days", { count: duration }) }),
      };
    }

    const end = scale.dateAt(scale.xOf(task.end_date) + dx + scale.dayWidth / 2);
    if (end === task.end_date) return null;
    const duration = Math.max(1, workingDaysBetween(task.start_date, end, calendar));
    if (duration === task.duration_days) return null;
    return {
      op: { type: "set_duration", task_id: task.id, duration_days: duration },
      optimistic: (state) => patchTask(state, task.id, { duration_days: duration }),
      toast: t("gantt.resized", { name: task.name, days: t("common.days", { count: duration }) }),
    };
  };

  /**
   * Отмена из тоста. Отменяется именно то изменение, о котором тост говорит:
   * его номер назвал сервер, применяя операцию, и он же уходит обратно в
   * `expected_seq`. «Последнее изменение проекта» здесь не годится — за шесть
   * секунд, что висит тост, последним успевает стать чужое.
   *
   * Сам путь тот же, что у кнопки «Отменить» в ленте истории: отмена
   * подчиняется тому же порогу объяснений, что и любой сдвиг.
   */
  const undoChange = async (seq: number) => {
    try {
      try {
        await undoLast(projectId, { seq });
      } catch (refusal) {
        if (!(refusal instanceof ApiError) || refusal.code !== "reason_required" || !askReason) {
          throw refusal;
        }
        // Числа — из подсказок сервера: вкладка не знает, к каким датам
        // приведёт обратная операция.
        const reason = await askReason({
          taskName: task.name,
          deviationDays: refusal.hints.deviationDays ?? 0,
          thresholdDays: refusal.hints.thresholdDays ?? 0,
        });
        if (reason === null) return;
        await undoLast(projectId, { seq, reason });
      }
      await queryClient.invalidateQueries({ queryKey: projectQueryKey(projectId) });
    } catch (error) {
      // Отказ отмены показывается там же, где было предложение отменить:
      // человек смотрит на тост, а не на шапку проекта.
      showToast({ message: t(errorKey(error)), tone: "error" });
    }
  };

  /**
   * Прервать начатый жест, ничего не отправив.
   *
   * Полоска возвращается туда, откуда её потащили: пока жест идёт, дат он не
   * менял — их меняет только отпускание. Возврат мгновенный, а не переездом:
   * Esc отменяет жест, а не доводит его до конца, и ехать полоске неоткуда —
   * её место по датам всё это время не менялось, менялся только сдвиг.
   */
  const cancel = useCallback(() => {
    const start = from.current;
    from.current = null;
    start?.scroll.stop();
    holdProgress(start?.bar, 0);
    motion.hold(0, 0);
    motion.release();
    setStarted(false);
    setDragging(null);
    // Захват снимается руками: иначе полоска до конца жеста продолжает
    // получать события указателя, и отпускание прилетело бы уже прерванному
    // перетаскиванию.
    if (start && start.bar.hasPointerCapture?.(start.pointerId)) {
      start.bar.releasePointerCapture?.(start.pointerId);
    }
    // Клик, который браузер пришлёт вслед за отпусканием, гасится тем же
    // признаком, что и после обычного перетаскивания: Esc означает «ничего не
    // делать», а не «открыть карточку».
    dragged.current = true;
    // Кроме слоя движения, живых зависимостей нет: внутри только ref-ы да
    // функции состояния, а сам слой ссылку не меняет. Постоянная ссылка нужна
    // эффекту ниже — иначе он переподписывался бы на каждой отрисовке.
  }, [motion]);

  // Esc прерывает начатое перетаскивание — как везде, где жест можно начать и
  // передумать. Слушатель на окне, а не на полоске: захват указателя держит
  // события мыши, но не клавиатуры, и фокус во время жеста может оказаться где
  // угодно — на полоске, если браузер отдал его нажатию, и на теле документа,
  // если не отдал.
  useEffect(() => {
    if (!started) return;
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancel, started]);

  // Качалка ленты живёт ровно на время жеста, но остановить её нужно и тогда,
  // когда строка исчезла посреди него: сосед удалил задачу, лента свернула
  // категорию. Кадр, оставшийся без узла, крутился бы вечно.
  useEffect(() => () => from.current?.scroll.stop(), []);

  /**
   * @param hold Держать ли полоску там, куда её бросили, пока изменение идёт.
   *   Так делает перетаскивание: полоску отпустили под пальцем, и до решения
   *   ей место там. Клавиатура не держит ничего — там полоска и не двигалась,
   *   а поехавшая до ответа на вопрос о причине означала бы сдвиг, которого
   *   ещё не было.
   *
   *   Держит сам слой движения: сдвиг уже записан в узел, и «подождать» здесь
   *   значит не снимать его до ответа. Второе состояние с той же датой считало
   *   бы этот сдвиг ещё раз — и полоска на кадр уезжала бы вдвое.
   */
  const commit = (plan: Plan | null, hold = false) => {
    // Жест, вернувший полоску на место, — не изменение и не должен оставлять
    // запись в истории.
    if (plan === null) {
      if (hold) motion.settle();
      return;
    }
    apply(plan.op, plan.optimistic)
      .then(
        (revision) => {
          // Тост с отменой — после подтверждения сервером, как в макете:
          // изменение применяется сразу, а лёгкий путь назад лежит под рукой.
          // Номер ревизии — из ответа сервера: он и делает кнопку обещанием
          // вернуть именно этот шаг, а не «что там сейчас сверху журнала».
          if (plan.toast === undefined) return;
          showToast({
            message: plan.toast,
            action: (
              <UndoMove
                projectId={projectId}
                seq={revision.seq}
                onUndo={() => void undoChange(revision.seq)}
              />
            ),
          });
        },
        () => {
          // Откат уже сделан внутри `apply`, а полоска возвращается туда,
          // откуда её тащили, когда отпускается захват ниже. Это и есть
          // сообщение об отказе: другого места для него на ленте нет, а
          // модальное окно поверх диаграммы прерывало бы работу там, где
          // человек и так всё увидел. Отказ при этом всегда приходит после
          // решения человека, а не до него, — и движение назад читается как
          // ответ на его жест, а не как отказ ещё не заданного вопроса.
        },
      )
      .finally(() => {
        // Изменение решено — сдвиг можно снимать. Подтверждённый снял уже слой
        // разметки: новые `left` и `width` пришли с датами, и `settle` увидит
        // ноль. Отказанный снимается здесь, и полоска едет назад — после
        // ответа, а не до него.
        if (hold) motion.settle();
      });
  };

  /** Общий разбор движения указателя: и от руки, и от уехавшей самой ленты. */
  const track = (clientX: number) => {
    const start = from.current;
    if (start === null) return;
    // Прибавка за уехавшую ленту: под неподвижным пальцем день меняется ровно
    // потому, что лента едет, и без этого слагаемого полоска отставала бы от
    // неё ровно на пройденное расстояние.
    const dx = clampGrip(start.grip, clientX - start.x + start.scroll.scrolled());
    // Порог в пару пикселей: дрожание руки при щелчке не должно превращать
    // щелчок в перетаскивание и закрывать карточку, которую человек как раз
    // открывал.
    if (Math.abs(dx) > 2 && !dragged.current) {
      dragged.current = true;
      setDragging(start.grip);
    }
    if (start.grip === "progress") {
      holdProgress(start.bar, dx);
      return;
    }
    const shape = heldShape(start.grip, dx);
    motion.hold(shape.dx, shape.dw);
  };

  /** Обработчики любой из ручек: тела полоски, её граней и заливки. */
  const gripHandlers = (grip: BarGrip) => ({
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (!enabled || event.button !== 0) return;
      if (grip !== "move") {
        // Грань внутри полоски, и без этого нажатие на неё дошло бы до полоски
        // тоже: жест начался бы дважды, и второй перезаписал бы первый.
        event.stopPropagation();
        // Ручка — не кнопка, а `span` внутри полоски, и нажатие на неё браузер
        // считает началом выделения текста: живая проверка показала жест,
        // который вместо растягивания полоски подсвечивал названия соседних
        // задач. Самой полоске (`move`) это не нужно и вредно — она кнопка, и
        // отмена умолчания отняла бы у неё фокус по щелчку.
        event.preventDefault();
      }
      const bar = event.currentTarget.closest<HTMLElement>(".gantt__bar") ?? event.currentTarget;
      // Прошлый жест, если он почему-то не закончился (второй палец на
      // планшете, отпускание, не дошедшее до полоски), снимается здесь:
      // иначе за ним остались бы кадр и подписка на прокрутку ленты.
      from.current?.scroll.stop();
      from.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        bar,
        grip,
        scroll: edgeScroll(bar, () => track(lastX.current)),
      };
      lastX.current = event.clientX;
      dragged.current = false;
      pointerMoved.current = false;
      // Жест начат — с этого мгновения его можно передумать по Esc. Вид
      // полоски при этом не меняется: щелчок начинается точно так же, и
      // подъём над соседями мигал бы на каждом открытии карточки.
      setStarted(true);
      // jsdom этого метода не знает, да и браузер откажет на устаревшем
      // указателе. Захват — улучшение жеста, а не его условие.
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },

    onPointerMove(event: PointerEvent<HTMLElement>) {
      const start = from.current;
      if (start === null || start.pointerId !== event.pointerId) return;
      lastX.current = event.clientX;
      pointerMoved.current = true;
      start.scroll.track(event.clientX);
      track(event.clientX);
    },

    onPointerUp(event: PointerEvent<HTMLElement>) {
      const start = from.current;
      if (start === null || start.pointerId !== event.pointerId) return;
      from.current = null;
      start.scroll.stop();
      setStarted(false);
      setDragging(null);
      // Нажатие, за которое указатель не сдвинулся ни разу, — щелчок по
      // полоске, и сдвига у него нет никакого. Считать его по общей формуле
      // нельзя: в неё входит ход ленты, а он бывает и без участия пальца
      // (см. `pointerMoved`).
      const dx = pointerMoved.current
        ? clampGrip(start.grip, event.clientX - start.x + start.scroll.scrolled())
        : 0;

      if (start.grip === "progress") {
        // Заливка ответа не ждёт: догадка о проценте — это и есть будущий
        // ответ, целиком, без календарной арифметики, которую считает сервер.
        // Снимается граница до отправки, потому что оптимистичная правда
        // ложится в кэш синхронно внутри `commit`, и держать сверх неё
        // пиксельный сдвиг значило бы посчитать его дважды.
        holdProgress(start.bar, 0);
        commit(planFor(start.grip, dx));
        return;
      }

      // Полоска ждёт ровно там, где её отпустили, — сдвиг снимет `settle`,
      // когда изменение решится, и она доедет до своего дня уже с ответом.
      // Снятый прямо сейчас, он вернул бы её на место ещё до вопроса о
      // причине — то есть ответил бы «не получилось» раньше, чем спросили.
      motion.release(true);
      commit(planFor(start.grip, dx), true);
    },

    onPointerCancel() {
      cancel();
    },

    onClickCapture(event: MouseEvent<HTMLElement>) {
      // После отпускания кнопки браузер шлёт клик по той же полоске. Без
      // этого перехвата каждое перетаскивание заканчивалось бы открытием
      // карточки — и человек, подвинувший десять задач, закрывал бы десять
      // карточек.
      if (!dragged.current) return;
      dragged.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  });

  return {
    /** Какой жест идёт прямо сейчас; `null` — никакой. */
    dragging,
    /** Тело полоски: перенос обеих дат разом. */
    handlers: {
      ...gripHandlers("move"),

      onKeyDown(event: KeyboardEvent<HTMLElement>) {
        // Полоска объявлена кнопкой, и человек, работающий с клавиатуры,
        // обязан иметь способ сделать всё то же, что указателем. Стрелки под
        // модификаторами, а голые оставлены прокрутке ленты: без этого нельзя
        // было бы просто посмотреть, что справа, не сдвинув при этом сроки.
        //
        //   Shift        — перенести задачу (обе даты)
        //   Alt          — растянуть конец (длительность)
        //   Shift + Alt  — двинуть начало, конец на месте
        //
        // Три сочетания вместо одного — потому что жестов у полоски стало
        // три, и «то же самое есть в карточке» перестаёт быть ответом, когда
        // указателем это делается одним движением, а с клавиатуры — открытием
        // карточки, поиском поля и возвратом.
        //
        // Сочетания названы вслух в двух местах — в `aria-keyshortcuts`
        // полоски и в строке подсказки карточки наведения (Row, BarTip):
        // возможность, о которой знает только исходник, всё равно что её нет.
        if (!enabled) return;
        const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (step === 0) return;

        // Веха длительности не имеет: её грани не тянутся ни указателем, ни с
        // клавиатуры. Переносить её при этом можно.
        const resizes = event.altKey && !task.milestone;
        if (!event.shiftKey && !resizes) return;
        // Alt + стрелка у браузера занят переходом по истории. Отмена
        // умолчания здесь обязательна, иначе сочетание уводит со страницы.
        event.preventDefault();

        if (resizes && event.shiftKey) {
          // Левая грань: начало едет, конец стоит, значит длительность растёт
          // ровно на столько, на сколько уехало начало.
          const start = addDays(task.start_date, step);
          const duration = Math.max(1, workingDaysBetween(start, task.end_date, calendar));
          commit({
            op: {
              type: "resize_task",
              task_id: task.id,
              start_date: start,
              duration_days: duration,
            },
            optimistic: (state) =>
              patchTask(state, task.id, { start_date: start, duration_days: duration }),
            toast: t("gantt.resized", {
              name: task.name,
              days: t("common.days", { count: duration }),
            }),
          });
          return;
        }

        if (resizes) {
          // Правая грань: шаг здесь считается в рабочих днях напрямую — это и
          // есть единица длительности, и переводить её через дату незачем.
          const duration = task.duration_days + step;
          if (duration < 1) return;
          commit({
            op: { type: "set_duration", task_id: task.id, duration_days: duration },
            optimistic: (state) => patchTask(state, task.id, { duration_days: duration }),
            toast: t("gantt.resized", {
              name: task.name,
              days: t("common.days", { count: duration }),
            }),
          });
          return;
        }

        const start = addDays(task.start_date, step);
        commit({
          op: { type: "move_task", task_id: task.id, start_date: start },
          optimistic: (state) => patchTask(state, task.id, { start_date: start }),
          toast: t("gantt.moved", {
            date: relativeAxis ? relativeDayLabel(t, start) : formatShortDate(t, start),
          }),
        });
      },
    },
    /**
     * Ручка грани или заливки. Отдельными узлами поверх полоски, а не зонами
     * внутри одного обработчика: у каждой свой курсор и своя подсказка, и
     * зонами это пришлось бы решать в момент нажатия, когда курсор уже показал
     * что-то одно.
     */
    gripHandlers,
  };
}

/**
 * Процент, до которого дотянули заливку, — с точностью до пяти.
 *
 * Не до единицы: на месячном масштабе день занимает восемнадцать пикселей, и
 * попасть в 37% там нельзя даже намеренно — выходит лотерея из соседних
 * значений. Пять — шаг, который человек и называет вслух («процентов
 * семьдесят»), и он же попадается на глаз по делениям полоски. Ровные 0 и 100
 * достижимы обычным движением до края, а не только точным попаданием.
 */
function progressStep(pct: number): number {
  return Math.min(100, Math.max(0, Math.round(pct / 5) * 5));
}
