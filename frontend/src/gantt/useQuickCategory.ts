import { useRef, useState } from "react";

import { errorKey } from "../api/errors";
import type { ProjectState } from "../api/projects";
import { useToast } from "../components/toast";
import { useLocale } from "../i18n/LocaleProvider";
import { suggestColor } from "../project/categoryColors";
import { useProjectMutation } from "../project/useProjectMutation";

/**
 * Категория, заведённая одним именем — строкой с самого низа ленты.
 *
 * Тот же приём, что и у `useQuickTask`: план пишут списком, и окно с выбором
 * цвета между каждой строкой было бы лишним шагом там, где хотят просто
 * продолжить список. Цвет подбирается тем же счётом, что и в форме создания
 * (см. `project/categoryColors.ts`) — по числу уже существующих категорий, — а
 * поправить его можно позже, тем же путём, что и всегда. Полноценная форма
 * никуда не делась: это второй, короткий путь к тому же действию, а не замена
 * первому.
 *
 * Отправленные категории держатся списком ожидания, пока сервер не ответит —
 * по той же причине, что и у задачи (см. `PendingRow`): оптимистичной строки
 * быть не может, идентификатор и позицию назначает сервер.
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
  // Считает и отправки, и уже заведённые категории разом: цвет следующей
  // строки, отправленной раньше ответа сервера на предыдущую, обязан
  // отличаться от неё, а `state.categories.length` в этот момент ещё не
  // видит ни одной из них.
  const sent = useRef(0);

  const create = (name: string) => {
    const id = sent.current + 1;
    const color = suggestColor(state.categories.length + sent.current);
    sent.current = id;
    setPending((rows) => [...rows, { id, name }]);

    void apply({ type: "create_category", name, color }, (current) => current)
      .catch((error: unknown) => {
        // Строка ожидания исчезнет, а категории так и не появится: без этих
        // слов исчезновение читалось бы как «сохранилось где-то там».
        showToast({ message: t(errorKey(error)), tone: "error" });
      })
      .finally(() => {
        setPending((rows) => rows.filter((row) => row.id !== id));
      });
  };

  return { create, pending };
}
