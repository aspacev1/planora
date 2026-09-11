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
 * The quote section's dialog — by the same motion as a plan category's (CategoryForm): a button in the
 * toolbar, a dialog with fields, "Create".
 *
 * It also edits an already created section. There is deliberately no separate edit dialog: the fields
 * are the same, and a second one like it would one day diverge from the first — while a section's name
 * and description are also edited right in the table's row, which cannot be reached from the keyboard
 * (see components/rows). The dialog is that very path.
 *
 * There is one difference from a plan category, and it comes from the quote's nature: there is no
 * colour, a quote section is not drawn as a band on the chart, and there is nothing to choose a colour
 * for it for.
 */
export function ProposalCategoryForm({
  projectId,
  category,
  onClose,
}: {
  projectId: string;
  /** The section being edited. `undefined` — a new one is being created. */
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
      // A refetch rather than writing into the cache: the id and the position were assigned by the
      // server — the same argument as with a plan category.
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
        {/* The description is optional: a line about the whole section, it will stand on its row in the
            table next to the sum of the work. */}
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
