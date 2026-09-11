import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { errorKey } from "../api/errors";
import { projectQueryKey } from "../api/projects";
import {
  buildProposalFromPlan,
  createProposalTask,
  deleteProposalCategory,
  deleteProposalTask,
  getProposal,
  proposalQueryKey,
  setProposalStage,
  updateProposalCategory,
  updateProposalSettings,
  updateProposalTask,
} from "../api/proposal";
import type {
  NewProposalTask,
  ProposalSettingsPatch,
  ProposalStage,
  ProposalTaskPatch,
} from "../api/proposal";
import { useFieldSaves } from "../components/autosave";
import { useToast } from "../components/toast";
import { useLocale } from "../i18n/LocaleProvider";
import { formatAmount, formatMoney, formatMoneyAmount, lineAmount, sumMoney, taxOf } from "./money";
import { ProposalCategoryForm } from "./ProposalCategoryForm";
import { ProposalEmptyState } from "./ProposalEmptyState";
import { ProposalNotes } from "./ProposalNotes";
import { ProposalParams } from "./ProposalParams";
import { ProposalStepper } from "./ProposalStepper";
import { ProposalSummary } from "./ProposalSummary";
import { COLUMNS, CategoryRows } from "./ProposalTable";
import type { EffortMath, Formats } from "./ProposalTable";
import { ProposalTaskPanel } from "./ProposalTaskPanel";
import { PushDone } from "./PushDone";
import { PushToPlanDialog } from "./PushToPlanDialog";

import "./proposal.css";

/**
 * The "Proposal" tab: the project's quote before the plan.
 *
 * One table for all the sections, as in the mockup: a section is a heading row
 * with a summary of its own work items, the work items are rows under it, the
 * totals are a card on the right. A line's price and all the totals are computed
 * here, on the screen: they are the product and the sum of numbers already shown,
 * and a server retelling them would be a second place with the same arithmetic
 * (see api/proposal.ts).
 *
 * Sections and lines are created by the same motions as categories and tasks in
 * the strip: every level of the list has its own "plus" in the table — an "Add
 * work" row at the end of a section and "New section" at the bottom (see
 * NewProposalTaskRow) — while the toolbar holds only the deal's stages and the
 * parameters.
 *
 * And they are edited by the same motion: any cell opens on a click and leaves
 * for the server on blur — like the cells of the strip's pinned table
 * (components/rows). A quote is written line by line, checking numbers against
 * their neighbours, and a card for the sake of one rate would mean opening,
 * fixing, closing — on every row in turn. The card is left for what the table
 * does not have: the details, the risks, the assumptions and the conversation.
 *
 * The screen holds the data and the tab's state; the table (ProposalTable), the
 * totals (ProposalSummary) and the notes (ProposalNotes) are their own
 * components, each getting exactly what it shows.
 *
 * While there are no sections, an explanation with two starts stands instead of
 * the table (ProposalEmptyState): an empty table with six headings tells a
 * newcomer neither what this is nor where to begin. The totals card and the stage
 * bar are not shown before the first line either — zeros in them would be an
 * answer to a question nobody asked.
 */
