import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { RefCallback } from "react";

import { MOTION_MS, prefersReducedMotion } from "./motion";

/**
 * Движение полоски задачи.
 *
 * Место полоски на ленте задают `left` и `width`. Оба выставляются на рендер и
 * больше не трогаются: это свойства разметки, и всякая их правка заставляет
 * браузер пересчитать положение целого слоя строк. Анимация по ним делает это
 * каждый кадр. На десятке задач разницы не видно, на сотнях лента начинает
 * дёргаться — и ровно тогда, когда это заметнее всего: сервер пересчитал
 * цепочку зависимостей, и едут все полоски разом.
 *
 * Поэтому движется полоска только через `transform`, который разметку не
 * трогает вовсе и живёт на слое композиции. Способа два, и оба пишут в один и
 * тот же `--bar-dx`:
 *
 * - под пальцем — запись в стиль узла напрямую, минуя состояние React.
 *   Указатель шлёт события десятки раз в секунду, и перерисовывать ради
 *   каждого целую строку значит платить рендером за то, что делает одна
 *   запись свойства;
 * - переезд после ответа сервера — короткая анимация от прежнего места к
 *   новому. Прежнее место известно числом с прошлого рендера, поэтому узел не
 *   измеряется: `getBoundingClientRect` — это принудительный пересчёт
 *   разметки, то самое, от чего здесь уходят.
 *
 * Своего кадра (`requestAnimationFrame`) под жест здесь нет намеренно: браузер
 * и так отдаёт `pointermove` не чаще кадра, а лишний перенос записи на
 * следующий добавил бы кадр отставания жесту, который обязан идти за пальцем
 * без задержки.
 */
export type BarMotion = {
  /** Ссылка на узел полоски: без него писать некуда. */
  ref: RefCallback<HTMLElement>;
  /**
   * Полоска под пальцем: сдвиг в пикселях от места, положенного ей по датам.
   *
   * @param dw насколько шире положенного полоска сейчас выглядит. Ненулевым
   *   бывает только при растягивании за грань, и там ширина обязана меняться —
   *   растянуть полоску, не меняя ширины, нельзя. Оговорка к правилу из
   *   заголовка файла («ширина выставляется на рендер и не трогается») ровно
   *   этим и ограничена: под пальцем в этот момент одна полоска, а не весь
   *   слой строк, и пересчёт разметки стоит одной строки.
   */
  hold: (dx: number, dw?: number) => void;
  /**
   * Палец отпустили.
   *
   * @param pending перенос ещё решается — полоска ждёт там, где её бросили, и
   *   сдвиг снимет `settle`. Иначе она возвращается на место сама.
   */
  release: (pending?: boolean) => void;
  /** Перенос решён: сдвиг снимается, и полоска встаёт по датам. */
  settle: () => void;
};

