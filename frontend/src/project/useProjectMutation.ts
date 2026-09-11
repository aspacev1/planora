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

/** The refusal code when the connection is down. Invented by the client: the request never leaves. */
export const OFFLINE_ERROR_CODE = "offline";

/**
 * A transformation of the state that shows a change before the server's answer.
 *
 * Returns a new state rather than editing the one passed in: the old one stays a
 * snapshot for the rollback, and spoiling it in place would leave the rollback with
 * nothing to return to.
 */
export type Optimistic = (state: ProjectState) => ProjectState;

export type ApplyOptions = {
  /** The reason for a shift — a person's text. The absence of the key and an empty string are different things. */
  reason?: string;
};

/**
 * The only path for any change to a project: show it at once, send it, put it back as
 * it was on a refusal.
 *
 * There is one path for all the gestures deliberately. Dragging, editing a field in
 * the card and reordering a row differ only in what to show before the answer — while
 * the order "snapshot → show → send → roll back or refetch" is common to them.
 * Written anew in every gesture, it diverges in every one on the small things, and
 * the divergence is only visible when the server refuses, that is, at the least
 * convenient moment.
 */
/** The server's "explain the shift" refusal. */
function isReasonRequired(error: unknown): boolean {
  return error instanceof ApiError && error.code === "reason_required";
}

/**
 * The numbers for the dialog when the server demanded a reason while the tab did not
 * think one was needed.
 *
 * That means the tab's state is stale — for example, the plan was approved in another
 * tab a minute ago. The numbers are taken from the server's hints; the tab has none of
 * its own at that moment and cannot have.
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
  // The lock on a dropped connection stands here rather than in every gesture (§12).
  // This is the only road for any change, and every next gesture will find itself
  // locked without its author being reminded. A hidden button does not cancel the
  // check at that: dragging and the keyboard go past the buttons.
  const blocked = useLiveBlocksEditing();

  const apply = useCallback(
    async (op: Op, optimistic: Optimistic, options?: ApplyOptions): Promise<Revision> => {
      // A refusal before any display: a change shown and rolled back at once flickers —
      // and there is nowhere to send it, the state on screen is stale by an unknown
      // amount, and the operation would land on top of someone else's edits blindly.
      if (blocked) throw new ApiError(OFFLINE_ERROR_CODE, 0);

      // The state by which it is decided whether a reason is needed. This is not yet
      // the snapshot for the rollback: that is taken below, right before applying.
      const before = queryClient.getQueryData<ProjectState>(key);

      // The reason is asked for before any display. This is not a concern for tidy
      // code but section 5's rule itself: a change is not applied until the reason has
      // been entered, and the intermediate state of "shifted but not explained" does not
      // exist in the system — including for the half-second while the person reads the
      // dialog.
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
        // The snapshot is taken here, immediately before applying, rather than once at
        // mount time and not before the reason dialog. The first so that rolling back a
        // second change does not return to the state before the first. The second
        // because, while the dialog is open, the state has time to change: a colleague
        // moved a task, the project was refetched — and a snapshot taken before the
        // dialog would cover their edit with its own copy, while a rollback on a refusal
        // would send the tab into the past with not a single refetch.
        const snapshot = queryClient.getQueryData<ProjectState>(key);

        // The display happens synchronously. A gesture must respond in the same frame it
        // was made in; a display deferred to a microtask is already a noticeable lag
        // under the finger.
        if (snapshot) queryClient.setQueryData(key, optimistic(snapshot));

        // A background refetch started before the gesture would return the state without it.
        await queryClient.cancelQueries({ queryKey: key });

        try {
          const revision = await applyOp(projectId, op, withReason);
          // The server's version is the only right one: the end dates are computed by it,
          // and the optimistic state at best coincides with its answer.
          await queryClient.invalidateQueries({ queryKey: key });
          // The task's dates have changed — which means the ones linked to it could have
          // travelled. The marker is set after the refetch: the nudge is computed from
          // dates computed by the server rather than from a guess.
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
        // The server knows more about the baseline plan than this tab does: the plan may
        // have just been approved. We ask for a reason and repeat once — rather than
        // showing the person a refusal with a machine code, to which they will answer
        // with the same gesture anyway.
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
