import type { Dependency, Task } from "../api/projects";
import { overlapDays } from "../project/DependencyNudge";
import { ROW_HEIGHT } from "./scale";
import type { Scale } from "./timescale";

/**
 * Слой стрелок между связанными задачами.
 *
 * Связи по спецификации — картинка, а не правило расчёта: даты по ним не
 * пересчитываются. Поэтому слой ничего не знает о домене и только соединяет
 * конец одной полоски с началом другой.
 *
 * Координаты берутся из шкалы и из порядка строк, а не измеряются у DOM.
 * Причина не в удобстве: полоски стоят там, куда их поставила та же шкала, и
 * измерять то, что мы сами и вычислили, значит получить второй источник правды,
 * который расходится с первым при каждой перерисовке — ровно то, из-за чего
 * стрелки уезжают. Высота строки в CSS задаётся отсюда же (см. ROW_HEIGHT),
 * так что расходиться нечему.
 */

/** Отступ, на который стрелка отходит от полоски, прежде чем повернуть. */
const ELBOW = 8;

/**
 * Радиус скругления поворота.
 *
 * Прямой угол на линии в полтора пикселя читается как ступенька и спорит с
 * округлыми полосками; дуга ведёт глаз по маршруту, не меняя сам маршрут.
 * На коротких звеньях радиус ужимается (см. roundedPath), так что цифра здесь —
 * потолок, а не обещание.
 */
const CORNER = 6;

/**
 * Признаки связи одной строкой.
 *
 * Нарушение идёт первым и в цвете побеждает: критический путь — это «здесь
 * держится срок», а нарушенная связь — «здесь уже сломано», и второе важнее.
 * Стиль критического пути при этом действует только при включённом слое (см.
 * `.gantt.show-critical`), так что на выключенном классы просто ничего не
 * значат.
 */
function classOf(violated: boolean, critical: boolean): string | undefined {
  const names = [violated && "is-violated", critical && "is-critical"].filter(Boolean);
  return names.length > 0 ? names.join(" ") : undefined;
}

export function Arrows({
  scale,
  tasks,
  dependencies,
  rowOf,
  rows,
}: {
  scale: Scale;
  tasks: Task[];
  dependencies: Dependency[];
  /** Номер строки задачи в ленте, считая строки категорий. */
  rowOf: Map<string, number>;
  /** Сколько всего строк в ленте. */
  rows: number;
}) {
  const byId = new Map(tasks.map((task) => [task.id, task]));

  const lines = dependencies
    .map((link) => {
      const from = byId.get(link.from_task_id);
      const to = byId.get(link.to_task_id);
      const fromRow = rowOf.get(link.from_task_id);
      const toRow = rowOf.get(link.to_task_id);
      // Связь переживает задачу ровно на один ответ сервера — задачу могли
      // удалить в соседней вкладке. Стрелка в пустоту уходит в NaN и уносит с
      // собой весь слой, поэтому такая связь просто не рисуется.
      if (!from || !to || fromRow === undefined || toRow === undefined) return null;

      const startX = scale.xOf(from.start_date) + scale.widthOf(from.start_date, from.end_date);
      const startY = fromRow * ROW_HEIGHT + ROW_HEIGHT / 2;
      const endX = scale.xOf(to.start_date);
      const endY = toRow * ROW_HEIGHT + ROW_HEIGHT / 2;

      // Линия не доходит до полоски на размер наконечника: остриё, лежащее
      // поверх линии, рисовало бы утолщение вместо стрелки.
      const shape = elbow(startX, startY, endX - 4, endY);

      return {
        key: `${link.from_task_id}-${link.to_task_id}`,
        d: roundedPath(shape),
        head: `M${endX - 6} ${endY - 4} L${endX} ${endY} L${endX - 6} ${endY + 4} Z`,
        // Место для знака нарушения — середина среднего звена ломаной, а не
        // повторно вычисленная по тем же условиям точка: второе такое же
        // вычисление разошлось бы с самой ломаной при первой её правке.
        warn: middleOf(shape),
        // Нарушенная связь: приёмник начат, пока источник ещё не кончился.
        // Правилом из предложения о сдвиге, а не своим сравнением: знак на
        // стрелке, кнопка под лентой и пометка в карточке обязаны загораться
        // от одного и того же (см. overlapDays — включительный конец там).
        violated: overlapDays(from, to) > 0,
        // Звено критического пути: обе задачи без запаса. Признак связи, а не
        // задачи: критическими бывают и две несвязанные цепочки, и стрелка
        // между ними принадлежала бы обеим, не будучи звеном ни одной.
        critical: from.critical && to.critical,
      };
    })
    .filter((line) => line !== null);

  return (
    // Скрыто от чтения с экрана: связь — это оформление, а не сведения. Их
    // место в карточке задачи, списком, а не в виде картинки, которую нечем
    // прочесть.
    <svg
      className="arrows"
      width={scale.width}
      height={rows * ROW_HEIGHT}
      aria-hidden="true"
      focusable="false"
    >
      {lines.map((line) => (
        <g
          key={line.key}
          className={classOf(line.violated, line.critical)}
        >
          <path
            d={line.d}
            className={["arrows__line", classOf(line.violated, line.critical)]
              .filter(Boolean)
              .join(" ")}
          />
          {/* Наконечник — сплошной треугольник остриём в начало полоски:
              линия без него не говорит, кто кого ждёт. Входит всегда
              горизонтально слева — ломаная кончается этим же направлением. */}
          <path className="arrows__head" d={line.head} />
          {/* Знак на нарушенной связи. Красного пунктира мало: на ленте из
              полусотни строк цвет линии толщиной в два пикселя замечают не
              сразу, а кружок виден и на беглом взгляде. */}
          {line.violated && (
            <>
              <circle className="arrows__warn" cx={line.warn[0]} cy={line.warn[1]} r={7} />
              <text
                className="arrows__warn-text"
                x={line.warn[0]}
                y={line.warn[1]}
                textAnchor="middle"
                dominantBaseline="central"
              >
                !
              </text>
            </>
          )}
        </g>
      ))}
    </svg>
  );
}

