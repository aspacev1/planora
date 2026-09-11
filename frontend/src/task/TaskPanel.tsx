import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { errorKey } from "../api/errors";
import { MEMBERS_QUERY_KEY, members as fetchMembers } from "../api/org";
import { CRITICALITY_LEVELS, RISK_FLAGS, TASK_STATUSES } from "../api/projects";
import type { Criticality, Op, ProjectState, RiskFlag, Task, TaskStatus } from "../api/projects";
import { Avatar } from "../components/Avatar";
import { StatusChip } from "../components/StatusChip";
import { Switch } from "../components/Switch";
import { useEscape } from "../components/useEscape";
import { baselineOf, deviationDays, endShiftDays, isBeyondPlan } from "../project/baseline";
import {
  addDependency,
  deleteTask,
  patchMilestone,
  patchProgress,
  patchStatus,
  patchTask,
  removeDependency,
  reorderTask,
} from "../project/optimistic";
import { overlapDays } from "../project/DependencyNudge";
import { isShiftCancelled } from "../project/ShiftReason";
import { useProjectMutation } from "../project/useProjectMutation";
import { dateOfProjectDay, projectDayNumber, relativeDayLabel } from "../gantt/relative";
import { addDays } from "../gantt/timescale";
import { formatShortDate } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";
import { Comments } from "./Comments";
import { PanelSection } from "./PanelSection";
import { SelectField, TextField, ValueField } from "./fields";
import { History } from "./History";
import { TaskProgress } from "./TaskProgress";

import "./panel.css";

/** A card's tab: the task's properties, its history or the discussion. */
export type PanelTab = "details" | "history" | "comments";

/**
 * A task's card — a panel sliding out over the full height of the screen.
 *
 * `position: fixed` from the window's top edge to its bottom, on top of the
 * project header and the strip: the card does not start from the click's place
 * and does not depend on the page's scroll — however the strip is scrolled it
 * stays stretched edge to edge. It is built in three tiers: a pinned header
 * (name, status, period, progress and tabs), a scrollable middle and a pinned
 * footer with buttons. If the content does not fit, only the middle scrolls.
 *
 * `complementary` rather than `dialog`: the card covers only the screen's right
 * column and does not take the focus — the strip on the left is worked with at
 * the same time, checking a bar against the fields. A dialog with a backdrop
 * would demand closing itself before every glance at a neighbouring task.
 *
 * It closes in three ways, because it is arrived at by three paths: with the
 * mouse on the cross, from the keyboard with Esc, and by a repeat click on the
 * same bar — people do the last one without thinking, and without it the click
 * looks like nothing happened.
 */
