import { useState } from "react";
import { Link } from "react-router-dom";

import { errorKey } from "../api/errors";
import type { ProjectState } from "../api/projects";
import { roleCanWrite, useOrgRole } from "../auth/permissions";
import { CreateProjectActions } from "../components/CreateProjectActions";
import { Menu } from "../components/Menu";
import { Modal } from "../components/Modal";
import { formatShortDate } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";
import { progressOf, statusCounts } from "../project/progress";
import { useDeleteProject } from "../project/useDeleteProject";
import { deadlineOverrunDays, overdueTasks } from "../project/verdict";
import { useToday } from "../time/useToday";
import { useProjectStates } from "./projectStates";

/**
 * Projects: the only list of projects, the only "how are things going" summary
 * and the place they are created from and parted with.
 *
 * These used to be two screens about one and the same set of projects — the
 * cards created a project and invited you to look at a coloured verdict, the
 * neighbouring "Reports" table checked readiness and dates row by row. There was
 * no point choosing which of the two to look at: the same six numbers compare
 * better down a column than across cards — and the section that creates and
 * deletes projects became the same section that shows their summary.
 *
 * Until the list and all the states have arrived together, the screen shows a
 * single "Loading" caption rather than rows with dashes in place of numbers that
 * are not there yet. Beyond that the rows do not depend on one another: one
 * project's summary failing to arrive is a refusal banner at the top, not a
 * missing row for a neighbour whose numbers all came out.
 */
