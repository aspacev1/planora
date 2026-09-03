import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { errorKey } from "../api/errors";
import { projectQueryKey } from "../api/projects";
import {
  createProposalTask,
  deleteProposalCategory,
  deleteProposalTask,
  getProposal,
  proposalQueryKey,
  setProposalStage,
  updateProposalCategory,
  updateProposalSettings,
  updateProposalTask,
} from "../api/proposal";
import type {
  NewProposalTask,
  ProposalSettingsPatch,
  ProposalStage,
  ProposalTaskPatch,
} from "../api/proposal";
import { useFieldSaves } from "../components/autosave";
import { useToast } from "../components/toast";
import { useLocale } from "../i18n/LocaleProvider";
import { formatAmount, formatMoney } from "./money";
import { ProposalCategoryForm } from "./ProposalCategoryForm";
import { ProposalNotes } from "./ProposalNotes";
import { ProposalParams } from "./ProposalParams";
import { ProposalStepper } from "./ProposalStepper";
import { ProposalSummary } from "./ProposalSummary";
import { COLUMNS, CategoryRows } from "./ProposalTable";
import type { EffortMath, Formats } from "./ProposalTable";
import { ProposalTaskPanel } from "./ProposalTaskPanel";
import { PushDone } from "./PushDone";
import { PushToPlanDialog } from "./PushToPlanDialog";

import "./proposal.css";

/**
 * Вкладка «Предложение»: смета проекта до плана.
 *
 * Одна таблица на все разделы, как в макете: раздел — строкой-заголовком со
 * сводкой своих работ, работы — строками под ним, итоги — карточкой справа.
 * Цена строки и все итоги считаются здесь, на экране: это произведение и
 * сумма уже показанных чисел, и сервер, пересказывающий их, был бы вторым
 * местом с той же арифметикой (см. api/proposal.ts).
 *
 * Разделы и строки заводятся теми же движениями, что категории и задачи в
 * ленте: у каждого уровня списка свой «плюс» в таблице — строка «Добавить
 * работу» в конце раздела и «Новый раздел» внизу (см. NewProposalTaskRow),
 * а тулбар держит только этапы сделки и параметры.
 *
 * И правятся тем же движением: любая ячейка открывается щелчком по ней и
 * уходит на сервер потерей фокуса — как ячейки закреплённой таблицы ленты
 * (components/rows). Смету пишут построчно, сверяя числа с соседними, и
 * карточка ради одной ставки означала бы открыть, поправить, закрыть — на
 * каждой строке подряд. Карточка остаётся для того, чего в таблице нет:
 * подробностей, рисков, допущений и разговора.
 *
 * Экран держит данные и состояние вкладки; таблица (ProposalTable), итоги
 * (ProposalSummary) и примечания (ProposalNotes) — свои компоненты, каждому
 * достаётся ровно то, что он показывает.
 */
