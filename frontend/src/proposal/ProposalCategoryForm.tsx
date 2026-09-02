import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { errorKey } from "../api/errors";
import {
  createProposalCategory,
  proposalQueryKey,
  updateProposalCategory,
} from "../api/proposal";
import type { ProposalCategory } from "../api/proposal";
import { Field } from "../components/Field";
import { Modal } from "../components/Modal";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * Окно раздела сметы — тем же движением, что категория плана (CategoryForm):
 * кнопка в тулбаре, окно с полями, «Создать».
 *
 * Оно же правит уже заведённый раздел. Отдельного окна правки нет намеренно:
 * поля те же самые, и второе такое же однажды разошлось бы с первым — а имя и
 * описание раздела правятся ещё и прямо в строке таблицы, до которой с
 * клавиатуры не дойти (см. components/rows). Окно — тот самый путь.
 *
 * Отличие от категории плана одно, и оно — от природы сметы: цвета нет,
 * раздел сметы не рисуется полосой на диаграмме, и выбирать ему цвет не для
 * чего.
 */
export function ProposalCategoryForm({
  projectId,
  category,
  onClose,
}: {
  projectId: string;
  /** Раздел на правке. `undefined` — заводится новый. */
  category?: ProposalCategory;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const [name, setName] = useState(category?.name ?? "");
  const [description, setDescription] = useState(category?.description ?? "");

  const save = useMutation({
    mutationFn: () =>
      category === undefined
        ? createProposalCategory(projectId, name.trim(), description.trim())
        : updateProposalCategory(projectId, category.id, {
            name: name.trim(),
            description: description.trim(),
          }),
    onSuccess: async () => {
      // Перезапрос, а не дописывание в кэш: идентификатор и позицию назначил
      // сервер — тот же довод, что у категории плана.
      await queryClient.invalidateQueries({ queryKey: proposalQueryKey(projectId) });
      onClose();
    },
  });

  const changed =
    name !== (category?.name ?? "") || description !== (category?.description ?? "");

  return (
    <Modal
      title={
        category === undefined
          ? t("proposal.category.new_title")
          : t("proposal.category.edit_title")
      }
      onClose={onClose}
      dirty={changed}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() === "") return;
          save.mutate();
        }}
      >
        <Field
          id="proposal-category-name"
          label={t("proposal.category.name")}
          value={name}
          onChange={setName}
        />
        {/* Описание — по желанию: строка о разделе целиком, она встанет на
            его строке в таблице рядом с суммой работ. */}
        <Field
          id="proposal-category-description"
          label={t("proposal.category.description")}
          value={description}
          onChange={setDescription}
        />

        {save.error !== null && (
          <p className="error" role="alert">
            {t(errorKey(save.error))}
          </p>
        )}

        <div className="modal__actions">
          <button type="submit" disabled={name.trim() === "" || save.isPending}>
            {t(category === undefined ? "common.create" : "common.save")}
          </button>
          <button type="button" className="button--quiet" onClick={onClose}>
            {t("common.cancel")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
