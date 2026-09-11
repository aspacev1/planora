import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { errorKey } from "../api/errors";
import { applySchedule, previewSchedule, projectQueryKey } from "../api/projects";
import type { ProjectState, ScheduleRequest } from "../api/projects";
import { Field } from "../components/Field";
import { Modal } from "../components/Modal";
import { formatDate } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";
import { useToday } from "../time/useToday";

/**
 * The dialog binding the plan to a start date — and moving an already assigned one.
 *
 * Before the confirmation the dialog shows the project's bounds as computed by the server: the
 * promise "we will account for weekends and holidays" is unverifiable without that figure, and
 * computing it here will not do — the client does not repeat calendar arithmetic (see the rule in
 * optimistic.ts).
 *
 * The working week is offered right here rather than only in the settings: the choice of "5/2, 6/1
 * or calendar days" is part of the decision about dates, and assigning a date only to change the
 * week afterwards in a separate trip to the settings would mean giving the customer one date and
 * getting another.
 */
export function StartDateDialog({
  projectId,
  state,
  onClose,
}: {
  projectId: string;
  state: ProjectState;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const rebinding = state.schedule_mode === "calendar";

  const today = useToday(state.settings?.timezone);
  const [startDate, setStartDate] = useState(state.start_date ?? today);
  // "" — keep the current week; otherwise a string with a mask from a fixed set. A mask rather than
  // a list of days: the same format as in the settings.
  const [week, setWeek] = useState("");
  // The tasks' fate when moving an already assigned date: shift everyone, preserving the offsets
  // from the start, or leave the dates in place. The first binding has no choice — the relative
  // coordinates must become dates.
  const [shift, setShift] = useState(true);

  const valid = startDate !== "";
  const body: ScheduleRequest = {
    start_date: startDate,
    ...(week === "" ? {} : { working_days: Number(week) }),
    ...(rebinding ? { shift_tasks: shift } : {}),
  };

  // The preview is recomputed on every change of the form: choosing a date and a week is discrete,
  // and there is no jitter here worth deferring a request for.
  const preview = useQuery({
    queryKey: ["schedule-preview", projectId, body] as const,
    queryFn: () => previewSchedule(projectId, body),
    enabled: valid,
    retry: false,
  });

  const apply = useMutation({
    mutationFn: () => applySchedule(projectId, body),
    onSuccess: (next) => {
      // The response is a ready project state: it is put into the cache at once rather than waiting
      // for a refetch, otherwise a relative plan would remain behind the "Apply" button for a frame.
      queryClient.setQueryData(projectQueryKey(projectId), next);
      void queryClient.invalidateQueries({ queryKey: projectQueryKey(projectId) });
      onClose();
    },
  });

  const weeks = [
    ["", t("schedule.week.keep")],
    ["31", t("schedule.week.mon_fri")],
    ["63", t("schedule.week.mon_sat")],
    ["127", t("schedule.week.all")],
  ] as const;

  return (
    <Modal
      title={rebinding ? t("schedule.change_title") : t("schedule.title")}
      onClose={onClose}
      dirty={startDate !== (state.start_date ?? today) || week !== ""}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          apply.mutate();
        }}
      >
        <Field
          id="schedule-start"
          label={t("schedule.start")}
          type="date"
          value={startDate}
          onChange={setStartDate}
        />

        <p className="field">
          <label htmlFor="schedule-week">{t("schedule.week_label")}</label>
          <select
            id="schedule-week"
            name="schedule-week"
            value={week}
            onChange={(event) => setWeek(event.target.value)}
          >
            {weeks.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </p>

        {/* Holidays are not chosen here: they are already configured — on the organization and in
            the project's settings — and the binding will apply them itself. The line is a reminder
            of that, so that "we will account for holidays" does not look like magic. */}
        <p className="field__hint">{t("schedule.holidays_note")}</p>

        {rebinding && (
          <fieldset className="field fieldset">
            <legend>{t("schedule.tasks_legend")}</legend>
            <label className="checkbox">
              <input
                type="radio"
                name="schedule-tasks"
                checked={shift}
                onChange={() => setShift(true)}
              />
              {t("schedule.tasks_shift")}
            </label>
            <label className="checkbox">
              <input
                type="radio"
                name="schedule-tasks"
                checked={!shift}
                onChange={() => setShift(false)}
              />
              {t("schedule.tasks_keep")}
            </label>
          </fieldset>
        )}

        {/* The computed bounds — before the confirmation. A preview error is the same line: a
            degenerate calendar is more honest shown before the button. */}
        {preview.data && (
          <p className="schedule__preview" role="status">
            {preview.data.end_date
              ? t("schedule.preview", {
                  from: formatDate(t, preview.data.start_date),
                  to: formatDate(t, preview.data.end_date),
                })
              : t("schedule.preview_empty", {
                  from: formatDate(t, preview.data.start_date),
                })}
          </p>
        )}
        {preview.error && (
          <p className="error" role="alert">
            {t(errorKey(preview.error))}
          </p>
        )}

        {apply.error && (
          <p className="error" role="alert">
            {t(errorKey(apply.error))}
          </p>
        )}

        <div className="modal__actions">
          <button type="submit" disabled={!valid || preview.isError || apply.isPending}>
            {t("schedule.apply")}
          </button>
          <button type="button" className="button--quiet" onClick={onClose}>
            {t("common.cancel")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