export function Proposal({
  projectId,
  canWrite,
  canExport,
}: {
  projectId: string;
  canWrite: boolean;
  /** Whether the viewer is entitled to get the document for the client (see permissions). */
  canExport: boolean;
}) {
  const { t, locale } = useLocale();
  const queryClient = useQueryClient();
  const toast = useToast();

  const query = useQuery({
    queryKey: proposalQueryKey(projectId),
    queryFn: () => getProposal(projectId),
    retry: false,
  });

  // A line's card is held by id rather than by object: after every edit the state
  // arrives from the server anew, and a card remembering the object would show
  // stale data. The same device as the task card's.
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [addingCategory, setAddingCategory] = useState(false);
  // The section opened for editing in a dialog. By id rather than by object — for
  // the same reason as the line above.
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  // The section a new work line is open in. `null` — closed.
  const [newTaskIn, setNewTaskIn] = useState<string | null>(null);
  // The collapsed sections. An empty set means everything is unfolded: a quote is
  // read whole, and there is no reason to hide anything by default.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  // Whether the transfer-into-the-plan dialog is open.
  const [pushing, setPushing] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: proposalQueryKey(projectId) });

  // The settings and the notes save themselves, like the project settings' fields.
  const saves = useFieldSaves((patch: ProposalSettingsPatch) =>
    updateProposalSettings(projectId, patch).then(invalidate),
  );

  const addTask = useMutation({
    mutationFn: (input: { categoryId: string; task: NewProposalTask }) =>
      createProposalTask(projectId, input.categoryId, input.task),
    onSuccess: invalidate,
  });

  // A deal's stage is marked by hand, in either direction. A refusal goes in a
  // toast: the stage bar stands above the table, and there is no room for an error
  // line under it.
  const mark = useMutation({
    mutationFn: (stage: ProposalStage) => setProposalStage(projectId, stage),
    onSuccess: invalidate,
    onError: (refusal: unknown) => {
      toast({ message: t(errorKey(refusal)), tone: "error" });
    },
  });

  // Assembly from the plan is the start of an empty quote: sections from
  // categories, lines from tasks. A refusal goes in a toast: on an empty screen
  // there is no error line under the table.
  const build = useMutation({
    mutationFn: () => buildProposalFromPlan(projectId),
    onSuccess: async (result) => {
      toast({ message: t("proposal.start.build.done", { count: result.created_tasks }) });
      await invalidate();
    },
    onError: (refusal: unknown) => {
      toast({ message: t(errorKey(refusal)), tone: "error" });
    },
  });

  const removeCategory = useMutation({
    mutationFn: (categoryId: string) => deleteProposalCategory(projectId, categoryId),
    onSuccess: invalidate,
  });

  const patchCategory = useMutation({
    mutationFn: (input: {
      categoryId: string;
      patch: Partial<{ name: string; description: string }>;
    }) => updateProposalCategory(projectId, input.categoryId, input.patch),
    onSuccess: invalidate,
  });

  // Editing a cell is the same operation as in the line's card: the table does not
  // create its own way to change an estimate or a rate, it calls the existing one.
  // The server's answer re-reads the quote whole, and the totals on the right come
  // to agree with the price column on their own.
  const patchTask = useMutation({
    mutationFn: (input: { taskId: string; patch: ProposalTaskPatch }) =>
      updateProposalTask(projectId, input.taskId, input.patch),
    onSuccess: invalidate,
  });

  // There is nothing and no reason to close a deleted line's card with: it is
  // looked up by id in the server's fresh answer and disappears with the line.
  const removeTask = useMutation({
    mutationFn: (taskId: string) => deleteProposalTask(projectId, taskId),
    onSuccess: invalidate,
  });

  // The transfer happened in the dialog; here is what comes after it: a toast with
  // the road to the chart and a "Revert" button, and the project re-read whole —
  // the transfer produces plan revisions, and the quote's nested key is
  // invalidated by the same call.
  const pushed = async (result: { created_tasks: number; batch_id: string }) => {
    setPushing(false);
    toast({
      message: t("proposal.push.done", { count: result.created_tasks }),
      action: <PushDone projectId={projectId} batchId={result.batch_id} />,
    });
    await queryClient.invalidateQueries({ queryKey: projectQueryKey(projectId) });
  };

  if (query.isPending) {
    return <p role="status">{t("common.loading")}</p>;
  }

  if (query.error) {
    return (
      <p className="error" role="alert">
        {t(errorKey(query.error))}
      </p>
    );
  }

  const proposal = query.data;

  if (proposal.categories.length === 0) {
    return (
      <div className="proposal proposal--start">
        <div className="proposal__main">
          <ProposalEmptyState
            proposal={proposal}
            canWrite={canWrite}
            saves={saves}
            onNewCategory={() => setAddingCategory(true)}
            onBuild={() => build.mutate()}
            building={build.isPending}
          />
        </div>
        {addingCategory && (
          <ProposalCategoryForm projectId={projectId} onClose={() => setAddingCategory(false)} />
        )}
      </div>
    );
  }

  const tasks = proposal.categories.flatMap((category) => category.tasks);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const selectedCategory =
    proposal.categories.find((category) => category.id === selectedTask?.category_id) ?? null;
  const editingCategory =
    proposal.categories.find((category) => category.id === editingCategoryId) ?? null;
  const hours = proposal.effort_unit === "hours";

  // The estimate lives in the quote's unit and is shown in both: the days column
  // and the hours column are converted through "hours in a day" — the same rules
  // by which the transfer into the plan computes durations. The reverse conversion
  // is needed for editing: people edit the column they are looking at.
  const math: EffortMath = {
    toDays: (effort) => (hours ? effort / proposal.hours_per_day : effort),
    toHours: (effort) => (hours ? effort : effort * proposal.hours_per_day),
    effortOfDays: (value) => (hours ? value * proposal.hours_per_day : value),
    effortOfHours: (value) => (hours ? value : value / proposal.hours_per_day),
  };

  const formats: Formats = {
    days: (value) => t("proposal.format.days", { value: formatAmount(locale, value) }),
    hoursLabel: (value) => t("proposal.format.hours", { value: formatAmount(locale, value) }),
    amount: (value) => formatAmount(locale, value),
    price: (value) => formatMoneyAmount(locale, value),
    money: (value) => formatMoney(locale, proposal.currency, value),
  };
  // The rate is per day or per hour, and the column's heading must say so: a bare
  // "Rate" does not answer the question "for what".
  const unitLetter = t(hours ? "proposal.format.hour_letter" : "proposal.format.day_letter");

  const subtotal = sumMoney(tasks.map((task) => lineAmount(task.effort, task.rate)));
  const tax = taxOf(subtotal, proposal.tax_rate_pct);
  const totalDays = tasks.reduce((sum, task) => sum + math.toDays(task.effort), 0);
  const totalHours = tasks.reduce((sum, task) => sum + math.toHours(task.effort), 0);

  const toggle = (categoryId: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });

  const createTask = (categoryId: string) => (task: NewProposalTask) =>
    addTask.mutate({ categoryId, task });

  const failure =
    addTask.error ?? removeCategory.error ?? patchCategory.error ?? patchTask.error ?? removeTask.error;

  return (
    <div className="proposal">
      <div className="proposal__main">
        <div className="proposal__toolbar">
          <ProposalStepper
            status={proposal.status}
            sentAt={proposal.sent_at}
            agreedAt={proposal.agreed_at}
            pushedCount={proposal.pushed_count}
            pushableCount={proposal.pushable_count}
            totalRows={tasks.length}
            canWrite={canWrite}
            marking={mark.isPending}
            onMark={(stage) => mark.mutate(stage)}
            onPush={() => setPushing(true)}
          />
          <ProposalParams proposal={proposal} canWrite={canWrite} saves={saves} />
        </div>

        {/* The table scrolls sideways within its own banks: six columns with
            names, descriptions and money do not get any narrower than they are on
            a narrow screen — and without this they would slide under the totals
            card, and the price column would disappear entirely. */}
        <div className="proposal-table__scroll">
            <table className="proposal-table">
              <thead>
                <tr>
                  <th>{t("proposal.columns.work_item")}</th>
                  <th>{t("proposal.columns.role")}</th>
                  <th>{t("proposal.columns.description")}</th>
                  <th className="proposal-table__num">{t("proposal.columns.effort")}</th>
                  <th className="proposal-table__num">
                    {t("proposal.columns.rate_unit", {
                      currency: proposal.currency,
                      unit: unitLetter,
                    })}
                  </th>
                  <th className="proposal-table__num">
                    {t("proposal.columns.price_unit", { currency: proposal.currency })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {proposal.categories.map((category) => (
                  <CategoryRows
                    key={category.id}
                    projectId={projectId}
                    category={category}
                    open={!collapsed.has(category.id)}
                    canWrite={canWrite}
                    unit={proposal.effort_unit}
                    currency={proposal.currency}
                    suggestions={proposal.role_suggestions}
                    math={math}
                    formats={formats}
                    addingTask={newTaskIn === category.id}
                    onToggle={() => toggle(category.id)}
                    onAddTask={() => setNewTaskIn(category.id)}
                    onCloseNewTask={() => setNewTaskIn(null)}
                    onCreateTask={createTask(category.id)}
                    onDelete={() => removeCategory.mutate(category.id)}
                    onEdit={() => setEditingCategoryId(category.id)}
                    onPatch={(patch) => patchCategory.mutate({ categoryId: category.id, patch })}
                    onPatchTask={(taskId, patch) => patchTask.mutate({ taskId, patch })}
                    onDeleteTask={(taskId) => removeTask.mutate(taskId)}
                    onOpenTask={(taskId) =>
                      // A repeat click on the same row closes the card — by the
                      // same motion that opened it. As with the task card.
                      setSelectedTaskId((current) => (current === taskId ? null : taskId))
                    }
                    t={t}
                  />
                ))}
                {/* A section is created by a row at the bottom of the table — with
                    a dialog, like a category in the strip: a section has a
                    description, and one input row cannot ask for it. */}
                {canWrite && (
                  <tr className="proposal-row proposal-row--add">
                    <td colSpan={COLUMNS}>
                      <button
                        type="button"
                        className="proposal-add proposal-add--section"
                        onClick={() => setAddingCategory(true)}
                      >
                        <span className="proposal-add__plus" aria-hidden="true">
                          +
                        </span>
                        {t("proposal.category.create")}
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

        {failure && (
          <p className="error" role="alert">
            {t(errorKey(failure))}
          </p>
        )}

        <ProposalNotes
          notes={proposal.notes}
          canWrite={canWrite}
          save={saves.at("notes")}
          onCommit={(value) => saves.commit("notes", { notes: value })}
        />
      </div>

      <ProposalSummary
        projectId={projectId}
        currency={proposal.currency}
        taxRatePct={proposal.tax_rate_pct}
        totalHours={totalHours}
        totalDays={totalDays}
        subtotal={subtotal}
        tax={tax}
        formats={formats}
        canWrite={canWrite}
        canExport={canExport}
        status={proposal.status}
        pushedCount={proposal.pushed_count}
        pushableCount={proposal.pushable_count}
        onPush={() => setPushing(true)}
      />

      {pushing && (
        <PushToPlanDialog projectId={projectId} onClose={() => setPushing(false)} onDone={pushed} />
      )}

      {selectedTask && (
        <ProposalTaskPanel
          projectId={projectId}
          task={selectedTask}
          categoryName={selectedCategory?.name ?? ""}
          effortUnit={proposal.effort_unit}
          currency={proposal.currency}
          canWrite={canWrite}
          onClose={() => setSelectedTaskId(null)}
        />
      )}

      {addingCategory && (
        <ProposalCategoryForm projectId={projectId} onClose={() => setAddingCategory(false)} />
      )}

      {/* The section dialog when editing is the same as when creating: the name
          and the description are also edited right in the row, but the cell cannot
          be reached from the keyboard (see components/rows), and the dialog stays
          that very path. */}
      {editingCategory && (
        <ProposalCategoryForm
          projectId={projectId}
          category={editingCategory}
          onClose={() => setEditingCategoryId(null)}
        />
      )}
    </div>
  );
}
