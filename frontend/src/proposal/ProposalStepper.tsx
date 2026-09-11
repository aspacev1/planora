import { Fragment } from "react";

import type { ProposalStage } from "../api/proposal";
import { formatShortDate } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";
import { useTimeZone } from "../time/useToday";
import { dayIn } from "../time/zone";
import { PushPlanButton } from "./PushPlanButton";

type StepKey = ProposalStage | "in_plan";

/**
 * The deal's stage bar: draft → sent → agreed → in the plan.
 *
 * It answers "where am I" and "what next" at a glance: the passed stages with their dates, the
 * current one highlighted, and on the right the next-step button and the transfer-into-the-plan
 * button. The first three stages are marked by a person, the fourth is derived from the lines'
 * references to tasks — it is not marked, it happens through a transfer.
 *
 * The transfer stands next to the step rather than instead of it, right from the draft: not
 * everyone sends the document to the client, and a quote written for oneself has no reason to pass
 * through "sent" and "agreed" to become a plan. While the deal is not agreed it is quiet — the next
 * step is still a mark; after the agreement there is no step left, and the transfer stands alone as
 * the primary one (see PushPlanButton).
 *
 * A passed stage is a button to go back to it: a mark can be removed by the same motion that set
 * it. These are notes for oneself rather than a legal status, and there are no "are you sure"
 * questions here.
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
  /** The mark is already going to the server: the next-step button is disabled meanwhile. */
  marking: boolean;
  onMark: (stage: ProposalStage) => void;
  onPush: () => void;
}) {
  const { t } = useLocale();
  // The marks are moments in time while the captions are days; the day is counted by the reader's
  // clock rather than by truncating an ISO string in UTC.
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
  // The current one is the last reached. A transfer from a draft makes "in the plan" current while
  // leaving "sent" empty: the bar does not invent a sending that never happened.
  const current = steps.reduce((last, step, index) => (step.reached ? index : last), 0);

  // The deal's next step is a mark and only a mark: a transfer does not count as a step, it has its
  // own button next to it, at any stage.
  const next = !canWrite
    ? null
    : status === "draft"
      ? { label: t("proposal.stage.mark_sent"), run: () => onMark("sent") }
      : status === "sent"
        ? { label: t("proposal.stage.mark_agreed"), run: () => onMark("agreed") }
        : null;
  // There is nothing to transfer — no button: the bar reports that everything is already in the plan
  // with a caption by the last stage, and a disabled button next to it would repeat that.
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
        // You can go back to a passed stage that is marked by hand, and only if it will change
        // something: a click on a stage the deal is already at must promise nothing.
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
