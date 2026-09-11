import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { errorKey } from "../api/errors";
import { pushPlanPreview, pushPreviewQueryKey, pushProposalToPlan } from "../api/proposal";
import type { PushPreview } from "../api/proposal";
import { Modal } from "../components/Modal";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * The dialog for transferring the quote into the plan.
 *
 * The button used to transfer everything at once and silently, and a second press doubled the plan.
 * The dialog says what exactly will happen — a section will become a category or land in an existing
 * one, a line will become a task of so many days — and lets you untick what it is too early to
 * transfer. What cannot be transferred it shows disabled rather than hiding: a line marked "already in
 * the plan" explains why it is not in the count, while a hidden one would have to be hunted for.
 *
 * Everything is computed by the server (see proposals.push_preview): the durations and the category
 * matching are its rules, and the dialog does not re-ask them.
 */
export function PushToPlanDialog({
  projectId,
  onClose,
  onDone,
}: {
  projectId: string;
  onClose: () => void;
  onDone: (result: { created_tasks: number; batch_id: string }) => void;
}) {
  const { t } = useLocale();

  const preview = useQuery({
    queryKey: pushPreviewQueryKey(projectId),
    queryFn: () => pushPlanPreview(projectId),
    retry: false,
  });

  // The unticked boxes rather than the ticked ones: by default everything transferable is selected, and
  // only the exceptions have to be remembered — that way the choice does not wait for the server's answer.
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());

  const push = useMutation({
    mutationFn: (taskIds: string[]) => pushProposalToPlan(projectId, taskIds),
    onSuccess: onDone,
  });

  const categories = preview.data?.categories ?? [];
  const selectable = (task: PushPreview["categories"][number]["tasks"][number]) =>
    !task.in_plan && task.estimated;
  const selected = (task: PushPreview["categories"][number]["tasks"][number]) =>
    selectable(task) && !excluded.has(task.id);
  const chosen = categories.flatMap((category) => category.tasks.filter(selected));

  const toggleTask = (id: string) =>
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleSection = (category: PushPreview["categories"][number]) => {
    const rows = category.tasks.filter(selectable);
    const allOn = rows.every(selected);
    setExcluded((current) => {
      const next = new Set(current);
      for (const row of rows) {
        if (allOn) next.add(row.id);
        else next.delete(row.id);
      }
      return next;
    });
  };

  return (
    <Modal title={t("proposal.push.title")} onClose={onClose} wide>
      <p className="push-dialog__lead">{t("proposal.push.lead")}</p>

      {preview.isPending && <p role="status">{t("common.loading")}</p>}
      {preview.error && (
        <p className="error" role="alert">
          {t(errorKey(preview.error))}
        </p>
      )}

      {preview.data && (
        <div className="push-pick">
          {categories.map((category) => {
            const rows = category.tasks.filter(selectable);
            const on = rows.filter(selected);
            const days = on.reduce((sum, task) => sum + task.duration_days, 0);
            return (
              <div key={category.id}>
                <label className="push-pick__group">
                  <input
                    type="checkbox"
                    aria-label={t("proposal.push.section_aria", { name: category.name })}
                    checked={rows.length > 0 && on.length === rows.length}
                    disabled={rows.length === 0}
                    ref={(box) => {
                      // A partial selection is shown with a dash, as in any list with sections: a tick
                      // would lie "everything", an empty box "nothing".
                      if (box) box.indeterminate = on.length > 0 && on.length < rows.length;
                    }}
                    onChange={() => toggleSection(category)}
                  />
                  <span className="push-pick__name">{category.name}</span>
                  <span className="proposal-chip proposal-chip--muted">
                    {category.plan_category
                      ? t("proposal.push.into_category", { name: category.plan_category.name })
                      : t("proposal.push.new_category")}
                  </span>
                  <span className="push-pick__right">
                    {t("proposal.push.rows", { count: on.length })} · {t("common.days", { count: days })}
                  </span>
                </label>
                {category.tasks.map((task) => (
                  <label
                    key={task.id}
                    className={`push-pick__row${selectable(task) ? "" : " push-pick__row--off"}`}
                  >
                    <input
                      type="checkbox"
                      aria-label={t("proposal.push.row_aria", { name: task.name })}
                      checked={selected(task)}
                      disabled={!selectable(task)}
                      onChange={() => toggleTask(task.id)}
                    />
                    <span className="push-pick__name">{task.name}</span>
                    <span className="push-pick__right">
                      {task.in_plan && (
                        <span className="proposal-chip proposal-chip--plan">
                          {t("proposal.push.already")}
                        </span>
                      )}
                      {task.in_plan || task.estimated
                        ? t("common.days", { count: task.duration_days })
                        : t("proposal.push.unestimated")}
                    </span>
                  </label>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {push.error !== null && (
        <p className="error" role="alert">
          {t(errorKey(push.error))}
        </p>
      )}

      <div className="modal__actions">
        <button
          type="button"
          className="button--primary"
          disabled={chosen.length === 0 || push.isPending}
          onClick={() => push.mutate(chosen.map((task) => task.id))}
        >
          {t("proposal.push.confirm", { count: chosen.length })}
        </button>
        <button type="button" className="button--quiet" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <span className="push-dialog__hint">{t("proposal.push.undo_hint")}</span>
      </div>
    </Modal>
  );
}