export function TaskPanel({
  projectId,
  task,
  state,
  canWrite,
  initialTab = "details",
  onClose,
}: {
  projectId: string;
  task: Task;
  /** The whole project: the card needs both the categories and the neighbours in them. */
  state: ProjectState;
  canWrite: boolean;
  /**
   * Which section to open on. Properties by default — that is what people come
   * for most often; from the reply counter on a strip row they come straight to
   * the discussion, and an extra click on the tab there would mean the counter
   * led somewhere other than it promised.
   */
  initialTab?: PanelTab;
  onClose: () => void;
}) {
  const categories = state.categories;
  const { t } = useLocale();
  const { apply } = useProjectMutation(projectId);
  const [error, setError] = useState<unknown>(null);
  // Deletion asks for confirmation right in the card — the same way plan
  // re-approval does: a dialog on top of the card would cover the task it is
  // asking about.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // The refusal counter. Serves the fields as a "go back to the state" signal:
  // comparing values is not enough for them — a guess and a rollback often fit
  // into one frame, and from a field's point of view the value never changed.
  const [refusals, setRefusals] = useState(0);

  // The card's tab. Reset to the one the card was opened on when moving to a
  // neighbouring task: a card left open on one task's "History" must not
  // silently show the next task's history — it was clicked on to see the task
  // itself.
  //
  // The dependency on the section is not redundant: two paths lead from a strip
  // row into one and the same task, and a click on the reply counter must open
  // the discussion even when that task's card is already open on its properties.
  const [tab, setTab] = useState<PanelTab>(initialTab);
  useEffect(() => setTab(initialTab), [task.id, initialTab]);

  // A refusal here is not the card's error: the `client` role never gets the
  // organization's roster at all, and the assignees block is simply not drawn.
  // The same reasoning as in the task creation form.
  const membersQuery = useQuery({
    queryKey: MEMBERS_QUERY_KEY,
    queryFn: fetchMembers,
    retry: false,
    staleTime: Infinity,
  });

  // The card is the bottom layer: the "explain the shift" dialog, the strip's
  // menu and the inline delete confirmation all stand on top of it. With its own
  // listener on the document the card would close together with any of them,
  // carrying away unfinished text; the shared stack gives Esc only to the top one.
  //
  // The listener is still on the document rather than on the card itself: by the
  // time of the keypress the focus is most often on the bar, and a listener on
  // the card would stay silent.
  useEscape(onClose);

  // The delete confirmation lives inside the card but behaves as a layer above
  // it: Esc here means "changed my mind about deleting", not "close the card".
  // The latter would carry away both the question and the task it is about.
  useEscape(() => setConfirmingDelete(false), confirmingDelete);

  // A relative plan: the card's date fields speak in project days — such a plan
  // has no dates yet (see gantt/relative.ts).
  const relative = state.schedule_mode === "relative";

  const send = (op: Op, optimistic: (state: ProjectState) => ProjectState) => {
    setError(null);
    // The refusal has already been rolled back inside `apply`: what is left here
    // is to explain it in words and return the field to what remains in state.
    apply(op, optimistic).catch((refusal: unknown) => {
      // Refusing to explain a shift is not an error: the person pressed
      // "Revert", and the field must return to the saved value silently. An
      // error message here would read as "something broke", though there is
      // nothing to break.
      if (!isShiftCancelled(refusal)) setError(refusal);
      setRefusals((count) => count + 1);
    });
  };

  const patch = (fields: Partial<Task>) => (state: ProjectState) =>
    patchTask(state, task.id, fields);

  // The note is the only field with restricted visibility, and
  // `set_task_fields` carries all three text fields at once. That means this
  // operation cannot be sent without seeing the note: it would erase it with an
  // empty string. By the permission matrix no such role exists — only someone
  // who sees the note can write — but relying on two permission lists
  // coinciding is not worth it.
  const editsText = canWrite && "internal_note" in task;

  const commitFields = (changed: Partial<Task>) => {
    const fields = {
      name: task.name,
      description: task.description ?? "",
      internal_note: task.internal_note ?? "",
      ...changed,
    };
    send({ type: "set_task_fields", task_id: task.id, ...fields }, patch(fields));
  };

  const toggleAssignee = (userId: string) => {
    const assigned = task.assignee_ids.includes(userId);
    send(
      {
        type: assigned ? "unassign_user" : "assign_user",
        task_id: task.id,
        user_id: userId,
      },
      patch({
        assignee_ids: assigned
          ? task.assignee_ids.filter((id) => id !== userId)
          : [...task.assignee_ids, userId],
      }),
    );
  };

  // The period in the header uses the same words as the date fields below: a
  // relative plan speaks in project days, a calendar one in short dates.
  const dateLabel = (iso: string) =>
    relative ? relativeDayLabel(t, iso) : formatShortDate(t, iso);

  return (
    <aside
      className="panel"
      role="complementary"
      // The task's name in the caption: a dozen cards are opened per session,
      // and "additional information" without a name does not say which one.
      aria-label={t("task.panel.aria", { name: task.name })}
    >
      {/* The header is pinned: the name, the status with the period, the
          progress and the tabs are visible however the middle is scrolled. */}
      <header className="panel__head">
        <div className="panel__head-top">
          {/* The task's name is user content: it is not translated. */}
          <h2 className="panel__title">{task.name}</h2>
          <button
            type="button"
            className="panel__close"
            aria-label={t("task.panel.close")}
            title={t("task.panel.close")}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {/* `key` by task: "the day is marked" and the percentage draft belong to
            this task and must not carry over to a neighbouring one. */}
        <TaskProgress
          key={task.id}
          task={task}
          canWrite={canWrite}
          timeZone={state.settings?.timezone}
          resetToken={refusals}
          meta={
            <>
              <StatusChip status={task.status} label={t(`task.status.${task.status}`)} />
              <span className="panel__meta-sep" aria-hidden="true" />
              {/* The period on one line as "start — end": the dash is inside the
                  string rather than two nodes — otherwise flex drives the dates apart. */}
              <span className="panel__period">
                {dateLabel(task.start_date)} — {dateLabel(task.end_date)}
              </span>
              <span className="panel__meta-sep" aria-hidden="true" />
            </>
          }
          onCommit={(progress_pct) =>
            send({ type: "set_progress", task_id: task.id, progress_pct }, (state) =>
              patchProgress(state, task.id, progress_pct),
            )
          }
        />

        {/* A server refusal goes in the header, not in the scrollable middle:
            the explanation must be in sight, however deep the field being edited is. */}
        {error !== null && (
          <p className="error" role="alert">
            {t(errorKey(error))}
          </p>
        )}

        {/* Properties, history and discussion are tabs of one card rather than
            three feeds in a row: both the history and the conversation are
            opened less often per session than the fields are edited, and
            keeping them always unfolded means stretching the card with things
            looked at now and then. */}
        <div className="panel__tabs" role="tablist" aria-label={t("task.panel.tabs")}>
        <button
          type="button"
          role="tab"
          id="panel-tab-details"
          aria-selected={tab === "details"}
          aria-controls="panel-tabpanel-details"
          className={tab === "details" ? "panel__tab is-active" : "panel__tab"}
          onClick={() => setTab("details")}
        >
          {t("task.panel.tab_details")}
        </button>
        <button
          type="button"
          role="tab"
          id="panel-tab-history"
          aria-selected={tab === "history"}
          aria-controls="panel-tabpanel-history"
          className={tab === "history" ? "panel__tab is-active" : "panel__tab"}
          onClick={() => setTab("history")}
        >
          {t("task.panel.history")}
        </button>
        <button
          type="button"
          role="tab"
          id="panel-tab-comments"
          aria-selected={tab === "comments"}
          aria-controls="panel-tabpanel-comments"
          className={tab === "comments" ? "panel__tab is-active" : "panel__tab"}
          onClick={() => setTab("comments")}
        >
          {t("task.panel.comments")}
        </button>
        </div>
      </header>

      {/* The middle is the only thing that scrolls: the header and the footer
          stand still. `key` by task: moving to a neighbouring one starts the
          fields afresh rather than carrying unfinished text into the new card. */}
      <div className="panel__body" key={task.id}>
      <Baseline task={task} state={state} />

      {tab === "details" && (
        <div id="panel-tabpanel-details" role="tabpanel" aria-labelledby="panel-tab-details">
          {/* The properties are gathered into accordions, as in the mockup. All
              are unfolded from the start: an accordion here is a table of
              contents for a long card and a way to get the extras out of sight,
              not a way to hide fields by default. */}
          <PanelSection title={t("task.panel.section_main")}>
          <div className="panel__fields">
            <TextField
              id="panel-name"
              label={t("task.panel.name")}
              value={task.name}
              disabled={!editsText}
              resetToken={refusals}
              onCommit={(name) => commitFields({ name })}
            />

            <TextField
              id="panel-description"
              label={t("task.panel.description")}
              value={task.description ?? ""}
              rows={3}
              disabled={!editsText}
              resetToken={refusals}
              onCommit={(description) => commitFields({ description })}
            />

            <SelectField
              id="panel-status"
              label={t("task.panel.status")}
              value={task.status}
              disabled={!canWrite}
              options={TASK_STATUSES.map((status) => ({
                value: status,
                label: t(`task.status.${status}`),
              }))}
              onCommit={(value) => {
                const status = value as TaskStatus;
                // The optimistic guess repeats the server's coupling: "done"
                // brings the progress up to a hundred (see optimistic.ts).
                send({ type: "set_status", task_id: task.id, status }, (state) =>
                  patchStatus(state, task.id, status),
                );
              }}
            />

            <SelectField
              id="panel-category"
              label={t("task.panel.category")}
              value={task.category_id}
              disabled={!canWrite}
              // The category's name is user content: it is not translated.
              options={categories.map((category) => ({
                value: category.id,
                label: category.name,
              }))}
              onCommit={(categoryId) => {
                // To the end of the chosen category: moving by list is a change
                // of belonging, not a choice of place inside. The place is
                // chosen by dragging the row.
                const position = state.tasks.filter(
                  (row) => row.category_id === categoryId && row.id !== task.id,
                ).length;
                send(
                  { type: "reorder_task", task_id: task.id, category_id: categoryId, position },
                  (state) => reorderTask(state, task.id, categoryId, position),
                );
              }}
            />

            <SelectField
              id="panel-criticality"
              label={t("task.panel.criticality")}
              value={task.criticality}
              disabled={!canWrite}
              options={CRITICALITY_LEVELS.map((level) => ({
                value: level,
                label: t(`task.criticality.${level}`),
              }))}
              onCommit={(value) => {
                const criticality = value as Criticality;
                send(
                  { type: "set_criticality", task_id: task.id, criticality },
                  patch({ criticality }),
                );
              }}
            />

            {/* Risk is the assignee's word rather than a computation: "am I
                going to make it". The reason is shown only for a non-green
                flag: "on plan" has nothing to explain, and an empty field would
                read as a forgotten one. */}
            <SelectField
              id="panel-risk"
              label={t("task.panel.risk")}
              value={task.risk}
              disabled={!canWrite}
              options={RISK_FLAGS.map((flag) => ({
                value: flag,
                label: t(`task.risk.${flag}`),
              }))}
              onCommit={(value) => {
                const risk = value as RiskFlag;
                send(
                  { type: "set_risk", task_id: task.id, risk, note: task.risk_note },
                  patch({ risk }),
                );
              }}
            />
            {task.risk !== "green" && (
              <TextField
                id="panel-risk-note"
                label={t("task.panel.risk_note")}
                value={task.risk_note}
                disabled={!canWrite}
                resetToken={refusals}
                onCommit={(value) => {
                  const note = value.slice(0, 300);
                  send(
                    { type: "set_risk", task_id: task.id, risk: task.risk, note },
                    patch({ risk_note: note }),
                  );
                }}
              />
            )}

            {/* A milestone is a switch, not a field: it has two states, and they
                change at once. It stands before the dates for a reason: turned
                on, it collapses the duration into a day, and the decision "is
                this a point or a stretch" is taken before the dates are typed. */}
            <div className="panel__row">
              <Switch
                id="panel-milestone"
                label={t("task.panel.milestone")}
                checked={task.milestone}
                disabled={!canWrite}
                onChange={(milestone) =>
                  send({ type: "set_milestone", task_id: task.id, milestone }, (state) =>
                    patchMilestone(state, task.id, milestone),
                  )
                }
              />
            </div>

            {relative ? (
              // A relative plan: the start is edited as a project day number —
              // such a plan has no dates. Converting the number into an axis
              // coordinate is linear; the working days are counted by the
              // server, as everywhere.
              <ValueField
                id="panel-start"
                label={t("task.panel.start_day")}
                type="number"
                value={String(projectDayNumber(task.start_date))}
                disabled={!canWrite}
                resetToken={refusals}
                onCommit={(value) => {
                  const day = Number(value);
                  if (!Number.isInteger(day) || day < 1) return;
                  const start_date = dateOfProjectDay(day);
                  send({ type: "move_task", task_id: task.id, start_date }, patch({ start_date }));
                }}
              />
            ) : (
              <ValueField
                id="panel-start"
                label={t("task.panel.start")}
                type="date"
                value={task.start_date}
                disabled={!canWrite}
                resetToken={refusals}
                onCommit={(start_date) =>
                  send({ type: "move_task", task_id: task.id, start_date }, patch({ start_date }))
                }
              />
            )}

            <ValueField
              id="panel-duration"
              label={t("task.panel.duration")}
              type="number"
              value={String(task.duration_days)}
              disabled={!canWrite}
              resetToken={refusals}
              onCommit={(value) => {
                const duration_days = Number(value);
                send(
                  { type: "set_duration", task_id: task.id, duration_days },
                  patch({ duration_days }),
                );
              }}
            />

            <div className="panel__row">
              <span className="panel__key">{t("task.panel.end")}</span>
              {/* The end date is only shown: it is computed by the server from
                  the project's calendar, and a field for editing it would
                  promise an influence that does not exist. */}
              <span className="panel__value">
                {relative ? relativeDayLabel(t, task.end_date) : formatShortDate(t, task.end_date)}
              </span>
            </div>

            {/* The only field with restricted visibility. Whether to show it is
                decided by the server: if the note is not in the response, the
                block is not in the interface. */}
            {"internal_note" in task && (
              <TextField
                id="panel-note"
                label={t("task.panel.internal_note")}
                value={task.internal_note ?? ""}
                rows={3}
                disabled={!editsText}
                resetToken={refusals}
                onCommit={(internal_note) => commitFields({ internal_note })}
              />
            )}
          </div>
          </PanelSection>

          <PanelSection title={t("task.panel.section_links")}>
            <Dependencies task={task} state={state} canWrite={canWrite} send={send} />
          </PanelSection>

          {membersQuery.data && membersQuery.data.length > 0 && (
            <PanelSection title={t("task.panel.assignees")}>
              {/* A group with a caption: the accordion's heading is decoration,
                  while the assignee list needs a name aloud too. */}
              <div
                className="panel__chips"
                role="group"
                aria-label={t("task.panel.assignees")}
              >
                {membersQuery.data.map((member) => (
                  // Each assignee is its own operation: they are both removed
                  // one at a time and read in the history as separate events.
                  <button
                    key={member.id}
                    type="button"
                    className="panel__chip"
                    aria-pressed={task.assignee_ids.includes(member.id)}
                    disabled={!canWrite}
                    onClick={() => toggleAssignee(member.id)}
                  >
                    {/* The avatar before the name: in a list and in a card a
                        person must be recognized by one and the same patch of colour. */}
                    <Avatar name={member.name} size={20} />
                    {/* A person's name is content, not chrome. */}
                    {member.name}
                  </button>
                ))}
              </div>
            </PanelSection>
          )}
        </div>
      )}

      {tab === "history" && (
        <div id="panel-tabpanel-history" role="tabpanel" aria-labelledby="panel-tab-history">
          <History projectId={projectId} taskId={task.id} relative={relative} />
        </div>
      )}

      {tab === "comments" && (
        <div id="panel-tabpanel-comments" role="tabpanel" aria-labelledby="panel-tab-comments">
          <Comments projectId={projectId} taskId={task.id} />
        </div>
      )}

      {/* Deletion comes as the last block, outside the tabs: this is not editing
          a task but parting with it, and it waits on any of the card's tabs.
          There is no separate dialog — the confirmation unfolds in place, as
          with plan re-approval. The deletion itself is undoable: the journal
          keeps a snapshot for the undo (with links, assignments and the
          conversation). */}
      {canWrite && (
        <div className="panel__danger">
          {confirmingDelete ? (
            <span className="plan__confirm">
              <span className="muted">{t("task.panel.delete_warning")}</span>
              <button
                type="button"
                onClick={() => {
                  send({ type: "delete_task", task_id: task.id }, (state) =>
                    deleteTask(state, task.id),
                  );
                  // The card is closed by the very fact of the task disappearing
                  // from the state, but the selected id must be forgotten:
                  // otherwise a server refusal, returning the task, would open
                  // its card again — this time with no explanation why.
                  onClose();
                }}
              >
                {t("task.panel.delete_confirm")}
              </button>
              <button
                type="button"
                className="button--quiet"
                onClick={() => setConfirmingDelete(false)}
              >
                {t("common.cancel")}
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="button--quiet button--alert"
              onClick={() => setConfirmingDelete(true)}
            >
              {t("task.panel.delete")}
            </button>
          )}
        </div>
      )}
      </div>

      {/* The footer is pinned, as in the mockup. The card's fields save
          themselves (see components/autosave), so both buttons finish the edit:
          a click on "Save changes" first takes the focus out of the field — and
          thereby sends the unfinished draft — and then closes the card.
          "Cancel" simply closes: rolling back what is already written is the job
          of the journal's "Undo" button, not the footer's. A reader is not shown
          the footer: they have nothing to save, and can close with the cross and
          Esc. */}
      {canWrite && (
        <footer className="panel__foot">
          <button type="button" className="button--quiet" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="panel__save" onClick={onClose}>
            {t("task.panel.save")}
          </button>
        </footer>
      )}
    </aside>
  );
}


