import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, FocusEvent, PointerEvent, ReactNode } from "react";

import type { Task } from "../api/projects";
import { modKeyLabel } from "../components/hotkeys";
import { formatShortDate } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * The card that shows under the cursor what is not written on the bar.
 *
 * A bar fits the name and the percentage, and the rest — the status, the dates,
 * the assignees — a person only learns by opening the task's card. Hovering
 * answers the same questions without taking them off the strip and without
 * opening anything.
 *
 * There is one node for the whole strip rather than one per bar: with a hundred
 * tasks that would be a hundred hidden nodes for nothing. Hence the context —
 * otherwise five new props would have to be dragged through the row, not one of
 * which the row needs.
 */

/** The point the card measures its place from: the cursor or the bar's edge. */
type Anchor = { x: number; y: number };

type BarTipApi = {
  /**
   * Hover. The card does not appear at once: `immediate` is needed where there
   * is nothing to wait for — when the focus moves from the keyboard.
   *
   * `keys` — whether to show the shortcuts line: it is about what a guest cannot do.
   */
  show: (task: Task, anchor: Anchor, keys: boolean, immediate?: boolean) => void;
  /** Move with the cursor — but only the card that is already assigned. */
  track: (anchor: Anchor) => void;
  hide: () => void;
  /** A press: the card goes out and is locked until the gesture ends. */
  press: () => void;
  /** A release: the lock comes off, but the card does not come back on its own. */
  release: () => void;
};

/**
 * The assigned card. `shown` separates the assigned one from the shown one:
 * while the delay has not run out the task and the point are already known,
 * while there is nothing on screen.
 */
type Pending = { task: Task; anchor: Anchor; keys: boolean; shown: boolean };

const BarTipContext = createContext<BarTipApi | null>(null);

/** The card's offset from the cursor — as in the mockup. */
export const GAP = 14;
/** The card's width. The same value stands in the styles: it will not grow wider than the name. */
const TIP_WIDTH = 235;
/**
 * The height before the first measurement — for one layout frame, no more.
 *
 * Every card's real height is its own: a task's name wraps onto a second line,
 * and by this number a card with a long name at the bottom edge of the screen
 * would be cut off rather than flipped. The live node is measured right after
 * the render (see `BarTip`), and the reserve here is taken generously: erring on
 * the large side only flips the card sooner, on the small side it would leave it
 * beyond the cut.
 */
const TIP_HEIGHT = 96;
/**
 * How long the cursor stands on a bar before the card appears.
 *
 * Without a delay a cursor drawn across the strip strikes a flash on every bar:
 * the card manages to appear and go out where nobody called it. System tooltips
 * hold a hover for the same amount — less reads as jitter, more as hesitation.
 */
export const SHOW_DELAY = 300;

/**
 * The card does not go beyond the screen's edge: at the edge it flips to the
 * other side, and if it does not fit flipped either, it is pinned to the edge.
 */
function placeTip({ x, y }: Anchor, height: number): CSSProperties {
  const left = x + GAP + TIP_WIDTH > window.innerWidth ? x - GAP - TIP_WIDTH : x + GAP;
  const top = y + GAP + height > window.innerHeight ? y - GAP - height : y + GAP;
  // The lower bound is computed from the measured height, so a card taller than
  // the window is pinned to the top edge rather than travelling beyond it:
  // `Math.max` stands on the outside and wins the argument between the two
  // pinnings in the top one's favour.
  return {
    left: Math.max(GAP, left),
    top: Math.max(GAP, Math.min(top, window.innerHeight - height - GAP)),
  };
}