export function Projects() {
  const { t } = useLocale();
  // There can be many projects in the list, and each could have its own zone:
  // being overdue is counted by the day of whoever is looking at the list, not by
  // the day of one of them.
  const today = useToday();
  const { pending, error, states } = useProjectStates();
  // Deletion is the owner's right, as in the project's settings: an editor edits
  // the plan but does not part with the project whole. The server decides either
  // way — here we merely refrain from offering an action that will end in a refusal.
  const role = useOrgRole();
  const canDelete = role === "owner";
  // Creation follows the same rule as deletion, and for the same reason: the
  // server decides about both identically (PROJECT_WRITE), and offering an
  // observer a button that will answer with a refusal means greeting a new
  // participant with a refusal on their very first press.
  const canCreate = roleCanWrite(role);
  // The project the question is about, rather than "the dialog is open": the
  // dialog names the name, and keeping it as a separate state would mean having a
  // second source of the same thing. There is one dialog for the list: the
  // question is asked about one project at a time.
  const [deleting, setDeleting] = useState<ProjectState | null>(null);

  return (
    <main className="screen">
      <div className="screen__head">
        <h1>{t("projects.title")}</h1>
        {canCreate && <CreateProjectActions />}
      </div>

      {pending && <p role="status">{t("common.loading")}</p>}

      {error !== null && (
        <p className="error" role="alert">
          {t(errorKey(error))}
        </p>
      )}

      {!pending && error === null && states.length === 0 && (
        // An empty list means different things for different roles, and one
        // explanation for both cases deceives half the readers. Someone who can
        // write really has no projects. An observer and a client most likely do
        // have them — they simply were not given access, and there is nowhere to
        // invite them to "create the first one": the server will refuse.
        <div className="empty">
          <p className="empty__title">
            {t(canCreate ? "projects.empty.title" : "projects.empty.no_access_title")}
          </p>
          <p className="muted">
            {t(canCreate ? "projects.empty.hint" : "projects.empty.no_access_hint")}
          </p>
        </div>
      )}

      {states.length > 0 && (
        <div className="report__scroll">
          <table className="report">
            <thead>
              <tr>
                <th scope="col">{t("reports.col.project")}</th>
                <th scope="col">{t("reports.col.progress")}</th>
                <th scope="col">{t("task.status.in_progress")}</th>
                <th scope="col">{t("task.status.blocked")}</th>
                <th scope="col">{t("reports.col.overdue")}</th>
                <th scope="col">{t("reports.col.deadline")}</th>
                {/* The column exists only where there is something to fill it
                    with: without the right to delete there would not be a single cell in it. */}
                {canDelete && (
                  <th scope="col" className="report__actions">
                    {t("reports.col.actions")}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {states.map((state) => (
                <ProjectRow
                  key={state.id}
                  state={state}
                  today={today}
                  onDelete={canDelete ? () => setDeleting(state) : undefined}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* The dialog lives on the screen rather than in the table's row: a deleted
          project's row disappears at the same instant as the project itself, and
          a dialog inside it would carry away the server's refusal with it, should
          the server refuse. */}
      {deleting && <DeleteProjectDialog project={deleting} onClose={() => setDeleting(null)} />}
    </main>
  );
}

/**
 * The question before deletion — as a dialog, not a popover on the row.
 *
 * A dialog here is not "just in case": deleting a project is the one action in
 * the product that nothing undoes — the revision journal goes with the project —
 * and it is pressed in a table of identical rows, where missing by one row up or
 * down gives itself away by nothing. The dialog names the project's name: this is
 * the only place where a person can notice they were aiming at the neighbour.
 */
function DeleteProjectDialog({
  project,
  onClose,
}: {
  project: ProjectState;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const remove = useDeleteProject({ onDeleted: onClose });

  return (
    <Modal title={t("projects.delete_title", { name: project.name })} onClose={onClose}>
      {/* Not "are you sure?" but the consequence — in the same words as in the
          project's settings: the action is one and the same, and a second set of
          strings would one day say something different about it. */}
      <p>{t("settings.project.delete_warning")}</p>

      {remove.error !== null && (
        <p className="error" role="alert">
          {t(errorKey(remove.error))}
        </p>
      )}

      {/* Refusal comes first, against a dialog's usual "the main action on the
          left" order: the dialog puts the focus on the first control, and for an
          irreversible action the first thing at hand must be the refusal. An
          Enter pressed faster than the warning is read deletes nothing here. */}
      <div className="modal__actions">
        <button type="button" className="button--quiet" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className="button--danger"
          disabled={remove.isPending}
          onClick={() => remove.mutate({ id: project.id, name: project.name })}
        >
          {t("settings.project.delete_confirm")}
        </button>
      </div>
    </Modal>
  );
}

function ProjectRow({
  state,
  today,
  onDelete,
}: {
  state: ProjectState;
  today: string;
  /** No — the person is not allowed to delete this project, and there is no cog in the row. */
  onDelete?: () => void;
}) {
  const { t } = useLocale();
  const progress = progressOf(state.tasks);
  const counts = statusCounts(state.tasks);
  // Computed by the shared module rather than by this row: "overdue" here and
  // "past the project's deadline" in the project's header are two different
  // quantities with one name, and a third reckoning of them would diverge from both.
  const overdue = overdueTasks(state, today).length;

  return (
    <tr>
      <th scope="row">
        {/* The project's name is user content: it is not translated. */}
        <Link to={`/projects/${state.id}`}>{state.name}</Link>
      </th>
      <td>{progress === null ? "—" : `${progress}%`}</td>
      <td>{counts.in_progress}</td>
      <td className={counts.blocked > 0 ? "report__warn" : undefined}>{counts.blocked}</td>
      <td className={overdue > 0 ? "report__late" : undefined}>{overdue}</td>
      <td>
        <Deadline state={state} />
      </td>
      {onDelete && (
        <td className="report__actions">
          <Menu
            label={<GearIcon />}
            buttonClass="report__gear"
            showCaret={false}
            buttonLabel={t("projects.card.menu")}
          >
            <button type="button" className="menu__item menu__item--danger" onClick={onDelete}>
              {t("settings.project.delete")}
            </button>
          </Menu>
        </td>
      )}
    </tr>
  );
}

/**
 * The cog: the sign of actions on a project.
 *
 * Drawn here rather than taken from a library — like the navigation column's
 * icons: ten lines of markup are not worth a dependency with a hundred unused
 * icons.
 *
 * A rim with a hole rather than a hub with rays: eight rays around a dot is a
 * sun, and at sixteen pixels that is exactly how it reads. Teeth are recognized
 * only by sticking out of a wheel.
 *
 * `aria-hidden`: the button is named by the menu's `buttonLabel`, and the icon
 * read aloud would repeat it.
 */
function GearIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="4.5" />
      <circle cx="8" cy="8" r="1.7" />
      <path d="M8 3.5V1.7M8 12.5v1.8M3.5 8H1.7M12.5 8h1.8M4.82 4.82 3.55 3.55M11.18 11.18l1.27 1.27M11.18 4.82l1.27-1.27M4.82 11.18l-1.27 1.27" />
    </svg>
  );
}

/**
 * The verdict on the deadline — in words rather than as a date: a date would have
 * to be compared in your head, while "+4 days" is already an answer. Without a
 * deadline there is no verdict: writing "on time" where there is nothing to be on
 * time for is inventing a meaning. A relative plan has none for the same reason:
 * there is nothing to compare a deadline with until a start is assigned, and
 * "we fit" about such a project would be a promise taken out of thin air.
 */
function Deadline({ state }: { state: ProjectState }) {
  const { t } = useLocale();
  if (
    state.schedule_mode !== "calendar" ||
    state.deadline === null ||
    state.project_end === null
  ) {
    return <span className="muted">—</span>;
  }
  const overrun = deadlineOverrunDays(state);
  if (overrun !== null) {
    return (
      <span className="report__late">
        {t("reports.deadline_late", { days: t("common.days", { count: overrun }) })}
      </span>
    );
  }
  return (
    <span className="report__fine">
      {t("reports.deadline_fits", { date: formatShortDate(t, state.deadline) })}
    </span>
  );
}
