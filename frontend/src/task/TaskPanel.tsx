import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { errorKey } from "../api/errors";
import { MEMBERS_QUERY_KEY, members as fetchMembers } from "../api/org";
import { CRITICALITY_LEVELS, TASK_STATUSES } from "../api/projects";
import type { Criticality, Op, ProjectState, Task, TaskStatus } from "../api/projects";
import { Avatar } from "../components/Avatar";
import { StatusChip } from "../components/StatusChip";
import { Switch } from "../components/Switch";
import { useEscape } from "../components/useEscape";
import { baselineOf, deviationDays, endShiftDays, isBeyondPlan } from "../project/baseline";
import {
  addDependency,
  deleteTask,
  patchMilestone,
  patchProgress,
  patchStatus,
  patchTask,
  removeDependency,
  reorderTask,
} from "../project/optimistic";
import { overlapDays } from "../project/DependencyNudge";
import { isShiftCancelled } from "../project/ShiftReason";
import { useProjectMutation } from "../project/useProjectMutation";
import { dateOfProjectDay, projectDayNumber, relativeDayLabel } from "../gantt/relative";
import { addDays } from "../gantt/timescale";
import { formatShortDate } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";
import { Comments } from "./Comments";
import { SelectField, TextField, ValueField } from "./fields";
import { History } from "./History";
import { TaskProgress } from "./TaskProgress";

import "./panel.css";

/** Вкладка карточки: свойства задачи, история или обсуждение. */
export type PanelTab = "details" | "history" | "comments";

/**
 * Карточка задачи — выдвижная панель во всю высоту экрана.
 *
 * `position: fixed` от верхнего края окна до нижнего, поверх шапки проекта и
 * ленты: карточка не начинается от места клика и не зависит от прокрутки
 * страницы — при любой прокрутке ленты она остаётся растянутой от края до
 * края. Устроена тремя ярусами: закреплённая шапка (название, статус, период,
 * прогресс и вкладки), прокручиваемая середина и закреплённый подвал с
 * кнопками. Если содержимое не помещается, прокручивается только середина.
 *
 * `complementary`, а не `dialog`: карточка накрывает лишь правую колонку
 * экрана и не забирает фокус — по ленте слева работают одновременно с ней,
 * сверяя полоску с полями. Окно с подложкой требовало бы закрывать себя перед
 * каждым взглядом на соседнюю задачу.
 *
 * Закрывается тремя способами, потому что к ней приходят тремя путями: мышью
 * за крестик, с клавиатуры по Esc и повторным щелчком по той же полоске —
 * последнее люди делают не задумываясь, и без этого щелчок выглядит
 * бездействием.
 */
