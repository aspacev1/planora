import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";

import type { Category } from "../api/projects";
import { useToast } from "../components/toast";
import { useLocale } from "../i18n/LocaleProvider";
import { shiftCategory } from "../project/optimistic";
import { useProjectMutation } from "../project/useProjectMutation";
import { edgeScroll } from "./edgeScroll";
import type { Scale } from "./timescale";

/**
 * Перенос всей категории за её сводную полосу.
 *
 * Этап целиком уезжает на неделю — обычное дело, и до этого жеста оно означало
 * перетащить каждую полоску по очереди, попав каждой в один и тот же день.
 * Десять движений вместо одного, десять записей в истории и десять отмен, если
 * передумали.
 *
 * Поэтому одна операция (`move_category`) и одна запись: человек сделал одно
 * движение. Сдвиг меряется днями, а не целевой датой, — своих границ у
 * категории нет, сводная полоса рисуется по крайним датам её задач.
 *
 * Слоя движения (`useBarMotion`) здесь нет намеренно. Он ведёт переезд полоски
 * после ответа сервера, сравнивая места на соседних отрисовках; у сводной полосы
 * переезжать нечему — она не задача, а обводка вокруг них, и её место
 * пересчитывается из тех же дат, которые в этот момент едут сами.
 */
export function useDragCategory({
  projectId,
  category,
  scale,
  enabled,
}: {
  projectId: string;
  category: Category;
  scale: Scale;
  /** Пустую категорию двигать нечем: сервер откажет, полосы на ленте и так нет. */
  enabled: boolean;
}) {
  const { apply } = useProjectMutation(projectId);
  const { t } = useLocale();
  const showToast = useToast();

  const span = useRef<HTMLElement | null>(null);
  const from = useRef<{
    pointerId: number;
    x: number;
    scroll: ReturnType<typeof edgeScroll>;
  } | null>(null);
  const lastX = useRef(0);
  // Двигался ли указатель за жест. Сдвиг полосы считает и ход самой ленты
  // (см. `edgeScroll.scrolled`), а она умеет ехать под неподвижным пальцем —
  // инерцией прокрутки, начатой перед самым нажатием. Без этого признака
  // нажатие на полосу переносило бы этап целиком на всё докатившееся.
  const pointerMoved = useRef(false);
  const [dragging, setDragging] = useState(false);

  /** Сдвиг полосы под пальцем — свойством прямо в узел, мимо состояния React. */
  const hold = (dx: number) => span.current?.style.setProperty("--span-dx", `${dx}px`);

  const stop = useCallback(() => {
    from.current?.scroll.stop();
    from.current = null;
    setDragging(false);
  }, []);

  const cancel = useCallback(() => {
    hold(0);
    stop();
  }, [stop]);

  // Esc прерывает начатый перенос — как у полоски задачи. Слушатель на окне:
  // захват указателя держит события мыши, но не клавиатуры.
  useEffect(() => {
    if (!dragging) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancel, dragging]);

  useEffect(() => () => from.current?.scroll.stop(), []);

  const track = (clientX: number) => {
    const start = from.current;
    if (start === null) return;
    hold(clientX - start.x + start.scroll.scrolled());
  };

  const move = (dx: number) => {
    // Округление до дня, а не до половины: у полосы нет своего дня, от края
    // которого отсчитывать. Сдвиг меньше половины деления — это дрожание руки,
    // и в изменение оно превращаться не должно.
    const days = Math.round(dx / scale.dayWidth);
    if (days === 0) {
      hold(0);
      return;
    }
    void apply(
      { type: "move_category", category_id: category.id, days },
      (state) => shiftCategory(state, category.id, days),
    )
      .then(() =>
        showToast({
          message: t(days > 0 ? "gantt.category_moved_late" : "gantt.category_moved_early", {
            name: category.name,
            days: t("common.days", { count: Math.abs(days) }),
          }),
        }),
      )
      .catch(() => {
        // Откат уже сделан внутри `apply`: задачи вернулись на свои даты, и
        // полоса, посчитанная по ним, встала обратно сама.
      })
      .finally(() => {
        // Сдвиг снимается после ответа, а не до него: снятый сразу, он вернул
        // бы полосу на прежнее место ещё до вопроса о причине — то есть ответил
        // бы «не получилось» раньше, чем спросили.
        hold(0);
      });
  };

  return {
    /** Тащат ли полосу прямо сейчас. */
    dragging,
    /** Ссылка на узел полосы: сдвиг пишется в него напрямую. */
    spanRef: useCallback((element: HTMLElement | null) => {
      span.current = element;
    }, []),
    handlers: enabled
      ? {
          onPointerDown(event: PointerEvent<HTMLElement>) {
            if (event.button !== 0) return;
            // Строка категории — цель броска при перестановке, и без этого
            // нажатие на полосу начинало бы заодно и её.
            event.stopPropagation();
            event.preventDefault();
            // Прошлый жест, если он почему-то не закончился, снимается здесь:
            // иначе за ним остались бы кадр и подписка на прокрутку ленты.
            from.current?.scroll.stop();
            from.current = {
              pointerId: event.pointerId,
              x: event.clientX,
              scroll: edgeScroll(event.currentTarget, () => track(lastX.current)),
            };
            lastX.current = event.clientX;
            pointerMoved.current = false;
            setDragging(true);
            event.currentTarget.setPointerCapture?.(event.pointerId);
          },

          onPointerMove(event: PointerEvent<HTMLElement>) {
            const start = from.current;
            if (start === null || start.pointerId !== event.pointerId) return;
            event.stopPropagation();
            lastX.current = event.clientX;
            pointerMoved.current = true;
            start.scroll.track(event.clientX);
            track(event.clientX);
          },

          onPointerUp(event: PointerEvent<HTMLElement>) {
            const start = from.current;
            if (start === null || start.pointerId !== event.pointerId) return;
            event.stopPropagation();
            // Нажатие без единого движения указателя — щелчок по полосе, а не
            // перенос этапа: ход ленты в его сдвиг не входит (см. выше).
            const dx = pointerMoved.current ? event.clientX - start.x + start.scroll.scrolled() : 0;
            stop();
            move(dx);
          },

          onPointerCancel() {
            cancel();
          },
        }
      : undefined,
  };
}
