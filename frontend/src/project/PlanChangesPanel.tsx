import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";

import { listPlanApprovals } from "../api/projects";
import type { ProjectState } from "../api/projects";
import { feedQueryKey, listProjectRevisions } from "../api/revisions";
import type { RevisionEntry } from "../api/revisions";
import { Switch } from "../components/Switch";
import { useEscape } from "../components/useEscape";
import { relativeDayLabel } from "../gantt/relative";
import { formatDate, formatShortDate } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";
import { useTimeZone } from "../time/useToday";
import { dayIn } from "../time/zone";
import { planChanges, removedTasks } from "./planChanges";
import type { PlanChange } from "./planChanges";

// Слой и три яруса панель берёт у карточки задачи — стили оттуда же, а не
// переписанные заново: две выдвижные колонки на одном месте обязаны выезжать
// одинаково, иначе переход из списка в карточку выглядит переездом в другое
// приложение.
import "../task/panel.css";
import "./planChanges.css";

/**
 * Операции, которые двигают сроки, — и только они.
 *
 * Тот же набор, что стоит за группой «Сроки» в фильтре истории: причины сдвигов
 * ищутся среди них, потому что причину спрашивают именно за уход от базового
 * плана, а переименование или смена статуса её не требуют и не имеют.
 */
// Веха тоже здесь: она схлопывает длительность до дня, и сервер спрашивает
// причину за это так же, как за растяжение (см. `_guard_shift_threshold`).
const DATE_OPS = ["move_task", "set_duration", "resize_task", "move_category", "set_milestone"];

type GroupKey = "shifts" | "durations" | "added" | "removed";

/**
 * Боковая панель «что изменилось после согласования».
 *
 * Панель, а не окно с подложкой: список и лента рассказывают одно и то же
 * двумя языками — строками и призраками полосок, — и читать их нужно вместе.
 * Окно накрывало бы диаграмму ровно в тот миг, когда тумблер «показывать
 * утверждённый план» включает на ней то, ради чего его и включают.
 *
 * Считается всё из состояния проекта — оно уже на экране. Два запроса, которые
 * панель всё же делает, лениво и только за тем, чего в состоянии нет по
 * определению: снимок версии знает удалённые задачи, журнал — причины сдвигов.
 * Обоих может не быть (отказ, роль без права на журнал) — тогда панель
 * показывает то же, что и без них, и молчит: список расхождений от этого не портится.
 */
