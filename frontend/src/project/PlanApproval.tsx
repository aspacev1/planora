import { useMutation, useQueryClient } from "@tanstack/react-query";

import { errorKey } from "../api/errors";
import { approvePlan, projectQueryKey } from "../api/projects";
import type { ProjectState } from "../api/projects";
import { useLocale } from "../i18n/LocaleProvider";
import { planChanges } from "./planChanges";

/**
 * Plan approval as an action — one for the whole application.
 *
 * It is called from two places: the header's button and the changes panel, where the
 * person has just read what exactly is being fixed. The submission itself and, above
 * all, the state reset after it must be the same for both: the baseline values change at
 * once on every task, and a second call that forgot to refetch the project would leave a
 * marker on screen about a divergence from a plan that no longer exists.
 */
export function useApprovePlan(projectId: string, onDone?: () => void) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => approvePlan(projectId),
    onSuccess: async () => {
      onDone?.();
      // The project's state is refetched whole rather than edited in place.
      await queryClient.invalidateQueries({ queryKey: projectQueryKey(projectId) });
    },
  });
}

/**
 * The "Approve the plan" button — which is also "Re-approve".
 *
 * Two captions on one button rather than two buttons: the action is one, and the
 * difference is only in whether there already is a baseline plan. Re-approval is
 * available to the owner, and that is decided by the server — here the button merely is
 * not shown to someone who would get a refusal anyway.
 *
 * Re-approval asks for a confirmation while the first approval does not. The difference
 * is not caution for caution's sake: re-approval moves the baseline all explained shifts
 * are measured from, that is, resets the accumulated lag. The first approval cancels
 * nothing.
 *
 * There is no version in the caption: the button stands in the plan's line, where the
 * version is already named ("PROJECT PLAN · V2"), and repeating it on the button itself
 * means writing one number twice a couple of centimetres apart.
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
   * Whether the re-approval question is currently asked.
   *
   * As state from outside rather than its own: the same question is asked by the button
   * in the changes panel's footer, and an action must have one question. A second one,
   * created for the sake of a second button, will one day diverge from the first in
   * wording or in permissions.
   */
  confirming: boolean;
  onConfirmingChange: (confirming: boolean) => void;
  /**
   * Show what exactly will be fixed. Not passed — the confirmation makes do with its own
   * summary: it names the volume but not by name.
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
      // The question is a card rather than a line in the row of chips: it names a number,
      // enumerates the kinds of changes and offers to look at them, and none of that fits
      // into one line of the header — and having fitted, it pushes the project's name out of it.
      <span className="plan-reapprove" role="group">
        <strong className="plan-reapprove__title">
          {t("plan.reapprove_title", { version: state.plan_version + 1 })}
        </strong>
        {/* The question used to warn about the consequence but not name its size, and "yes"
            had to be said blindly. The link next to it shows the same tasks by name: looking
            is optional, but the possibility must be at hand at exactly the moment the
            decision is made. */}
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
        {/* The refusal goes right where the press was: the card does not fold on a refusal
            (folding it is a success), and the error from the branch below never reached here. */}
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
      {/* Outlined rather than filled: only task creation gets a fill in the header. Plan
          approval is a rare action, and a permanent chip for it would be calling to be
          pressed every time a person opened the project to look. Re-approval, at that, is
          set in the alarm colour: it stands in the line that reports a divergence and
          answers exactly that. */}
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
 * An enumeration of the kinds of changes: "2 shifts, 1 duration, 1 new task".
 *
 * The number on its own says how much work has diverged from the plan but not what it is
 * about: five moved tasks and five added ones are different news, and the re-approval
 * decision is made on the second rather than only on the first.
 *
 * Deleted ones are not here: only a version's snapshot knows them, and it is loaded only
 * when the panel is opened. The enumeration names what is known for certain.
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