export function Proposal({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const { t, locale } = useLocale();
  const queryClient = useQueryClient();
  const toast = useToast();

  const query = useQuery({
    queryKey: proposalQueryKey(projectId),
    queryFn: () => getProposal(projectId),
    retry: false,
  });

  // Карточка строки — идентификатором, а не объектом: после каждой правки
  // состояние приходит с сервера заново, и карточка, помнящая объект,
  // показывала бы устаревшие данные. Тот же приём, что у карточки задачи.
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [addingCategory, setAddingCategory] = useState(false);
  // Раздел, открытый на правку в окне. Идентификатором, а не объектом — по той
  // же причине, что и строка выше.
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  // Раздел, в котором открыта строка новой работы. `null` — закрыта.
  const [newTaskIn, setNewTaskIn] = useState<string | null>(null);
  // Свёрнутые разделы. Пустое множество — всё развёрнуто: смету читают
  // целиком, и прятать что-то по умолчанию не за чем.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  // Открыто ли окно переноса в план.
  const [pushing, setPushing] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: proposalQueryKey(projectId) });

  // Настройки и примечания сохраняют себя сами, как поля настроек проекта.
  const saves = useFieldSaves((patch: ProposalSettingsPatch) =>
    updateProposalSettings(projectId, patch).then(invalidate),
  );

  const addTask = useMutation({
    mutationFn: (input: { categoryId: string; task: NewProposalTask }) =>
      createProposalTask(projectId, input.categoryId, input.task),
    onSuccess: invalidate,
  });

  // Этап сделки — отметка рукой, в любую сторону. Отказ — тостом: полоса
  // этапов стоит над таблицей, и строке ошибки под ней места нет.
  const mark = useMutation({
    mutationFn: (stage: ProposalStage) => setProposalStage(projectId, stage),
    onSuccess: invalidate,
    onError: (refusal: unknown) => {
      toast({ message: t(errorKey(refusal)), tone: "error" });
    },
  });

  const removeCategory = useMutation({
    mutationFn: (categoryId: string) => deleteProposalCategory(projectId, categoryId),
    onSuccess: invalidate,
  });

  const patchCategory = useMutation({
    mutationFn: (input: {
      categoryId: string;
      patch: Partial<{ name: string; description: string }>;
    }) => updateProposalCategory(projectId, input.categoryId, input.patch),
    onSuccess: invalidate,
  });

  // Правка ячейки — та же операция, что и в карточке строки: таблица не
  // заводит своего способа менять оценку или ставку, она вызывает
  // существующий. Ответ сервера перечитывает смету целиком, и итоги справа
  // сходятся с колонкой цены сами.
  const patchTask = useMutation({
    mutationFn: (input: { taskId: string; patch: ProposalTaskPatch }) =>
      updateProposalTask(projectId, input.taskId, input.patch),
    onSuccess: invalidate,
  });

  // Карточку удалённой строки закрывать нечем и не за чем: она ищется по
  // идентификатору в свежем ответе сервера и исчезает вместе со строкой.
  const removeTask = useMutation({
    mutationFn: (taskId: string) => deleteProposalTask(projectId, taskId),
    onSuccess: invalidate,
  });

  // Перенос случился в окне; здесь — что после него: тост с дорогой к
  // диаграмме и кнопкой «Вернуть», и перечитанный проект целиком — перенос
  // рождает ревизии плана, а вложенный ключ сметы сбрасывается тем же вызовом.
  const pushed = async (result: { created_tasks: number; batch_id: string }) => {
    setPushing(false);
    toast({
      message: t("proposal.push.done", { count: result.created_tasks }),
      action: <PushDone projectId={projectId} batchId={result.batch_id} />,
    });
    await queryClient.invalidateQueries({ queryKey: projectQueryKey(projectId) });
  };

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

  const proposal = query.data;
  const tasks = proposal.categories.flatMap((category) => category.tasks);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const editingCategory =
    proposal.categories.find((category) => category.id === editingCategoryId) ?? null;
  const hours = proposal.effort_unit === "hours";

  // Оценка живёт в единице сметы, а показывается в обеих: колонка дней и
  // колонка часов пересчитываются через «часов в дне» — те же правила, по
  // которым перенос в план считает длительности. Обратный пересчёт нужен
  // правке: правят ту колонку, в которую смотрят.
  const math: EffortMath = {
    toDays: (effort) => (hours ? effort / proposal.hours_per_day : effort),
    toHours: (effort) => (hours ? effort : effort * proposal.hours_per_day),
    effortOfDays: (value) => (hours ? value * proposal.hours_per_day : value),
    effortOfHours: (value) => (hours ? value : value / proposal.hours_per_day),
  };

  const formats: Formats = {
    days: (value) => t("proposal.format.days", { value: formatAmount(locale, value) }),
    hoursLabel: (value) => t("proposal.format.hours", { value: formatAmount(locale, value) }),
    amount: (value) => formatAmount(locale, value),
    money: (value) => formatMoney(locale, proposal.currency, value),
  };
  // Ставка — за день или за час, и шапка колонки обязана это говорить: голое
  // «Ставка» не отвечает на вопрос «за что».
  const unitLetter = t(hours ? "proposal.format.hour_letter" : "proposal.format.day_letter");

  const subtotal = tasks.reduce((sum, task) => sum + task.effort * task.rate, 0);
  const tax = (subtotal * proposal.tax_rate_pct) / 100;
  const totalDays = tasks.reduce((sum, task) => sum + math.toDays(task.effort), 0);
  const totalHours = tasks.reduce((sum, task) => sum + math.toHours(task.effort), 0);

  const toggle = (categoryId: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });

  const createTask = (categoryId: string) => (task: NewProposalTask) =>
    addTask.mutate({ categoryId, task });

  const failure =
    addTask.error ?? removeCategory.error ?? patchCategory.error ?? patchTask.error ?? removeTask.error;

  return (
    <div className="proposal">
      <div className="proposal__main">
        <div className="proposal__toolbar">
          <ProposalStepper
            status={proposal.status}
            sentAt={proposal.sent_at}
            agreedAt={proposal.agreed_at}
            pushedCount={proposal.pushed_count}
            pushableCount={proposal.pushable_count}
            totalRows={tasks.length}
            canWrite={canWrite}
            marking={mark.isPending}
            onMark={(stage) => mark.mutate(stage)}
            onPush={() => setPushing(true)}
          />
          <ProposalParams proposal={proposal} canWrite={canWrite} saves={saves} />
        </div>

        {proposal.categories.length === 0 ? (
          <div className="proposal__empty">
            <p className="muted">{t("proposal.empty")}</p>
            {canWrite && (
              <button
                type="button"
                className="button--quiet"
                onClick={() => setAddingCategory(true)}
              >
                {t("proposal.category.create")}
              </button>
            )}
          </div>
        ) : (
          // Таблица прокручивается вбок в своих берегах: шесть колонок с
          // именами, описаниями и деньгами на узком экране уже, чем есть, не
          // становятся — а без этого они уезжали бы под карточку итогов, и
          // колонка цены пропадала бы вовсе.
          <div className="proposal-table__scroll">
            <table className="proposal-table">
              <thead>
                <tr>
                  <th>{t("proposal.columns.work_item")}</th>
                  <th>{t("proposal.columns.role")}</th>
                  <th>{t("proposal.columns.description")}</th>
                  <th className="proposal-table__num">{t("proposal.columns.effort")}</th>
                  <th className="proposal-table__num">
                    {t("proposal.columns.rate_unit", {
                      currency: proposal.currency,
                      unit: unitLetter,
                    })}
                  </th>
                  <th className="proposal-table__num">
                    {t("proposal.columns.price_unit", { currency: proposal.currency })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {proposal.categories.map((category) => (
                  <CategoryRows
                    key={category.id}
                    projectId={projectId}
                    category={category}
                    open={!collapsed.has(category.id)}
                    canWrite={canWrite}
                    unit={proposal.effort_unit}
                    currency={proposal.currency}
                    suggestions={proposal.role_suggestions}
                    math={math}
                    formats={formats}
                    addingTask={newTaskIn === category.id}
                    onToggle={() => toggle(category.id)}
                    onAddTask={() => setNewTaskIn(category.id)}
                    onCloseNewTask={() => setNewTaskIn(null)}
                    onCreateTask={createTask(category.id)}
                    onDelete={() => removeCategory.mutate(category.id)}
                    onEdit={() => setEditingCategoryId(category.id)}
                    onPatch={(patch) => patchCategory.mutate({ categoryId: category.id, patch })}
                    onPatchTask={(taskId, patch) => patchTask.mutate({ taskId, patch })}
                    onDeleteTask={(taskId) => removeTask.mutate(taskId)}
                    onOpenTask={(taskId) =>
                      // Повторный щелчок по той же строке закрывает карточку —
                      // тем же движением, что открыл. Как у карточки задачи.
                      setSelectedTaskId((current) => (current === taskId ? null : taskId))
                    }
                    t={t}
                  />
                ))}
                {/* Раздел заводят строкой внизу таблицы — окном, как категорию
                    в ленте: у раздела есть описание, и одной строкой ввода его
                    не спросить. */}
                {canWrite && (
                  <tr className="proposal-row proposal-row--add">
                    <td colSpan={COLUMNS}>
                      <button
                        type="button"
                        className="proposal-add proposal-add--section"
                        onClick={() => setAddingCategory(true)}
                      >
                        <span className="proposal-add__plus" aria-hidden="true">
                          +
                        </span>
                        {t("proposal.category.create")}
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {failure && (
          <p className="error" role="alert">
            {t(errorKey(failure))}
          </p>
        )}

        <ProposalNotes
          notes={proposal.notes}
          canWrite={canWrite}
          save={saves.at("notes")}
          onCommit={(value) => saves.commit("notes", { notes: value })}
        />
      </div>

      <ProposalSummary
        projectId={projectId}
        currency={proposal.currency}
        taxRatePct={proposal.tax_rate_pct}
        totalHours={totalHours}
        totalDays={totalDays}
        subtotal={subtotal}
        tax={tax}
        formats={formats}
        canWrite={canWrite}
        pushedCount={proposal.pushed_count}
        pushableCount={proposal.pushable_count}
        onPush={() => setPushing(true)}
      />

      {pushing && (
        <PushToPlanDialog projectId={projectId} onClose={() => setPushing(false)} onDone={pushed} />
      )}

      {selectedTask && (
        <ProposalTaskPanel
          projectId={projectId}
          task={selectedTask}
          effortUnit={proposal.effort_unit}
          currency={proposal.currency}
          canWrite={canWrite}
          onClose={() => setSelectedTaskId(null)}
        />
      )}

      {addingCategory && (
        <ProposalCategoryForm projectId={projectId} onClose={() => setAddingCategory(false)} />
      )}

      {/* Окно раздела на правке — то же, что и при заведении: имя и описание
          правятся и прямо в строке, но с клавиатуры до ячейки не дойти (см.
          components/rows), и окно остаётся тем самым путём. */}
      {editingCategory && (
        <ProposalCategoryForm
          projectId={projectId}
          category={editingCategory}
          onClose={() => setEditingCategoryId(null)}
        />
      )}
    </div>
  );
}
