import { Link } from "react-router-dom";

import { errorKey } from "../api/errors";
import type { ProjectState, Task } from "../api/projects";
import { useAuth } from "../auth/AuthProvider";
import { StatusChip } from "../components/StatusChip";
import { relativeDayLabel } from "../gantt/relative";
import { formatShortDate } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";
import { isTaskOverdue } from "../project/verdict";
import { useProjectStates } from "./projectStates";
import { useToday } from "../time/useToday";

/**
 * "My tasks": everything assigned to the signed-in person, across all the projects.
 *
 * Sorted by end date, the finished at the end: the list answers "what is urgent for me" rather than
 * retelling the projects in order. The overdue is marked with the same red as on the strip — red here
 * always means a date.
 */
export function MyTasks() {
  const { t } = useLocale();
  const { user } = useAuth();
  const { pending, error, states } = useProjectStates();
  // There are many projects here, and each could have its own zone: "overdue" on a shared list is
  // counted by the reader's day rather than by the day of one of them.
  const today = useToday();

  const mine: { task: Task; project: ProjectState }[] = states
    .flatMap((project) =>
      project.tasks
        .filter((task) => user !== null && task.assignee_ids.includes(user.id))
        .map((task) => ({ task, project })),
    )
    .sort((a, b) => {
      const doneA = a.task.status === "done" ? 1 : 0;
      const doneB = b.task.status === "done" ? 1 : 0;
      if (doneA !== doneB) return doneA - doneB;
      return a.task.end_date < b.task.end_date ? -1 : a.task.end_date > b.task.end_date ? 1 : 0;
    });

  return (
    <main className="screen">
      <div className="screen__head">
        <h1>{t("my_tasks.title")}</h1>
      </div>

      {pending && <p role="status">{t("common.loading")}</p>}

      {error !== null && (
        <p className="error" role="alert">
          {t(errorKey(error))}
        </p>
      )}

      {!pending && error === null && mine.length === 0 && (
        <div className="empty">
          <p className="empty__title">{t("my_tasks.empty.title")}</p>
          <p className="muted">{t("my_tasks.empty.hint")}</p>
        </div>
      )}

      {mine.length > 0 && (
        <ul className="task-list">
          {mine.map(({ task, project }) => {
            // The shared overdueness reckoning rather than a comparison with today of its own: for a
            // relative plan's task a "date" is an axis coordinate from 2001, and such a comparison would
            // mark every row of a project with no assigned dates as overdue.
            const overdue = isTaskOverdue(project, task, today);
            return (
              <li key={task.id} className="task-list__row">
                <span className="task-list__main">
                  {/* The task's and the project's names are user content. */}
                  <span className="task-list__name">{task.name}</span>
                  <Link to={`/projects/${project.id}`} className="task-list__project muted">
                    {project.name}
                  </Link>
                </span>
                <span className={`task-list__dates${overdue ? " is-late" : ""}`}>
                  {t("project.period", {
                    from:
                      project.schedule_mode === "relative"
                        ? relativeDayLabel(t, task.start_date)
                        : formatShortDate(t, task.start_date),
                    to:
                      project.schedule_mode === "relative"
                        ? relativeDayLabel(t, task.end_date)
                        : formatShortDate(t, task.end_date),
                  })}
                  {overdue && (
                    <span role="img" aria-label={t("my_tasks.overdue")} title={t("my_tasks.overdue")}>
                      {" "}
                      !
                    </span>
                  )}
                </span>
                <StatusChip status={task.status} label={t(`task.status.${task.status}`)} />
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