export function BarTipProvider({
  names,
  formatDay,
  children,
}: {
  /**
   * Assignee names by id. They arrive as a prop from above and are never asked
   * for from here: the strip must not decide who to ask what — on a public page
   * the organization's roster is not handed out at all.
   */
  names?: ReadonlyMap<string, string>;
  /**
   * A day caption instead of a short date — for the relative view: the card must
   * speak the language of the scale behind it, "Day 8", not a real date, which
   * the plan does not have.
   */
  formatDay?: (iso: string) => string;
  children: ReactNode;
}) {
  const [tip, setTip] = useState<Pending | null>(null);
  // Whether a gesture is running. In a ref, not in state: the value is read in
  // the pointer handlers and does not affect the render.
  const pressed = useRef(false);
  // The deferred show. Also a ref: the countdown runs past the render, and it
  // has to be cancelled from every other handler.
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const api = useMemo<BarTipApi>(() => {
    const forget = () => {
      clearTimeout(timer.current);
      timer.current = undefined;
    };
    return {
      show: (task, anchor, keys, immediate = false) => {
        if (pressed.current) return;
        forget();
        setTip({ task, anchor, keys, shown: immediate });
        if (immediate) return;
        timer.current = setTimeout(() => {
          timer.current = undefined;
          setTip((current) => (current === null ? null : { ...current, shown: true }));
        }, SHOW_DELAY);
      },
      // Hovering shows, movement only repositions: otherwise the card would come
      // back right under the finger straight after a drag — and by that moment
      // the person is already aiming at the neighbouring day. While the delay
      // runs, movement repositions the card's future place: in that time the
      // cursor leaves the point at which it entered the bar.
      track: (anchor) => setTip((current) => (current === null ? null : { ...current, anchor })),
      hide: () => {
        forget();
        setTip(null);
      },
      press: () => {
        pressed.current = true;
        forget();
        setTip(null);
      },
      release: () => {
        pressed.current = false;
      },
    };
  }, []);

  // The countdown must not outlive the strip: a timer that fires after unmount
  // sets state on a node that is not there.
  useEffect(() => () => clearTimeout(timer.current), []);

  /**
   * Scrolling takes the bar out from under the card.
   *
   * The card stands by window coordinates and does not travel with the strip
   * itself — left hanging, it would attribute one task's work to another that
   * happened to be underneath. We listen in the capture phase: a scroll event
   * does not bubble, and both the strip and the page under it scroll here.
   */
  const armed = tip !== null;
  useEffect(() => {
    if (!armed) return;
    const dismiss = () => api.hide();
    window.addEventListener("scroll", dismiss, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", dismiss, { capture: true });
  }, [api, armed]);

  return (
    <BarTipContext.Provider value={api}>
      {children}
      {tip !== null && tip.shown && (
        <BarTip task={tip.task} anchor={tip.anchor} keys={tip.keys} names={names} formatDay={formatDay} />
      )}
    </BarTipContext.Provider>
  );
}

/**
 * The bar's handlers.
 *
 * Returned as a ready set rather than one at a time: the bar already carries the
 * drag, and there is no need to work out which event belongs to whom in the
 * markup. Outside the provider they all stay silent — the chart is also drawn
 * where there is no card.
 *
 * `keys` — the right to move the bar: the shortcuts line is shown only to
 * someone who has something to do with them. To a reader and a guest it would
 * promise work the server will reject.
 */
export function useBarTip(task: Task, keys = false) {
  const api = useContext(BarTipContext);
  const cursor = useCallback(
    (event: PointerEvent<HTMLElement>): Anchor => ({ x: event.clientX, y: event.clientY }),
    [],
  );

  return useMemo(
    () => ({
      onPointerEnter: (event: PointerEvent<HTMLElement>) => api?.show(task, cursor(event), keys),
      onPointerMove: (event: PointerEvent<HTMLElement>) => api?.track(cursor(event)),
      onPointerLeave: () => api?.hide(),
      onPointerDown: () => api?.press(),
      onPointerUp: () => api?.release(),
      onPointerCancel: () => api?.release(),
      // From the keyboard there is no cursor, and the card stands right by the
      // bar: a place under the cursor would mean a point nobody sees on screen.
      // And without a delay: there is no reason to wait for it where the bar was
      // chosen rather than brushed on the way to a neighbouring one.
      onFocus: (event: FocusEvent<HTMLElement>) => {
        const box = event.currentTarget.getBoundingClientRect();
        api?.show(task, { x: box.left, y: box.bottom }, keys, true);
      },
      onBlur: () => api?.hide(),
    }),
    [api, cursor, keys, task],
  );
}

/**
 * The card itself.
 *
 * Hidden from screen readers: everything written in it is already named by the
 * bar in its `aria-label`, and a second voice on the same thing only makes
 * reading the strip longer.
 */
function BarTip({
  task,
  anchor,
  keys,
  names,
  formatDay,
}: {
  task: Task;
  anchor: Anchor;
  keys: boolean;
  names?: ReadonlyMap<string, string>;
  formatDay?: (iso: string) => string;
}) {
  const { t } = useLocale();
  const node = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(TIP_HEIGHT);

  /**
   * The card's real height — from the live node.
   *
   * We measure it in a layout effect: it runs after the render but before the
   * frame, and at the bottom edge the card appears already flipped rather than
   * repositioning itself before the person's eyes. The dependencies are the
   * text, not the point under the cursor: the card's width is constant, its
   * height changes only with the text, and measuring it anew on every cursor
   * movement would mean recomputing the page's layout just as many times. We do
   * not take a zero height: that is what the node reports while there is no
   * layout at all — the reserve is more honest then.
   *
   * The shortcuts line is in the dependencies for the same reason as the text:
   * it adds two lines to the card, and without a recount a card at the bottom
   * edge of the screen would cover its own bar with them.
   */
  useLayoutEffect(() => {
    const measured = node.current?.offsetHeight ?? 0;
    if (measured > 0) setHeight(measured);
  }, [task, names, keys, t]);

  // The short date form rather than the full one: the card is 235px wide, and
  // "12 August — 14 August" wraps onto a second line in its right column.
  const day = formatDay ?? ((iso: string) => formatShortDate(t, iso));
  const dates = `${day(task.start_date)} → ${day(task.end_date)}`;
  const status =
    task.status === "blocked"
      ? `⚠ ${t(`task.status.${task.status}`)}`
      : t(`task.status.${task.status}`);
  const people = assigneeText(task, t, names);

  return (
    <div
      ref={node}
      className="gantt__tip"
      style={placeTip(anchor, height)}
      data-testid="bar-tip"
      aria-hidden="true"
    >
      {/* The name is user content: it is not translated. */}
      <strong className="gantt__tip-name">{task.name}</strong>
      <div className="gantt__tip-grid">
        <span>{status}</span>
        <b>{dates}</b>
        {people !== null && <span>{people}</span>}
        {/* With no assignees the percentage stays in its own column: shifted
            left, it would read as a muted caption to emptiness. */}
        <b className={people === null ? "gantt__tip-alone" : undefined}>{task.progress_pct}%</b>
      </div>
      {/* The risk flag is the assignee's word, and the tooltip repeats it
          verbatim: "at risk — waiting for access" answers the question the bar
          was hovered for. For "done" the flag is already history. */}
      {task.status !== "done" && task.risk !== "green" && (
        <div className="gantt__tip-risk" data-risk={task.risk}>
          <b>{t("gantt.tip.risk", { risk: t(`task.risk.${task.risk}`) })}</b>
          {task.risk_note && ` — ${task.risk_note}`}
        </div>
      )}
      {/* The keyboard shortcuts live here rather than in a separate help page:
          the card already hangs over the very bar they apply to, and this is the
          only place where a person reads about a task without opening anything.
          Hidden from screen readers along with the whole card — someone reading
          from the screen is told the same by the bar's `aria-keyshortcuts`. */}
      {keys && <div className="gantt__tip-keys">{t("gantt.tip.keys", { mod: modKeyLabel() })}</div>}
    </div>
  );
}

/**
 * The assignees line: one is called by name, several become "the first and N more".
 *
 * A card this wide will not take an enumeration, and "and 2 more" answers the
 * question "is this one person's work" no worse than three names. No names at
 * all means no line: an empty space is more honest than a dash, which would read
 * as "nobody is assigned" where the roster was simply never asked for.
 */
function assigneeText(
  task: Task,
  t: (key: string, params?: Record<string, string | number>) => string,
  names?: ReadonlyMap<string, string>,
): string | null {
  if (names === undefined) return null;
  const known = task.assignee_ids
    .map((id) => names.get(id))
    .filter((name): name is string => name !== undefined);
  if (known.length === 0) return null;
  if (known.length === 1) return known[0];
  return t("gantt.tip.more", { name: known[0], count: known.length - 1 });
}
