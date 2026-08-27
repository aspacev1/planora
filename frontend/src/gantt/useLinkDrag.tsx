import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent, RefCallback } from "react";

import { errorKey } from "../api/errors";
import type { ProjectState } from "../api/projects";
import { useToast } from "../components/toast";
import { useLocale } from "../i18n/LocaleProvider";
import { addDependency } from "../project/optimistic";
import { useProjectMutation } from "../project/useProjectMutation";
import { edgeScroll } from "./edgeScroll";

/**
 * Связь, протянутая от полоски к полоске.
 *
 * До этого связи заводились только списком в карточке задачи: открыть карточку,
 * найти нужную задачу в выпадающем списке из полусотни, выбрать. Список
 * остаётся — с клавиатуры и на узком экране он единственный способ, — но
 * основной жест теперь тот же, каким связь и рисуют на бумаге: от конца одной
 * полоски к началу другой.
 *
 * За какой кружок взялись, тем и решается направление: за правый (`end`) —
 * взятая задача блокирует ту, на которую бросили; за левый (`start`) — наоборот,
 * взятую блокирует та, на которую бросили. Иначе связь можно было бы протянуть
 * только в одну сторону, и половину зависимостей пришлось бы заводить,
 * начиная с конца.
 *
 * ## Почему всё это мимо состояния React
 *
 * Линия под пальцем и подсветка цели меняются на каждом движении указателя.
 * Состояние React перерисовывало бы ради них всю ленту — сотню строк на каждое
 * событие. Поэтому линия пишется прямо в атрибуты своего узла, а подсветка —
 * классом на найденной строке; в состояние уходит один признак «жест идёт»,
 * и меняется он дважды за жест.
 */

/** За какой кружок взялись: конец полоски или её начало. */
export type LinkSide = "start" | "end";

/** Класс строки, на которую бросят связь. Ставится и снимается вручную. */
const TARGET_CLASS = "is-link-target";

