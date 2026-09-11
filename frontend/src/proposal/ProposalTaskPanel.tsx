import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  addProposalComment,
  deleteProposalTask,
  proposalComments,
  proposalCommentsQueryKey,
  proposalQueryKey,
  updateProposalTask,
} from "../api/proposal";
import type { EffortUnit, ProposalTask, ProposalTaskPatch } from "../api/proposal";
import { CommentThread } from "../comments/CommentThread";
import { useFieldSaves } from "../components/autosave";
import { ConfirmAction } from "../components/ConfirmAction";
import { IconLock } from "../components/icons";
import { useEscape } from "../components/useEscape";
import { useLocale } from "../i18n/LocaleProvider";
import { TextField, ValueField } from "../task/fields";
import { PanelSection } from "../task/PanelSection";
import { formatAmount, formatMoney, lineAmount } from "./money";
import type { Money } from "./money";

import "../task/panel.css";

/**
 * A quote line's card — the same sliding panel as a plan task's.
 *
 * The task card's markup and classes are reused deliberately: two different drawers in one product
 * would mean a person guessing how each of them closes.
 *
 * The fields are gathered by who will see them rather than by type: "in the client's document" and
 * "team only". A quote is written for the customer, and a person adding a risk must know at first
 * glance whether the line will go into the document or stay inside — otherwise one day the customer
 * will read "the contractor is unreliable".
 */
