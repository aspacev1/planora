import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { errorKey } from "../api/errors";
import { getScorecard, recalculateScorecard, scorecardQueryKey } from "../api/scorecard";
import type {
  ScorecardSummary,
  TeamMember,
  TeamReason,
  TeamTask,
} from "../api/scorecard";
import { Avatar } from "../components/Avatar";
import { useToast } from "../components/toast";
import { formatShortDate, formatTime } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";
import { useLiveBlocksEditing } from "../live/LiveProvider";
import { formatAmount } from "../proposal/money";

import "./scorecard.css";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * The "Scorecard" tab: who on the team is keeping up.
 *
 * One screen for one question. Three project figures in the header, and under them a row per person:
 * done out of what was planned for the week, beyond the plan, on time, a signal with a reason and
 * eight weeks of pace. A row unfolds into the week's tasks. Everything arrives from the server
 * computed: the formulas live in one place (backend/app/scorecard.py), the client only draws.
 *
 * A per-person signal is an assessment, and it arrives only to whoever is entitled to see it (see
 * Action.TEAM_ASSESSMENT_READ): for the rest the field is simply not in the response, and the column
 * is not drawn rather than hidden.
 */
export function Scorecard({
  projectId,
  canWrite,
  onOpenTask,
}: {
  projectId: string;
  canWrite: boolean;
  onOpenTask: (taskId: string) => void;
}) {
  const { t, locale } = useLocale();
  const queryClient = useQueryClient();
  const toast = useToast();
  const offline = useLiveBlocksEditing();

  const query = useQuery({
    queryKey: scorecardQueryKey(projectId),
    queryFn: () => getScorecard(projectId),
    retry: false,
  });

  const recalc = useMutation({
    mutationFn: () => recalculateScorecard(projectId),
    onSuccess: (state) => queryClient.setQueryData(scorecardQueryKey(projectId), state),
    onError: (refusal: unknown) => toast({ message: t(errorKey(refusal)), tone: "error" }),
  });

  if (query.isPending) {
    return <p role="status">{t("common.loading")}</p>;
  }

  if (query.error) {
    return (
      <p className="error" role="alert">
        {t(errorKey(query.error))}
      </p>
    );
  }

  const state = query.data;

  return (
    <div className="scorecard">
      <header className="scorecard__head">
        <div>
          <h2 className="scorecard__title">
            {t("scorecard.subtitle", {
              number: state.week.number,
              start: formatShortDate(t, state.week.start),
              end: formatShortDate(t, state.week.end),
            })}
          </h2>
          <p className="scorecard__subtitle">
            {t("scorecard.summary.week_done", {
              done: state.summary.done,
              planned: state.summary.planned,
            })}
            {state.computed_at &&
              ` · ${t("scorecard.updated", {
                time: formatTime(locale, new Date(state.computed_at)),
              })}`}
          </p>
        </div>
        {canWrite && (
          <button
            type="button"
            className="scorecard__recalculate"
            disabled={offline || recalc.isPending}
            onClick={() => recalc.mutate()}
          >
            {t("scorecard.recalculate")}
          </button>
        )}
      </header>

      <SummaryStrip summary={state.summary} />

      {state.team && (
        <TeamTable
          team={state.team}
          onOpenTask={onOpenTask}
        />
      )}
    </div>
  );
}

/** The project's three tiles: overdue, blocked, the finish shift. */
function SummaryStrip({ summary }: { summary: ScorecardSummary }) {
  const { t, locale } = useLocale();
  const overdue = summary.overdue;
  const blocked = summary.blocked;
  const drift = summary.finish_drift;
  const driftValue =
    drift.value === null
      ? "—"
      : t("scorecard.summary.drift_value", {
          value: `${drift.value > 0 ? "+" : ""}${formatAmount(locale, drift.value)}`,
        });
  return (
    <div className="scorecard-stats">
      <div className="scorecard-stat">
        <span className="scorecard-stat__label">{t("scorecard.summary.overdue")}</span>
        <span className="scorecard-stat__value" data-status={overdue.status}>
          {overdue.value === null ? "—" : formatAmount(locale, overdue.value)}
        </span>
        <span className="scorecard-stat__note">
          {overdue.value
            ? t("scorecard.row.avg_overdue", {
                count: formatAmount(locale, overdue.avg_days ?? 0),
              })
            : t("scorecard.summary.none")}
        </span>
      </div>
      <div className="scorecard-stat">
        <span className="scorecard-stat__label">{t("scorecard.summary.blocked")}</span>
        <span className="scorecard-stat__value" data-status={blocked.status}>
          {blocked.value}
        </span>
        <span className="scorecard-stat__note">
          {blocked.longest
            ? t("scorecard.summary.blocked_longest", {
                task: blocked.longest.name,
                count: blocked.longest.days,
              })
            : t("scorecard.summary.none")}
        </span>
      </div>
      <div className="scorecard-stat">
        <span className="scorecard-stat__label">{t("scorecard.summary.finish_drift")}</span>
        <span className="scorecard-stat__value" data-status={drift.status}>
          {driftValue}
        </span>
        <span className="scorecard-stat__note">
          {drift.projected_finish
            ? t("scorecard.summary.projected", {
                date: formatShortDate(t, drift.projected_finish),
              })
            : t("scorecard.summary.no_forecast")}
        </span>
      </div>
    </div>
  );
}

