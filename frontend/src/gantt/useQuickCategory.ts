import { useRef, useState } from "react";

import { errorKey } from "../api/errors";
import type { ProjectState } from "../api/projects";
import { useToast } from "../components/toast";
import { useLocale } from "../i18n/LocaleProvider";
import { suggestColor } from "../project/categoryColors";
import { useProjectMutation } from "../project/useProjectMutation";

/**
 * A category created from a name alone — as a row at the very bottom of the strip.
 *
 * The same device as `useQuickTask`'s: a plan is written as a list, and a dialog with a colour choice
 * between every row would be an extra step exactly where people just want to continue the list. The
 * colour is picked by the same reckoning as in the creation form (see `project/categoryColors.ts`) —
 * by the number of already existing categories — and it can be corrected later, the same way as
 * always. The full form has gone nowhere: this is a second, short path to the same action rather than
 * a replacement for the first.
 *
 * Sent categories are held in a pending list until the server answers — for the same reason as a
 * task's (see `PendingRow`): an optimistic row is impossible, the server assigns the id and the
 * position.
 */

export type PendingCategory = { id: number; name: string };

export function useQuickCategory({
  projectId,
  state,
}: {
  projectId: string;
  state: ProjectState;
}) {
  const { apply } = useProjectMutation(projectId);
  const { t } = useLocale();
  const showToast = useToast();
  const [pending, setPending] = useState<PendingCategory[]>([]);
  // It counts both the submissions and the already created categories at once: the colour of the next
  // row, sent before the server's answer to the previous one, must differ from it, while
  // `state.categories.length` at that moment does not yet see either of them.
  const sent = useRef(0);

  const create = (name: string) => {
    const id = sent.current + 1;
    const color = suggestColor(state.categories.length + sent.current);
    sent.current = id;
    setPending((rows) => [...rows, { id, name }]);

    void apply({ type: "create_category", name, color }, (current) => current)
      .catch((error: unknown) => {
        // The pending row will disappear while the category never appears: without these words the
        // disappearance would read as "it was saved somewhere".
        showToast({ message: t(errorKey(error)), tone: "error" });
      })
      .finally(() => {
        setPending((rows) => rows.filter((row) => row.id !== id));
      });
  };

  return { create, pending };
}