export function TaskPanel({
  projectId,
  task,
  state,
  canWrite,
  initialTab = "details",
  onClose,
}: {
  projectId: string;
  task: Task;
  /** Весь проект: карточке нужны и категории, и соседи по ним. */
  state: ProjectState;
  canWrite: boolean;
  /**
   * С какого раздела открыть. По умолчанию свойства — за ними приходят чаще
   * всего; со счётчика реплик на строке ленты приходят сразу в обсуждение, и
   * лишний щелчок по вкладке там означал бы, что счётчик привёл не туда, куда
   * обещал.
   */
  initialTab?: PanelTab;
  onClose: () => void;
}) {
  const categories = state.categories;
  const { t } = useLocale();
  const { apply } = useProjectMutation(projectId);
  const [error, setError] = useState<unknown>(null);
  // Удаление спрашивает подтверждение прямо в карточке — тем же образом, что
  // пересогласование плана: окно поверх карточки закрывало бы задачу, о
  // которой спрашивает.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Счётчик отказов. Служит полям знаком «вернись к состоянию»: сравнивать
  // значения им недостаточно — догадка и откат часто укладываются в один кадр,
  // и с точки зрения поля значение не менялось.
  const [refusals, setRefusals] = useState(0);

  // Вкладка карточки. Сбрасывается к той, с которой карточку открыли, при
  // переходе к соседней задаче: карточка, оставшаяся открытой на «Истории»
  // одной задачи, не должна молча показывать историю следующей — на неё
  // щёлкнули, чтобы увидеть саму задачу.
  //
  // Зависимость по разделу — не лишняя: со строки ленты в одну и ту же задачу
  // ведут два пути, и щелчок по счётчику реплик обязан открыть обсуждение,
  // даже когда карточка этой задачи уже открыта на свойствах.
  const [tab, setTab] = useState<PanelTab>(initialTab);
  useEffect(() => setTab(initialTab), [task.id, initialTab]);

  // Отказ здесь — не ошибка карточки: роль `client` состава организации не
  // получает вовсе, и блок исполнителей просто не рисуется. Тот же довод, что
  // и в форме создания задачи.
  const membersQuery = useQuery({
    queryKey: MEMBERS_QUERY_KEY,
    queryFn: fetchMembers,
    retry: false,
    staleTime: Infinity,
  });

  // Карточка — нижний слой: поверх неё встают и окно «объясните сдвиг», и
  // меню ленты, и встроенное подтверждение удаления. Своим слушателем на
  // документе карточка закрывалась бы вместе с любым из них, унося
  // недописанное; общая стопка отдаёт Esc только верхнему.
  //
  // Слушатель по-прежнему на документе, а не на самой карточке: к моменту
  // нажатия фокус чаще всего на полоске, и слушатель на карточке молчал бы.
  useEscape(onClose);

  // Подтверждение удаления живёт внутри карточки, но ведёт себя как слой над
  // ней: Esc здесь значит «передумал удалять», а не «закрой карточку». Второе
  // унесло бы и вопрос, и задачу, о которой он.
  useEscape(() => setConfirmingDelete(false), confirmingDelete);

  // Относительный план: поля дат карточки говорят днями проекта — дат у
  // такого плана ещё нет (см. gantt/relative.ts).
  const relative = state.schedule_mode === "relative";

  const send = (op: Op, optimistic: (state: ProjectState) => ProjectState) => {
    setError(null);
    // Отказ уже откачен внутри `apply`: здесь остаётся объяснить его словами и
    // вернуть поле к тому, что осталось в состоянии.
    apply(op, optimistic).catch((refusal: unknown) => {
      // Отказ объяснять сдвиг — не ошибка: человек нажал «Вернуть», и поле
      // обязано вернуться к сохранённому значению молча. Сообщение об ошибке
      // здесь читалось бы как «что-то сломалось», хотя сломаться нечему.
      if (!isShiftCancelled(refusal)) setError(refusal);
      setRefusals((count) => count + 1);
    });
  };

  const patch = (fields: Partial<Task>) => (state: ProjectState) =>
    patchTask(state, task.id, fields);

  // Заметка — единственное поле с ограниченной видимостью, и `set_task_fields`
  // несёт все три текстовых поля разом. Значит, не видя заметки, послать эту
  // операцию нельзя: она стёрла бы её пустой строкой. По матрице прав такой
  // роли не существует — писать может лишь тот, кто заметку видит, — но
  // рассчитывать на совпадение двух списков прав не стоит.
  const editsText = canWrite && "internal_note" in task;

  const commitFields = (changed: Partial<Task>) => {
    const fields = {
      name: task.name,
      description: task.description ?? "",
      internal_note: task.internal_note ?? "",
      ...changed,
    };
    send({ type: "set_task_fields", task_id: task.id, ...fields }, patch(fields));
  };

  const toggleAssignee = (userId: string) => {
    const assigned = task.assignee_ids.includes(userId);
    send(
      {
        type: assigned ? "unassign_user" : "assign_user",
        task_id: task.id,
        user_id: userId,
      },
      patch({
        assignee_ids: assigned
          ? task.assignee_ids.filter((id) => id !== userId)
          : [...task.assignee_ids, userId],
      }),
    );
  };

  // Период в шапке — теми же словами, что и поля дат ниже: относительный план
  // говорит днями проекта, календарный — короткими датами.
  const dateLabel = (iso: string) =>
    relative ? relativeDayLabel(t, iso) : formatShortDate(t, iso);

  return (
    <aside
      className="panel"
      role="complementary"
      // Название задачи в подписи: карточек за сеанс открывают десяток, и
      // «дополнительная информация» без имени не говорит, о какой из них речь.
      aria-label={t("task.panel.aria", { name: task.name })}
    >
      {/* Шапка закреплена: название, статус с периодом, прогресс и вкладки
          видны при любой прокрутке середины. */}
      <header className="panel__head">
        <div className="panel__head-top">
          {/* Название задачи — содержимое пользователя: не переводится. */}
          <h2 className="panel__title">{task.name}</h2>
          <button
            type="button"
            className="panel__close"
            aria-label={t("task.panel.close")}
            title={t("task.panel.close")}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {/* `key` по задаче: «день отмечен» и черновик процента относятся к
            этой задаче и не должны доноситься до соседней. */}
        <TaskProgress
          key={task.id}
          task={task}
          canWrite={canWrite}
          timeZone={state.settings?.timezone}
          resetToken={refusals}
          meta={
            <>
              <StatusChip status={task.status} label={t(`task.status.${task.status}`)} />
              <span className="panel__meta-sep" aria-hidden="true" />
              {/* Период одной строкой «старт — конец»: тире внутри строки, а
                  не два узла, — иначе даты разъезжаются по флексу. */}
              <span className="panel__period">
                {dateLabel(task.start_date)} — {dateLabel(task.end_date)}
              </span>
              <span className="panel__meta-sep" aria-hidden="true" />
            </>
          }
          onCommit={(progress_pct) =>
            send({ type: "set_progress", task_id: task.id, progress_pct }, (state) =>
              patchProgress(state, task.id, progress_pct),
            )
          }
        />

        {/* Отказ сервера — в шапке, а не в прокручиваемой середине: объяснение
            обязано быть на глазах, на какой бы глубине ни правили поле. */}
        {error !== null && (
          <p className="error" role="alert">
            {t(errorKey(error))}
          </p>
        )}

        {/* Свойства, история и обсуждение — вкладки одной карточки, а не три
            ленты подряд: и историю, и разговор за сеанс открывают реже, чем
            правят поля, и держать их всегда развёрнутыми — растягивать
            карточку тем, что смотрят от случая к случаю. */}
        <div className="panel__tabs" role="tablist" aria-label={t("task.panel.tabs")}>
        <button
          type="button"
          role="tab"
          id="panel-tab-details"
          aria-selected={tab === "details"}
          aria-controls="panel-tabpanel-details"
          className={tab === "details" ? "panel__tab is-active" : "panel__tab"}
          onClick={() => setTab("details")}
        >
          {t("task.panel.tab_details")}
        </button>
        <button
          type="button"
          role="tab"
          id="panel-tab-history"
          aria-selected={tab === "history"}
          aria-controls="panel-tabpanel-history"
          className={tab === "history" ? "panel__tab is-active" : "panel__tab"}
          onClick={() => setTab("history")}
        >
          {t("task.panel.history")}
        </button>
        <button
          type="button"
          role="tab"
          id="panel-tab-comments"
          aria-selected={tab === "comments"}
          aria-controls="panel-tabpanel-comments"
          className={tab === "comments" ? "panel__tab is-active" : "panel__tab"}
          onClick={() => setTab("comments")}
        >
          {t("task.panel.comments")}
        </button>
        </div>
      </header>

      {/* Середина — единственное, что прокручивается: шапка и подвал стоят.
          `key` по задаче: переход к соседней начинает поля заново, а не
          доносит в новую карточку недописанный текст из прежней. */}
      <div className="panel__body" key={task.id}>
      <Baseline task={task} state={state} />

      {tab === "details" && (
        <div id="panel-tabpanel-details" role="tabpanel" aria-labelledby="panel-tab-details">
          {/* Свойства собраны аккордеонами, как в макете. Все раскрыты с
              порога: аккордеон здесь — оглавление длинной карточки и способ
              убрать с глаз лишнее, а не спрятать поля по умолчанию. */}
          <Section title={t("task.panel.section_main")}>
          <div className="panel__fields">
            <TextField
              id="panel-name"
              label={t("task.panel.name")}
              value={task.name}
              disabled={!editsText}
              resetToken={refusals}
              onCommit={(name) => commitFields({ name })}
            />

            <TextField
              id="panel-description"
              label={t("task.panel.description")}
              value={task.description ?? ""}
              rows={3}
              disabled={!editsText}
              resetToken={refusals}
              onCommit={(description) => commitFields({ description })}
            />

            <SelectField
              id="panel-status"
              label={t("task.panel.status")}
              value={task.status}
              disabled={!canWrite}
              options={TASK_STATUSES.map((status) => ({
                value: status,
                label: t(`task.status.${status}`),
              }))}
              onCommit={(value) => {
                const status = value as TaskStatus;
                // Оптимистичная догадка повторяет серверную сцепку: «готово»
                // доводит прогресс до ста (см. optimistic.ts).
                send({ type: "set_status", task_id: task.id, status }, (state) =>
                  patchStatus(state, task.id, status),
                );
              }}
            />

            <SelectField
              id="panel-category"
              label={t("task.panel.category")}
              value={task.category_id}
              disabled={!canWrite}
              // Название категории — содержимое пользователя: не переводится.
              options={categories.map((category) => ({
                value: category.id,
                label: category.name,
              }))}
              onCommit={(categoryId) => {
                // В конец выбранной категории: перенос списком — это смена
                // принадлежности, а не выбор места внутри. Место выбирают
                // перетаскиванием строки.
                const position = state.tasks.filter(
                  (row) => row.category_id === categoryId && row.id !== task.id,
                ).length;
                send(
                  { type: "reorder_task", task_id: task.id, category_id: categoryId, position },
                  (state) => reorderTask(state, task.id, categoryId, position),
                );
              }}
            />

            <SelectField
              id="panel-criticality"
              label={t("task.panel.criticality")}
              value={task.criticality}
              disabled={!canWrite}
              options={CRITICALITY_LEVELS.map((level) => ({
                value: level,
                label: t(`task.criticality.${level}`),
              }))}
              onCommit={(value) => {
                const criticality = value as Criticality;
                send(
                  { type: "set_criticality", task_id: task.id, criticality },
                  patch({ criticality }),
                );
              }}
            />

            {/* Веха — рубильник, а не поле: у него два состояния, и меняются
                они сразу. Стоит перед сроками не случайно: включённый он
                схлопывает длительность в день, и решение «это точка или
                отрезок» принимается раньше, чем набирается срок. */}
            <div className="panel__row">
              <Switch
                id="panel-milestone"
                label={t("task.panel.milestone")}
                checked={task.milestone}
                disabled={!canWrite}
                onChange={(milestone) =>
                  send({ type: "set_milestone", task_id: task.id, milestone }, (state) =>
                    patchMilestone(state, task.id, milestone),
                  )
                }
              />
            </div>

            {relative ? (
              // Относительный план: старт правится номером дня проекта — дат
              // у такого плана нет. Перевод номера в координату оси линейный;
              // рабочие дни считает сервер, как и всюду.
              <ValueField
                id="panel-start"
                label={t("task.panel.start_day")}
                type="number"
                value={String(projectDayNumber(task.start_date))}
                disabled={!canWrite}
                resetToken={refusals}
                onCommit={(value) => {
                  const day = Number(value);
                  if (!Number.isInteger(day) || day < 1) return;
                  const start_date = dateOfProjectDay(day);
                  send({ type: "move_task", task_id: task.id, start_date }, patch({ start_date }));
                }}
              />
            ) : (
              <ValueField
                id="panel-start"
                label={t("task.panel.start")}
                type="date"
                value={task.start_date}
                disabled={!canWrite}
                resetToken={refusals}
                onCommit={(start_date) =>
                  send({ type: "move_task", task_id: task.id, start_date }, patch({ start_date }))
                }
              />
            )}

            <ValueField
              id="panel-duration"
              label={t("task.panel.duration")}
              type="number"
              value={String(task.duration_days)}
              disabled={!canWrite}
              resetToken={refusals}
              onCommit={(value) => {
                const duration_days = Number(value);
                send(
                  { type: "set_duration", task_id: task.id, duration_days },
                  patch({ duration_days }),
                );
              }}
            />

            <div className="panel__row">
              <span className="panel__key">{t("task.panel.end")}</span>
              {/* Дата окончания только показывается: её считает сервер по
                  календарю проекта, и поле для правки обещало бы влияние,
                  которого нет. */}
              <span className="panel__value">
                {relative ? relativeDayLabel(t, task.end_date) : formatShortDate(t, task.end_date)}
              </span>
            </div>

            {/* Единственное поле с ограниченной видимостью. Показывать его
                или нет, решает сервер: если заметки нет в ответе, блока нет
                в интерфейсе. */}
            {"internal_note" in task && (
              <TextField
                id="panel-note"
                label={t("task.panel.internal_note")}
                value={task.internal_note ?? ""}
                rows={3}
                disabled={!editsText}
                resetToken={refusals}
                onCommit={(internal_note) => commitFields({ internal_note })}
              />
            )}
          </div>
          </Section>

          <Section title={t("task.panel.section_links")}>
            <Dependencies task={task} state={state} canWrite={canWrite} send={send} />
          </Section>

          {membersQuery.data && membersQuery.data.length > 0 && (
            <Section title={t("task.panel.assignees")}>
              {/* Группа с подписью: заголовок аккордеона — украшение, а имя
                  списку исполнителей нужно и на слух. */}
              <div
                className="panel__chips"
                role="group"
                aria-label={t("task.panel.assignees")}
              >
                {membersQuery.data.map((member) => (
                  // Каждый исполнитель — своя операция: их и снимают по
                  // одному, и в истории они читаются как отдельные события.
                  <button
                    key={member.id}
                    type="button"
                    className="panel__chip"
                    aria-pressed={task.assignee_ids.includes(member.id)}
                    disabled={!canWrite}
                    onClick={() => toggleAssignee(member.id)}
                  >
                    {/* Аватар до имени: в списке и в карточке человек обязан
                        узнаваться одним и тем же пятном цвета. */}
                    <Avatar name={member.name} size={20} />
                    {/* Имя человека — содержимое, а не хрома. */}
                    {member.name}
                  </button>
                ))}
              </div>
            </Section>
          )}
        </div>
      )}

      {tab === "history" && (
        <div id="panel-tabpanel-history" role="tabpanel" aria-labelledby="panel-tab-history">
          <History projectId={projectId} taskId={task.id} relative={relative} />
        </div>
      )}

      {tab === "comments" && (
        <div id="panel-tabpanel-comments" role="tabpanel" aria-labelledby="panel-tab-comments">
          <Comments projectId={projectId} taskId={task.id} />
        </div>
      )}

      {/* Удаление — последним блоком, вне вкладок: это не правка задачи, а
          расставание с ней, и она ждёт на любой вкладке карточки. Отдельного
          окна нет — подтверждение разворачивается на месте, как у
          пересогласования плана. Само удаление отменяемо: снимок для отмены
          (со связями, назначениями и разговором) хранит журнал. */}
      {canWrite && (
        <div className="panel__danger">
          {confirmingDelete ? (
            <span className="plan__confirm">
              <span className="muted">{t("task.panel.delete_warning")}</span>
              <button
                type="button"
                onClick={() => {
                  send({ type: "delete_task", task_id: task.id }, (state) =>
                    deleteTask(state, task.id),
                  );
                  // Карточку закрывает сам факт исчезновения задачи из
                  // состояния, но выбранный идентификатор должен забыться:
                  // иначе отказ сервера, вернув задачу, снова открыл бы её
                  // карточку — уже без объяснения, почему.
                  onClose();
                }}
              >
                {t("task.panel.delete_confirm")}
              </button>
              <button
                type="button"
                className="button--quiet"
                onClick={() => setConfirmingDelete(false)}
              >
                {t("common.cancel")}
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="button--quiet button--alert"
              onClick={() => setConfirmingDelete(true)}
            >
              {t("task.panel.delete")}
            </button>
          )}
        </div>
      )}
      </div>

      {/* Подвал закреплён, как в макете. Поля карточки сохраняют себя сами
          (см. components/autosave), поэтому обе кнопки завершают правку:
          щелчок по «Сохранить изменения» сперва уводит фокус из поля — и тем
          отправляет недописанный черновик, — потом закрывает карточку.
          «Отмена» просто закрывает: откат уже записанного — работа кнопки
          «Отменить» в журнале, а не подвала. Читателю подвал не показывается:
          сохранять ему нечего, закрыть можно крестиком и Esc. */}
      {canWrite && (
        <footer className="panel__foot">
          <button type="button" className="button--quiet" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="panel__save" onClick={onClose}>
            {t("task.panel.save")}
          </button>
        </footer>
      )}
    </aside>
  );
}

