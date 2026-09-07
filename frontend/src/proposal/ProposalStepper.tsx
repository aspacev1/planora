import { Fragment } from "react";

import type { ProposalStage } from "../api/proposal";
import { formatShortDate } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";
import { useTimeZone } from "../time/useToday";
import { dayIn } from "../time/zone";
import { PushPlanButton } from "./PushPlanButton";

type StepKey = ProposalStage | "in_plan";

/**
 * Полоса этапов сделки: черновик → отправлено → согласовано → в плане.
 *
 * Отвечает на «где я» и «что дальше» одним взглядом: пройденные этапы с
 * датами, текущий выделен, а справа — кнопка следующего шага и кнопка
 * переноса в план. Три первых этапа отмечает человек, четвёртый выводится из
 * ссылок строк на задачи — его не отмечают, он случается переносом.
 *
 * Перенос стоит рядом с шагом, а не вместо него, с самого черновика: не все
 * отправляют документ клиенту, и смете, написанной для себя, незачем
 * проходить «отправлено» и «согласовано», чтобы стать планом. Пока сделка не
 * согласована, он тихий — следующий шаг всё же отметка; после согласования
 * шага больше нет, и перенос остаётся один, главным (см. PushPlanButton).
 *
 * Пройденный этап — кнопка возврата к нему: снять отметку можно тем же
 * движением, каким её поставили. Это заметки для себя, а не юридический
 * статус, и вопросов «вы уверены» здесь нет.
 */
export function ProposalStepper({
  status,
  sentAt,
  agreedAt,
  pushedCount,
  pushableCount,
  totalRows,
  canWrite,
  marking,
  onMark,
  onPush,
}: {
  status: ProposalStage;
  sentAt: string | null;
  agreedAt: string | null;
  pushedCount: number;
  pushableCount: number;
  totalRows: number;
  canWrite: boolean;
  /** Отметка уже уходит на сервер: кнопку следующего шага на это время гасим. */
  marking: boolean;
  onMark: (stage: ProposalStage) => void;
  onPush: () => void;
}) {
  const { t } = useLocale();
  // Отметки — моменты времени, а подписи — дни; день считается по часам
  // читателя, а не обрезкой ISO-строки по UTC.
  const zone = useTimeZone();
  const dayOf = (at: string) => formatShortDate(t, dayIn(zone, new Date(at)));

  const steps: { key: StepKey; reached: boolean; caption?: string }[] = [
    { key: "draft", reached: true },
    {
      key: "sent",
      reached: sentAt !== null,
      caption: sentAt !== null ? dayOf(sentAt) : undefined,
    },
    {
      key: "agreed",
      reached: agreedAt !== null,
      caption: agreedAt !== null ? dayOf(agreedAt) : undefined,
    },
    {
      key: "in_plan",
      reached: pushedCount > 0,
      caption:
        pushedCount > 0
          ? t("proposal.stage.in_plan_count", { pushed: pushedCount, count: totalRows })
          : undefined,
    },
  ];
  // Текущий — последний достигнутый. Перенос из черновика делает текущим
  // «в плане», а «отправлено» оставляет пустым: полоса не выдумывает
  // отправку, которой не было.
  const current = steps.reduce((last, step, index) => (step.reached ? index : last), 0);

  // Следующий шаг сделки — отметка, и только она: перенос шагом не считается,
  // у него своя кнопка рядом, на любом этапе.
  const next = !canWrite
    ? null
    : status === "draft"
      ? { label: t("proposal.stage.mark_sent"), run: () => onMark("sent") }
      : status === "sent"
        ? { label: t("proposal.stage.mark_agreed"), run: () => onMark("agreed") }
        : null;
  // Переносить нечего — кнопки нет: полоса сообщает, что всё уже в плане,
  // подписью у последнего этапа, и выключенная кнопка рядом повторяла бы её.
  const pushable = canWrite && pushableCount > 0;

  return (
    <div className="stepper" role="list" aria-label={t("proposal.stage.title")}>
      {steps.map((step, index) => {
        const done = step.reached && index < current;
        const label = t(`proposal.stage.${step.key}`);
        const inner = (
          <>
            <span className="stepper__mark" aria-hidden="true">
              {done && (
                <svg className="glyph" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="m3.5 8.5 3 3 6-7" />
                </svg>
              )}
            </span>
            <span className="stepper__text">
              <span className="stepper__label">{label}</span>
              {step.caption !== undefined && <span className="stepper__sub">{step.caption}</span>}
            </span>
          </>
        );
        // Вернуться можно на пройденный этап, который отмечают рукой, и
        // только если это что-то изменит: щелчок по этапу, на котором сделка
        // и так стоит, не должен ничего обещать.
        const backable = canWrite && done && step.key !== "in_plan" && step.key !== status;
        return (
          <Fragment key={step.key}>
            {index > 0 && (
              <span
                className={`stepper__line${done || index === current ? " stepper__line--done" : ""}`}
                aria-hidden="true"
              />
            )}
            <div
              role="listitem"
              className={`stepper__step${done ? " stepper__step--done" : ""}${index === current ? " stepper__step--current" : ""}`}
              aria-current={index === current ? "step" : undefined}
            >
              {backable ? (
                <button
                  type="button"
                  className="stepper__back"
                  aria-label={t("proposal.stage.back_to", { stage: label })}
                  title={t("proposal.stage.back_to", { stage: label })}
                  disabled={marking}
                  onClick={() => onMark(step.key as ProposalStage)}
                >
                  {inner}
                </button>
              ) : (
                inner
              )}
            </div>
          </Fragment>
        );
      })}
      {(next || pushable) && (
        <span className="stepper__actions">
          {next && (
            <button type="button" className="button--quiet" disabled={marking} onClick={next.run}>
              {next.label}
            </button>
          )}
          {pushable && (
            <PushPlanButton
              status={status}
              pushedCount={pushedCount}
              pushableCount={pushableCount}
              onPush={onPush}
            />
          )}
        </span>
      )}
    </div>
  );
}