/** The per-person table: a row unfolds into the week's tasks. */
function TeamTable({
  team,
  onOpenTask,
}: {
  team: { assessment: boolean; members: TeamMember[]; unassigned_planned: number };
  onOpenTask: (taskId: string) => void;
}) {
  const { t } = useLocale();
  const [openId, setOpenId] = useState<string | null>(null);

  if (team.members.length === 0) {
    return <p className="scorecard-team__empty">{t("scorecard.team.empty")}</p>;
  }

  return (
    <section className="scorecard-team">
      <div className="scorecard-table__scroll">
        <table className="scorecard-table">
          <thead>
            <tr>
              <th scope="col">{t("scorecard.team.person")}</th>
              <th scope="col">{t("scorecard.team.pace")}</th>
              <th scope="col">{t("scorecard.team.on_time")}</th>
              {team.assessment && <th scope="col">{t("scorecard.team.signal")}</th>}
              <th scope="col">{t("scorecard.team.trend")}</th>
              <th scope="col" aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {team.members.map((member) => (
              <MemberRow
                key={member.user.id}
                member={member}
                assessment={team.assessment}
                open={openId === member.user.id}
                onToggle={() =>
                  setOpenId((current) => (current === member.user.id ? null : member.user.id))
                }
                onOpenTask={onOpenTask}
              />
            ))}
          </tbody>
        </table>
      </div>
      <p className="scorecard-team__foot">
        <span>
          {team.unassigned_planned > 0 &&
            t("scorecard.team.unassigned", {
              tasks: t("common.tasks", { count: team.unassigned_planned }),
            })}
        </span>
        <span>{t(team.assessment ? "scorecard.team.assessment_note" : "scorecard.team.no_assessment")}</span>
      </p>
    </section>
  );
}