export function useLinkDrag({
  projectId,
  state,
  canWrite,
}: {
  projectId: string;
  state: ProjectState;
  canWrite: boolean;
}) {
  const { apply } = useProjectMutation(projectId);
  const { t } = useLocale();
  const showToast = useToast();

  const layer = useRef<SVGSVGElement | null>(null);
  const line = useRef<SVGLineElement | null>(null);
  const hovered = useRef<HTMLElement | null>(null);
  const from = useRef<{
    pointerId: number;
    taskId: string;
    side: LinkSide;
    scroll: ReturnType<typeof edgeScroll>;
  } | null>(null);
  const lastPoint = useRef({ x: 0, y: 0 });
  const [active, setActive] = useState(false);

  /** Точка в координатах слоя связей: линия живёт внутри него, указатель — в окне. */
  const localPoint = (clientX: number, clientY: number) => {
    const box = layer.current?.getBoundingClientRect();
    return box ? { x: clientX - box.left, y: clientY - box.top } : { x: 0, y: 0 };
  };

  const markTarget = (element: HTMLElement | null) => {
    if (hovered.current === element) return;
    hovered.current?.classList.remove(TARGET_CLASS);
    element?.classList.add(TARGET_CLASS);
    hovered.current = element;
  };

  /**
   * Строка под указателем — по координатам точки, а не по адресату события.
   *
   * Причина та же, что у перестановки строк: пальцем указатель после нажатия
   * захвачен кружком, за который начали жест, и строки под пальцем событий не
   * получают вовсе (см. `targetAt` в useReorder).
   */
  const rowAt = (clientX: number, clientY: number): HTMLElement | null => {
    const under = document.elementFromPoint?.(clientX, clientY) ?? null;
    const row = under?.closest<HTMLElement>('[data-drop-kind="task"]') ?? null;
    // Своя же строка целью не подсвечивается: связь задачи с самой собой
    // сервер откажет, и обещать её кружком не за чем.
    return row?.dataset.dropId === from.current?.taskId ? null : row;
  };

  const track = (clientX: number, clientY: number) => {
    if (from.current === null) return;
    lastPoint.current = { x: clientX, y: clientY };
    const point = localPoint(clientX, clientY);
    line.current?.setAttribute("x2", String(point.x));
    line.current?.setAttribute("y2", String(point.y));
    markTarget(rowAt(clientX, clientY));
  };

  // Постоянная ссылка нужна эффекту ниже: иначе он переподписывался бы на
  // каждой отрисовке. Всё, что `finish` трогает, живёт в ref-ах и в функции
  // состояния — вещах, чья ссылка между отрисовками не меняется, — поэтому
  // список зависимостей и пуст.
  const finish = useCallback(() => {
    from.current?.scroll.stop();
    from.current = null;
    hovered.current?.classList.remove(TARGET_CLASS);
    hovered.current = null;
    setActive(false);
  }, []);

  // Отпустить кнопку можно и мимо строк — за краем ленты, над шапкой, вообще
  // вне окна. Без этого слушателя связь осталась бы «в руке» навсегда, и линия
  // тянулась бы за курсором без всякого нажатия.
  useEffect(() => {
    if (!active) return;
    const abandon = () => finish();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      // Esc прерывает жест — как везде, где его можно начать и передумать.
      if (event.key !== "Escape") return;
      event.preventDefault();
      finish();
    };
    window.addEventListener("pointercancel", abandon);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointercancel", abandon);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [active, finish]);

  const link = (sourceId: string, side: LinkSide, targetId: string) => {
    // За правый кружок тянут «эта задача блокирует ту», за левый — «эту
    // блокирует та». Направление решает кружок, а не порядок клика.
    const fromId = side === "end" ? sourceId : targetId;
    const toId = side === "end" ? targetId : sourceId;
    if (fromId === toId) return;
    // Повторную связь глушит вызывающий, а не сервер: отказ был бы честным, но
    // человек, дважды протянувший одну и ту же стрелку, ошибки не совершил —
    // ему просто нечего показывать.
    const exists = state.dependencies.some(
      (dep) => dep.from_task_id === fromId && dep.to_task_id === toId,
    );
    if (exists) return;

    void apply({ type: "add_dependency", from_task_id: fromId, to_task_id: toId }, (current) =>
      addDependency(current, fromId, toId),
    ).catch((error) => {
      // Кольцо — единственный отказ, которого человек не мог предвидеть: он
      // видит две полоски, а не весь граф. Откат уже сделан внутри `apply`,
      // стрелка исчезла, и без этих слов исчезновение читалось бы как сбой.
      showToast({ message: t(errorKey(error)), tone: "error" });
    });
  };

  return {
    /** Показывать ли кружки связи. У гостя их нет вовсе. */
    enabled: canWrite,
    /** Тянут ли связь прямо сейчас: лента поднимает кружки у всех полосок. */
    active,

    /**
     * Ссылка на слой линии. Отдаётся разметке, а сама линия дальше живёт мимо
     * React: её концы меняются на каждом движении указателя.
     */
    layerRef: useCallback<RefCallback<SVGSVGElement>>((element) => {
      layer.current = element;
    }, []),
    lineRef: useCallback<RefCallback<SVGLineElement>>((element) => {
      line.current = element;
    }, []),

    /** Кружок на краю полоски. Им жест и начинают, и ведут — как ручкой строки. */
    handleProps(taskId: string, side: LinkSide) {
      return {
        onPointerDown(event: PointerEvent<SVGElement | HTMLElement>) {
          if (!canWrite || event.button !== 0) return;
          // Иначе нажатие дойдёт до полоски под кружком и начнёт перенос дат.
          event.preventDefault();
          event.stopPropagation();
          const node = event.currentTarget as unknown as HTMLElement;
          // Прошлый жест, если он почему-то не закончился, снимается здесь:
          // иначе за ним остались бы кадр и подписка на прокрутку ленты.
          from.current?.scroll.stop();
          from.current = {
            pointerId: event.pointerId,
            taskId,
            side,
            scroll: edgeScroll(node, () => track(lastPoint.current.x, lastPoint.current.y)),
          };
          setActive(true);
          const point = localPoint(event.clientX, event.clientY);
          for (const [name, value] of [
            ["x1", point.x],
            ["y1", point.y],
            ["x2", point.x],
            ["y2", point.y],
          ] as const) {
            line.current?.setAttribute(name, String(value));
          }
          node.setPointerCapture?.(event.pointerId);
        },

        onPointerMove(event: PointerEvent<SVGElement | HTMLElement>) {
          const start = from.current;
          if (start === null || start.pointerId !== event.pointerId) return;
          event.stopPropagation();
          start.scroll.track(event.clientX);
          track(event.clientX, event.clientY);
        },

        onPointerUp(event: PointerEvent<SVGElement | HTMLElement>) {
          const start = from.current;
          if (start === null || start.pointerId !== event.pointerId) return;
          event.stopPropagation();
          const target = rowAt(event.clientX, event.clientY)?.dataset.dropId;
          finish();
          if (target !== undefined) link(start.taskId, start.side, target);
        },
      };
    },
  };
}

export type LinkDrag = ReturnType<typeof useLinkDrag>;
