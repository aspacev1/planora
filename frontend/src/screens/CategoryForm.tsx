import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { CSSProperties } from "react";

import { errorKey } from "../api/errors";
import { applyOp, projectQueryKey } from "../api/projects";
import { Field } from "../components/Field";
import { Modal } from "../components/Modal";
import { useLocale } from "../i18n/LocaleProvider";
import { CATEGORY_COLORS, suggestColor } from "../project/categoryColors";

// The palette and the colour picking moved into `project/categoryColors.ts` — they gained a second
// consumer (quickly adding a category from the bottom of the strip), and a second copy of the same
// numbers would one day diverge from this one. The re-export keeps the former import path working —
// the form was called their source and stays so for everyone who already refers to it.
export { CATEGORY_COLORS, suggestColor };

export function CategoryForm({
  projectId,
  suggested,
  onClose,
}: {
  projectId: string;
  suggested: string;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [color, setColor] = useState(suggested);

  const create = useMutation({
    mutationFn: (payload: { name: string; color: string }) =>
      applyOp(projectId, { type: "create_category", name: payload.name, color: payload.color }),
    onSuccess: async () => {
      // The state is refetched whole rather than written into the cache by hand. The id and the
      // position were assigned by the server; inventing them on the client means creating a row in
      // the cache that does not exist on the server — and finding out about it on the very first
      // action over it.
      await queryClient.invalidateQueries({ queryKey: projectQueryKey(projectId) });
      onClose();
    },
  });

  // The name goes as typed — only without the edge whitespace. The form used to raise it to capitals
  // so that a group's heading in the strip read uniformly; in practice caps at the same size as the
  // tasks inflated a category's row and truncated long names with an ellipsis prematurely, while
  // uniformity is given to the row by the typeface (see .gantt__row--category in gantt.css) rather
  // than by the letters' case.
  const trimmed = name.trim();

  return (
    <Modal
      title={t("category.new.title")}
      onClose={onClose}
      // The colour counts as input too: picked by hand from ten circles, it is lost to a stray click
      // outside the dialog just as the name is.
      dirty={name !== "" || color !== suggested}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate({ name: trimmed, color });
        }}
      >
        <Field
          id="category-name"
          label={t("category.new.name")}
          value={name}
          onChange={setName}
        />

        {/* A set of radios rather than a list: exactly one colour is chosen, and the keyboard arrows
            must walk it by themselves — that behaviour is given by the browser to a group of radio
            buttons with a shared `name`. The circle itself is the radio button, repainted in CSS:
            replacing it with markup of our own would mean taking the keyboard and the screen reader
            away from the browser. */}
        <fieldset className="fieldset swatches">
          <legend>{t("category.new.color")}</legend>
          <div className="swatches__row">
            {CATEGORY_COLORS.map((option) => (
              <input
                key={option.value}
                type="radio"
                className="swatch"
                name="category-color"
                value={option.value}
                checked={color === option.value}
                onChange={() => setColor(option.value)}
                aria-label={t(`category.new.colors.${option.name}`)}
                style={{ "--swatch": option.value } as CSSProperties}
              />
            ))}
          </div>
        </fieldset>

        {create.error && (
          <p className="error" role="alert">
            {t(errorKey(create.error))}
          </p>
        )}

        <div className="modal__actions">
          <button type="submit" disabled={trimmed === "" || create.isPending}>
            {t("common.create")}
          </button>
          <button type="button" className="button--quiet" onClick={onClose}>
            {t("common.cancel")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
