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
  pushProposalToPlan,
  updateProposalCategory,
  updateProposalSettings,
  updateProposalTask,
} from "../api/proposal";
import type { ProposalSettingsPatch, ProposalTaskPatch } from "../api/proposal";
import { SelectField, TextField, ValueField } from "../components/autosave";
import { useFieldSaves } from "../components/autosave";
import { useToast } from "../components/toast";
import { useLocale } from "../i18n/LocaleProvider";
import { formatAmount, formatMoney } from "./money";
import { ProposalCategoryForm } from "./ProposalCategoryForm";
import { ProposalNotes } from "./ProposalNotes";
import { ProposalSummary } from "./ProposalSummary";
import { CategoryRows } from "./ProposalTable";
import type { EffortMath, Formats } from "./ProposalTable";
import { ProposalTaskPanel } from "./ProposalTaskPanel";

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
 * ленте: раздел — окном из тулбара, строка — полем прямо в таблице, по
 * «плюсу» на строке раздела или кнопкой тулбара (см. NewProposalTaskRow).
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

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: proposalQueryKey(projectId) });

  // Настройки и примечания сохраняют себя сами, как поля настроек проекта.
  const saves = useFieldSaves((patch: ProposalSettingsPatch) =>
    updateProposalSettings(projectId, patch).then(invalidate),
  );

  const addTask = useMutation({
    mutationFn: (input: { categoryId: string; name: string }) =>
      createProposalTask(projectId, input.categoryId, input.name),
    onSuccess: invalidate,
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

  const push = useMutation({
    mutationFn: () => pushProposalToPlan(projectId),
    onSuccess: async (result) => {
      toast({ message: t("proposal.push.done", { count: result.created_tasks }) });
      // Перенос рождает ревизии плана: перечитывается проект целиком, и
      // вложенный ключ сметы сбрасывается тем же вызовом.
      await queryClient.invalidateQueries({ queryKey: projectQueryKey(projectId) });
    },
    onError: (refusal: unknown) => {
      toast({ message: t(errorKey(refusal)), tone: "error" });
    },
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

  const money = (value: number) => formatMoney(locale, proposal.currency, value);
  const formats: Formats = {
    days: (value) => t("proposal.format.days", { value: formatAmount(locale, value) }),
    hoursLabel: (value) => t("proposal.format.hours", { value: formatAmount(locale, value) }),
    money,
    // Ставка — за день или за час, и подпись обязана это говорить: голое
    // «$100» не отвечает на вопрос «за что».
    rate: (value) =>
      t(hours ? "proposal.format.per_hour" : "proposal.format.per_day", { rate: money(value) }),
  };

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

  const createTask = (categoryId: string) => (name: string) =>
    addTask.mutate({ categoryId, name });

  const failure =
    addTask.error ?? removeCategory.error ?? patchCategory.error ?? patchTask.error ?? removeTask.error;

  return (
    <div className="proposal">
      <div className="proposal__main">
        <div className="proposal__toolbar">
          <div className="proposal__settings">
            <SelectField
              id="proposal-unit"
              label={t("proposal.settings.unit")}
              value={proposal.effort_unit}
              disabled={!canWrite}
              options={[
                { value: "days", label: t("proposal.settings.unit_days") },
                { value: "hours", label: t("proposal.settings.unit_hours") },
              ]}
              save={saves.at("unit")}
              onCommit={(value) =>
                saves.commit("unit", { effort_unit: value as "days" | "hours" })
              }
            />
            <ValueField
              id="proposal-hours-per-day"
              label={t("proposal.settings.hours_per_day")}
              type="number"
              value={String(proposal.hours_per_day)}
              disabled={!canWrite}
              resetToken={proposal.hours_per_day}
              save={saves.at("hours_per_day")}
              onCommit={(value) =>
                saves.commitNumber("hours_per_day", value, (hoursPerDay) => ({
                  hours_per_day: hoursPerDay,
                }))
              }
            />
            <ValueField
              id="proposal-tax"
              label={t("proposal.settings.tax_rate")}
              type="number"
              value={String(proposal.tax_rate_pct)}
              disabled={!canWrite}
              resetToken={proposal.tax_rate_pct}
              save={saves.at("tax")}
              onCommit={(value) =>
                saves.commitNumber("tax", value, (taxRate) => ({ tax_rate_pct: taxRate }))
              }
            />
            <TextField
              id="proposal-currency"
              label={t("proposal.settings.currency")}
              value={proposal.currency}
              disabled={!canWrite}
              resetToken={proposal.currency}
              save={saves.at("currency")}
              onCommit={(value) => {
                const code = value.trim().toUpperCase();
                // До сервера не доходит: код валюты — ровно три буквы, и
                // сказать об этом можно у поля, не спрашивая никого.
                if (!/^[A-Z]{3}$/.test(code)) {
                  saves.refuse("currency", "proposal.settings.currency_invalid");
                  return;
                }
                saves.commit("currency", { currency: code });
              }}
            />
          </div>
          {canWrite && (
            <div className="proposal__actions">
              {/* Тот же порядок, что в тулбаре ленты: сначала раздел, потом
                  строка — работу некуда класть, пока нет ни одного раздела,
                  и кнопка строки до первого раздела не показывается. Дальше
                  она открывает поле в первом разделе: положить работу в любой
                  другой — «плюс» на его строке. */}
              <button
                type="button"
                className="button--quiet"
                onClick={() => setAddingCategory(true)}
              >
                {t("proposal.category.create")}
              </button>
              {proposal.categories.length > 0 && (
                <button
                  type="button"
                  onClick={() => setNewTaskIn(proposal.categories[0].id)}
                >
                  {t("proposal.task.create")}
                </button>
              )}
            </div>
          )}
        </div>

        {proposal.categories.length === 0 ? (
          <p className="muted proposal__empty">{t("proposal.empty")}</p>
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
                  <th>{t("proposal.columns.description")}</th>
                  <th className="proposal-table__num">{t("proposal.columns.effort")}</th>
                  <th className="proposal-table__num">{t("proposal.columns.hours")}</th>
                  <th className="proposal-table__num">{t("proposal.columns.rate")}</th>
                  <th className="proposal-table__num">{t("proposal.columns.price")}</th>
                </tr>
              </thead>
              <tbody>
                {proposal.categories.map((category) => (
                  <CategoryRows
                    key={category.id}
                    category={category}
                    open={!collapsed.has(category.id)}
                    canWrite={canWrite}
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
        currency={proposal.currency}
        taxRatePct={proposal.tax_rate_pct}
        totalHours={totalHours}
        totalDays={totalDays}
        subtotal={subtotal}
        tax={tax}
        formats={formats}
        canWrite={canWrite}
        canPush={tasks.length > 0}
        pushing={push.isPending}
        onPush={() => push.mutate()}
      />

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
