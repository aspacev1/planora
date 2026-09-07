import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { MEMBERS_QUERY_KEY, members as fetchMembers } from "../api/org";
import { errorKey } from "../api/errors";
import { listPlanApprovals } from "../api/projects";
import type { PlanApproval, ProjectState } from "../api/projects";
import { FEED_PAGE, feedQueryKey, listProjectRevisions } from "../api/revisions";
import type { FeedFilters, RevisionEntry } from "../api/revisions";
import { modKeyLabel } from "../components/hotkeys";
import { formatDate, formatTime } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";
import { formatEvent } from "../task/formatEvent";
import { useTimeZone } from "../time/useToday";
import { dayIn } from "../time/zone";
import { useUndo } from "./useUndo";

import "./history.css";

/**
 * Группы фильтра по типу изменения.
 *
 * Человек ищет не операцию журнала, а род события: «кто двигал сроки», «кто
 * трогал состав». Отдельный пункт на каждый из тринадцати типов превратил бы
 * фильтр в оглавление кода. Сервер при этом фильтрует по настоящим типам —
 * группа разворачивается в список ещё на клиенте.
 */
const TYPE_GROUPS = {
  dates: ["move_task", "set_duration", "resize_task", "move_category", "set_milestone"],
  status: ["set_status", "set_progress"],
  fields: ["set_task_fields", "set_criticality", "set_risk", "rename_category", "set_category_color"],
  structure: [
    "create_task",
    "delete_task",
    "reorder_task",
    "create_category",
    "reorder_category",
    "delete_category",
  ],
  people: ["assign_user", "unassign_user"],
  links: ["add_dependency", "remove_dependency"],
} as const;

type TypeGroup = keyof typeof TYPE_GROUPS;

/**
 * Значок записи: род события виден раньше, чем прочитана фраза.
 *
 * Глиф — символ шрифта, а не картинка: пиктограммы здесь размером с букву, и
 * набор SVG ради тринадцати стрелок был бы зависимостью без выигрыша. Тон
 * повторяет палитру статусов приложения: сроки и новое — акцентом, готовность
 * и назначение — зелёным, правки — янтарным, удаления и критичность — тревогой.
 */
const EVENT_ICONS: Record<string, readonly [glyph: string, tone: string]> = {
  move_task: ["↔", "accent"],
  set_duration: ["↔", "accent"],
  resize_task: ["↔", "accent"],
  move_category: ["↔", "accent"],
  // Веха — не срок и не текст: она превращает отрезок в точку, и знак у
  // неё свой, тот же ромб, каким она нарисована на ленте.
  set_milestone: ["◆", "accent"],
  set_status: ["✓", "ok"],
  set_progress: ["✓", "ok"],
  set_criticality: ["!", "danger"],
  // Риск — слово исполнителя о сроке: тон внимания, как у просрочки.
  set_risk: ["!", "warn"],
  set_task_fields: ["✎", "warn"],
  rename_category: ["✎", "warn"],
  set_category_color: ["✎", "warn"],
  create_task: ["＋", "accent"],
  create_category: ["＋", "accent"],
  reorder_task: ["⇅", "warn"],
  reorder_category: ["⇅", "warn"],
  delete_task: ["✕", "danger"],
  delete_category: ["✕", "danger"],
  assign_user: ["＋", "ok"],
  unassign_user: ["−", "warn"],
  add_dependency: ["→", "accent"],
  remove_dependency: ["−", "warn"],
};

/** Запись-отмена узнаётся по стрелке назад, каким бы ни было отменённое. */
function eventIcon(entry: RevisionEntry): readonly [string, string] {
  if (entry.undoes_seq !== null) return ["↶", "muted"];
  return EVENT_ICONS[String(entry.op.type)] ?? ["•", "muted"];
}

/** Строка ленты: запись журнала или веха согласования плана. */
type FeedRow =
  | { kind: "revision"; at: string; entry: RevisionEntry }
  | { kind: "batch"; at: string; batchId: string; entries: RevisionEntry[] }
  | { kind: "milestone"; at: string; approval: PlanApproval };

/**
 * Лента изменений всего проекта — вкладка «История».
 *
 * Новые сверху, дни — заголовками: историю читают с последнего события.
 * Пачка AI сворачивается в одну строку — тридцать записей «создал задачу»
 * подряд не история, а шум. Отменённые записи остаются и помечаются: журнал
 * не переписывается, в этом его смысл.
 *
 * Кнопка «Отменить» стоит только у записи, которую сервер назвал в
 * `state.undoable`: бэкенд сознательно отменяет только последнее действие, и
 * кнопка у каждой записи обещала бы то, чего нет. Шаг за шагом назад —
 * повторными нажатиями.
 */
