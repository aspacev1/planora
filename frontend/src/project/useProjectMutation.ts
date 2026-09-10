import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { ApiError } from "../api/client";
import { applyOp, projectQueryKey } from "../api/projects";
import type { Op, ProjectState, Revision } from "../api/projects";
import { useLiveBlocksEditing } from "../live/LiveProvider";
import { shiftNeedingReason, thresholdOf } from "./baseline";
import type { ShiftRequest } from "./baseline";
import { useNoteMovedTask } from "./DependencyNudge";
import { ShiftCancelled, useAskShiftReason } from "./ShiftReason";

/** Код отказа, когда связь оборвана. Придуман клиентом: запрос не уходит вовсе. */
export const OFFLINE_ERROR_CODE = "offline";

/**
 * Преобразование состояния, показывающее изменение до ответа сервера.
 *
 * Возвращает новое состояние, а не правит переданное: старое остаётся снимком
 * для отката, и порча его на месте лишила бы откат того, к чему возвращаться.
 */
export type Optimistic = (state: ProjectState) => ProjectState;

export type ApplyOptions = {
  /** Причина сдвига — текст человека. Отсутствие ключа и пустая строка различаются. */
  reason?: string;
};

/**
 * Единственный путь любого изменения проекта: показать сразу, отправить,
 * вернуть как было при отказе.
 *
 * Путь один на все жесты сознательно. Перетаскивание, правка поля в карточке и
 * перестановка строки отличаются только тем, что показать до ответа, — а
 * порядок «снимок → показ → отправка → откат или перезапрос» у них общий.
 * Написанный в каждом жесте заново, он в каждом расходится по мелочи, и
 * расхождение видно только тогда, когда сервер отказал, то есть в самый
 * неудачный момент.
 */
/** Отказ сервера «объясните сдвиг». */
function isReasonRequired(error: unknown): boolean {
  return error instanceof ApiError && error.code === "reason_required";
}

/**
 * Числа для окна, когда причину потребовал сервер, а вкладка так не считала.
 *
 * Значит, состояние во вкладке устарело — например, план утвердили в соседней
 * вкладке минуту назад. Числа берутся из подсказок сервера; своих у вкладки в
 * этот момент нет и быть не может.
 */
function refusalRequest(state: ProjectState, op: Op, error: unknown): ShiftRequest {
  const hints = error instanceof ApiError ? error.hints : {};
  const taskId = "task_id" in op ? op.task_id : "";
  return {
    taskName: state.tasks.find((task) => task.id === taskId)?.name ?? "",
    deviationDays: hints.deviationDays ?? 0,
    thresholdDays: hints.thresholdDays ?? thresholdOf(state),
  };
}

export function useProjectMutation(projectId: string) {
  const queryClient = useQueryClient();
  const askReason = useAskShiftReason();
  const noteMoved = useNoteMovedTask();
  const key = projectQueryKey(projectId);
  // Блокировка при обрыве связи стоит здесь, а не в каждом жесте (§12). Это
  // единственная дорога любого изменения, и всякий следующий жест окажется
  // заперт сам, без напоминания автору. Спрятанная кнопка при этом не отменяет
  // проверку: перетаскивание и клавиатура мимо кнопок ходят.
  const blocked = useLiveBlocksEditing();

  const apply = useCallback(
    async (op: Op, optimistic: Optimistic, options?: ApplyOptions): Promise<Revision> => {
      // Отказ до всякого показа: изменение, показанное и тут же откаченное,
      // мигает — а отправлять его некуда, состояние на экране устарело
      // неизвестно насколько, и операция ляжет поверх чужих правок вслепую.
      if (blocked) throw new ApiError(OFFLINE_ERROR_CODE, 0);

      // Состояние, по которому решается, нужна ли причина. Это ещё не снимок
      // для отката: тот берётся ниже, перед самым применением.
      const before = queryClient.getQueryData<ProjectState>(key);

      // Причина спрашивается до всякого показа. Это не забота об аккуратности
      // кода, а само правило раздела 5: изменение не применяется, пока причина
      // не введена, и промежуточного состояния «сдвинуто, но не объяснено» в
      // системе не существует — в том числе на те полсекунды, пока человек
      // читает окно.
      let reason = options?.reason;
      if (reason === undefined && before && askReason) {
        const request = shiftNeedingReason(before, op);
        if (request) {
          const answer = await askReason(request);
          if (answer === null) throw new ShiftCancelled();
          reason = answer;
        }
      }

      const commit = async (withReason: string | undefined): Promise<Revision> => {
        // Снимок берётся здесь, непосредственно перед применением, а не один
        // раз при монтировании и не до окна с причиной. Первое — чтобы откат
        // второго изменения не возвращал к состоянию до первого. Второе —
        // потому что, пока окно открыто, состояние успевает смениться: сосед
        // подвинул задачу, проект перезапросился, — и снимок, взятый до окна,
        // накрыл бы его правку своей копией, а откат на отказе вернул бы
        // вкладку в прошлое без единого перезапроса.
        const snapshot = queryClient.getQueryData<ProjectState>(key);

        // Показ идёт синхронно. Жест обязан отозваться в том же кадре, в
        // котором его сделали; отложенный на микрозадачу показ — это уже
        // заметное запаздывание под пальцем.
        if (snapshot) queryClient.setQueryData(key, optimistic(snapshot));

        // Фоновый перезапрос, начатый до жеста, вернул бы состояние без него.
        await queryClient.cancelQueries({ queryKey: key });

        try {
          const revision = await applyOp(projectId, op, withReason);
          // Версия сервера единственно верная: даты окончания считает он, и
          // оптимистичное состояние в лучшем случае совпадает с его ответом.
          await queryClient.invalidateQueries({ queryKey: key });
          // Сроки задачи изменились — значит, связанные с ней могли поехать.
          // Отметка ставится после перезапроса: предложение считается по
          // датам, посчитанным сервером, а не по догадке.
          if (
            noteMoved &&
            (op.type === "move_task" ||
              op.type === "set_duration" ||
              op.type === "resize_task")
          ) {
            noteMoved(op.task_id);
          }
          return revision;
        } catch (error) {
          if (snapshot) queryClient.setQueryData(key, snapshot);
          throw error;
        }
      };

      try {
        return await commit(reason);
      } catch (error) {
        // Сервер знает о базовом плане больше, чем эта вкладка: план могли
        // утвердить только что. Спрашиваем причину и повторяем один раз — а не
        // показываем человеку отказ с машинным кодом, на который он всё равно
        // ответит тем же жестом.
        if (!isReasonRequired(error) || reason !== undefined || !askReason || !before) {
          throw error;
        }
        const answer = await askReason(refusalRequest(before, op, error));
        if (answer === null) throw new ShiftCancelled();
        return commit(answer);
      }
    },
    [projectId, queryClient, key, askReason, noteMoved, blocked],
  );

  return { apply };
}
