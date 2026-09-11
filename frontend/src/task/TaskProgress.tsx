import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

import type { Task } from "../api/projects";
import { useLocale } from "../i18n/LocaleProvider";
import { baselineOf } from "../project/baseline";
import { useToday } from "../time/useToday";

/**
 * The progress module — above the fields, not a line among them.
 *
 * Marking progress is the only thing done in the card every day, and it is given the
 * main place and the main button: "Mark the day" adds a day's quota without asking
 * for a figure. The exact figure stays available by two paths — as a number (typed)
 * and as a bar (set "by eye" with a click or a drag).
 *
 * All three paths reduce to one and the same `set_progress` operation: the server has
 * no notion of "marked a day", it has a new readiness — and that is deliberate,
 * otherwise three ways of input would give three kinds of entry about one and the same
 * thing. The mark itself goes into the task's shared journal and is visible on the
 * "History" tab — there is deliberately no second list of marks of its own here.
 */

/** The daily quota: how many percent one day's work brings. */
function dayStep(durationDays: number): number {
  return Math.max(1, Math.round(100 / Math.max(1, durationDays)));
}

/**
 * Where readiness should be today by the plan, in percent.
 *
 * By the baseline plan if there is one, otherwise by the current dates: before the
 * plan is approved the "plan" is the task's dates themselves. The fraction is by the
 * calendar rather than by working days: the notch is a landmark for the eye rather
 * than a second computation of dates, and repeating the server's calendar here would
 * mean diverging from it one day.
 */
function expectedToday(task: Task, today: string): number {
  const baseline = baselineOf(task);
  const start = baseline?.start ?? task.start_date;
  const end = baseline?.end ?? task.end_date;
  if (today <= start) return 0;
  if (today >= end) return 100;
  const span = Date.parse(end) - Date.parse(start);
  return Math.round(((Date.parse(today) - Date.parse(start)) / span) * 100);
}

function clamp(pct: number): number {
  return Math.max(0, Math.min(100, Math.round(pct)));
}

export function TaskProgress({
  task,
  canWrite,
  timeZone,
  resetToken,
  meta,
  onCommit,
}: {
  task: Task;
  canWrite: boolean;
  /** The project's zone: its dates are computed in it too (see useToday). */
  timeZone?: string;
  /** Changes when the server refuses: the field must return to the truth. */
  resetToken: unknown;
  /**
   * The task's status and period — on one line with the percentage, as in the mockup.
   * They are drawn by the card: they do not belong to the progress module, but they
   * share a line with it, and splitting it between two components would mean aligning
   * two flexes under each other.
   */
  meta?: ReactNode;
  onCommit: (pct: number) => void;
}) {
  const { t } = useLocale();
  const pct = clamp(task.progress_pct);
  const step = dayStep(task.duration_days);
  // The plan notch stands at "how much should be done today", and "today" here is the
  // same as on the strip: in UTC the notch showed yesterday's quota at night, that is,
  // declared as a lag what is not yet due to be done.
  const expected = expectedToday(task, useToday(timeZone));

  // A draft for the duration of a drag: the bar follows the cursor while one operation
  // leaves — on release. Sending on movement would mean writing a dozen entries into
  // the history about one gesture.
  const [dragPct, setDragPct] = useState<number | null>(null);

  // "The day is marked" lives until the card is closed: the disabled button guards
  // against a double tap right now rather than keeping a calendar record — the record
  // is visible in the journal, on the "History" tab.
  //
  // The mark is set before the server's answer — as everything in the card is — and on
  // a refusal it must return to the truth together with the fields: the progress was
  // not written, so the day is not marked, and the main daily button has no right to
  // stay dark. There is one dependency, `resetToken`: a success changes `pct`, but
  // darkening the button for the whole visit is exactly its job.
  const [markedDay, setMarkedDay] = useState(false);
  useEffect(() => setMarkedDay(false), [resetToken]);

  // The number is the same field as before: a draft, a submission on blur or on Enter,
  // a return to the truth on a server refusal (see fields.tsx about resetToken). Not on
  // every key: typing "75" would send "7" first, and one input would leave two entries
  // in the task's history.
  const [draft, setDraft] = useState(String(pct));
  useEffect(() => setDraft(String(pct)), [pct, resetToken]);
  const commitDraft = () => {
    // An empty field is the middle of typing, not a value: it returns to the truth.
    if (draft === "") {
      setDraft(String(pct));
      return;
    }
    // The bounds are deliberately not checked here: they are checked by the server, and
    // a refusal will return the field to the truth, explaining in words.
    if (Number(draft) !== pct) onCommit(Number(draft));
  };

  const barRef = useRef<HTMLDivElement | null>(null);
  const shown = dragPct ?? pct;

  const pctAt = (clientX: number): number | null => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    return clamp(((clientX - rect.left) / rect.width) * 100);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!canWrite) return;
    // The capture holds the gesture even if the cursor leaves the bar: a release outside
    // it is an ordinary end to a drag, not a cancellation.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const next = pctAt(event.clientX);
    if (next !== null) setDragPct(next);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragPct === null) return;
    const next = pctAt(event.clientX);
    if (next !== null) setDragPct(next);
  };

  const onPointerUp = () => {
    if (dragPct === null) return;
    if (dragPct !== pct) onCommit(dragPct);
    setDragPct(null);
  };

  return (
    <div className="panel__progress">
      {/* The "status | period | percentage" line — as in the mockup. The percentage
          stays a field: the bar is used to set it "by eye", while an exact figure is entered in figures. */}
      <div className="panel__meta">
        {meta}
        <span className="panel__progress-pct">
          <input
            id="panel-progress"
            name="panel-progress"
            type="number"
            min={0}
            max={100}
            value={draft}
            disabled={!canWrite}
            aria-label={t("task.panel.progress")}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
          <span aria-hidden="true">%</span>
        </span>
        <span className="panel__progress-plan">
          {t("task.panel.plan_expected", { pct: expected })}
        </span>
      </div>

      {/* The bar and the record button on one line, as in the mockup: the bar takes the
          width, the button stands to its right. */}
      <div className="panel__progress-row">
        {/* The bar is a control for the mouse and the finger; for reading and the
            keyboard there is the number above. role="img" with a caption — as on the
            previous bar: the fraction is audible too, and as a second focusable slider
            it would duplicate the number field. */}
        <div
          ref={barRef}
          className={canWrite ? "panel__progress-bar" : "panel__progress-bar is-static"}
          role="img"
          aria-label={t("task.panel.progress_aria", { pct: shown })}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <i style={{ width: `${shown}%` }} />
          {/* The plan notch: being ahead and being behind are visible without arithmetic. */}
          <b
            style={{ left: `${expected}%` }}
            title={t("task.panel.plan_expected", { pct: expected })}
            aria-hidden="true"
          />
        </div>

        {canWrite && (
          <button
            type="button"
            className={markedDay ? "panel__progress-day is-done" : "panel__progress-day"}
            disabled={markedDay || pct >= 100}
            onClick={() => {
              onCommit(Math.min(100, pct + step));
              setMarkedDay(true);
            }}
          >
            {markedDay
              ? t("task.panel.day_marked")
              : t("task.panel.mark_day", { pct: step })}
          </button>
        )}
      </div>
    </div>
  );
}
