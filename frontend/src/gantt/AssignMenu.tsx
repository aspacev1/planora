import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { Task } from "../api/projects";
import { Avatar } from "../components/Avatar";
import { useEscape } from "../components/useEscape";
import { useLocale } from "../i18n/LocaleProvider";
import { patchTask } from "../project/optimistic";
import { useProjectMutation } from "../project/useProjectMutation";

/**
 * A task's assignees right from the strip's row.
 *
 * A person could only be assigned in the task's card — that is, by opening it, finding
 * the assignees block and closing it again. Work, though, is handed out in batches while
 * looking at the whole plan at once: "these three to Nigar, this week to Alexey". Hence
 * the button on the row: assignment is the only action done not task by task but by list.
 *
 * The panel stands by window coordinates and is rendered at the end of the document
 * rather than inside the row. Both parts matter, and the second is not a consequence of
 * the first: the strip's pinned column is positioned and holds its own layer (`sticky`
 * with a z-index), and a layer contains everything inside it — including `position:
 * fixed`. A panel left in the row would go under the neighbouring rows, however large a
 * z-index it was given. The same argument as with the hover card (see BarTip) — with the
 * difference that there the node is one for the whole strip and lives next to it, while
 * here the panel belongs to its own row and is carried out through a portal.
 */

/** How many avatars fit on the button before the rest fold into a "+N". */
const SHOWN_AVATARS = 3;

/** The panel's measure. Needed before the render: it decides whether the panel opens downwards or upwards. */
const PANEL_WIDTH = 224;
const PANEL_HEIGHT = 268;
/** The gap between the button and the panel — and the minimum offset from the window's edge. */
const GAP = 6;

type Point = { left: number; top: number };

/** The panel's place: under the button, and above it near the screen's bottom edge. */
function placeBelow(rect: DOMRect): Point {
  const left = Math.max(
    GAP,
    Math.min(rect.left, (window.innerWidth || PANEL_WIDTH) - PANEL_WIDTH - GAP),
  );
  const below = rect.bottom + GAP;
  const fits = below + PANEL_HEIGHT <= (window.innerHeight || 0);
  return { left, top: fits ? below : Math.max(GAP, rect.top - GAP - PANEL_HEIGHT) };
}

