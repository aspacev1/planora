import { createContext, useCallback, useContext, useState } from "react";
import type { ReactNode } from "react";

import type { ProjectState, Task } from "../api/projects";
import { addDays, daysBetween } from "../gantt/timescale";
import { useLocale } from "../i18n/LocaleProvider";
import { patchTask } from "./optimistic";
import { isShiftCancelled } from "./ShiftReason";
import { useProjectMutation } from "./useProjectMutation";

/**
 * Что система делает со связями, когда автоперенос выключен.
 *
 * Тогда даты по связям не пересчитываются: связь — это стрелка на картинке, а
 * не правило расчёта. Но молчать, когда задача уехала на предшественника, тоже
 * нельзя: стрелка нарисуется наискось, и человек узнает об этом, только если
 * посмотрит именно туда.
 *
 * Поэтому предложение, а не действие. Отказ ничего не ломает — стрелка просто
 * рисуется наискось, как и рисовалась бы.
 *
 * При включённом автопереносе (`auto_schedule`) предложения нет вовсе: сервер
 * уже подвинул последователей, и предлагать сделать сделанное значило бы
 * показать кнопку, которая ничего не меняет.
 */

type Notice = (taskId: string) => void;

const MovedTaskContext = createContext<{ moved: string | null; note: Notice } | null>(null);

export function DependencyNudgeProvider({ children }: { children: ReactNode }) {
  const [moved, setMoved] = useState<string | null>(null);
  // Один и тот же вызов на каждый сдвиг: предложение показывается по поводу
  // последней подвинутой задачи, а не копится списком. Копящийся список
  // предложений — это уже уведомления, которые надо разбирать.
  const note = useCallback<Notice>((taskId) => setMoved(taskId), []);
  const dismiss = useCallback(() => setMoved(null), []);

  return (
    <MovedTaskContext.Provider value={{ moved, note }}>
      <DismissContext.Provider value={dismiss}>{children}</DismissContext.Provider>
    </MovedTaskContext.Provider>
  );
}

const DismissContext = createContext<() => void>(() => {});

/**
 * Отметка «эту задачу только что подвинули».
 *
 * Вне провайдера возвращает `null`: диаграмма рисуется и там, где двигать
 * нечего — например, на публичной странице.
 */
export function useNoteMovedTask(): Notice | null {
  return useContext(MovedTaskContext)?.note ?? null;
}

/**
 * Насколько подвинуть последователя, чтобы он начинался после предшественника.
 * Больше нуля — связь нарушена; ноль и меньше — запас.
 *
 * Правило одно на всех, кто смотрит на связи: предложение здесь, знак на
 * стрелке ленты (см. Arrows) и пометка в карточке задачи. Написанное в каждом
 * месте заново, оно разошлось бы на включительном конце отрезка — совпадение
 * дат тоже нахлёст, и «+1» здесь ровно об этом.
 */
export function overlapDays(predecessor: Task, successor: Task): number {
  // Начинается раньше окончания предшественника — значит, работа встала бы
  // раньше, чем закончилось то, от чего она зависит. Ровно на следующий день
  // после окончания — уже нормально.
  return daysBetween(successor.start_date, predecessor.end_date) + 1;
}

export function DependencyNudge({
  projectId,
  state,
}: {
  projectId: string;
  state: ProjectState;
}) {
  const { t } = useLocale();
  const { apply } = useProjectMutation(projectId);
  const moved = useContext(MovedTaskContext)?.moved ?? null;
  const dismiss = useContext(DismissContext);

  // При включённом автопереносе предлагать нечего: последователи уже уехали,
  // и предложение сделать сделанное читается как сбой — человек нажимает
  // «Подвинуть», ничего не происходит, и виноватой выглядит кнопка.
  if (state.auto_schedule === true) return null;

  const shifted = state.tasks.find((task) => task.id === moved);
  if (!shifted) return null;

  // По обе стороны связей подвинутой задачи. Она предшественник — наехать
  // могла на своих последователей, и подвинуть предлагается их. Она
  // последователь — её саму поставили раньше конца предшественника, и
  // предложение касается её же: прежде эта половина молчала, человек ставил
  // задачу поперёк связи и узнавал об этом только по косой стрелке.
  const followers = state.dependencies
    .filter((edge) => edge.from_task_id === shifted.id)
    .map((edge) => state.tasks.find((task) => task.id === edge.to_task_id))
    .filter((task): task is Task => task !== undefined)
    .map((task) => ({ task, days: overlapDays(shifted, task) }))
    .filter((item) => item.days > 0);

  // Наибольшее из перекрытий: предшественников может быть несколько, а кнопка
  // одна — сдвиг, после которого задача выходит за всех разом.
  const behind = state.dependencies
    .filter((edge) => edge.to_task_id === shifted.id)
    .map((edge) => state.tasks.find((task) => task.id === edge.from_task_id))
    .filter((task): task is Task => task !== undefined)
    .reduce((worst, pred) => Math.max(worst, overlapDays(pred, shifted)), 0);

  const affected = behind > 0 ? [...followers, { task: shifted, days: behind }] : followers;

  if (affected.length === 0) return null;

  const move = (task: Task, days: number) => {
    const start_date = addDays(task.start_date, days);
    apply({ type: "move_task", task_id: task.id, start_date }, (current) =>
      patchTask(current, task.id, { start_date }),
    )
      .then(dismiss)
      .catch((refusal: unknown) => {
        // Отказ объяснять сдвиг — не ошибка: предложение просто остаётся на
        // месте, и человек волен его принять позже или не принимать вовсе.
        if (!isShiftCancelled(refusal)) dismiss();
      });
  };

  return (
    <div className="nudge" role="status">
      {affected.map(({ task, days }) => (
        <button key={task.id} type="button" className="button--quiet" onClick={() => move(task, days)}>
          {/* Название задачи — содержимое пользователя: не переводится. */}
          {t("gantt.nudge", { name: task.name, days: t("common.days", { count: days }) })}
        </button>
      ))}
      <button
        type="button"
        className="button--quiet nudge__dismiss"
        aria-label={t("gantt.nudge_dismiss")}
        title={t("gantt.nudge_dismiss")}
        onClick={dismiss}
      >
        ×
      </button>
    </div>
  );
}
