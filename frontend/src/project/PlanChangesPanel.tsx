import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";

import { listPlanApprovals } from "../api/projects";
import type { ProjectState } from "../api/projects";
import { feedQueryKey, listProjectRevisions } from "../api/revisions";
import type { RevisionEntry } from "../api/revisions";
import { Switch } from "../components/Switch";
import { useEscape } from "../components/useEscape";
import { relativeDayLabel } from "../gantt/relative";
import { formatDate, formatShortDate } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";
import { useTimeZone } from "../time/useToday";
import { dayIn } from "../time/zone";
import { planChanges, removedTasks } from "./planChanges";
import type { PlanChange } from "./planChanges";

// The panel takes its layer and three tiers from the task card — the styles come
// from there too rather than being rewritten from scratch: two sliding columns
// in the same place must slide out identically, otherwise moving from the list
// into the card looks like moving into a different application.
import "../task/panel.css";
import "./planChanges.css";

/**
 * The operations that move dates — and only they.
 *
 * The same set that stands behind the "Dates" group in the history filter: the
 * reasons for shifts are looked for among them, because a reason is asked for
 * precisely for departing from the baseline plan, while a rename or a status
 * change neither requires nor has one.
 */
// A milestone is here too: it collapses the duration to a day, and the server
// asks for a reason for that just as it does for a stretch (see
// `_guard_shift_threshold`).
const DATE_OPS = ["move_task", "set_duration", "resize_task", "move_category", "set_milestone"];

type GroupKey = "shifts" | "durations" | "added" | "removed";

/**
 * The "what has changed since approval" side panel.
 *
 * A panel rather than a dialog with a backdrop: the list and the strip tell the
 * same thing in two languages — as lines and as ghost bars — and they need to be
 * read together. A dialog would cover the chart at the very moment the "show the
 * approved plan" toggle turns on the thing it is turned on for.
 *
 * Everything is computed from the project's state — it is already on screen. The
 * two requests the panel does make are lazy and only for what the state does not
 * have by definition: a version's snapshot knows the deleted tasks, the journal
 * knows the reasons for shifts. Either may be missing (a refusal, a role without
 * the right to the journal) — the panel then shows the same as it would without
 * them and stays silent: the divergence list is none the worse for it.
 */
