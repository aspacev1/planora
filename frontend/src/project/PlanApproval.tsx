import { useMutation, useQueryClient } from "@tanstack/react-query";

import { errorKey } from "../api/errors";
import { approvePlan, projectQueryKey } from "../api/projects";
import type { ProjectState } from "../api/projects";
import { useLocale } from "../i18n/LocaleProvider";
import { planChanges } from "./planChanges";

/**
 * Согласование плана как действие — одно на всё приложение.
 *
 * Зовут его из двух мест: кнопкой в шапке и из окна изменений, где человек
 * только что прочитал, что именно фиксирует. Сама отправка и, главное, сброс
 * состояния после неё у обоих обязаны быть одни: базовые значения меняются
 * сразу у всех задач, и второй вызов, забывший перезапросить проект, оставил
 * бы на экране пометку о расхождении с планом, которого больше нет.
 */
export function useApprovePlan(projectId: string, onDone?: () => void) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => approvePlan(projectId),
    onSuccess: async () => {
      onDone?.();
      // Состояние проекта перезапрашивается целиком, а не правится по месту.
      await queryClient.invalidateQueries({ queryKey: projectQueryKey(projectId) });
    },
  });
}

/**
 * Кнопка «Согласовать план» — она же «Пересогласовать».
 *
 * Две подписи у одной кнопки, а не две кнопки: действие одно, и различие
 * только в том, есть ли уже базовый план. Пересогласование доступно владельцу,
 * и решает это сервер — здесь кнопка лишь не показывается тому, кто и так
 * получит отказ.
 *
 * Пересогласование спрашивает подтверждение, а первое согласование — нет.
 * Разница не в осторожности ради осторожности: пересогласование сдвигает базу,
 * от которой считаются все объяснённые сдвиги, то есть обнуляет накопленное
 * отставание. Первое согласование не отменяет ничего.
 *
 * Версии в подписи нет: кнопка стоит в строке плана, где версия уже названа
 * («ПЛАН ПРОЕКТА · V2»), и повторять её на самой кнопке значит написать одно
 * число дважды в двух сантиметрах друг от друга.
 */
export function PlanApproval({
  projectId,
  state,
  canApprove,
  canReapprove,
  confirming,
  onConfirmingChange,
  onShowChanges,
}: {
  projectId: string;
  state: ProjectState;
  canApprove: boolean;
  canReapprove: boolean;
  /**
   * Задан ли сейчас вопрос о переутверждении.
   *
   * Состоянием снаружи, а не своим: этот же вопрос задаёт кнопка в подвале окна
   * изменений, а вопрос у действия обязан быть один. Второй, заведённый ради
   * второй кнопки, однажды разойдётся с первым в формулировке или в правах.
   */
  confirming: boolean;
  onConfirmingChange: (confirming: boolean) => void;
  /**
   * Показать, что именно будет зафиксировано. Не передано — подтверждение
   * обходится своей сводкой: она называет объём, но не поимённо.
   */
  onShowChanges?: () => void;
}) {
  const { t } = useLocale();

  const approved = state.plan_approved_at !== null;
  const changes = planChanges(state);
  const changed = changes.taskCount;

  const mutation = useApprovePlan(projectId, () => onConfirmingChange(false));

  if (approved ? !canReapprove : !canApprove) return null;

  if (approved && confirming) {
    return (
      // Вопрос — карточкой, а не строкой в ряд с плашками: он называет число,
      // перечисляет виды изменений и предлагает на них посмотреть, и всё это
      // в одну строку шапки не встаёт, а встав — вытесняет из неё имя проекта.
      <span className="plan-reapprove" role="group">
        <strong className="plan-reapprove__title">
          {t("plan.reapprove_title", { version: state.plan_version + 1 })}
        </strong>
        {/* Прежде вопрос предупреждал о последствии, но не называл его размера,
            и «да» приходилось говорить вслепую. Ссылка рядом показывает те же
            задачи поимённо: смотреть необязательно, но возможность обязана быть
            под рукой ровно в тот миг, когда решение принимается. */}
        <p className="plan-reapprove__text">
          {changed > 0
            ? `${t("plan.reapprove_summary", {
                count: changed,
                parts: partsOf(changes, t),
              })} ${t("plan.reapprove_warning")}`
            : t("plan.reapprove_warning")}
          {changed > 0 && onShowChanges && (
            <>
              {" "}
              <button type="button" className="plan__link" onClick={onShowChanges}>
                {t("plan.changes_open")}
              </button>
            </>
          )}
        </p>
        {/* Отказ — здесь же, где нажали: карточка не сворачивается по отказу
            (свернуть её — успех), и ошибка из ветки ниже сюда не доходила. */}
        {mutation.error !== null && (
          <span className="error" role="alert">
            {t(errorKey(mutation.error))}
          </span>
        )}
        <span className="plan-reapprove__actions">
          <button
            type="button"
            className="button--danger"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {t("plan.reapprove_confirm")}
          </button>
          <button
            type="button"
            className="button--quiet"
            onClick={() => onConfirmingChange(false)}
          >
            {t("common.cancel")}
          </button>
        </span>
      </span>
    );
  }

  return (
    <>
      {/* Контурная, а не залитая: заливку в шапке получает только создание
          задачи. Согласование плана — действие редкое, и постоянная плашка
          ради него звала бы нажать себя каждый раз, когда человек открыл
          проект посмотреть. Пересогласование при этом набрано цветом тревоги:
          оно стоит в строке, которая сообщает о расхождении, и отвечает
          именно на неё. */}
      <button
        type="button"
        className={`button--quiet${approved ? " button--alert" : ""}`}
        onClick={() => (approved ? onConfirmingChange(true) : mutation.mutate())}
        disabled={mutation.isPending}
      >
        {approved ? t("plan.reapprove") : t("plan.approve")}
      </button>
      {mutation.error !== null && (
        <span className="error" role="alert">
          {t(errorKey(mutation.error))}
        </span>
      )}
    </>
  );
}

/**
 * Перечисление видов изменений: «2 сдвига, 1 длительность, 1 новая задача».
 *
 * Число само по себе говорит, сколько работы разошлось с планом, но не о чём
 * речь: пять перенесённых задач и пять дописанных — разные новости, и решение
 * о переутверждении принимают по второму, а не только по первому.
 *
 * Удалённых здесь нет: их знает лишь снимок версии, а он грузится только при
 * открытии окна. Перечисление называет то, что известно наверняка.
 */
function partsOf(
  changes: ReturnType<typeof planChanges>,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  return (
    [
      ["shifts", changes.shifts.length],
      ["durations", changes.durations.length],
      ["added", changes.added.length],
    ] as const
  )
    .filter(([, count]) => count > 0)
    .map(([key, count]) => t(`plan.reapprove_part.${key}`, { count }))
    .join(", ");
}