function MemberRow({
  member,
  assessment,
  open,
  onToggle,
  onOpenTask,
}: {
  member: TeamMember;
  assessment: boolean;
  open: boolean;
  onToggle: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  const { t } = useLocale();
  const columns = assessment ? 6 : 5;
  const doneOfPlanned = member.planned === 0 ? null : member.done / member.planned;
  return (
    <>
      <tr
        className={`scorecard-row${open ? " is-open" : ""}`}
        aria-expanded={open}
        onClick={onToggle}
      >
        <td>
          <span className="scorecard-person">
            <Avatar name={member.user.name} size={28} />
            {member.user.name}
          </span>
        </td>
        <td>
          <div className="scorecard-pace">
            <div className="scorecard-pace__nums">
              <strong>
                {member.done} / {member.planned}
              </strong>
              <span>{t("scorecard.team.pace_planned")}</span>
              {member.extra > 0 && (
                <span className="scorecard-pace__extra">
                  {t("scorecard.team.extra", { count: member.extra })}
                </span>
              )}
            </div>
            <div className="scorecard-pace__bar">
              {doneOfPlanned !== null && (
                <i
                  data-status={paceStatus(doneOfPlanned)}
                  style={{ width: `${Math.round(doneOfPlanned * 100)}%` }}
                />
              )}
            </div>
          </div>
        </td>
        <td className={`scorecard-ontime${member.done > member.on_time ? " is-bad" : ""}`}>
          {member.done === 0 ? (
            "—"
          ) : (
            <>
              {member.on_time}
              <small>{t("scorecard.team.of", { count: member.done })}</small>
            </>
          )}
        </td>
        {assessment && (
          <td>
            {member.signal && member.reason && (
              <span className="scorecard-signal" data-level={member.signal}>
                <span className="scorecard-signal__dot" />
                <span className="scorecard-signal__reason">
                  {reasonText(t, member.reason)}
                </span>
              </span>
            )}
          </td>
        )}
        <td>
          <TrendBars member={member} />
        </td>
        <td className="scorecard-row__caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </td>
      </tr>
      {open && (
        <tr className="scorecard-drill">
          <td colSpan={columns}>
            {member.tasks.length === 0 ? (
              <p className="scorecard-drill__empty">{t("scorecard.drill.empty")}</p>
            ) : (
              <ul className="scorecard-drill__list">
                {member.tasks.map((task) => (
                  <li key={task.id}>
                    <button
                      type="button"
                      className="scorecard-task"
                      onClick={() => onOpenTask(task.id)}
                    >
                      <span className="scorecard-task__name">{task.name}</span>
                      <span className="scorecard-task__due">
                        {task.due ? t("scorecard.task.due", { date: formatShortDate(t, task.due) }) : ""}
                      </span>
                      <span className="scorecard-task__state">
                        <span className="scorecard-chip" data-kind={task.state}>
                          {taskChip(t, task)}
                        </span>
                        {taskNote(t, task)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The pace bar's colour — by the share done: the same thresholds as the server's share metrics (a
 * target of 0.8; a risk below three quarters of it).
 */
function paceStatus(share: number): string {
  if (share >= 0.8) return "ok";
  if (share >= 0.6) return "warn";
  return "risk";
}

/** Eight bars of what was closed in a week, without libraries. The current one in the accent colour. */
function TrendBars({ member }: { member: TeamMember }) {
  const { t } = useLocale();
  const peak = Math.max(...member.trend.map((point) => point.closed ?? 0), 1);
  const last = member.trend.length - 1;
  return (
    <span className="scorecard-trend">
      {member.trend.map((point, index) => {
        const label = `${formatShortDate(t, point.week_start)} · ${
          point.closed === null
            ? t("scorecard.status.no_data")
            : t("scorecard.team.closed", { count: point.closed })
        }`;
        return (
          <span key={point.week_start} className="scorecard-trend__slot" title={label}>
            {point.closed !== null && (
              <i
                className={index === last ? "is-now" : undefined}
                data-zero={point.closed === 0 ? "" : undefined}
                style={{ height: `${Math.max(8, (point.closed / peak) * 100)}%` }}
              />
            )}
          </span>
        );
      })}
    </span>
  );
}

function reasonText(t: Translate, reason: TeamReason): string {
  switch (reason.kind) {
    case "in_pace":
      return t("scorecard.team.reason.in_pace");
    case "overdue_silent":
      return t("scorecard.team.reason.overdue_silent", { count: reason.count });
    case "overdue_warned":
      return t("scorecard.team.reason.overdue_warned", { count: reason.count });
    case "blocked":
      return t("scorecard.team.reason.blocked", { task: reason.task, count: reason.days });
    case "risk_flag":
      return t("scorecard.team.reason.risk_flag", {
        task: reason.task,
        risk: t(`task.risk.${reason.risk}`),
      });
    case "reopened":
      return t("scorecard.team.reason.reopened", { task: reason.task });
  }
}

function taskChip(t: Translate, task: TeamTask): string {
  switch (task.state) {
    case "done":
      return t("scorecard.task.done");
    case "late":
      return t("scorecard.task.late", { count: task.late_days ?? 0 });
    case "blocked":
      return t("scorecard.task.blocked", { count: task.blocked_days ?? 0 });
    case "risk":
      return t("scorecard.task.risk", { risk: t(`task.risk.${task.risk}`) });
    case "progress":
      return t("scorecard.task.progress");
    case "planned":
      return t("scorecard.task.planned");
  }
}

/** A note on the chip: what they warned about, how late they were, whether it came back. */
function taskNote(t: Translate, task: TeamTask): string | null {
  const notes: string[] = [];
  if (task.state === "late") {
    notes.push(
      task.warned
        ? t(`scorecard.task.warned_${task.warned_kind ?? "risk"}`)
        : t("scorecard.task.silent"),
    );
  }
  if (task.state === "done" && (task.late_days ?? 0) > 0) {
    notes.push(t("scorecard.task.done_late", { count: task.late_days ?? 0 }));
  }
  if (task.reopened) {
    notes.push(t("scorecard.task.reopened"));
  }
  return notes.length ? notes.join(" · ") : null;
}
