import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { errorKey } from "../api/errors";
import { pushPlanPreview, pushPreviewQueryKey, pushProposalToPlan } from "../api/proposal";
import type { PushPreview } from "../api/proposal";
import { Modal } from "../components/Modal";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * Окно переноса сметы в план.
 *
 * Прежде кнопка переносила всё сразу и молча, и второе нажатие удваивало
 * план. Окно говорит, что именно случится — раздел станет категорией или
 * ляжет в существующую, строка станет задачей на столько-то дней, — и даёт
 * снять галочку с того, что переносить рано. Что переносить нельзя, оно
 * показывает выключенным, а не прячет: строка «уже в плане» объясняет, почему
 * её нет в счёте, а спрятанная заставила бы искать.
 *
 * Считает всё сервер (см. proposals.push_preview): длительности и
 * сопоставление категорий — его правила, и окно их не переспрашивает.
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

  // Снятые галочки, а не поставленные: по умолчанию выбрано всё переносимое,
  // и помнить надо только исключения — так выбор не ждёт ответа сервера.
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
                      // Частичный выбор — минусом, как в любом списке с
                      // разделами: галочка врала бы «всё», пустой квадрат —
                      // «ничего».
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
                    {t("common.tasks", { count: on.length })} · {t("common.days", { count: days })}
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