export function PlanChangesPanel({
  projectId,
  state,
  canReapprove,
  baselineShown,
  onBaselineToggle,
  onOpenTask,
  onReapprove,
  onClose,
}: {
  projectId: string;
  state: ProjectState;
  /** Право переутвердить план — владелец при живой связи. */
  canReapprove: boolean;
  /** Показывает ли лента призрак согласованного плана. */
  baselineShown: boolean;
  onBaselineToggle: () => void;
  /** Открыть карточку задачи. Окно при этом закрывается: карточка встаёт на его место. */
  onOpenTask: (taskId: string) => void;
  /** Перейти к подтверждению переутверждения — тому же, что и у кнопки в шапке. */
  onReapprove: () => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [group, setGroup] = useState<GroupKey | "all">("all");
  const zone = useTimeZone(state.settings?.timezone);

  // Летопись версий — ради имён удалённых задач и имени согласовавшего. Ключ
  // тот же, что у ленты истории: она уже могла её загрузить, и второй раз
  // ходить незачем.
  const approvals = useQuery({
    queryKey: ["project", projectId, "plan-approvals"] as const,
    queryFn: () => listPlanApprovals(projectId),
    retry: false,
  });

  // Причины сдвигов. Одной страницей: причина нужна к последнему уходу задачи
  // от плана, а не ко всем подряд, и она стоит в верхних записях журнала.
  const feedFilters = { types: DATE_OPS };
  const feed = useQuery({
    queryKey: feedQueryKey(projectId, feedFilters),
    queryFn: () => listProjectRevisions(projectId, feedFilters),
    retry: false,
  });

  const changes = planChanges(state);
  const removed = removedTasks(state, approvals.data ?? []);
  const reasons = reasonsByTask(state, feed.data ?? []);

  const approvedBy = (approvals.data ?? []).find(
    (approval) => approval.version === state.plan_version,
  )?.approved_by;

  /** Дата в том виде, в каком её показывает лента: у плана без старта — день проекта. */
  const day = (iso: string) =>
    state.schedule_mode === "relative" ? relativeDayLabel(t, iso) : formatShortDate(t, iso);

  const groups: { key: GroupKey; rows: PlanChange[] }[] = [
    { key: "shifts", rows: changes.shifts },
    { key: "durations", rows: changes.durations },
    { key: "added", rows: changes.added },
    { key: "removed", rows: removed },
  ];
  const filled = groups.filter((row) => row.rows.length > 0);
  const shown = filled.filter((row) => group === "all" || group === row.key);
  // Сумма групп, а не отдельный счёт: группы делят задачи между собой, и это
  // число обязано сходиться со счётом на чипе в шапке — иначе список опровергал
  // бы пометку, которая его открыла.
  const total = filled.reduce((sum, row) => sum + row.rows.length, 0);

  // Esc через общую стопку слоёв: панель почти всегда всплывает поверх ленты,
  // а поверх неё могут открыться окно сдвига или вопрос о переутверждении, и
  // собственный слушатель на документе закрывал бы всех разом.
  useEscape(onClose);

  const title = t("plan.changes_title", { version: state.plan_version });

  return (
    // Панель, а не окно: подложки у неё нет намеренно — лента слева остаётся и
    // видимой, и рабочей, и призраки согласованного плана на ней читаются
    // вместе со списком.
    <aside className="panel plan-changes" role="complementary" aria-label={title}>
      {/* Шапка закреплена: заголовок, сводка и рубильник призрака не уезжают с
          прокруткой списка — фильтр нужен ровно тогда, когда список длинный. */}
      <header className="panel__head plan-changes__head">
        <div className="panel__head-top">
          <h2 className="panel__title">{title}</h2>
          <button
            type="button"
            className="panel__close"
            aria-label={t("common.close")}
            title={t("common.close")}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {/* Когда согласовали и кто — то, относительно чего считается весь
            список. Без этой строки «после v1» остаётся отсылкой к неизвестной
            дате. */}
        {state.plan_approved_at && (
          <p className="plan-changes__since">
            {t("plan.changes_since", {
              // Сутки читателя, а не сервера: обрезка ISO-строки давала день
              // по UTC, и согласование в час ночи датировалось вчерашним
              // числом — тем же, что и лента истории, только та считает верно.
              date: formatDate(t, dayIn(zone, new Date(state.plan_approved_at))),
            })}
            {/* Имя человека — содержимое пользователя: без перевода. */}
            {approvedBy && <span className="muted"> · {approvedBy.name}</span>}
          </p>
        )}

        {/* Сводка отвечает на «что вообще случилось» до того, как список
            прочитан, и она же фильтр: у групп разная срочность, и «покажи
            только сдвиги» — первое, что просят, увидев число. Пустые группы не
            показываются: тег с нулём предлагает открыть пустоту. */}
        <div className="plan-changes__summary">
          <GroupTag active={group === "all"} onClick={() => setGroup("all")}>
            {t("plan.changes_all")} · {total}
          </GroupTag>
          {filled.map((row) => (
            <GroupTag
              key={row.key}
              active={group === row.key}
              onClick={() => setGroup(group === row.key ? "all" : row.key)}
            >
              {t(`plan.changes_tag.${row.key}`)} · {row.rows.length}
            </GroupTag>
          ))}
        </div>

        {/* Тот же слой, что включает флажок «Вид» на ленте, — не второй такой
            же: список и диаграмма рассказывают одно и то же двумя языками, и
            переключаться между ними человек должен там, где смотрит. Ради
            этого рубильника панель и не накрывает ленту.

            Рубильником, а не флажком: состояние меняется сразу и без кнопки
            «сохранить» — это ровно тот случай, ради которого в приложении и
            заведён `Switch`. */}
        <div className="plan-changes__ghost">
          <Switch
            id="plan-changes-ghost"
            label={t("plan.changes_ghost")}
            checked={baselineShown}
            onChange={onBaselineToggle}
          />
        </div>
      </header>

      <div className="panel__body">
        {shown.map(({ key, rows }) => (
          <section key={key} className="plan-changes__group">
            <h3 className="plan-changes__group-title">
              {t(`plan.changes_group.${key}`)}
              <span className="plan-changes__count">{rows.length}</span>
            </h3>
            <ul className="plan-changes__list">
              {rows.map((change) => (
                <li key={rowKey(change)} className="plan-changes__row">
                  <div className="plan-changes__main">
                    {/* Имя задачи ведёт в её карточку: увидев расхождение, идут
                        чинить именно эту задачу, и путь туда не должен идти
                        через закрытие панели и поиск строки глазами. Панель при
                        этом уходит: карточка выезжает на то же место справа, и
                        двум панелям там не разойтись. У удалённой задачи вести
                        некуда — она остаётся текстом. */}
                    {change.kind === "removed" ? (
                      <span className="plan-changes__name plan-changes__name--gone">
                        {change.name}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="plan-changes__name"
                        onClick={() => {
                          onClose();
                          onOpenTask(change.task.id);
                        }}
                      >
                        {change.task.name}
                      </button>
                    )}
                    <span className="plan-changes__diff">{diffOf(change, t, day)}</span>
                    <Badge change={change} />
                  </div>

                  {/* Растяжение, случившееся тем же движением, что и перенос:
                      задача стоит в одной группе, но поехало у неё двое, и
                      умолчать о втором значило бы показать половину правды. */}
                  {change.kind === "shift" && change.stretch && (
                    <p className="plan-changes__also">
                      {t("plan.changes_also_duration", {
                        from: t("common.days_short", { count: change.stretch.from }),
                        to: t("common.days_short", { count: change.stretch.to }),
                      })}
                    </p>
                  )}

                  {/* Причина — то, ради чего её и спрашивали при сдвиге: без неё
                      список отвечает «что изменилось», а с ней — «почему». */}
                  {change.kind !== "removed" && reasons.get(change.task.id) && (
                    <p className="plan-changes__reason">{reasons.get(change.task.id)}</p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {/* Переутверждение отсюда ведёт к тому же вопросу, что и кнопка в шапке
          проекта, — не к своему собственному: подтверждение у действия одно, и
          второе, заведённое ради второй кнопки, однажды разойдётся с первым в
          формулировке или в правах. Многоточие на кнопке о том и говорит:
          нажатие не переутверждает, а спрашивает. */}
      {canReapprove && (
        <div className="panel__foot plan-changes__foot">
          <span className="plan-changes__hint">
            {t("plan.changes_reapprove_hint", { count: total })}
          </span>
          <button
            type="button"
            className="button--quiet button--alert"
            onClick={() => {
              onClose();
              onReapprove();
            }}
          >
            {t("plan.changes_reapprove")}
          </button>
        </div>
      )}
    </aside>
  );
}

/**
 * Бейдж расхождения — та же величина и тот же цвет, что у бейджа на полоске
 * ленты: «+2 дн.» красным, «−2 дн.» зелёным. Приближение — не тревога, и
 * набирать его цветом тревоги значило бы сообщать о хорошей новости плохим
 * голосом.
 *
 * У работы сверх плана числа нет вовсе: сравнивать не с чем, и вместо цифры
 * стоит слово. У удалённой — бейджа нет: её расхождение уже названо в строке.
 */
function Badge({ change }: { change: PlanChange }) {
  const { t } = useLocale();

  if (change.kind === "removed") return null;
  if (change.kind === "added") {
    return <span className="plan-changes__badge is-new">{t("plan.changes_beyond")}</span>;
  }

  const days = t("common.days_short", { count: Math.abs(change.days) });
  return (
    <span className={`plan-changes__badge ${change.days > 0 ? "is-late" : "is-early"}`}>
      {t(change.days > 0 ? "gantt.deviation_late" : "gantt.deviation_early", { days })}
    </span>
  );
}

function GroupTag({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className="plan-changes__tag" aria-pressed={active} onClick={onClick}>
      {children}
    </button>
  );
}

/** Ключ строки. Задача стоит ровно в одной группе, поэтому хватает её самой. */
function rowKey(change: PlanChange): string {
  return change.kind === "removed" ? `removed-${change.taskId}` : change.task.id;
}

/** Было и стало — то, ради чего строка существует. */
function diffOf(
  change: PlanChange,
  t: (key: string, params?: Record<string, string | number>) => string,
  day: (iso: string) => string,
): string {
  switch (change.kind) {
    case "shift":
      return `${day(change.from)} → ${day(change.to)}`;
    case "duration":
      return `${t("common.days_short", { count: change.from })} → ${t("common.days_short", {
        count: change.to,
      })}`;
    case "added":
      return t("plan.changes_added_at", { date: day(change.task.start_date) });
    case "removed":
      return t("plan.changes_removed_note");
  }
}

/**
 * Последняя объяснённая причина по каждой задаче — из журнала.
 *
 * Берётся только то, что случилось после согласования: причина, названная до
 * него, объясняет сдвиг, который сам же и вошёл в базовый план.
 *
 * Записи приходят новыми вперёд, поэтому первая найденная причина и есть
 * последняя по времени — дальше по задаче не заглядываем. Сдвиг категории
 * объясняет все её задачи разом: причина у движения одна, а уехали от него
 * многие, и повторить её у каждой строки честнее, чем не показать ни у одной.
 */
function reasonsByTask(state: ProjectState, entries: RevisionEntry[]): Map<string, string> {
  const reasons = new Map<string, string>();
  const approvedAt = state.plan_approved_at;
  if (!approvedAt) return reasons;

  for (const entry of entries) {
    if (!entry.reason || entry.created_at < approvedAt) continue;

    const taskId = entry.op.task_id;
    if (typeof taskId === "string") {
      if (!reasons.has(taskId)) reasons.set(taskId, entry.reason);
      continue;
    }

    const categoryId = entry.op.category_id;
    if (typeof categoryId === "string") {
      for (const task of state.tasks) {
        if (task.category_id === categoryId && !reasons.has(task.id)) {
          reasons.set(task.id, entry.reason);
        }
      }
    }
  }

  return reasons;
}