export function AssignMenu({
  projectId,
  task,
  roster,
  describedBy,
}: {
  projectId: string;
  task: Task;
  /** The organization's roster: names by id. */
  roster: ReadonlyMap<string, string>;
  /**
   * The node with the task's name in the same row.
   *
   * The button's name is "Assignees", without the task's name, while the task itself is
   * named by the description. The difference is not cosmetic: with the name inside its
   * caption the button on the strip becomes a second control whose accessible name
   * contains a task's name — and "find task X's button" stops meaning one definite
   * place. The description, though, is read after the name and says exactly what is
   * needed: "Assignees, button, Logo".
   */
  describedBy?: string;
}) {
  const { t } = useLocale();
  const { apply } = useProjectMutation(projectId);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // A point rather than "open/closed": the panel's place is computed once, at the moment
  // of opening — the panel does not travel with the row and goes out on the first movement.
  const [at, setAt] = useState<Point | null>(null);
  const open = at !== null;

  useEscape(() => setAt(null), open);

  useEffect(() => {
    if (!open) return;
    const close = () => setAt(null);
    function onPointerDown(event: globalThis.PointerEvent) {
      const target = event.target as Node;
      const inside =
        root.current?.contains(target) === true || panel.current?.contains(target) === true;
      if (!inside) close();
    }
    document.addEventListener("pointerdown", onPointerDown);
    // Capture rather than bubbling: what scrolls is the strip, not the window, and its
    // event otherwise never reaches the window. The panel closes at that rather than
    // following along: it is open for a second, and there is no point chasing a departing
    // button with it.
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const toggle = (userId: string) => {
    const assigned = task.assignee_ids.includes(userId);
    void apply(
      {
        type: assigned ? "unassign_user" : "assign_user",
        task_id: task.id,
        user_id: userId,
      },
      (state) =>
        patchTask(state, task.id, {
          assignee_ids: assigned
            ? task.assignee_ids.filter((id) => id !== userId)
            : [...task.assignee_ids, userId],
        }),
      // The refusal stays silent: the guess has already been rolled back inside `apply`,
      // and the avatar returned to the row on its own. A second explanation here would
      // read as a breakage where the person can already see the assignment did not hold.
    ).catch(() => {});
  };

  // The names in the order the server sent them: the organization's roster is read as one
  // and the same list both in the card and here.
  const members = [...roster].map(([id, name]) => ({ id, name }));
  const assigned = task.assignee_ids
    .map((id) => ({ id, name: roster.get(id) }))
    .filter((member): member is { id: string; name: string } => member.name !== undefined);
  const label =
    assigned.length === 0
      ? t("gantt.assign.empty")
      : t("gantt.assign.some", { names: assigned.map((member) => member.name).join(", ") });

  return (
    <span className="gantt__assign" ref={root}>
      <button
        ref={button}
        type="button"
        className={`gantt__assign-button${assigned.length === 0 ? " is-empty" : ""}`}
        aria-expanded={open}
        aria-label={t("gantt.assign.label")}
        aria-describedby={describedBy}
        title={label}
        onClick={() => {
          if (open) {
            setAt(null);
            return;
          }
          const rect = button.current?.getBoundingClientRect();
          if (rect) setAt(placeBelow(rect));
        }}
      >
        {assigned.length === 0 ? (
          <>
            <PeopleIcon />
            <span className="gantt__assign-empty">{t("gantt.assign.empty")}</span>
          </>
        ) : (
          <>
            {assigned.slice(0, SHOWN_AVATARS).map((member) => (
              <Avatar key={member.id} name={member.name} size={20} />
            ))}
            {assigned.length > SHOWN_AVATARS && (
              <span className="gantt__assign-more">+{assigned.length - SHOWN_AVATARS}</span>
            )}
          </>
        )}
      </button>

      {at &&
        createPortal(
          <div
            className="gantt__assign-pop"
            style={{ left: at.left, top: at.top, width: PANEL_WIDTH }}
            role="group"
            aria-label={t("gantt.assign.aria", { name: task.name })}
            data-testid={`assign-${task.id}`}
            // The panel is carried out of the row, and a click on it no longer counts as a
            // click inside `root` (see the listener above): without this marker choosing an
            // assignee would close the panel itself.
            ref={panel}
          >
            {members.map((member) => (
              // Each assignee is its own operation, as in the card: they are removed one at
              // a time and read in the history as separate events. The panel does not close
              // after a choice — two and three people are put on a task in a row.
              <button
                key={member.id}
                type="button"
                className="gantt__assign-item"
                aria-pressed={task.assignee_ids.includes(member.id)}
                onClick={() => toggle(member.id)}
              >
                <Avatar name={member.name} size={22} />
                {/* A person's name is content, not chrome. */}
                <span className="gantt__assign-name">{member.name}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </span>
  );
}

/**
 * The "people" sign — as a drawing rather than as a letter or an emoji.
 *
 * An emoji here is drawn as a coloured picture from the system's font and looks like a
 * sticker among the strip's thin lines; besides, on different systems these are different
 * pictures. A drawing takes the text's colour and changes along with it.
 */
export function PeopleIcon() {
  return (
    <svg className="glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="6" cy="5" r="2.4" />
      <path d="M1.6 13.2c0-2.3 2-3.8 4.4-3.8s4.4 1.5 4.4 3.8" />
      <circle cx="11.6" cy="5.6" r="1.9" />
      <path d="M11.6 9.6c2 0 3.4 1.3 3.4 3.3" />
    </svg>
  );
}