/**
 * Аккордеон карточки: заголовок-створка и содержимое под ней.
 *
 * Нативный `details`: створка доступна с клавиатуры и читается вслух без
 * единой строки скрипта. Раскрыт с порога — аккордеон здесь способ свернуть
 * прочитанное, а не спрятать поля по умолчанию.
 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="panel__section" open>
      <summary className="panel__section-head">{title}</summary>
      {children}
    </details>
  );
}

/**
 * Связи задачи: «зависит от» и «блокирует», с правкой из карточки.
 *
 * Обе стороны одной и той же связи `from → to`: «зависит от» — где задача
 * приёмник, «блокирует» — где источник. Правятся они здесь, а не только
 * рисуются стрелками, потому что стрелку нельзя ни добавить, ни снять мышью
 * на ленте — жеста для этого там нет.
 *
 * Кандидаты не включают уже связанных и обратную сторону: A→B вместе с B→A —
 * это цикл, и предлагать его значило бы предлагать отказ сервера. Остальные
 * циклы — длинные — ловит сервер, и отказ откатывает догадку.
 */
function Dependencies({
  task,
  state,
  canWrite,
  send,
}: {
  task: Task;
  state: ProjectState;
  canWrite: boolean;
  send: (op: Op, optimistic: (state: ProjectState) => ProjectState) => void;
}) {
  const { t } = useLocale();
  const nameOf = new Map(state.tasks.map((row) => [row.id, row.name]));
  const byId = new Map(state.tasks.map((row) => [row.id, row]));

  const predecessors = state.dependencies
    .filter((link) => link.to_task_id === task.id)
    .map((link) => link.from_task_id);
  const successors = state.dependencies
    .filter((link) => link.from_task_id === task.id)
    .map((link) => link.to_task_id);

  /**
   * Нарушена ли связь с этой задачей — и как её починить.
   *
   * Стрелка на ленте показывает нарушение молча, и её знак «!» отправляет
   * человека сюда — значит, здесь оно обязано быть и названо, и поправимо.
   * Предложение под лентой (см. DependencyNudge) живёт только вокруг
   * последнего сдвига; нарушение, оставшееся с прежних правок, без этой
   * пометки не имело ни одного места, где его можно взять и снять.
   *
   * Двигается всегда последователь — тем же правилом и на тот же день, что и
   * в предложении под лентой: два способа починить одну связь обязаны чинить
   * её одинаково.
   */
  const trouble = (link: { from: string; to: string }) => {
    const from = byId.get(link.from);
    const to = byId.get(link.to);
    if (from === undefined || to === undefined) return null;
    const days = overlapDays(from, to);
    if (days <= 0) return null;
    const start_date = addDays(to.start_date, days);
    return {
      label: t("task.panel.link_violated", {
        from: from.name,
        to: to.name,
      }),
      fix: t("gantt.nudge", { name: to.name, days: t("common.days", { count: days }) }),
      move: () =>
        send({ type: "move_task", task_id: to.id, start_date }, (current) =>
          patchTask(current, to.id, { start_date }),
        ),
    };
  };

  const candidates = (taken: string[], opposite: string[]) =>
    state.tasks.filter(
      (row) => row.id !== task.id && !taken.includes(row.id) && !opposite.includes(row.id),
    );

  const add = (from: string, to: string) =>
    send({ type: "add_dependency", from_task_id: from, to_task_id: to }, (current) =>
      addDependency(current, from, to),
    );
  const remove = (from: string, to: string) =>
    send({ type: "remove_dependency", from_task_id: from, to_task_id: to }, (current) =>
      removeDependency(current, from, to),
    );

  const group = (
    label: string,
    ids: string[],
    options: Task[],
    link: (otherId: string) => { from: string; to: string },
  ) => (
    <div className="panel__row panel__deps">
      <span className="panel__key">{label}</span>
      <span className="panel__dep-list">
        {ids.length === 0 && !canWrite && <span className="muted">—</span>}
        {ids.map((id) => {
          const broken = trouble(link(id));
          return (
            <span key={id} className={`panel__dep${broken ? " is-violated" : ""}`}>
              {broken && (
                // Тот же знак, что на стрелке ленты: человек пришёл сюда с
                // «!» на связи и должен узнать его, а не искать заново.
                <span className="panel__dep-warn" role="img" aria-label={broken.label} title={broken.label}>
                  !
                </span>
              )}
              {/* Название задачи — содержимое пользователя: не переводится. */}
              {nameOf.get(id) ?? id}
              {canWrite && (
                <button
                  type="button"
                  className="panel__dep-remove"
                  aria-label={t("task.panel.unlink", { name: nameOf.get(id) ?? id })}
                  title={t("task.panel.unlink", { name: nameOf.get(id) ?? id })}
                  onClick={() => {
                    const { from, to } = link(id);
                    remove(from, to);
                  }}
                >
                  ×
                </button>
              )}
            </span>
          );
        })}
        {canWrite &&
          ids.map((id) => {
            const broken = trouble(link(id));
            if (broken === null) return null;
            // Кнопка стоит рядом с пилюлями, а не внутри пилюли: внутри она
            // читалась бы как часть имени задачи, и целиться в неё среди
            // текста пришлось бы точнее, чем стоит просить ради починки.
            return (
              <button
                key={`fix-${id}`}
                type="button"
                className="button--quiet panel__dep-fix"
                onClick={broken.move}
              >
                {broken.fix}
              </button>
            );
          })}
        {canWrite && options.length > 0 && (
          // Значение всегда пустое: это не выбор состояния, а команда
          // «добавить связь», и после неё список обязан вернуться к подсказке.
          <select
            className="panel__dep-add"
            value=""
            aria-label={t("task.panel.add_link_to", { label })}
            onChange={(event) => {
              if (event.target.value === "") return;
              const { from, to } = link(event.target.value);
              add(from, to);
            }}
          >
            <option value="">{t("task.panel.add_link")}</option>
            {options.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        )}
      </span>
    </div>
  );

  return (
    <div className="panel__links">
      {group(t("task.panel.depends_on"), predecessors, candidates(predecessors, successors), (id) => ({
        from: id,
        to: task.id,
      }))}
      {group(t("task.panel.blocks"), successors, candidates(successors, predecessors), (id) => ({
        from: task.id,
        to: id,
      }))}
    </div>
  );
}

/**
 * Сводка отклонения от базового плана.
 *
 * Отдельным блоком наверху карточки, а не строкой среди полей: это не поле —
 * его нельзя править, и стоя между «датой старта» и «длительностью», оно
 * читалось бы как ещё одно значение, которое кто-то ввёл.
 *
 * Список переносов с причинами живёт ниже, в ленте истории: причина стоит
 * рядом со своим событием и датой, а второй список тех же событий здесь
 * означал бы два места, где одно и то же расходится.
 */
function Baseline({ task, state }: { task: Task; state: ProjectState }) {
  const { t } = useLocale();
  const relative = state.schedule_mode === "relative";

  if (isBeyondPlan(state, task)) {
    return <p className="panel__baseline muted">{t("plan.beyond_plan_explained")}</p>;
  }

  const baseline = baselineOf(task);
  if (baseline === null) return null;

  const shift = endShiftDays(task);
  const deviation = deviationDays(task) ?? 0;

  return (
    <p className="panel__baseline">
      <span className="muted">
        {t("gantt.baseline", {
          from: relative ? relativeDayLabel(t, baseline.start) : formatShortDate(t, baseline.start),
          to: relative ? relativeDayLabel(t, baseline.end) : formatShortDate(t, baseline.end),
        })}
      </span>
      {shift !== null && shift !== 0 && (
        <span className={shift > 0 ? "panel__deviation is-late" : "panel__deviation is-early"}>
          {shift > 0
            ? t("gantt.deviation_late", { days: t("common.days", { count: shift }) })
            : t("gantt.deviation_early", { days: t("common.days", { count: -shift }) })}
        </span>
      )}
      {deviation > 0 && (
        <span className="muted">
          {t("plan.deviation_summary", { days: t("common.days", { count: deviation }) })}
        </span>
      )}
    </p>
  );
}