/**
 * A task's links: "depends on" and "blocks", editable from the card.
 *
 * Both sides of one and the same `from → to` link: "depends on" is where the
 * task is the receiver, "blocks" is where it is the source. They are edited
 * here and not only drawn as arrows, because an arrow can be neither added nor
 * removed with the mouse on the strip — there is no gesture for it there.
 *
 * The candidates exclude already linked tasks and the reverse side: A→B
 * together with B→A is a cycle, and offering it would mean offering a server
 * refusal. The other cycles — the long ones — are caught by the server, and the
 * refusal rolls the guess back.
 */
function Dependencies({
  task,
  state,
  canWrite,
  send,
}: {
  task: Task;
  state: ProjectState;
  canWrite: boolean;
  send: (op: Op, optimistic: (state: ProjectState) => ProjectState) => void;
}) {
  const { t } = useLocale();
  const nameOf = new Map(state.tasks.map((row) => [row.id, row.name]));
  const byId = new Map(state.tasks.map((row) => [row.id, row]));

  const predecessors = state.dependencies
    .filter((link) => link.to_task_id === task.id)
    .map((link) => link.from_task_id);
  const successors = state.dependencies
    .filter((link) => link.from_task_id === task.id)
    .map((link) => link.to_task_id);

  /**
   * Whether the link to this task is violated — and how to fix it.
   *
   * The arrow on the strip shows a violation silently, and its "!" sign sends
   * the person here — which means that here it must be both named and fixable.
   * The nudge under the strip (see DependencyNudge) lives only around the last
   * shift; a violation left over from earlier edits had, without this marker,
   * not a single place where it could be taken up and cleared.
   *
   * It is always the successor that moves — by the same rule and to the same day
   * as in the nudge under the strip: two ways to fix one link must fix it
   * identically.
   */
  const trouble = (link: { from: string; to: string }) => {
    const from = byId.get(link.from);
    const to = byId.get(link.to);
    if (from === undefined || to === undefined) return null;
    const days = overlapDays(from, to);
    if (days <= 0) return null;
    const start_date = addDays(to.start_date, days);
    return {
      label: t("task.panel.link_violated", {
        from: from.name,
        to: to.name,
      }),
      fix: t("gantt.nudge", { name: to.name, days: t("common.days", { count: days }) }),
      move: () =>
        send({ type: "move_task", task_id: to.id, start_date }, (current) =>
          patchTask(current, to.id, { start_date }),
        ),
    };
  };

  const candidates = (taken: string[], opposite: string[]) =>
    state.tasks.filter(
      (row) => row.id !== task.id && !taken.includes(row.id) && !opposite.includes(row.id),
    );

  const add = (from: string, to: string) =>
    send({ type: "add_dependency", from_task_id: from, to_task_id: to }, (current) =>
      addDependency(current, from, to),
    );
  const remove = (from: string, to: string) =>
    send({ type: "remove_dependency", from_task_id: from, to_task_id: to }, (current) =>
      removeDependency(current, from, to),
    );

  const group = (
    label: string,
    ids: string[],
    options: Task[],
    link: (otherId: string) => { from: string; to: string },
  ) => (
    <div className="panel__row panel__deps">
      <span className="panel__key">{label}</span>
      <span className="panel__dep-list">
        {ids.length === 0 && !canWrite && <span className="muted">—</span>}
        {ids.map((id) => {
          const broken = trouble(link(id));
          return (
            <span key={id} className={`panel__dep${broken ? " is-violated" : ""}`}>
              {broken && (
                // The same sign as on the strip's arrow: the person came here
                // from the "!" on the link and should recognize it rather than
                // look for it anew.
                <span className="panel__dep-warn" role="img" aria-label={broken.label} title={broken.label}>
                  !
                </span>
              )}
              {/* The task's name is user content: it is not translated. */}
              {nameOf.get(id) ?? id}
              {canWrite && (
                <button
                  type="button"
                  className="panel__dep-remove"
                  aria-label={t("task.panel.unlink", { name: nameOf.get(id) ?? id })}
                  title={t("task.panel.unlink", { name: nameOf.get(id) ?? id })}
                  onClick={() => {
                    const { from, to } = link(id);
                    remove(from, to);
                  }}
                >
                  ×
                </button>
              )}
            </span>
          );
        })}
        {canWrite &&
          ids.map((id) => {
            const broken = trouble(link(id));
            if (broken === null) return null;
            // The button stands next to the pills rather than inside a pill:
            // inside it would read as part of the task's name, and aiming at it
            // among the text would have to be more precise than is worth asking
            // for the sake of a fix.
            return (
              <button
                key={`fix-${id}`}
                type="button"
                className="button--quiet panel__dep-fix"
                onClick={broken.move}
              >
                {broken.fix}
              </button>
            );
          })}
        {canWrite && options.length > 0 && (
          // The value is always empty: this is not a choice of state but an "add
          // a link" command, and after it the list must return to the prompt.
          <select
            className="panel__dep-add"
            value=""
            aria-label={t("task.panel.add_link_to", { label })}
            onChange={(event) => {
              if (event.target.value === "") return;
              const { from, to } = link(event.target.value);
              add(from, to);
            }}
          >
            <option value="">{t("task.panel.add_link")}</option>
            {options.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        )}
      </span>
    </div>
  );

  return (
    <div className="panel__links">
      {group(t("task.panel.depends_on"), predecessors, candidates(predecessors, successors), (id) => ({
        from: id,
        to: task.id,
      }))}
      {group(t("task.panel.blocks"), successors, candidates(successors, predecessors), (id) => ({
        from: task.id,
        to: id,
      }))}
    </div>
  );
}

/**
 * A summary of the deviation from the baseline plan.
 *
 * As a separate block at the top of the card rather than a line among the
 * fields: this is not a field — it cannot be edited, and standing between "start
 * date" and "duration" it would read as one more value somebody typed in.
 *
 * The list of moves with their reasons lives below, in the history feed: a
 * reason stands next to its own event and date, and a second list of the same
 * events here would mean two places where one and the same thing diverges.
 */
function Baseline({ task, state }: { task: Task; state: ProjectState }) {
  const { t } = useLocale();
  const relative = state.schedule_mode === "relative";

  if (isBeyondPlan(state, task)) {
    return <p className="panel__baseline muted">{t("plan.beyond_plan_explained")}</p>;
  }

  const baseline = baselineOf(task);
  if (baseline === null) return null;

  const shift = endShiftDays(task);
  const deviation = deviationDays(task) ?? 0;

  return (
    <p className="panel__baseline">
      <span className="muted">
        {t("gantt.baseline", {
          from: relative ? relativeDayLabel(t, baseline.start) : formatShortDate(t, baseline.start),
          to: relative ? relativeDayLabel(t, baseline.end) : formatShortDate(t, baseline.end),
        })}
      </span>
      {shift !== null && shift !== 0 && (
        <span className={shift > 0 ? "panel__deviation is-late" : "panel__deviation is-early"}>
          {shift > 0
            ? t("gantt.deviation_late", { days: t("common.days", { count: shift }) })
            : t("gantt.deviation_early", { days: t("common.days", { count: -shift }) })}
        </span>
      )}
      {deviation > 0 && (
        <span className="muted">
          {t("plan.deviation_summary", { days: t("common.days", { count: deviation }) })}
        </span>
      )}
    </p>
  );
}
