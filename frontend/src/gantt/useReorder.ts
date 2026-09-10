import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";

import type { ProjectState } from "../api/projects";
import { reorderCategory, reorderTask } from "../project/optimistic";
import { useProjectMutation } from "../project/useProjectMutation";

/**
 * Перестановка строк перетаскиванием за левую колонку.
 *
 * Жестов два, и они разделены нарочно: полоску тащат по горизонтали и меняют
 * даты, строку тащат за ручку и меняют порядок. Одно движение — одно
 * последствие. Смешать их значило бы сбивать сроки каждому, кто попытался
 * переставить строку и промахнулся вниз на пиксель.
 *
 * Строк две породы, и тащат обе одинаково: задача меняет место внутри своего
 * этапа или переезжает в соседний, категория меняет место в списке этапов.
 * Один жест на обе, а не два похожих: ручка, ведущая себя по-разному на
 * заголовке и на строке под ним, — это две вещи, выглядящие как одна.
 *
 * Клиент шлёт только целевую позицию (и категорию — для задачи): раздвинуть
 * соседей и записать их сдвиги в журнал — дело сервера, и вторая реализация
 * того же расчёта здесь разошлась бы с ней на первом же переносе между
 * категориями.
 */

export type RowKind = "task" | "category";
export type DropTarget = { kind: RowKind; id: string; half: "top" | "bottom" };
/** Что сейчас в руке. */
export type DraggedRow = { kind: RowKind; id: string };

/** Верхняя половина строки или нижняя — от настоящих границ, а не от индекса. */
export function halfOf(row: Element, clientY: number): "top" | "bottom" {
  const box = row.getBoundingClientRect();
  return clientY < box.top + box.height / 2 ? "top" : "bottom";
}

/**
 * Строка под указателем — по координатам точки, а не по адресату события.
 *
 * Пальцем указатель после нажатия неявно захватывается ручкой, за которую
 * начали жест: до конца жеста все события достаются ей одной, и строка, над
 * которой ведут палец, о движении не узнаёт. Полагаться на то, кому пришло
 * событие, значит поддерживать перестановку только мышью — а `touch-action`
 * на ручке обещает обратное.
 */
function targetAt(clientX: number, clientY: number): DropTarget | null {
  // Метода нет у jsdom, а браузер вернёт `null` за краем окна: попадания может
  // не быть, и это не ошибка, а «палец не над строкой».
  const under = document.elementFromPoint?.(clientX, clientY) ?? null;
  const row = under?.closest<HTMLElement>("[data-drop-id]") ?? null;
  const id = row?.dataset.dropId;
  if (row === null || id === undefined) return null;
  return {
    kind: row.dataset.dropKind === "category" ? "category" : "task",
    id,
    half: halfOf(row, clientY),
  };
}

/** Место призрака — свойствами прямо в узел, мимо состояния React. */
function moveGhost(node: HTMLElement, at: { x: number; y: number }): void {
  node.style.setProperty("--drag-x", `${at.x}px`);
  node.style.setProperty("--drag-y", `${at.y}px`);
}

function byOrder<T extends { position: number; id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
}

/** Куда встанет задача, если её отпустить здесь. */
function placeForTask(
  state: ProjectState,
  taskId: string,
  target: DropTarget,
): { categoryId: string; position: number } | null {
  if (target.kind === "category") {
    // Бросок на заголовок — это «положи в эту категорию», а не выбор места
    // внутри неё: место выбирают, целясь между строками.
    return {
      categoryId: target.id,
      position: state.tasks.filter((row) => row.category_id === target.id && row.id !== taskId)
        .length,
    };
  }

  const over = state.tasks.find((row) => row.id === target.id);
  if (!over) return null;

  const siblings = byOrder(
    state.tasks.filter((row) => row.category_id === over.category_id && row.id !== taskId),
  );
  const index = siblings.findIndex((row) => row.id === over.id);
  if (index === -1) return null;

  return { categoryId: over.category_id, position: target.half === "top" ? index : index + 1 };
}

/**
 * Куда встанет категория, если её отпустить здесь.
 *
 * Номер считается среди остальных этапов, без самой переносимой: так же, как
 * у задачи, и по той же причине — строка, вынутая из списка, своих же соседей
 * не нумерует.
 */
function placeForCategory(
  state: ProjectState,
  categoryId: string,
  target: DropTarget,
): number | null {
  if (target.kind !== "category") return null;
  const others = byOrder(state.categories.filter((row) => row.id !== categoryId));
  const index = others.findIndex((row) => row.id === target.id);
  if (index === -1) return null;
  return target.half === "top" ? index : index + 1;
}

