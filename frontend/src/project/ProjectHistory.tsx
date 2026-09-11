import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { MEMBERS_QUERY_KEY, members as fetchMembers } from "../api/org";
import { errorKey } from "../api/errors";
import { listPlanApprovals } from "../api/projects";
import type { PlanApproval, ProjectState } from "../api/projects";
import { FEED_PAGE, feedQueryKey, listProjectRevisions } from "../api/revisions";
import type { FeedFilters, RevisionEntry } from "../api/revisions";
import { modKeyLabel } from "../components/hotkeys";
import { formatDate, formatTime } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";
import { formatEvent } from "../task/formatEvent";
import { useTimeZone } from "../time/useToday";
import { dayIn } from "../time/zone";
import { useUndo } from "./useUndo";

import "./history.css";

/**
 * The filter's groups by change type.
 *
 * A person looks not for a journal operation but for a kind of event: "who moved
 * the dates", "who touched the roster". A separate item for each of the thirteen
 * types would turn the filter into a table of contents for the code. The server,
 * at that, filters by the real types — a group is expanded into a list on the
 * client.
 */
const TYPE_GROUPS = {
  dates: ["move_task", "set_duration", "resize_task", "move_category", "set_milestone"],
  status: ["set_status", "set_progress"],
  fields: ["set_task_fields", "set_criticality", "set_risk", "rename_category", "set_category_color"],
  structure: [
    "create_task",
    "delete_task",
    "reorder_task",
    "create_category",
    "reorder_category",
    "delete_category",
  ],
  people: ["assign_user", "unassign_user"],
  links: ["add_dependency", "remove_dependency"],
} as const;

type TypeGroup = keyof typeof TYPE_GROUPS;

/**
 * An entry's icon: the kind of event is seen before the phrase is read.
 *
 * A glyph is a font character rather than a picture: the pictograms here are the
 * size of a letter, and a set of SVGs for the sake of thirteen arrows would be a
 * dependency with no gain. The tone repeats the application's status palette:
 * dates and the new in the accent colour, readiness and assignment in green, edits
 * in amber, deletions and criticality in the alarm colour.
 */
const EVENT_ICONS: Record<string, readonly [glyph: string, tone: string]> = {
  move_task: ["↔", "accent"],
  set_duration: ["↔", "accent"],
  resize_task: ["↔", "accent"],
  move_category: ["↔", "accent"],
  // A milestone is neither a date nor text: it turns a stretch into a point, and it
  // has a sign of its own, the same diamond it is drawn with on the strip.
  set_milestone: ["◆", "accent"],
  set_status: ["✓", "ok"],
  set_progress: ["✓", "ok"],
  set_criticality: ["!", "danger"],
  // Risk is the assignee's word about a date: the attention tone, as for being overdue.
  set_risk: ["!", "warn"],
  set_task_fields: ["✎", "warn"],
  rename_category: ["✎", "warn"],
  set_category_color: ["✎", "warn"],
  create_task: ["＋", "accent"],
  create_category: ["＋", "accent"],
  reorder_task: ["⇅", "warn"],
  reorder_category: ["⇅", "warn"],
  delete_task: ["✕", "danger"],
  delete_category: ["✕", "danger"],
  assign_user: ["＋", "ok"],
  unassign_user: ["−", "warn"],
  add_dependency: ["→", "accent"],
  remove_dependency: ["−", "warn"],
};

/** An undo entry is recognized by a back arrow, whatever was undone. */
function eventIcon(entry: RevisionEntry): readonly [string, string] {
  if (entry.undoes_seq !== null) return ["↶", "muted"];
  return EVENT_ICONS[String(entry.op.type)] ?? ["•", "muted"];
}

/** A feed row: a journal entry or a plan-approval milestone. */
type FeedRow =
  | { kind: "revision"; at: string; entry: RevisionEntry }
  | { kind: "batch"; at: string; batchId: string; entries: RevisionEntry[] }
  | { kind: "milestone"; at: string; approval: PlanApproval };

/**
 * The change feed for the whole project — the "History" tab.
 *
 * Newest on top, days as headings: history is read from the last event. An AI
 * batch is folded into one line — thirty "created a task" entries in a row are not
 * history but noise. Undone entries stay and are marked: the journal is not
 * rewritten, that is the whole point of it.
 *
 * The "Undo" button stands only by the entry the server named in `state.undoable`:
 * the backend deliberately undoes only the last action, and a button by every entry
 * would promise something that does not exist. Step by step back — by repeated
 * presses.
 */