export function PlanChangesPanel({
  projectId,
  state,
  canReapprove,
  baselineShown,
  onBaselineToggle,
  onOpenTask,
  onReapprove,
  onClose,
}: {
  projectId: string;
  state: ProjectState;
  /** The right to re-approve the plan — the owner, with a live connection. */
  canReapprove: boolean;
  /** Whether the strip shows the ghost of the approved plan. */
  baselineShown: boolean;
  onBaselineToggle: () => void;
  /** Open the task's card. The dialog closes at that: the card takes its place. */
  onOpenTask: (taskId: string) => void;
  /** Go to the re-approval confirmation — the same one as the header button's. */
  onReapprove: () => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [group, setGroup] = useState<GroupKey | "all">("all");
  const zone = useTimeZone(state.settings?.timezone);

  // The version chronicle — for the names of deleted tasks and the name of
  // whoever approved. The key is the same as the history feed's: it may already
  // have loaded it, and there is no point going a second time.
  const approvals = useQuery({
    queryKey: ["project", projectId, "plan-approvals"] as const,
    queryFn: () => listPlanApprovals(projectId),
    retry: false,
  });

  // The reasons for shifts. One page: a reason is needed for a task's last
  // departure from the plan, not for all of them, and it stands in the journal's
  // top entries.
  const feedFilters = { types: DATE_OPS };
  const feed = useQuery({
    queryKey: feedQueryKey(projectId, feedFilters),
    queryFn: () => listProjectRevisions(projectId, feedFilters),
    retry: false,
  });

  const changes = planChanges(state);
  const removed = removedTasks(state, approvals.data ?? []);
  const reasons = reasonsByTask(state, feed.data ?? []);

  const approvedBy = (approvals.data ?? []).find(
    (approval) => approval.version === state.plan_version,
  )?.approved_by;

  /** The date as the strip shows it: for a plan without a start — a project day. */
  const day = (iso: string) =>
    state.schedule_mode === "relative" ? relativeDayLabel(t, iso) : formatShortDate(t, iso);

  const groups: { key: GroupKey; rows: PlanChange[] }[] = [
    { key: "shifts", rows: changes.shifts },
    { key: "durations", rows: changes.durations },
    { key: "added", rows: changes.added },
    { key: "removed", rows: removed },
  ];
  const filled = groups.filter((row) => row.rows.length > 0);
  const shown = filled.filter((row) => group === "all" || group === row.key);
  // The sum of the groups rather than a separate count: the groups divide the
  // tasks between themselves, and this number must agree with the count on the
  // chip in the header — otherwise the list would contradict the marker that
  // opened it.
  const total = filled.reduce((sum, row) => sum + row.rows.length, 0);

  // Esc through the shared layer stack: the panel almost always pops up on top
  // of the strip, and the shift dialog or the re-approval question may open on
  // top of it, and an own listener on the document would close them all at once.
  useEscape(onClose);

  const title = t("plan.changes_title", { version: state.plan_version });

  return (
    // A panel, not a dialog: it deliberately has no backdrop — the strip on the
    // left stays both visible and workable, and the ghosts of the approved plan
    // on it are read together with the list.
    <aside className="panel plan-changes" role="complementary" aria-label={title}>
      {/* The header is pinned: the heading, the summary and the ghost switch do
          not travel with the list's scroll — the filter is needed exactly when the list is long. */}
      <header className="panel__head plan-changes__head">
        <div className="panel__head-top">
          <h2 className="panel__title">{title}</h2>
          <button
            type="button"
            className="panel__close"
            aria-label={t("common.close")}
            title={t("common.close")}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {/* When it was approved and by whom — what the whole list is measured
            against. Without this line "after v1" stays a reference to an unknown
            date. */}
        {state.plan_approved_at && (
          <p className="plan-changes__since">
            {t("plan.changes_since", {
              // The reader's day, not the server's: truncating the ISO string
              // gave the day in UTC, and an approval at one in the morning was
              // dated yesterday — the same as in the history feed, only that one
              // counts correctly.
              date: formatDate(t, dayIn(zone, new Date(state.plan_approved_at))),
            })}
            {/* A person's name is user content: not translated. */}
            {approvedBy && <span className="muted"> · {approvedBy.name}</span>}
          </p>
        )}

        {/* The summary answers "what happened at all" before the list is read,
            and it is also the filter: the groups differ in urgency, and "show
            only the shifts" is the first thing asked once the number is seen.
            Empty groups are not shown: a tag with a zero offers to open emptiness. */}
        <div className="plan-changes__summary">
          <GroupTag active={group === "all"} onClick={() => setGroup("all")}>
            {t("plan.changes_all")} · {total}
          </GroupTag>
          {filled.map((row) => (
            <GroupTag
              key={row.key}
              active={group === row.key}
              onClick={() => setGroup(group === row.key ? "all" : row.key)}
            >
              {t(`plan.changes_tag.${row.key}`)} · {row.rows.length}
            </GroupTag>
          ))}
        </div>

        {/* The same layer the "View" checkbox turns on in the strip — not a
            second one like it: the list and the chart tell the same thing in two
            languages, and a person must switch between them where they are
            looking. It is for the sake of this switch that the panel does not
            cover the strip.

            A switch rather than a checkbox: the state changes at once and with
            no "save" button — exactly the case `Switch` exists in the
            application for. */}
        <div className="plan-changes__ghost">
          <Switch
            id="plan-changes-ghost"
            label={t("plan.changes_ghost")}
            checked={baselineShown}
            onChange={onBaselineToggle}
          />
        </div>
      </header>

      <div className="panel__body">
        {shown.map(({ key, rows }) => (
          <section key={key} className="plan-changes__group">
            <h3 className="plan-changes__group-title">
              {t(`plan.changes_group.${key}`)}
              <span className="plan-changes__count">{rows.length}</span>
            </h3>
            <ul className="plan-changes__list">
              {rows.map((change) => (
                <li key={rowKey(change)} className="plan-changes__row">
                  <div className="plan-changes__main">
                    {/* A task's name leads into its card: having seen a
                        divergence, people go to fix that very task, and the way
                        there must not run through closing the panel and hunting
                        for the row by eye. The panel leaves at that: the card
                        slides out into the same place on the right, and two
                        panels cannot fit there. A deleted task has nowhere to
                        lead — it stays as text. */}
                    {change.kind === "removed" ? (
                      <span className="plan-changes__name plan-changes__name--gone">
                        {change.name}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="plan-changes__name"
                        onClick={() => {
                          onClose();
                          onOpenTask(change.task.id);
                        }}
                      >
                        {change.task.name}
                      </button>
                    )}
                    <span className="plan-changes__diff">{diffOf(change, t, day)}</span>
                    <Badge change={change} />
                  </div>

                  {/* A stretch that happened in the same motion as a move: the
                      task stands in one group, but two things moved for it, and
                      passing over the second would mean showing half the truth. */}
                  {change.kind === "shift" && change.stretch && (
                    <p className="plan-changes__also">
                      {t("plan.changes_also_duration", {
                        from: t("common.days_short", { count: change.stretch.from }),
                        to: t("common.days_short", { count: change.stretch.to }),
                      })}
                    </p>
                  )}

                  {/* The reason is what it was asked for at the shift: without it
                      the list answers "what changed", with it — "why". */}
                  {change.kind !== "removed" && reasons.get(change.task.id) && (
                    <p className="plan-changes__reason">{reasons.get(change.task.id)}</p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {/* Re-approval from here leads to the same question as the button in the
          project's header — not to one of its own: an action has one
          confirmation, and a second one created for the sake of a second button
          will one day diverge from the first in wording or in permissions. The
          ellipsis on the button says exactly that: the press does not re-approve
          but asks. */}
      {canReapprove && (
        <div className="panel__foot plan-changes__foot">
          <span className="plan-changes__hint">
            {t("plan.changes_reapprove_hint", { count: total })}
          </span>
          <button
            type="button"
            className="button--quiet button--alert"
            onClick={() => {
              onClose();
              onReapprove();
            }}
          >
            {t("plan.changes_reapprove")}
          </button>
        </div>
      )}
    </aside>
  );
}

/**
 * The divergence badge — the same value and the same colour as the badge on the
 * strip's bar: "+2 d." in red, "−2 d." in green. Coming in early is not an
 * alarm, and setting it in an alarm's colour would mean announcing good news in
 * a bad voice.
 *
 * Work beyond the plan has no number at all: there is nothing to compare with,
 * and a word stands in place of a figure. A deleted task has no badge — its
 * divergence is already named in the line.
 */
function Badge({ change }: { change: PlanChange }) {
  const { t } = useLocale();

  if (change.kind === "removed") return null;
  if (change.kind === "added") {
    return <span className="plan-changes__badge is-new">{t("plan.changes_beyond")}</span>;
  }

  const days = t("common.days_short", { count: Math.abs(change.days) });
  return (
    <span className={`plan-changes__badge ${change.days > 0 ? "is-late" : "is-early"}`}>
      {t(change.days > 0 ? "gantt.deviation_late" : "gantt.deviation_early", { days })}
    </span>
  );
}

function GroupTag({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className="plan-changes__tag" aria-pressed={active} onClick={onClick}>
      {children}
    </button>
  );
}

/** The row's key. A task stands in exactly one group, so the task itself is enough. */
function rowKey(change: PlanChange): string {
  return change.kind === "removed" ? `removed-${change.taskId}` : change.task.id;
}

/** Before and after — what the line exists for. */
function diffOf(
  change: PlanChange,
  t: (key: string, params?: Record<string, string | number>) => string,
  day: (iso: string) => string,
): string {
  switch (change.kind) {
    case "shift":
      return `${day(change.from)} → ${day(change.to)}`;
    case "duration":
      return `${t("common.days_short", { count: change.from })} → ${t("common.days_short", {
        count: change.to,
      })}`;
    case "added":
      return t("plan.changes_added_at", { date: day(change.task.start_date) });
    case "removed":
      return t("plan.changes_removed_note");
  }
}

/**
 * The last explained reason for each task — from the journal.
 *
 * Only what happened after the approval is taken: a reason named before it
 * explains a shift that itself went into the baseline plan.
 *
 * The entries arrive newest first, so the first reason found is the latest in
 * time — we do not look further for that task. A category shift explains all its
 * tasks at once: the movement has one reason while many moved because of it, and
 * repeating it on every line is more honest than showing it on none.
 */
function reasonsByTask(state: ProjectState, entries: RevisionEntry[]): Map<string, string> {
  const reasons = new Map<string, string>();
  const approvedAt = state.plan_approved_at;
  if (!approvedAt) return reasons;

  for (const entry of entries) {
    if (!entry.reason || entry.created_at < approvedAt) continue;

    const taskId = entry.op.task_id;
    if (typeof taskId === "string") {
      if (!reasons.has(taskId)) reasons.set(taskId, entry.reason);
      continue;
    }

    const categoryId = entry.op.category_id;
    if (typeof categoryId === "string") {
      for (const task of state.tasks) {
        if (task.category_id === categoryId && !reasons.has(task.id)) {
          reasons.set(task.id, entry.reason);
        }
      }
    }
  }

  return reasons;
}
