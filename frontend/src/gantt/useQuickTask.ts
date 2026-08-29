import { useRef, useState } from "react";

import { errorKey } from "../api/errors";
import type { ProjectState } from "../api/projects";
import { useToast } from "../components/toast";
import { useLocale } from "../i18n/LocaleProvider";
import { useProjectMutation } from "../project/useProjectMutation";
import { RELATIVE_EPOCH } from "./relative";
import { useToday } from "../time/useToday";

/**
 * Задача, заведённая одним именем.
 *
 * Всё остальное у неё уже есть: день, срок в один рабочий день и статус
 * «запланировано». Это не сокращённый набор полей, а разделение вопросов: «что
 * нужно сделать» спрашивают, когда пишут план списком, а «когда и кем» — когда
 * его раскладывают по времени, и второе делается в карточке задачи и
 * перетаскиванием полоски.
 *
 * Отправленные задачи держатся списком ожидания, пока сервер не ответит.
 * Оптимистичной строки у создания быть не может — почему, сказано у `PendingRow`.
 */

export type PendingTask = { id: number; categoryId: string; name: string };

/**
 * День, в который встаёт новая задача: сегодняшний — или начало своего этапа,
 * если этап ещё впереди.
 *
 * Не просто «сегодня». Планы пишут наперёд: этап, который начнётся в октябре,
 * заполняют в августе, и каждая заведённая задача уезжала бы на два месяца
 * левее собственного этапа, растягивая ленту пустотой до сегодняшнего дня, —
 * то есть попадала бы за пределы видимого окна и требовала переноса
 * немедленно. Обе границы — нижние, поэтому берётся большая: у идущего этапа
 * побеждает сегодня (задача, заведённая сегодня, вчера не начиналась), у
 * будущего — его начало.
 *
 * У плана без дат сегодняшнего дня не существует вовсе, и нижняя граница там —
 * первый день проекта: настоящих дат на этой оси нет, а координата нужна.
 * Пустой этап никуда не ведёт: у него нет начала, и остаётся одна граница.
 */
export function startDayFor(state: ProjectState, categoryId: string, today: string): string {
  const floor = state.schedule_mode === "relative" ? RELATIVE_EPOCH : today;
  const phase = state.tasks
    .filter((task) => task.category_id === categoryId)
    .reduce<string | null>(
      (earliest, task) =>
        earliest === null || task.start_date < earliest ? task.start_date : earliest,
      null,
    );
  return phase !== null && phase > floor ? phase : floor;
}

export function useQuickTask({ projectId, state }: { projectId: string; state: ProjectState }) {
  const { apply } = useProjectMutation(projectId);
  const { t } = useLocale();
  const showToast = useToast();
  const today = useToday(state.settings?.timezone);
  const [pending, setPending] = useState<PendingTask[]>([]);
  // Номер отправки. Именно номер, а не имя: две задачи с одинаковым именем в
  // одной категории — обычное дело («созвон», «созвон»), и ответ на первую
  // убирал бы из ожидания обе.
  const sent = useRef(0);

  /**
   * `position` — номер строки, на который её кладут. Не назван — задача встаёт
   * в конец категории, как и было; назван — на своё место, а соседи ниже
   * едут на единицу (см. `_make_room` на сервере).
   */
  const create = (categoryId: string, name: string, position?: number) => {
    sent.current += 1;
    const id = sent.current;
    setPending((rows) => [...rows, { id, categoryId, name }]);

    void apply(
      {
        type: "create_task",
        category_id: categoryId,
        name,
        start_date: startDayFor(state, categoryId, today),
        duration_days: 1,
        // Ключа нет вовсе, когда места не называли: сервер отличает «в конец»
        // от названного номера, и первое — это отсутствие ключа, а не ключ со
        // значением.
        ...(position === undefined ? {} : { position }),
      },
      // Догадки нет — есть строка ожидания рядом. `apply` всё равно единственная
      // дорога изменения: она же запирает правку при обрыве связи и она же
      // перезапрашивает состояние, в котором задача уже есть.
      (current) => current,
    )
      .catch((error: unknown) => {
        // Строка ожидания исчезнет, а задачи так и не появится: без этих слов
        // исчезновение читалось бы как «сохранилось где-то там».
        showToast({ message: t(errorKey(error)), tone: "error" });
      })
      .finally(() => {
        // Только после ответа: `apply` дожидается перезапроса состояния, и к
        // этому моменту настоящая строка уже на экране. Снятое раньше ожидание
        // мигнуло бы пустотой на месте задачи.
        setPending((rows) => rows.filter((row) => row.id !== id));
      });
  };

  return {
    create,
    /** Отправленные, но ещё не подтверждённые задачи этой категории. */
    pendingIn: (categoryId: string): PendingTask[] =>
      pending.filter((row) => row.categoryId === categoryId),
  };
}