export function ProjectHistory({
  projectId,
  state,
  canUndo,
}: {
  projectId: string;
  state: ProjectState;
  /** The right and the ability to undo: the right to write plus a live connection. */
  canUndo: boolean;
}) {
  const { t, locale } = useLocale();
  const [taskFilter, setTaskFilter] = useState("");
  const [actorFilter, setActorFilter] = useState("");
  const [groupFilter, setGroupFilter] = useState<TypeGroup | "">("");
  const [openBatches, setOpenBatches] = useState<ReadonlySet<string>>(new Set());

  const filters: FeedFilters = {
    taskId: taskFilter || undefined,
    actorId: actorFilter || undefined,
    types: groupFilter ? [...TYPE_GROUPS[groupFilter]] : undefined,
  };
  const filtered = Boolean(taskFilter || actorFilter || groupFilter);

  const feed = useInfiniteQuery({
    queryKey: feedQueryKey(projectId, filters),
    queryFn: ({ pageParam }) => listProjectRevisions(projectId, filters, pageParam),
    initialPageParam: undefined as number | undefined,
    // A page shorter than the limit is the journal's end: the cursor will lead no further.
    getNextPageParam: (last) =>
      last.length < FEED_PAGE ? undefined : last[last.length - 1].seq,
    retry: false,
  });

  // The roster — only for the author filter. A refusal is not the feed's error: the
  // roster is not given to the `client` role, and the filter is then simply not drawn.
  const membersQuery = useQuery({
    queryKey: MEMBERS_QUERY_KEY,
    queryFn: fetchMembers,
    retry: false,
    staleTime: Infinity,
  });

  // The approval milestones. The key is under the project's key: a re-approval event
  // invalidates the whole subtree, and the chronicle is re-read along with the
  // state. A refusal does not break the feed — it is left without the flags.
  const approvalsQuery = useQuery({
    queryKey: ["project", projectId, "plan-approvals"] as const,
    queryFn: () => listPlanApprovals(projectId),
    retry: false,
  });

  const undo = useUndo(projectId, state);

  // The feed is grouped by the reader's day rather than the server's: "Today" in a
  // day's heading answers "what happened today for me", and an entry made at half
  // past midnight must fall under today's heading rather than yesterday's.
  const zone = useTimeZone(state.settings?.timezone);

  if (feed.isPending) {
    return <p role="status">{t("common.loading")}</p>;
  }
  if (feed.error) {
    return (
      <p className="error" role="alert">
        {t(errorKey(feed.error))}
      </p>
    );
  }

  const entries = feed.data.pages.flat();

  // Who undid what: an undo entry is always newer than the one it undid, so reading
  // from the head of the journal pairs them up without a second request to the server.
  const undoneBy = new Map<number, RevisionEntry>();
  for (const entry of entries) {
    if (entry.undoes_seq !== null) undoneBy.set(entry.undoes_seq, entry);
  }

  const rows = buildRows(entries, approvalsQuery.data ?? [], {
    // The milestones are hidden under a filter: a feed filtered by task with other
    // tasks' flags would read as that task's history with extra events in it.
    milestones: !filtered,
    exhausted: !feed.hasNextPage,
  });

  const days = new Map<string, FeedRow[]>();
  for (const row of rows) {
    const day = dayIn(zone, new Date(row.at));
    days.set(day, [...(days.get(day) ?? []), row]);
  }

  const today = dayIn(zone);
  const yesterday = dayIn(zone, Date.now() - 86_400_000);
  // "Today" comes with the date rather than instead of it: the word grows stale in
  // an open tab, and a "Today" entry with no date will be a lie tomorrow morning.
  const dayLabel = (day: string) =>
    day === today
      ? `${t("history.today")} · ${formatDate(t, day)}`
      : day === yesterday
        ? `${t("history.yesterday")} · ${formatDate(t, day)}`
        : formatDate(t, day);

  const toggleBatch = (batchId: string) =>
    setOpenBatches((current) => {
      const next = new Set(current);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });

  // The undo button goes strictly by what the server named: a single entry or a
  // whole batch. canUndo already includes both the right and the live connection.
  const undoableSeq =
    canUndo && state.undoable && !state.undoable.batch_id ? state.undoable.seq : null;
  const undoableBatch = (canUndo && state.undoable?.batch_id) || null;

  // Ctrl/⌘+Z does exactly the same — and the combination is named right on the
  // button: otherwise only those who tried at random would know about it.
  const undoButton = (label: string) => (
    <button
      type="button"
      className="button--quiet feed__undo"
      onClick={() => undo.mutation.mutate()}
      disabled={undo.mutation.isPending}
      title={`${label} · ${modKeyLabel()}+Z`}
      aria-keyshortcuts="Control+Z"
    >
      {label}
    </button>
  );

  const line = (entry: RevisionEntry) => (
    <>
      {entry.actor && <span className="feed__actor">{entry.actor.name} </span>}
      {!entry.actor && <span className="feed__actor">{t("history.no_actor")} </span>}
      {entry.undoes_seq !== null && (
        <span className="feed__badge">{t("history.undo_badge")} </span>
      )}
      {formatEvent(entry.op, locale, entry.names, state.schedule_mode === "relative")}
      {subjectOf(entry) && <span className="feed__subject"> · {subjectOf(entry)}</span>}
    </>
  );

  /**
   * The caption under the phrase. The card's time stands in its right column, so it
   * only gets here for a batch's nested entries — they have no right column. An
   * empty caption is not drawn: a card with no reason stays a single line.
   */
  const meta = (entry: RevisionEntry, withTime = false) => {
    const undoneEntry = undoneBy.get(entry.seq);
    if (!withTime && !entry.reason && !undoneEntry) return null;
    return (
      <p className="feed__meta">
        {withTime && <span>{formatTime(locale, new Date(entry.created_at))}</span>}
        {/* The reason is the user's text: as is, without translation. */}
        {entry.reason && <span className="feed__reason">{entry.reason}</span>}
        {undoneEntry && (
          <span className="feed__undone-mark">
            {undoneEntry.actor
              ? t("history.undone_by", { name: undoneEntry.actor.name })
              : t("history.undone")}
          </span>
        )}
      </p>
    );
  };

  const time = (at: string) => (
    <span className="feed__time">{formatTime(locale, new Date(at))}</span>
  );

  const icon = (glyph: string, tone: string) => (
    <span className={`feed__icon feed__icon--${tone}`} aria-hidden="true">
      {glyph}
    </span>
  );

  return (
    <section className="feed" aria-label={t("history.title")}>
      <div className="feed__filters">
        {membersQuery.data && (
          <label className="feed__filter">
            {t("history.filter.person")}
            <select value={actorFilter} onChange={(e) => setActorFilter(e.target.value)}>
              <option value="">{t("history.filter.all")}</option>
              {membersQuery.data.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="feed__filter">
          {t("history.filter.task")}
          <select value={taskFilter} onChange={(e) => setTaskFilter(e.target.value)}>
            <option value="">{t("history.filter.all")}</option>
            {state.tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.name}
              </option>
            ))}
          </select>
        </label>
        <label className="feed__filter">
          {t("history.filter.type")}
          <select
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value as TypeGroup | "")}
          >
            <option value="">{t("history.filter.all")}</option>
            {(Object.keys(TYPE_GROUPS) as TypeGroup[]).map((group) => (
              <option key={group} value={group}>
                {t(`history.filter.group.${group}`)}
              </option>
            ))}
          </select>
        </label>
        {filtered && (
          <button
            type="button"
            className="button--quiet"
            onClick={() => {
              setTaskFilter("");
              setActorFilter("");
              setGroupFilter("");
            }}
          >
            {t("history.filter.reset")}
          </button>
        )}
      </div>

      {undo.error !== null && (
        <p className="error" role="alert">
          {t(errorKey(undo.error))}
        </p>
      )}

      {rows.length === 0 && <p className="muted feed__empty">{t("history.feed_empty")}</p>}

      {[...days.entries()].map(([day, dayRows]) => (
        <section
          key={day}
          className={`feed__day${day === today ? " feed__day--today" : ""}`}
        >
          <header className="feed__day-head">
            {/* The number comes straight from the day's key: the key is the local date. */}
            <span className="feed__day-dot" aria-hidden="true">
              {Number(day.slice(8, 10))}
            </span>
            <h3 className="feed__day-title">{dayLabel(day)}</h3>
          </header>
          <ol className="feed__list">
            {dayRows.map((row) => {
              if (row.kind === "milestone") {
                return (
                  <li key={`plan-${row.approval.version}`} className="feed__card feed__milestone">
                    {icon("⚑", "ok")}
                    <div className="feed__main">
                      <p className="feed__line">
                        {t("history.milestone", { version: row.approval.version })}
                        {row.approval.approved_by && (
                          <span className="feed__subject"> · {row.approval.approved_by.name}</span>
                        )}
                      </p>
                    </div>
                    <div className="feed__tools">{time(row.at)}</div>
                  </li>
                );
              }

              if (row.kind === "batch") {
                const open = openBatches.has(row.batchId);
                const isUndo = row.entries.every((entry) => entry.undoes_seq !== null);
                const head = row.entries[0];
                return (
                  <li key={`batch-${row.batchId}`} className="feed__card feed__batch">
                    {/* A batch is the AI's handwriting, and its sign is not an action but a spark. */}
                    {icon(isUndo ? "↶" : "✦", isUndo ? "muted" : "accent")}
                    <div className="feed__main">
                      <p className="feed__line">
                        {head.actor && <span className="feed__actor">{head.actor.name} </span>}
                        {!head.actor && (
                          <span className="feed__actor">{t("history.no_actor")} </span>
                        )}
                        {t(isUndo ? "history.batch_undo" : "history.batch", {
                          count: row.entries.length,
                        })}
                      </p>
                      <p className="feed__meta">
                        <button
                          type="button"
                          className="feed__toggle"
                          aria-expanded={open}
                          onClick={() => toggleBatch(row.batchId)}
                        >
                          {t(open ? "history.collapse" : "history.expand")}
                        </button>
                        {undoableBatch === row.batchId && undoButton(t("history.undo_batch"))}
                      </p>
                      {open && (
                        <ol className="feed__list feed__list--nested">
                          {row.entries.map((entry) => (
                            <li key={entry.seq} className="feed__item">
                              <p className="feed__line">{line(entry)}</p>
                              {meta(entry, true)}
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                    <div className="feed__tools">{time(head.created_at)}</div>
                  </li>
                );
              }

              const entry = row.entry;
              const undone = undoneBy.has(entry.seq);
              const [glyph, tone] = eventIcon(entry);
              return (
                <li
                  key={entry.seq}
                  className={`feed__card feed__item${undone ? " feed__item--undone" : ""}`}
                >
                  {icon(glyph, tone)}
                  <div className="feed__main">
                    <p className="feed__line">{line(entry)}</p>
                    {meta(entry)}
                  </div>
                  <div className="feed__tools">
                    {time(entry.created_at)}
                    {undoableSeq === entry.seq && undoButton(t("undo.action"))}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}

      {feed.hasNextPage && (
        <button
          type="button"
          className="button--quiet feed__more"
          onClick={() => void feed.fetchNextPage()}
          disabled={feed.isFetchingNextPage}
        >
          {t("history.show_more")}
        </button>
      )}
    </section>
  );
}

/**
 * Whose name to put next to the phrase. The phrase says "moved the start from 12 to
 * 19 March", and the subject — the task — is taken from the entry's name dictionary.
 *
 * Renaming a category does not duplicate the name: both bounds are already in the
 * phrase itself. A link has two subjects, and they are in the phrase too (see
 * formatEvent).
 */
function subjectOf(entry: RevisionEntry): string | null {
  const op = entry.op;
  const type = String(op.type);
  if (type === "rename_category" || type.endsWith("_dependency")) return null;
  for (const key of ["task_id", "category_id"]) {
    const id = op[key];
    if (id && entry.names[String(id)]) return entry.names[String(id)];
  }
  return null;
}

/**
 * Entries and milestones — into feed rows, newest on top.
 *
 * Neighbouring entries of one batch are folded into a single row. Milestones are
 * glued in by time, but only within the loaded stretch of the journal: a milestone
 * older than the oldest loaded entry will appear together with its own page —
 * otherwise it would jump about the feed on every "Show more".
 */
function buildRows(
  entries: RevisionEntry[],
  approvals: PlanApproval[],
  { milestones, exhausted }: { milestones: boolean; exhausted: boolean },
): FeedRow[] {
  const rows: FeedRow[] = [];
  for (const entry of entries) {
    const last = rows[rows.length - 1];
    if (entry.batch_id && last?.kind === "batch" && last.batchId === entry.batch_id) {
      last.entries.push(entry);
      continue;
    }
    if (entry.batch_id) {
      rows.push({
        kind: "batch",
        at: entry.created_at,
        batchId: entry.batch_id,
        entries: [entry],
      });
      continue;
    }
    rows.push({ kind: "revision", at: entry.created_at, entry });
  }

  if (!milestones) return rows;

  const oldest = entries.length > 0 ? entries[entries.length - 1].created_at : null;
  const visible = approvals.filter(
    (approval) => exhausted || (oldest !== null && approval.approved_at >= oldest),
  );
  const merged = [
    ...rows,
    ...visible.map(
      (approval): FeedRow => ({ kind: "milestone", at: approval.approved_at, approval }),
    ),
  ];
  // Sorted by time, newest on top; a milestone sharing an instant with an entry
  // stands above it — an approval closes what came before it.
  return merged.sort(
    (a, b) =>
      (a.at < b.at ? 1 : a.at > b.at ? -1 : 0) ||
      (a.kind === "milestone" ? -1 : b.kind === "milestone" ? 1 : 0),
  );
}
