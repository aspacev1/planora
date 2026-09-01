import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import type { RefObject } from "react";

/**
 * Ширина видимой части ленты — числом, а не стилем.
 *
 * Нужна ровно одному расчёту: окну относительного плана. У плана без дат нет
 * ничего, из чего вывести правый край шкалы, — окно строится от константы, и
 * без этой меры оно всегда одной и той же ширины, сколько бы места ни было на
 * экране (см. `weeksAcross` в relative.ts). Календарное окно выводится из дат
 * задач и в мере не нуждается.
 *
 * Меряется тем же приёмом, что и высота ленты (см. `useViewportFit`): слоем
 * разметки на каждую отрисовку плюс `resize`, без `ResizeObserver` — он стоил
 * бы полифила ради jsdom, а лента и так перерисовывается на всякую правку
 * плана и на всякую смену раскладки колонок.
 *
 * Возвращаемое число само вызывает перерисовку — потому и состояние, а не
 * ссылка: по нему строится шкала. Цикла из этого не выходит: ширина окна от
 * ширины шкалы не зависит — за краем видимой части лента прокручивается, а не
 * растягивает своего предка.
 */
export function useLaneWidth(box: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);

  const measure = useCallback(() => {
    const node = box.current;
    if (node === null) return;
    // `clientWidth`, а не ширина прямоугольника: полоса прокрутки места ленте
    // не даёт, и шкала, построенная вместе с ней, оказывалась бы на десяток
    // пикселей шире окна — с горизонтальной прокруткой у пустого проекта.
    const next = node.clientWidth;
    setWidth((current) => (current === next ? current : next));
  }, [box]);

  useLayoutEffect(measure);

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  return width;
}