export function useReorder({
  projectId,
  state,
  canWrite,
}: {
  projectId: string;
  state: ProjectState;
  canWrite: boolean;
}) {
  const { apply } = useProjectMutation(projectId);
  const [dragged, setDragged] = useState<DraggedRow | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);

  // Призрак — копия переносимой строки под курсором. Место пишется прямо в
  // узел свойствами, мимо состояния React: точка меняется на каждом движении
  // руки, и перерисовывать ленту ради неё значило бы пересобирать сотню строк
  // по десять раз в секунду (тем же способом ведут полосу категории, см.
  // useDragCategory).
  const ghost = useRef<HTMLElement | null>(null);
  const point = useRef({ x: 0, y: 0 });

  /**
   * Узел призрака. Место пишется сразу при появлении: узла в момент нажатия
   * ещё нет, и без этого первый кадр жеста призрак стоял бы в углу окна и
   * прыгал бы оттуда под курсор на первом же движении.
   */
  const ghostRef = useCallback((element: HTMLElement | null) => {
    ghost.current = element;
    if (element !== null) moveGhost(element, point.current);
  }, []);

  // Точку жеста слушает окно, а не ручка и не строки: мышью события достаются
  // строке под курсором, пальцем — захватившей указатель ручке, и призрак,
  // подписанный на одно из двух, отставал бы ровно в другом случае.
  useEffect(() => {
    if (dragged === null) return;
    const follow = (event: globalThis.PointerEvent) => {
      point.current = { x: event.clientX, y: event.clientY };
      const node = ghost.current;
      if (node !== null) moveGhost(node, point.current);
      // Мышью цель сообщают сами строки (см. handleProps): над шапкой или
      // тулбаром сообщить некому, и линия вставки оставалась бы на строке,
      // с которой курсор давно ушёл, хотя бросок там уже ничего не делает.
      // Пальцем указатель захвачен ручкой, и событие всегда приходит из её
      // строки — этот случай ведёт `targetAt`, а не строки.
      const target = event.target instanceof Element ? event.target : null;
      if (target !== null && target.closest("[data-drop-id]") === null) setTarget(null);
    };
    window.addEventListener("pointermove", follow);
    return () => window.removeEventListener("pointermove", follow);
  }, [dragged]);

  // Отпустить кнопку можно и мимо строк — за краем ленты, над шапкой, вообще
  // вне окна. Без этого слушателя строка осталась бы «в руке» навсегда, и
  // следующее движение мыши переставляло бы её без всякого нажатия.
  useEffect(() => {
    if (dragged === null) return;
    const finish = () => {
      setDragged(null);
      setTarget(null);
    };
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [dragged]);

  const start = (row: DraggedRow, at: { x: number; y: number }) => {
    if (!canWrite) return;
    point.current = at;
    setDragged(row);
    setTarget(null);
  };

  /**
   * Строка под указателем → цель, которую можно принять.
   *
   * Задача целится между строками и в заголовки: и то, и другое — её место.
   * Категория целится только в заголовки, поэтому строка задачи означает свой
   * этап: попасть в узкую полоску заголовка, стоящего десятью строками выше,
   * иначе пришлось бы точно. Внутрь себя этап не встаёт — «где-то здесь» для
   * него значит «после этого этапа».
   */
  const aimAt = (raw: DropTarget | null): DropTarget | null => {
    if (raw === null || dragged === null) return null;

    if (dragged.kind === "task") {
      // Над самой собой линия вставки не рисуется: она обещала бы перемещение
      // туда, где строка и так стоит.
      return raw.kind === "task" && raw.id === dragged.id ? null : raw;
    }

    if (raw.kind === "task") {
      const task = state.tasks.find((row) => row.id === raw.id);
      if (task === undefined) return null;
      return task.category_id === dragged.id
        ? null
        : { kind: "category", id: task.category_id, half: "bottom" };
    }
    return raw.id === dragged.id ? null : raw;
  };

  /** `null` — палец увели мимо строк: линия вставки гаснет, бросок ничего не делает. */
  const over = (next: DropTarget | null) => {
    if (dragged === null) return;
    setTarget(aimAt(next));
  };

  const dropTask = (taskId: string, spot: DropTarget) => {
    const place = placeForTask(state, taskId, spot);
    if (place === null) return;

    // Строка, вернувшаяся на своё место, — не изменение: сравниваем не
    // индексы, а весь порядок после перестановки. Индексы сравнивать нельзя,
    // потому что одна и та же позиция считается по-разному в зависимости от
    // того, откуда пришла строка.
    const next = reorderTask(state, taskId, place.categoryId, place.position);
    const unchanged = next.tasks.every((row) => {
      const before = state.tasks.find((old) => old.id === row.id);
      return (
        before !== undefined &&
        before.position === row.position &&
        before.category_id === row.category_id
      );
    });
    if (unchanged) return;

    void apply(
      {
        type: "reorder_task",
        task_id: taskId,
        category_id: place.categoryId,
        position: place.position,
      },
      (current) => reorderTask(current, taskId, place.categoryId, place.position),
    ).catch(() => {
      // Откат уже сделан внутри `apply`: строка вернулась туда, откуда её
      // взяли, и это и есть ответ на отказ.
    });
  };

  const dropCategory = (categoryId: string, spot: DropTarget) => {
    const position = placeForCategory(state, categoryId, spot);
    if (position === null) return;

    // Тот же счёт «изменилось ли что-нибудь», что и у задачи, и по той же
    // причине: этап, брошенный под своего верхнего соседа, приезжает на свой
    // же номер, и записывать это в историю не за что.
    const next = reorderCategory(state, categoryId, position);
    const unchanged = next.categories.every((row) => {
      const before = state.categories.find((old) => old.id === row.id);
      return before !== undefined && before.position === row.position;
    });
    if (unchanged) return;

    void apply({ type: "reorder_category", category_id: categoryId, position }, (current) =>
      reorderCategory(current, categoryId, position),
    ).catch(() => {
      // Откат уже сделан внутри `apply`.
    });
  };

  const drop = () => {
    if (dragged === null) return;
    const row = dragged;
    const spot = target;
    setDragged(null);
    setTarget(null);
    if (spot === null) return;
    if (row.kind === "category") dropCategory(row.id, spot);
    else dropTask(row.id, spot);
  };

  /**
   * Что показывать в призраке: имя переносимой строки и цвет её этапа.
   *
   * Имя, а не вся строка целиком: под курсором нужно узнать, что именно в
   * руке, — даты и проценты в этот момент не спрашивают, а копия строки в
   * половину экрана закрывала бы собой то место, куда целятся.
   */
  const ghostRow = (() => {
    if (dragged === null) return null;
    if (dragged.kind === "category") {
      const category = state.categories.find((row) => row.id === dragged.id);
      return category === undefined
        ? null
        : { kind: dragged.kind, name: category.name, color: category.color };
    }
    const task = state.tasks.find((row) => row.id === dragged.id);
    if (task === undefined) return null;
    const category = state.categories.find((row) => row.id === task.category_id);
    return { kind: dragged.kind, name: task.name, color: category?.color };
  })();

  return {
    /** Показывать ли ручки перетаскивания. У гостя их нет вовсе. */
    enabled: canWrite,
    /** Идёт ли перестановка прямо сейчас. */
    active: dragged !== null,
    /** Что именно в руке: строка гаснет, а её имя едет за курсором. */
    dragging: dragged,
    /** Содержимое призрака под курсором. `null` — не тащат ничего. */
    ghost: ghostRow,
    ghostRef,

    start,
    over,
    drop,

    /**
     * Ручка строки. Ею жест не только начинают — ею его и ведут.
     *
     * Пальцем указатель захвачен ручкой (см. `targetAt`), и события до чужих
     * строк не доходят: цель броска ручка ищет сама, попаданием в точку. Мышью
     * события достаются строкам, и ведут жест их обработчики; здесь ручка
     * повторяет тот же расчёт для строки под курсором и потому останавливает
     * событие — иначе своя же строка, до которой оно всплывёт, стёрла бы
     * найденную цель как «бросок на самого себя».
     */
    handleProps(kind: RowKind, id: string) {
      return {
        onPointerDown(event: PointerEvent<HTMLElement>) {
          // Только основная кнопка — как у всякого жеста на ленте: правая
          // зовёт контекстное меню, и оно съедает отпускание, оставляя
          // призрак строки ехать за курсором без нажатия.
          if (event.button !== 0) return;
          // Без этого нажатие уводит фокус и начинает выделение текста вместо
          // перетаскивания.
          event.preventDefault();
          start({ kind, id }, { x: event.clientX, y: event.clientY });
        },
        onPointerMove(event: PointerEvent<HTMLElement>) {
          if (dragged === null) return;
          event.stopPropagation();
          over(targetAt(event.clientX, event.clientY));
        },
        onPointerUp(event: PointerEvent<HTMLElement>) {
          if (dragged === null) return;
          event.stopPropagation();
          drop();
        },
      };
    },

    /**
     * Класс строки на время жеста: та, что в руке, — погашена; та, над которой
     * курсор, — с линией вставки.
     *
     * Заголовок этапа отвечает на бросок двумя разными способами, и разница не
     * косметическая: задача в него кладётся (заливка на всю строку), а
     * категория встаёт до или после него (линия по краю). Один и тот же знак
     * на два разных исхода обещал бы не то, что произойдёт.
     */
    markFor(kind: RowKind, id: string): string {
      if (dragged !== null && dragged.kind === kind && dragged.id === id) return "is-dragged";
      if (target === null || target.kind !== kind || target.id !== id) return "";
      if (kind === "category" && dragged?.kind === "task") return "drop-into";
      return target.half === "top" ? "drop-before" : "drop-after";
    },
  };
}

export type Reorder = ReturnType<typeof useReorder>;