export function useBarMotion({
  left,
  scaleKey,
}: {
  left: number;
  /** Признак системы координат ленты — см. `Scale.key`. */
  scaleKey: string;
}): BarMotion {
  const node = useRef<HTMLElement | null>(null);
  // Сдвиг под пальцем и признак самого жеста. В ref, а не в состоянии: они
  // читаются в обработчиках указателя и в слое разметки, а перерисовывать
  // строку ради них не нужно — в этом весь смысл (см. заголовок файла).
  const held = useRef(0);
  // Прибавка к ширине под пальцем — растягивание за грань. Отдельно от сдвига,
  // потому что снимается по-другому: сдвиг доезжает до места анимацией, а
  // ширина встаёт сразу. Анимировать её нечем и незачем — конец полоски и так
  // стоит там, где его отпустили.
  const heldWidth = useRef(0);
  const holding = useRef(false);
  const settling = useRef<Animation | null>(null);
  const frame = useRef(0);
  // Где полоска стояла на прошлом рендере. Разница с нынешним местом и есть
  // расстояние переезда. Ширина сюда не входит: длительность задачи — не место,
  // и меняется она сама по себе, без всякого движения по ленте.
  const was = useRef<{ left: number; scaleKey: string } | null>(null);

  useLayoutEffect(() => {
    const before = was.current;
    was.current = { left, scaleKey };

    // Полоску всё ещё держат. Её место задаёт палец, а не даты: пришедшая в
    // этот момент чужая правка меняет `left` под ней, но жест не прерывает.
    if (holding.current) return;
    // Первый рендер: полоске неоткуда ехать.
    if (before === null) return;

    // Полоска едет от того места, где её видели в последний раз. Под пальцем
    // это не прежний `left`, а прежний `left` плюс сдвиг жеста: иначе
    // отпущенная полоска сперва прыгнула бы назад, к своим прежним датам, и
    // только оттуда поехала на новый день.
    const from = before.left + held.current;
    held.current = 0;
    heldWidth.current = 0;
    write(node.current, 0, 0);

    const dx = from - left;
    if (dx === 0) return;
    // Лента сменила масштаб или раздвинула окно — полоска не переезжала, это
    // у ленты другие координаты (см. `Scale.key`).
    if (before.scaleKey !== scaleKey) return;

    settling.current?.cancel();
    settling.current = slide(node.current, dx);
  }, [left, scaleKey]);

  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      settling.current?.cancel();
    },
    [],
  );

  const ref = useCallback<RefCallback<HTMLElement>>((element) => {
    node.current = element;
  }, []);

  const hold = useCallback((dx: number, dw = 0) => {
    holding.current = true;
    held.current = dx;
    heldWidth.current = dw;
    // Начатый переезд отменяется: анимация и палец спорили бы за один и тот же
    // transform, и полоска дрожала бы между ними.
    settling.current?.cancel();
    settling.current = null;
    write(node.current, dx, dw);
  }, []);

  // Сдвиг снимается не сразу, а следующим кадром. Если жест перенёс задачу,
  // до этого кадра успеет прийти рендер с новым `left`, и откуда полоске
  // ехать, решит он: снятый прямо сейчас сдвиг был бы рывком назад к прежним
  // датам и только потом переездом вперёд. Если же жест ничего не изменил —
  // вернуть полоску на место, кроме этого кадра, некому.
  const settle = useCallback(() => {
    if (held.current === 0 && heldWidth.current === 0) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      // Ноль значит, что слой разметки уже разобрался с этим сдвигом сам.
      const dx = held.current;
      const dw = heldWidth.current;
      if (dx === 0 && dw === 0) return;
      held.current = 0;
      heldWidth.current = 0;
      write(node.current, 0, 0);
      if (dx === 0) return;
      settling.current?.cancel();
      settling.current = slide(node.current, dx);
    });
  }, []);

  const release = useCallback(
    (pending = false) => {
      holding.current = false;
      // Перенос ещё решается: полоска остаётся там, куда её бросили, пока не
      // придёт ответ. Иначе она успевала бы вернуться на место ещё до вопроса
      // о причине — и движение назад читалось бы как «не получилось» там, где
      // не решено ещё ничего.
      if (pending) return;
      settle();
    },
    [settle],
  );

  // Один объект на всё время жизни: его берут в зависимости эффекты жестов
  // (см. `cancel` в useDragDates), и новый объект на каждую отрисовку
  // переподписывал бы слушатель Esc на каждом кадре перетаскивания.
  return useMemo(() => ({ ref, hold, release, settle }), [ref, hold, release, settle]);
}

/** Сдвиг полоски по горизонтали и прибавка к ширине. Пишутся свойствами, чтобы
    не спорить с наведением: подъём под курсором — слагаемое того же transform. */
function write(node: HTMLElement | null, dx: number, dw: number) {
  node?.style.setProperty("--bar-dx", `${dx}px`);
  node?.style.setProperty("--bar-dw", `${dw}px`);
}

/**
 * Переезд полоски от прежнего места к нынешнему.
 *
 * Кадры пишут `transform` целиком, а не через `--bar-dx`: непользовательское
 * свойство браузер интерполирует на главном потоке, а готовый `translate3d` он
 * умеет отдать слою композиции.
 */
function slide(node: HTMLElement | null, dx: number): Animation | null {
  // Человек попросил меньше движения — полоска просто встаёт на новое место.
  // Общее правило из styles.css сюда не достаёт: оно гасит переходы CSS, а
  // это анимация, заведённая из кода.
  if (prefersReducedMotion()) return null;
  // `animate` может не быть — в jsdom его нет. Анимация здесь улучшение, а не
  // условие: без неё полоска встаёт на место мгновенно и не врёт при этом.
  if (!node?.animate) return null;
  return node.animate(
    [{ transform: `translate3d(${dx}px, 0, 0)` }, { transform: "translate3d(0px, 0, 0)" }],
    { duration: MOTION_MS, easing: "ease" },
  );
}
