import type { Dependency, Task } from "../api/projects";
import { overlapDays } from "../project/DependencyNudge";
import { ROW_HEIGHT } from "./scale";
import type { Scale } from "./timescale";

/**
 * The layer of arrows between linked tasks.
 *
 * By the specification links are a picture, not a calculation rule: dates are not
 * recomputed along them. So the layer knows nothing about the domain and merely
 * joins the end of one bar to the start of another.
 *
 * The coordinates are taken from the scale and from the row order rather than
 * measured off the DOM. The reason is not convenience: the bars stand where that
 * same scale put them, and measuring what we computed ourselves means getting a
 * second source of truth that diverges from the first on every repaint — exactly
 * what makes arrows drift. The row height in CSS is set from here too (see
 * ROW_HEIGHT), so there is nothing to diverge.
 */

/** The offset by which an arrow steps away from a bar before turning. */
const ELBOW = 8;

/**
 * The corner rounding radius.
 *
 * A right angle on a line a pixel and a half thick reads as a step and argues
 * with the rounded bars; an arc leads the eye along the route without changing
 * the route itself. On short segments the radius is squeezed (see roundedPath),
 * so the figure here is a ceiling, not a promise.
 */
const CORNER = 6;

/**
 * A link's flags in one line.
 *
 * The violation comes first and wins in colour: the critical path is "this is
 * what holds the date", while a violated link is "this is already broken", and
 * the second matters more. The critical-path style, at that, only applies when
 * the layer is on (see `.gantt.show-critical`), so with it off the classes simply
 * mean nothing.
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
  /** The task's row number in the strip, counting the category rows. */
  rowOf: Map<string, number>;
  /** How many rows there are in the strip in total. */
  rows: number;
}) {
  const byId = new Map(tasks.map((task) => [task.id, task]));

  const lines = dependencies
    .map((link) => {
      const from = byId.get(link.from_task_id);
      const to = byId.get(link.to_task_id);
      const fromRow = rowOf.get(link.from_task_id);
      const toRow = rowOf.get(link.to_task_id);
      // A link outlives a task by exactly one server answer — the task may have
      // been deleted in another tab. An arrow into nothing goes to NaN and takes
      // the whole layer with it, so such a link is simply not drawn.
      if (!from || !to || fromRow === undefined || toRow === undefined) return null;

      const startX = scale.xOf(from.start_date) + scale.widthOf(from.start_date, from.end_date);
      const startY = fromRow * ROW_HEIGHT + ROW_HEIGHT / 2;
      const endX = scale.xOf(to.start_date);
      const endY = toRow * ROW_HEIGHT + ROW_HEIGHT / 2;

      // The line stops short of the bar by the arrowhead's size: a head lying on
      // top of the line would draw a thickening instead of an arrow.
      const shape = elbow(startX, startY, endX - 4, endY);

      return {
        key: `${link.from_task_id}-${link.to_task_id}`,
        d: roundedPath(shape),
        head: `M${endX - 6} ${endY - 4} L${endX} ${endY} L${endX - 6} ${endY + 4} Z`,
        // The place for the violation sign is the middle of the polyline's middle
        // segment, rather than a point recomputed from the same conditions: a
        // second such computation would diverge from the polyline itself on its
        // first edit.
        warn: middleOf(shape),
        // A violated link: the receiver has started while the source has not
        // ended. By the rule from the shift nudge rather than by a comparison of
        // its own: the sign on the arrow, the button under the strip and the
        // marker in the card must all light up from the same thing (see
        // overlapDays — the end is inclusive there).
        violated: overlapDays(from, to) > 0,
        // A critical-path segment: both tasks have no slack. A property of the
        // link rather than of a task: two unlinked chains can be critical too, and
        // an arrow between them would belong to both while being a segment of
        // neither.
        critical: from.critical && to.critical,
      };
    })
    .filter((line) => line !== null);

  return (
    // Hidden from screen readers: a link is decoration, not information. Its place
    // is in the task's card, as a list, rather than as a picture there is nothing
    // to read it with.
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
          {/* The arrowhead is a solid triangle pointing at the bar's start:
              without it the line does not say who is waiting for whom. It always
              enters horizontally from the left — the polyline ends in that same direction. */}
          <path className="arrows__head" d={line.head} />
          {/* The sign on a violated link. A red dashed line is not enough: on a
              strip of fifty rows the colour of a two-pixel line is not noticed at
              once, while a circle is visible even at a glance. */}
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
 * A polyline from one bar's end to another's start.
 *
 * A straight diagonal line would cross other bars and read worse than a corner:
 * on a chart where everything stands on a grid, a diagonal looks accidental.
 */
function elbow(startX: number, startY: number, endX: number, endY: number): number[][] {
  const points: number[][] = [[startX, startY]];

  if (endX >= startX + ELBOW * 2) {
    // There is room to turn: we go out to the right, down, and in from the left.
    points.push([startX + ELBOW, startY], [startX + ELBOW, endY]);
  } else {
    // The receiving task starts earlier than the source ends: we go around it
    // through the gap between the rows, otherwise the line would run over both bars.
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
 * A path along the polyline's points with rounded corners.
 *
 * The polyline stays the source of truth about the route (the violation sign's
 * place is computed from it too — see middleOf): the arcs only cut the corners
 * without moving the segments. At every corner the radius is squeezed down to
 * what the segment can give: the whole of it if the segment's other end is the
 * path's end, and half if there is a neighbouring corner there, otherwise two
 * arcs would eat the segment from both sides and the line would run backwards. A
 * zero-length segment (a link within the same row) gives a zero radius — the
 * corner degenerates into a straight line rather than into a division by zero.
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
      // An arc smaller than half a pixel is invisible, and drawing it means
      // dividing by a zero segment's length.
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
 * The middle of the polyline's middle segment.
 *
 * A short polyline has three segments, a detouring one five; the middle one in
 * both cases is the one that runs between rows and touches no bar. A sign placed
 * on it lies neither on the source nor on the receiver.
 */
function middleOf(points: number[][]): [number, number] {
  const from = points[Math.floor((points.length - 2) / 2)];
  const to = points[Math.floor((points.length - 2) / 2) + 1];
  return [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
}
