import { Link } from "react-router-dom";

import type {
  EffortUnit,
  NewProposalTask,
  ProposalCategory,
  ProposalTask,
  ProposalTaskPatch,
  RoleSuggestion,
} from "../api/proposal";
import { ConfirmAction } from "../components/ConfirmAction";
import { CommentIcon, EditableCell, PencilIcon, RowBadge, RowIcon } from "../components/rows";
import { NewProposalTaskRow } from "./NewProposalTaskRow";
import { isPositive, lineAmount, moneyToNumber, sumMoney } from "./money";
import type { Money } from "./money";

/** The table's columns: work, role, description, estimate, rate, price. */
export const COLUMNS = 6;

/** A caption translated by the screen: the table does not open the dictionary itself. */
type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * The conversions between a line's effort and what is shown in the columns.
 *
 * The estimate lives in the quote's unit and is shown in both: days and hours are
 * converted through "hours in a day" — by the same rules the transfer into the
 * plan computes durations with. The reverse conversion is needed for editing:
 * people edit the column they are looking at, and what they write is converted
 * into effort by the same number it was shown with.
 */
export type EffortMath = {
  toDays: (effort: number) => number;
  toHours: (effort: number) => number;
  effortOfDays: (value: number) => number;
  effortOfHours: (value: number) => number;
};

/**
 * Numbers in words and in money — the screen's formatters, which know the
 * language and the currency.
 *
 * In the table's cells money comes without a currency (`amount`): the currency is
 * named once in the column's heading, and a "$" in every one of forty cells would
 * only crowd the numbers. In the totals it comes with a currency (`money`): a
 * total is read apart from the heading.
 */
export type Formats = {
  days: (value: number) => string;
  hoursLabel: (value: number) => string;
  amount: (value: number) => string;
  /** A cost without a currency — an exact sum rather than a number (see money.ts). */
  price: (value: Money) => string;
  money: (value: Money) => string;
};

/**
 * A section in the table: a heading row with a summary and the work rows under it.
 *
 * A section's summary is the sums of its lines; the rate is shown only when it is
 * the same on all of them: an average of different rates means nothing, while the
 * first one to hand lies.
 */
