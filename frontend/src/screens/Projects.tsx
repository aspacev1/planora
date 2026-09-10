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
 * Проекты: единственный список проектов, единственная сводка «как идут дела»
 * и место, откуда их заводят и где с ними расстаются.
 *
 * Раньше это были два экрана про один и тот же набор проектов — карточки
 * заводили проект и звали посмотреть на цветной вердикт, соседняя таблица
 * «Отчётов» сверяла готовность и сроки по строкам. Выбирать, на каком из двух
 * смотреть, было незачем: те же шесть чисел сравниваются по столбцу лучше,
 * чем по карточкам, — и раздел, который заводит и удаляет проекты, стал тем
 * же разделом, что показывает их сводку.
 *
 * Пока список и все состояния не пришли разом, экран показывает одну надпись
 * «Загрузка», а не строки с прочерками на месте чисел, которых ещё нет.
 * Дальше строки друг от друга не зависят: не пришедшая сводка одного проекта —
 * это баннер отказа сверху, а не пропавшая строка соседа, у которого всё
 * посчиталось.
 */
export function Projects() {
  const { t } = useLocale();
  // Проектов в списке может быть много, и у каждого мог быть свой пояс:
  // просрочка считается по суткам того, кто на список смотрит, а не по
  // суткам одного из них.
  const today = useToday();
  const { pending, error, states } = useProjectStates();
  // Удаление — право владельца, как и в настройках проекта: редактор правит
  // план, но не расстаётся с проектом целиком. Решает всё равно сервер, здесь
  // лишь не предлагается действие, которое кончится отказом.
  const role = useOrgRole();
  const canDelete = role === "owner";
  // Создание — по тому же правилу, что и удаление, и по той же причине: сервер
  // решает про оба одинаково (PROJECT_WRITE), и предлагать наблюдателю кнопку,
  // которая ответит отказом, — значит встречать нового участника отказом на
  // первом же нажатии.
  const canCreate = roleCanWrite(role);
  // Проект, о котором задан вопрос, а не «окно открыто»: окно называет имя, и
  // держать его отдельным состоянием значило бы завести второй источник того
  // же самого. Окно одно на список: вопрос задают об одном проекте за раз.
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
        // Пустой список значит разное для разных ролей, и одно объяснение на
        // оба случая обманывает половину читателей. У того, кто может писать,
        // проектов действительно нет. У наблюдателя и клиента они, скорее
        // всего, есть — просто ему не выдали доступ, и звать его «создать
        // первый» некуда: сервер откажет.
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
                {/* Столбец есть только там, где есть чем его заполнить: без
                    права удалять в нём не нашлось бы ни одной ячейки. */}
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

      {/* Окно живёт на экране, а не в строке таблицы: строка удалённого
          проекта исчезает в тот же миг, что и он сам, и окно внутри неё
          унесло бы с собой отказ сервера, если тот откажет. */}
      {deleting && <DeleteProjectDialog project={deleting} onClose={() => setDeleting(null)} />}
    </main>
  );
}

/**
 * Вопрос перед удалением — окном, а не выноской на строке.
 *
 * Окно здесь не «на всякий случай»: удаление проекта единственное действие
 * продукта, которое не отменяется ничем — вместе с проектом уходит журнал
 * ревизий, — а нажимают его в таблице из одинаковых строк, где промах на
 * одну выше или ниже ничем не выдаёт себя. Окно называет имя проекта: это
 * единственное место, где человек может заметить, что целился в соседний.
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
      {/* Не «вы уверены?», а последствие — теми же словами, что и в настройках
          проекта: действие одно и то же, и второй набор строк однажды сказал
          бы о нём другое. */}
      <p>{t("settings.project.delete_warning")}</p>

      {remove.error !== null && (
        <p className="error" role="alert">
          {t(errorKey(remove.error))}
        </p>
      )}

      {/* Отказ стоит первым, вопреки обычному для окна порядку «главное
          действие слева»: окно ставит фокус на первый орган управления, и у
          необратимого действия первым под рукой обязан быть отказ. Enter,
          нажатый быстрее, чем прочитано предупреждение, здесь ничего не
          удаляет. */}
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
  /** Нет — удалять этот проект человеку не позволено, и шестерни в строке нет. */
  onDelete?: () => void;
}) {
  const { t } = useLocale();
  const progress = progressOf(state.tasks);
  const counts = statusCounts(state.tasks);
  // Считает общий модуль, а не эта строка: «просрочено» здесь и «после
  // дедлайна проекта» в шапке проекта — две разные величины с одним именем, и
  // третий их счёт разошёлся бы с обоими.
  const overdue = overdueTasks(state, today).length;

  return (
    <tr>
      <th scope="row">
        {/* Название проекта — содержимое пользователя: не переводится. */}
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
 * Шестерёнка: знак действий над проектом.
 *
 * Нарисована здесь, а не взята библиотекой, — как и значки колонки навигации:
 * десять строк разметки не стоят зависимости с сотней неиспользованных
 * значков.
 *
 * Обод с отверстием, а не втулка с лучами: восемь лучей вокруг точки — это
 * солнце, и в шестнадцати пикселях оно так и читается. Зубья узнаются только
 * тем, что они торчат из колеса.
 *
 * `aria-hidden`: имя кнопке даёт `buttonLabel` меню, и прочитанный вслух
 * значок повторил бы его.
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
 * Вердикт по сроку — словами, а не датой: дату пришлось бы сравнивать в уме,
 * а «+4 дня» — уже ответ. Без дедлайна вердикта нет: писать «успеваем» там,
 * где успевать не к чему, — выдумывать смысл. У относительного плана его нет
 * по той же причине: сравнивать дедлайн не с чем, пока не назначен старт, и
 * «укладываемся» про такой проект было бы обещанием, взятым из воздуха.
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