/**
 * Ломаная от конца одной полоски к началу другой.
 *
 * Прямая линия наискось пересекала бы чужие полоски и читалась бы хуже угла:
 * на диаграмме, где всё стоит по сетке, диагональ выглядит случайной.
 */
function elbow(startX: number, startY: number, endX: number, endY: number): number[][] {
  const points: number[][] = [[startX, startY]];

  if (endX >= startX + ELBOW * 2) {
    // Есть куда повернуть: выходим вправо, идём вниз, входим слева.
    points.push([startX + ELBOW, startY], [startX + ELBOW, endY]);
  } else {
    // Задача-приёмник начинается раньше, чем кончается источник: обходим её
    // по промежутку между строками, иначе линия шла бы поверх обеих полосок.
    const between = (startY + endY) / 2;
    points.push(
      [startX + ELBOW, startY],
      [startX + ELBOW, between],
      [endX - ELBOW, between],
      [endX - ELBOW, endY],
    );
  }

  points.push([endX, endY]);
  return points;
}

/**
 * Путь по точкам ломаной со скруглёнными поворотами.
 *
 * Ломаная остаётся источником правды о маршруте (по ней же считается место
 * знака нарушения — см. middleOf): дуги только срезают углы, не двигая звенья.
 * Радиус на каждом повороте ужимается до того, что звено может отдать: целиком,
 * если другой конец звена — конец пути, и до половины, если там сосед-поворот,
 * иначе две дуги съели бы звено с двух сторон и линия пошла бы вспять.
 * Нулевое звено (связь в той же строке) даёт нулевой радиус — поворот
 * вырождается в прямую, а не в деление на ноль.
 */
function roundedPath(points: number[][]): string {
  const parts = [`M${points[0][0]} ${points[0][1]}`];

  for (let i = 1; i < points.length - 1; i += 1) {
    const [prevX, prevY] = points[i - 1];
    const [cornerX, cornerY] = points[i];
    const [nextX, nextY] = points[i + 1];
    const inLen = Math.hypot(cornerX - prevX, cornerY - prevY);
    const outLen = Math.hypot(nextX - cornerX, nextY - cornerY);
    const r = Math.min(
      CORNER,
      i === 1 ? inLen : inLen / 2,
      i === points.length - 2 ? outLen : outLen / 2,
    );

    if (r < 0.5) {
      // Дуга мельче полупикселя не видна, а рисовать её — значит делить на
      // длину нулевого звена.
      parts.push(`L${cornerX} ${cornerY}`);
      continue;
    }

    const inX = cornerX - ((cornerX - prevX) / inLen) * r;
    const inY = cornerY - ((cornerY - prevY) / inLen) * r;
    const outX = cornerX + ((nextX - cornerX) / outLen) * r;
    const outY = cornerY + ((nextY - cornerY) / outLen) * r;
    parts.push(`L${inX} ${inY}`, `Q${cornerX} ${cornerY} ${outX} ${outY}`);
  }

  const [endX, endY] = points[points.length - 1];
  parts.push(`L${endX} ${endY}`);
  return parts.join(" ");
}

/**
 * Середина среднего звена ломаной.
 *
 * У короткой ломаной звеньев три, у обходной — пять; среднее в обоих случаях
 * то самое, которое идёт между строками и ни одну полоску не задевает. Знак,
 * поставленный на него, не ложится ни на источник, ни на приёмник.
 */
function middleOf(points: number[][]): [number, number] {
  const from = points[Math.floor((points.length - 2) / 2)];
  const to = points[Math.floor((points.length - 2) / 2) + 1];
  return [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
}