export function ProposalTaskPanel({
  projectId,
  task,
  categoryName,
  effortUnit,
  currency,
  canWrite,
  onClose,
}: {
  projectId: string;
  task: ProposalTask;
  /** The quote section the line stands in: shown in the header. */
  categoryName: string;
  effortUnit: EffortUnit;
  currency: string;
  canWrite: boolean;
  onClose: () => void;
}) {
  const { t, locale } = useLocale();
  const queryClient = useQueryClient();

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: proposalQueryKey(projectId) });

  // The fields save themselves — on blur, with a mark by the field: the card has no "Save" button,
  // just like the task card.
  const saves = useFieldSaves((patch: ProposalTaskPatch) =>
    updateProposalTask(projectId, task.id, patch).then(invalidate),
  );

  const remove = useMutation({
    mutationFn: () => deleteProposalTask(projectId, task.id),
    onSuccess: async () => {
      onClose();
      await invalidate();
    },
  });

  const commentsQuery = useQuery({
    queryKey: proposalCommentsQueryKey(projectId, task.id),
    queryFn: () => proposalComments(projectId, task.id),
    retry: false,
  });

  const send = useMutation({
    // The whole quote is invalidated rather than only the feed: the reply counter stands on the
    // table's row, and it and the feed must refresh together.
    mutationFn: (body: string) => addProposalComment(projectId, task.id, body),
    onSuccess: invalidate,
  });

  // The same Esc layer as the task card's: the top layer closes rather than everything at once.
  useEscape(onClose);

  const hours = effortUnit === "hours";
  const money = (value: Money) => formatMoney(locale, currency, value);
  // The price formula — "2d × $400.00 per day": the price in the header is not a field, and a person
  // must see what it adds up from to know which field to edit.
  const effort = t(hours ? "proposal.format.hours" : "proposal.format.days", {
    value: formatAmount(locale, task.effort),
  });
  const formula = t(hours ? "proposal.task.formula_hour" : "proposal.task.formula_day", {
    effort,
    rate: money(lineAmount(1, task.rate)),
  });

  return (
    <aside
      className="panel"
      role="complementary"
      aria-label={t("proposal.task.panel_aria", { name: task.name })}
    >
      <header className="panel__head">
        <div className="panel__head-top">
          {/* The line's name is user content: it is not translated. */}
          <h2 className="panel__title">{task.name}</h2>
          <button
            type="button"
            className="panel__close"
            aria-label={t("task.panel.close")}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {/* Section | formula | price — as a dashboard line, like a task's status and period. The
            price is edited through its factors in the fields below. */}
        <p className="panel__meta">
          <span>{categoryName}</span>
          <span className="panel__meta-sep" aria-hidden="true" />
          <span>{formula}</span>
          <span className="panel__meta-sep" aria-hidden="true" />
          <strong>{money(lineAmount(task.effort, task.rate))}</strong>
        </p>
      </header>

      <div className="panel__body">
        <PanelSection title={t("proposal.task.section_client")}>
          <div className="panel__fields">
            <TextField
              id="proposal-task-name"
              label={t("proposal.columns.work_item")}
              value={task.name}
              disabled={!canWrite}
              resetToken={task.id}
              save={saves.at("name")}
              onCommit={(value) => saves.commitText("name", value, (name) => ({ name }))}
            />
            <TextField
              id="proposal-task-role"
              label={t("proposal.task.role")}
              value={task.role}
              disabled={!canWrite}
              resetToken={task.id}
              save={saves.at("role")}
              onCommit={(value) => saves.commit("role", { role: value.trim() })}
            />
            <div className="panel__pair">
              <ValueField
                id="proposal-task-effort"
                label={t(hours ? "proposal.columns.effort_hours" : "proposal.columns.effort_days")}
                type="number"
                value={String(task.effort)}
                disabled={!canWrite}
                resetToken={task.id}
                save={saves.at("effort")}
                onCommit={(value) =>
                  saves.commitNumber("effort", value, (effort) => ({ effort }))
                }
              />
              <ValueField
                id="proposal-task-rate"
                label={t(hours ? "proposal.task.rate_per_hour" : "proposal.task.rate_per_day")}
                type="number"
                value={String(task.rate)}
                disabled={!canWrite}
                resetToken={task.id}
                save={saves.at("rate")}
                onCommit={(value) => saves.commitNumber("rate", value, (rate) => ({ rate }))}
              />
            </div>
            <TextField
              id="proposal-task-description"
              label={t("proposal.task.description")}
              value={task.description}
              rows={2}
              disabled={!canWrite}
              resetToken={task.id}
              save={saves.at("description")}
              onCommit={(value) => saves.commit("description", { description: value })}
            />
            <TextField
              id="proposal-task-details"
              label={t("proposal.task.details")}
              value={task.details}
              rows={5}
              disabled={!canWrite}
              resetToken={task.id}
              save={saves.at("details")}
              onCommit={(value) => saves.commit("details", { details: value })}
            />
          </div>
        </PanelSection>

        <PanelSection
          title={t("proposal.task.section_internal")}
          icon={<IconLock className="panel__section-icon" />}
        >
          <div className="panel__fields">
            <TextField
              id="proposal-task-notes"
              label={t("proposal.task.notes")}
              value={task.notes}
              rows={3}
              disabled={!canWrite}
              resetToken={task.id}
              save={saves.at("notes")}
              onCommit={(value) => saves.commit("notes", { notes: value })}
            />
            <TextField
              id="proposal-task-risks"
              label={t("proposal.task.risks")}
              value={task.risks}
              rows={3}
              disabled={!canWrite}
              resetToken={task.id}
              save={saves.at("risks")}
              onCommit={(value) => saves.commit("risks", { risks: value })}
            />
            <TextField
              id="proposal-task-assumptions"
              label={t("proposal.task.assumptions")}
              value={task.assumptions}
              rows={3}
              disabled={!canWrite}
              resetToken={task.id}
              save={saves.at("assumptions")}
              onCommit={(value) => saves.commit("assumptions", { assumptions: value })}
            />
          </div>
        </PanelSection>

        {/* The conversation about the line uses the same feed as a task's and the public page's: two
            forms of one conversation would diverge on the first edit. */}
        <PanelSection
          title={t("proposal.task.section_discussion")}
          note={t("proposal.task.discussion_note")}
        >
          <CommentThread
            embedded
            comments={commentsQuery.data ?? []}
            loading={commentsQuery.isPending}
            error={commentsQuery.error}
            canComment={canWrite}
            onSend={({ body }) => send.mutateAsync(body)}
            sending={send.isPending}
            sendError={send.error}
          />
        </PanelSection>
      </div>

      {canWrite && (
        <footer className="panel__foot">
          <ConfirmAction
            className="button--quiet"
            label={t("proposal.task.delete")}
            warning={t("proposal.task.delete_warning", { name: task.name })}
            confirm={t("proposal.task.delete_confirm")}
            disabled={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
        </footer>
      )}
    </aside>
  );
}