export function CategoryRows({
  projectId,
  category,
  open,
  canWrite,
  unit,
  currency,
  suggestions,
  math,
  formats,
  addingTask,
  onToggle,
  onAddTask,
  onCloseNewTask,
  onCreateTask,
  onDelete,
  onEdit,
  onPatch,
  onPatchTask,
  onDeleteTask,
  onOpenTask,
  t,
}: {
  projectId: string;
  category: ProposalCategory;
  open: boolean;
  canWrite: boolean;
  unit: EffortUnit;
  currency: string;
  suggestions: RoleSuggestion[];
  math: EffortMath;
  formats: Formats;
  addingTask: boolean;
  onToggle: () => void;
  onAddTask: () => void;
  onCloseNewTask: () => void;
  onCreateTask: (input: NewProposalTask) => void;
  onDelete: () => void;
  /** Open the section's dialog: the name and the description are edited there from the keyboard. */
  onEdit: () => void;
  onPatch: (patch: Partial<{ name: string; description: string }>) => void;
  onPatchTask: (taskId: string, patch: ProposalTaskPatch) => void;
  onDeleteTask: (taskId: string) => void;
  onOpenTask: (taskId: string) => void;
  t: Translate;
}) {
  const categoryEffort = category.tasks.reduce((sum, task) => sum + task.effort, 0);
  const categoryPrice = sumMoney(category.tasks.map((task) => lineAmount(task.effort, task.rate)));
  const rates = new Set(category.tasks.map((task) => task.rate));
  const uniformRate = rates.size === 1 ? [...rates][0] : null;

  const toggleLabel = t(open ? "proposal.category.collapse" : "proposal.category.expand", {
    name: category.name,
  });

  return (
    <>
      <tr className="proposal-row proposal-row--category">
        <td>
          <span className="proposal-row__name">
            <button
              type="button"
              className="row-chevron"
              aria-expanded={open}
              aria-label={toggleLabel}
              title={toggleLabel}
              onClick={onToggle}
            >
              {open ? "▾" : "▸"}
            </button>
            {/* The section's name is user content: it is not translated. */}
            <span className="proposal-row__field">
              <EditableCell
                type="text"
                value={category.name}
                display={category.name}
                disabled={!canWrite}
                label={t("proposal.category.rename", { name: category.name })}
                onCommit={(value) => {
                  const name = value.trim();
                  if (name !== "" && name !== category.name) onPatch({ name });
                }}
              />
            </span>
            {canWrite && (
              // The row's signs are the same as a strip row's, and they stay just
              // as quiet: a permanent delete next to every section reads as a
              // threat. Each one's caption includes the section's name — with a
              // dozen sections, nameless signs are indistinguishable on a screen
              // reader. There is no "plus" here: work is created by a row at the
              // end of the section.
              <span className="row-icons">
                <RowIcon
                  label={t("proposal.category.edit", { name: category.name })}
                  onClick={onEdit}
                >
                  <PencilIcon />
                </RowIcon>
                <ConfirmAction
                  className="row-icon row-icon--danger"
                  icon="×"
                  label={t("proposal.category.delete", { name: category.name })}
                  warning={t("proposal.category.delete_warning", { name: category.name })}
                  confirm={t("proposal.category.delete_confirm")}
                  onConfirm={onDelete}
                />
              </span>
            )}
          </span>
        </td>
        <td></td>
        <td className="proposal-table__desc">
          <EditableCell
            type="text"
            value={category.description}
            display={category.description}
            disabled={!canWrite}
            allowEmpty
            label={t("proposal.category.describe", { name: category.name })}
            onCommit={(description) => onPatch({ description })}
          />
        </td>
        {/* A section's numbers are a summary of its lines rather than values:
            editing them would mean changing who knows which work item. Like a category row in the strip. */}
        <td className="proposal-table__num">
          <Estimate effort={categoryEffort} unit={unit} math={math} formats={formats} />
        </td>
        <td className="proposal-table__num muted">
          {uniformRate !== null && uniformRate > 0 ? formats.amount(uniformRate) : ""}
        </td>
        <td className="proposal-table__num proposal-table__price">
          {isPositive(categoryPrice) ? formats.price(categoryPrice) : ""}
        </td>
      </tr>

      {open &&
        category.tasks.map((task) => (
          <TaskRow
            key={task.id}
            projectId={projectId}
            task={task}
            canWrite={canWrite}
            unit={unit}
            math={math}
            formats={formats}
            onOpen={() => onOpenTask(task.id)}
            onPatch={(patch) => onPatchTask(task.id, patch)}
            onDelete={() => onDeleteTask(task.id)}
            t={t}
          />
        ))}

      {addingTask && (
        <NewProposalTaskRow
          columns={COLUMNS}
          label={t("proposal.task.new_label", { name: category.name })}
          placeholder={t("proposal.task.new_placeholder")}
          unit={unit}
          currency={currency}
          suggestions={suggestions}
          onCreate={onCreateTask}
          onClose={onCloseNewTask}
        />
      )}

      {/* Work is created by a row at the end of its section — like a task in the
          strip: every level of the list has its own "plus", and the toolbar does
          not need the buttons. In a collapsed section there is no such row:
          there is no point putting work into something you cannot see. */}
      {open && canWrite && !addingTask && (
        <tr className="proposal-row proposal-row--add">
          <td colSpan={COLUMNS}>
            <button type="button" className="proposal-add" onClick={onAddTask}>
              <span className="proposal-add__plus" aria-hidden="true">
                +
              </span>
              {t("proposal.category.add_task", { name: category.name })}
            </button>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The estimate in the quote's unit and, next to it, in the other one, in small
 * type: both are needed, but one of them is the main one, and the second must not
 * read as one more column.
 */
function Estimate({
  effort,
  unit,
  math,
  formats,
}: {
  effort: number;
  unit: EffortUnit;
  math: EffortMath;
  formats: Formats;
}) {
  if (effort === 0) return <span className="cell-value faint">—</span>;
  const days = math.toDays(effort);
  const hours = math.toHours(effort);
  return (
    <span className="proposal-estimate">
      <span className="cell-value">
        {unit === "hours" ? formats.hoursLabel(hours) : formats.days(days)}
      </span>
      <span className="proposal-hours">
        {unit === "hours" ? formats.days(days) : formats.hoursLabel(hours)}
      </span>
    </span>
  );
}

/**
 * A work row: every cell is edited in place.
 *
 * The estimate lives in the line's effort and is edited in the quote's unit; the
 * second unit stands next to it in small type, for checking. The price is the
 * estimate times the rate, and editing it changes the rate: "this line costs five
 * thousand" is said in exactly that way, and the estimate is not revisited at that
 * moment. A line without an estimate has no multiplier, and there is nothing to
 * set its price with. An empty role, estimate and rate hint at what goes in them: a
 * dash would say "empty" rather than "in here".
 *
 * The card is left for what the table does not have: the details, the risks, the
 * assumptions and the conversation. It is opened by the "edit" sign — which is
 * also the only path there from the keyboard: the cells open on a click (see
 * components/rows).
 */
function TaskRow({
  projectId,
  task,
  canWrite,
  unit,
  math,
  formats,
  onOpen,
  onPatch,
  onDelete,
  t,
}: {
  projectId: string;
  task: ProposalTask;
  canWrite: boolean;
  unit: EffortUnit;
  math: EffortMath;
  formats: Formats;
  onOpen: () => void;
  onPatch: (patch: ProposalTaskPatch) => void;
  onDelete: () => void;
  t: Translate;
}) {
  /** "Change: {column} on “{name}”" — the caption of the field opened in place. */
  const label = (column: string) =>
    t("proposal.cell.edit", { column: t(column), name: task.name });
  const price = lineAmount(task.effort, task.rate);

  const commit = {
    name: (value: string) => {
      const name = value.trim();
      if (name !== "" && name !== task.name) onPatch({ name });
    },
    effort: (value: number | null) => {
      const effort = value === null ? null : rounded(value);
      if (effort !== null && effort !== task.effort) onPatch({ effort });
    },
    rate: (value: string) => {
      const parsed = amount(value);
      if (parsed !== null && rounded(parsed) !== task.rate) onPatch({ rate: rounded(parsed) });
    },
    price: (value: string) => {
      const parsed = amount(value);
      // There is nothing to divide by: a line without an estimate does not decompose its price into a rate.
      if (parsed === null || task.effort === 0) return;
      const next = rounded(parsed / task.effort);
      if (next !== task.rate) onPatch({ rate: next });
    },
  };

  return (
    <tr className="proposal-row proposal-row--task">
      <td>
        <span className="proposal-row__name proposal-row__name--task">
          {/* The line's name is user content: it is not translated.

              For a reader a click on the name opens the card — as before: it
              cannot be an edit, while the card with everything the table does not
              have is open for them to read too. For someone who writes the same
              motion opens the cell, and the card is opened by the "edit" sign on
              the right: two different jobs do not fit on one click. */}
          <span className="proposal-row__field">
            {canWrite ? (
              <EditableCell
                type="text"
                value={task.name}
                display={task.name}
                label={label("proposal.columns.work_item")}
                onCommit={commit.name}
              />
            ) : (
              <button type="button" className="cell-value proposal-row__open" onClick={onOpen}>
                {task.name}
              </button>
            )}
          </span>
          {/* The line is already in the plan: the marker leads to its task on the
              chart. As a link rather than as text — "where is it now" is exactly
              the question this marker is asked. */}
          {task.plan_task_id && (
            <Link
              className="proposal-chip proposal-chip--plan"
              to={`/projects/${projectId}?task=${task.plan_task_id}`}
              aria-label={t("proposal.task.in_plan_aria", { name: task.name })}
            >
              {t("proposal.task.in_plan")}
            </Link>
          )}
          <span className="row-icons">
            {(task.comment_count > 0 || canWrite) && (
              <RowBadge
                // The caption is the same as the counter's on a strip row: the
                // conversation is one and the same conversation, wherever it is opened.
                label={t("comments.aria", { name: task.name, count: task.comment_count })}
                set={task.comment_count > 0}
                onClick={onOpen}
              >
                <CommentIcon />
                {task.comment_count > 0 && task.comment_count}
              </RowBadge>
            )}
            {canWrite && (
              <>
                <RowIcon label={t("proposal.task.edit", { name: task.name })} onClick={onOpen}>
                  <PencilIcon />
                </RowIcon>
                <ConfirmAction
                  className="row-icon row-icon--danger"
                  icon="×"
                  label={t("proposal.task.remove", { name: task.name })}
                  warning={t("proposal.task.delete_warning", { name: task.name })}
                  confirm={t("proposal.task.delete_confirm")}
                  onConfirm={onDelete}
                />
              </>
            )}
          </span>
        </span>
      </td>
      <td className="role">
        <EditableCell
          type="text"
          value={task.role}
          display={task.role}
          disabled={!canWrite}
          allowEmpty
          placeholder={t("proposal.cell.role_hint")}
          label={label("proposal.columns.role")}
          onCommit={(role) => onPatch({ role: role.trim() })}
        />
      </td>
      <td className="proposal-table__desc">
        <EditableCell
          type="text"
          value={task.description}
          display={task.description}
          disabled={!canWrite}
          allowEmpty
          label={label("proposal.columns.description")}
          onCommit={(description) => onPatch({ description })}
        />
      </td>
      <td className="proposal-table__num">
        <span className="proposal-estimate">
          <EditableCell
            type="number"
            step="any"
            min={0}
            value={String(task.effort)}
            display={
              task.effort > 0
                ? unit === "hours"
                  ? formats.hoursLabel(task.effort)
                  : formats.days(task.effort)
                : ""
            }
            placeholder={t("proposal.cell.effort_hint")}
            disabled={!canWrite}
            label={label("proposal.columns.effort")}
            onCommit={(value) => commit.effort(amount(value))}
          />
          {task.effort > 0 && (
            <span className="proposal-hours">
              {unit === "hours"
                ? formats.days(math.toDays(task.effort))
                : formats.hoursLabel(math.toHours(task.effort))}
            </span>
          )}
        </span>
      </td>
      <td className="proposal-table__num muted">
        <EditableCell
          type="number"
          step="any"
          min={0}
          value={String(task.rate)}
          display={task.rate > 0 ? formats.amount(task.rate) : ""}
          placeholder={t("proposal.cell.rate_hint")}
          disabled={!canWrite}
          label={label("proposal.columns.rate")}
          onCommit={commit.rate}
        />
      </td>
      <td className="proposal-table__num">
        <EditableCell
          type="number"
          step="any"
          min={0}
          value={String(moneyToNumber(price))}
          display={isPositive(price) ? formats.price(price) : ""}
          disabled={!canWrite || task.effort === 0}
          label={label("proposal.columns.price")}
          onCommit={commit.price}
        />
      </td>
    </tr>
  );
}

/**
 * The number from a cell — or `null` if what is written is not a number.
 *
 * Negatives do not pass: neither an estimate, nor a rate, nor a price is ever
 * less than zero, and the server will refuse — but this can be said here too,
 * without asking anyone.
 */
function amount(text: string): number | null {
  const value = Number(text);
  return text.trim() === "" || !Number.isFinite(value) || value < 0 ? null : value;
}

/**
 * Two decimal places — exactly as many as the server stores.
 *
 * The quote's conversions divide: 25 hours at an eight-hour day is 3.125 days,
 * while the price column decomposed into a rate gives an infinite fraction
 * outright. Sending it whole means asking the server for a precision its column
 * does not have, and getting back a rounding nobody asked for.
 */
function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}