export function ProjectHistory({
  projectId,
  state,
  canUndo,
}: {
  projectId: string;
  state: ProjectState;
  /** Право и возможность отменять: право писать плюс живая связь. */
  canUndo: boolean;
}) {
  const { t, locale } = useLocale();
  const [taskFilter, setTaskFilter] = useState("");
  const [actorFilter, setActorFilter] = useState("");
  const [groupFilter, setGroupFilter] = useState<TypeGroup | "">("");
  const [openBatches, setOpenBatches] = useState<ReadonlySet<string>>(new Set());

  const filters: FeedFilters = {
    taskId: taskFilter || undefined,
    actorId: actorFilter || undefined,
    types: groupFilter ? [...TYPE_GROUPS[groupFilter]] : undefined,
  };
  const filtered = Boolean(taskFilter || actorFilter || groupFilter);

  const feed = useInfiniteQuery({
    queryKey: feedQueryKey(projectId, filters),
    queryFn: ({ pageParam }) => listProjectRevisions(projectId, filters, pageParam),
    initialPageParam: undefined as number | undefined,
    // Страница короче предела — конец журнала: курсор дальше не поведёт.
    getNextPageParam: (last) =>
      last.length < FEED_PAGE ? undefined : last[last.length - 1].seq,
    retry: false,
  });

  // Состав — только для фильтра по автору. Отказ — не ошибка ленты: роли
  // `client` состав не отдаётся, и фильтр тогда просто не рисуется.
  const membersQuery = useQuery({
    queryKey: MEMBERS_QUERY_KEY,
    queryFn: fetchMembers,
    retry: false,
    staleTime: Infinity,
  });

  // Вехи согласования. Ключ — под ключом проекта: событие о переутверждении
  // сбрасывает всё поддерево, и летопись перечитывается вместе с состоянием.
  // Отказ ленту не ломает — она остаётся без флажков.
  const approvalsQuery = useQuery({
    queryKey: ["project", projectId, "plan-approvals"] as const,
    queryFn: () => listPlanApprovals(projectId),
    retry: false,
  });

  const undo = useUndo(projectId, state);

  // Лента группируется по суткам читателя, а не по суткам сервера: «Сегодня»
  // в заголовке дня отвечает на «что было сегодня у меня», и запись, сделанная
  // в половине первого ночи, обязана попасть под сегодняшний заголовок, а не
  // под вчерашний.
  const zone = useTimeZone(state.settings?.timezone);

  if (feed.isPending) {
    return <p role="status">{t("common.loading")}</p>;
  }
  if (feed.error) {
    return (
      <p className="error" role="alert">
        {t(errorKey(feed.error))}
      </p>
    );
  }

  const entries = feed.data.pages.flat();

  // Кто что отменил: запись об отмене всегда новее отменённой, поэтому при
  // чтении с головы журнала пара сходится без второго запроса к серверу.
  const undoneBy = new Map<number, RevisionEntry>();
  for (const entry of entries) {
    if (entry.undoes_seq !== null) undoneBy.set(entry.undoes_seq, entry);
  }

  const rows = buildRows(entries, approvalsQuery.data ?? [], {
    // Вехи под фильтром прячутся: отфильтрованная по задаче лента с чужими
    // флажками читалась бы как история этой задачи с лишними событиями.
    milestones: !filtered,
    exhausted: !feed.hasNextPage,
  });

  const days = new Map<string, FeedRow[]>();
  for (const row of rows) {
    const day = dayIn(zone, new Date(row.at));
    days.set(day, [...(days.get(day) ?? []), row]);
  }

  const today = dayIn(zone);
  const yesterday = dayIn(zone, Date.now() - 86_400_000);
  // «Сегодня» — с датой, а не вместо неё: слово стареет в открытой вкладке,
  // и запись «Сегодня» без числа завтра утром будет ложью.
  const dayLabel = (day: string) =>
    day === today
      ? `${t("history.today")} · ${formatDate(t, day)}`
      : day === yesterday
        ? `${t("history.yesterday")} · ${formatDate(t, day)}`
        : formatDate(t, day);

  const toggleBatch = (batchId: string) =>
    setOpenBatches((current) => {
      const next = new Set(current);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });

  // Кнопка отмены — строго у того, что назвал сервер: одиночная запись или
  // пачка целиком. canUndo уже включает и право, и живую связь.
  const undoableSeq =
    canUndo && state.undoable && !state.undoable.batch_id ? state.undoable.seq : null;
  const undoableBatch = (canUndo && state.undoable?.batch_id) || null;

  // Ctrl/⌘+Z делает ровно то же самое — и сочетание названо прямо на кнопке:
  // иначе о нём знали бы только те, кто попробовал наугад.
  const undoButton = (label: string) => (
    <button
      type="button"
      className="button--quiet feed__undo"
      onClick={() => undo.mutation.mutate()}
      disabled={undo.mutation.isPending}
      title={`${label} · ${modKeyLabel()}+Z`}
      aria-keyshortcuts="Control+Z"
    >
      {label}
    </button>
  );

  const line = (entry: RevisionEntry) => (
    <>
      {entry.actor && <span className="feed__actor">{entry.actor.name} </span>}
      {!entry.actor && <span className="feed__actor">{t("history.no_actor")} </span>}
      {entry.undoes_seq !== null && (
        <span className="feed__badge">{t("history.undo_badge")} </span>
      )}
      {formatEvent(entry.op, locale, entry.names, state.schedule_mode === "relative")}
      {subjectOf(entry) && <span className="feed__subject"> · {subjectOf(entry)}</span>}
    </>
  );

  /**
   * Подпись под фразой. Время карточки стоит в её правой колонке, поэтому сюда
   * оно попадает только у вложенных записей пачки — у них правой колонки нет.
   * Пустая подпись не рисуется: карточка без причины остаётся однострочной.
   */
  const meta = (entry: RevisionEntry, withTime = false) => {
    const undoneEntry = undoneBy.get(entry.seq);
    if (!withTime && !entry.reason && !undoneEntry) return null;
    return (
      <p className="feed__meta">
        {withTime && <span>{formatTime(locale, new Date(entry.created_at))}</span>}
        {/* Причина — текст пользователя: как есть, без перевода. */}
        {entry.reason && <span className="feed__reason">{entry.reason}</span>}
        {undoneEntry && (
          <span className="feed__undone-mark">
            {undoneEntry.actor
              ? t("history.undone_by", { name: undoneEntry.actor.name })
              : t("history.undone")}
          </span>
        )}
      </p>
    );
  };

  const time = (at: string) => (
    <span className="feed__time">{formatTime(locale, new Date(at))}</span>
  );

  const icon = (glyph: string, tone: string) => (
    <span className={`feed__icon feed__icon--${tone}`} aria-hidden="true">
      {glyph}
    </span>
  );

  return (
    <section className="feed" aria-label={t("history.title")}>
      <div className="feed__filters">
        {membersQuery.data && (
          <label className="feed__filter">
            {t("history.filter.person")}
            <select value={actorFilter} onChange={(e) => setActorFilter(e.target.value)}>
              <option value="">{t("history.filter.all")}</option>
              {membersQuery.data.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="feed__filter">
          {t("history.filter.task")}
          <select value={taskFilter} onChange={(e) => setTaskFilter(e.target.value)}>
            <option value="">{t("history.filter.all")}</option>
            {state.tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.name}
              </option>
            ))}
          </select>
        </label>
        <label className="feed__filter">
          {t("history.filter.type")}
          <select
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value as TypeGroup | "")}
          >
            <option value="">{t("history.filter.all")}</option>
            {(Object.keys(TYPE_GROUPS) as TypeGroup[]).map((group) => (
              <option key={group} value={group}>
                {t(`history.filter.group.${group}`)}
              </option>
            ))}
          </select>
        </label>
        {filtered && (
          <button
            type="button"
            className="button--quiet"
            onClick={() => {
              setTaskFilter("");
              setActorFilter("");
              setGroupFilter("");
            }}
          >
            {t("history.filter.reset")}
          </button>
        )}
      </div>

      {undo.error !== null && (
        <p className="error" role="alert">
          {t(errorKey(undo.error))}
        </p>
      )}

      {rows.length === 0 && <p className="muted feed__empty">{t("history.feed_empty")}</p>}

      {[...days.entries()].map(([day, dayRows]) => (
        <section
          key={day}
          className={`feed__day${day === today ? " feed__day--today" : ""}`}
        >
          <header className="feed__day-head">
            {/* Номер — прямо из ключа дня: ключ и есть местная дата. */}
            <span className="feed__day-dot" aria-hidden="true">
              {Number(day.slice(8, 10))}
            </span>
            <h3 className="feed__day-title">{dayLabel(day)}</h3>
          </header>
          <ol className="feed__list">
            {dayRows.map((row) => {
              if (row.kind === "milestone") {
                return (
                  <li key={`plan-${row.approval.version}`} className="feed__card feed__milestone">
                    {icon("⚑", "ok")}
                    <div className="feed__main">
                      <p className="feed__line">
                        {t("history.milestone", { version: row.approval.version })}
                        {row.approval.approved_by && (
                          <span className="feed__subject"> · {row.approval.approved_by.name}</span>
                        )}
                      </p>
                    </div>
                    <div className="feed__tools">{time(row.at)}</div>
                  </li>
                );
              }

              if (row.kind === "batch") {
                const open = openBatches.has(row.batchId);
                const isUndo = row.entries.every((entry) => entry.undoes_seq !== null);
                const head = row.entries[0];
                return (
                  <li key={`batch-${row.batchId}`} className="feed__card feed__batch">
                    {/* Пачка — почерк AI, и её значок — не действие, а искра. */}
                    {icon(isUndo ? "↶" : "✦", isUndo ? "muted" : "accent")}
                    <div className="feed__main">
                      <p className="feed__line">
                        {head.actor && <span className="feed__actor">{head.actor.name} </span>}
                        {!head.actor && (
                          <span className="feed__actor">{t("history.no_actor")} </span>
                        )}
                        {t(isUndo ? "history.batch_undo" : "history.batch", {
                          count: row.entries.length,
                        })}
                      </p>
                      <p className="feed__meta">
                        <button
                          type="button"
                          className="feed__toggle"
                          aria-expanded={open}
                          onClick={() => toggleBatch(row.batchId)}
                        >
                          {t(open ? "history.collapse" : "history.expand")}
                        </button>
                        {undoableBatch === row.batchId && undoButton(t("history.undo_batch"))}
                      </p>
                      {open && (
                        <ol className="feed__list feed__list--nested">
                          {row.entries.map((entry) => (
                            <li key={entry.seq} className="feed__item">
                              <p className="feed__line">{line(entry)}</p>
                              {meta(entry, true)}
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                    <div className="feed__tools">{time(head.created_at)}</div>
                  </li>
                );
              }

              const entry = row.entry;
              const undone = undoneBy.has(entry.seq);
              const [glyph, tone] = eventIcon(entry);
              return (
                <li
                  key={entry.seq}
                  className={`feed__card feed__item${undone ? " feed__item--undone" : ""}`}
                >
                  {icon(glyph, tone)}
                  <div className="feed__main">
                    <p className="feed__line">{line(entry)}</p>
                    {meta(entry)}
                  </div>
                  <div className="feed__tools">
                    {time(entry.created_at)}
                    {undoableSeq === entry.seq && undoButton(t("undo.action"))}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}

      {feed.hasNextPage && (
        <button
          type="button"
          className="button--quiet feed__more"
          onClick={() => void feed.fetchNextPage()}
          disabled={feed.isFetchingNextPage}
        >
          {t("history.show_more")}
        </button>
      )}
    </section>
  );
}

/**
 * Чьё имя ставить рядом с фразой. Фраза говорит «перенёс старт с 12 на 19
 * марта», подлежащее — задача — берётся из словаря имён записи.
 *
 * Переименование категории имя не дублирует: обе границы уже в самой фразе.
 * У связи подлежащих два, и они тоже в фразе (см. formatEvent).
 */
function subjectOf(entry: RevisionEntry): string | null {
  const op = entry.op;
  const type = String(op.type);
  if (type === "rename_category" || type.endsWith("_dependency")) return null;
  for (const key of ["task_id", "category_id"]) {
    const id = op[key];
    if (id && entry.names[String(id)]) return entry.names[String(id)];
  }
  return null;
}

/**
 * Записи и вехи — в строки ленты, новые сверху.
 *
 * Соседние записи одной пачки сворачиваются в одну строку. Вехи вклеиваются по
 * времени, но только внутри загруженного отрезка журнала: веха старше самой
 * старой загруженной записи появится вместе со своей страницей — иначе она
 * прыгала бы по ленте при каждом «Показать ещё».
 */
function buildRows(
  entries: RevisionEntry[],
  approvals: PlanApproval[],
  { milestones, exhausted }: { milestones: boolean; exhausted: boolean },
): FeedRow[] {
  const rows: FeedRow[] = [];
  for (const entry of entries) {
    const last = rows[rows.length - 1];
    if (entry.batch_id && last?.kind === "batch" && last.batchId === entry.batch_id) {
      last.entries.push(entry);
      continue;
    }
    if (entry.batch_id) {
      rows.push({
        kind: "batch",
        at: entry.created_at,
        batchId: entry.batch_id,
        entries: [entry],
      });
      continue;
    }
    rows.push({ kind: "revision", at: entry.created_at, entry });
  }

  if (!milestones) return rows;

  const oldest = entries.length > 0 ? entries[entries.length - 1].created_at : null;
  const visible = approvals.filter(
    (approval) => exhausted || (oldest !== null && approval.approved_at >= oldest),
  );
  const merged = [
    ...rows,
    ...visible.map(
      (approval): FeedRow => ({ kind: "milestone", at: approval.approved_at, approval }),
    ),
  ];
  // Сортировка по времени, новые сверху; веха одного мгновения с записью
  // встаёт над ней — согласование закрывает то, что было до него.
  return merged.sort(
    (a, b) =>
      (a.at < b.at ? 1 : a.at > b.at ? -1 : 0) ||
      (a.kind === "milestone" ? -1 : b.kind === "milestone" ? 1 : 0),
  );
}
