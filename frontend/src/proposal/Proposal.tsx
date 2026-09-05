import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { errorKey } from "../api/errors";
import { proposalPdfUrl } from "../api/export";
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
import type {
  ProposalCategory,
  ProposalSettingsPatch,
  ProposalTask,
  ProposalTaskPatch,
} from "../api/proposal";
import { SaveMark, SelectField, TextField, ValueField } from "../components/autosave";
import { useFieldSaves } from "../components/autosave";
import { ConfirmAction } from "../components/ConfirmAction";
import { CommentIcon, EditableCell, PencilIcon, RowBadge, RowIcon } from "../components/rows";
import { useToast } from "../components/toast";
import { useLocale } from "../i18n/LocaleProvider";
import { formatAmount, formatMoney } from "./money";
import { NewProposalTaskRow } from "./NewProposalTaskRow";
import { ProposalCategoryForm } from "./ProposalCategoryForm";
import { ProposalTaskPanel } from "./ProposalTaskPanel";

import "./proposal.css";

/** Колонки таблицы: работа, описание, оценка, часы, ставка, цена. */
const COLUMNS = 6;

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
 */
export function Proposal({
  projectId,
  canWrite,
  canExport,
}: {
  projectId: string;
  canWrite: boolean;
  /** Вправе ли смотрящий получить документ для клиента (см. permissions). */
  canExport: boolean;
}) {
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
  const [editingNotes, setEditingNotes] = useState(false);

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
  // которым перенос в план считает длительности.
  const toDays = (effort: number) => (hours ? effort / proposal.hours_per_day : effort);
  const toHours = (effort: number) => (hours ? effort : effort * proposal.hours_per_day);
  // Обратный пересчёт: правят ту колонку, в которую смотрят, а в трудоёмкость
  // строки написанное переводится тем же «часов в дне», каким и показано.
  const effortOfDays = (value: number) => (hours ? value * proposal.hours_per_day : value);
  const effortOfHours = (value: number) => (hours ? value : value / proposal.hours_per_day);

  const days = (value: number) =>
    t("proposal.format.days", { value: formatAmount(locale, value) });
  const hoursLabel = (value: number) =>
    t("proposal.format.hours", { value: formatAmount(locale, value) });
  const money = (value: number) => formatMoney(locale, proposal.currency, value);
  // Ставка — за день или за час, и подпись обязана это говорить: голое
  // «$100» не отвечает на вопрос «за что».
  const rate = (value: number) =>
    t(hours ? "proposal.format.per_hour" : "proposal.format.per_day", {
      rate: money(value),
    });

  const subtotal = tasks.reduce((sum, task) => sum + task.effort * task.rate, 0);
  const tax = (subtotal * proposal.tax_rate_pct) / 100;
  const totalDays = tasks.reduce((sum, task) => sum + toDays(task.effort), 0);
  const totalHours = tasks.reduce((sum, task) => sum + toHours(task.effort), 0);

  const toggle = (categoryId: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });

  const createTask = (categoryId: string) => (name: string) =>
    addTask.mutate({ categoryId, name });

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
                    toDays={toDays}
                    toHours={toHours}
                    effortOfDays={effortOfDays}
                    effortOfHours={effortOfHours}
                    days={days}
                    hoursLabel={hoursLabel}
                    money={money}
                    rate={rate}
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

        {(addTask.error ||
          removeCategory.error ||
          patchCategory.error ||
          patchTask.error ||
          removeTask.error) && (
          <p className="error" role="alert">
            {t(
              errorKey(
                addTask.error ??
                  removeCategory.error ??
                  patchCategory.error ??
                  patchTask.error ??
                  removeTask.error,
              ),
            )}
          </p>
        )}

        {/* Допущения и примечания — свойство предложения целиком, карточкой
            под таблицей: «оценки по текущему объёму», «ставки без лицензий»
            относятся ко всем строкам сразу. */}
        <section className="proposal-notes" aria-label={t("proposal.notes.title")}>
          <header className="proposal-notes__head">
            <h3 className="proposal-notes__title" id="proposal-notes-title">
              {t("proposal.notes.title")}
            </h3>
            <SaveMark save={saves.at("notes")} />
            {canWrite && !editingNotes && (
              <button
                type="button"
                className="button--quiet"
                onClick={() => setEditingNotes(true)}
              >
                {t("proposal.notes.edit")}
              </button>
            )}
          </header>
          {editingNotes ? (
            <NotesEditor
              initial={proposal.notes}
              onDone={(value) => {
                if (value !== proposal.notes) saves.commit("notes", { notes: value });
                setEditingNotes(false);
              }}
            />
          ) : proposal.notes.trim() === "" ? (
            <p className="muted">{t("proposal.notes.empty")}</p>
          ) : (
            // Пункт на строку, как их и пишут: маркеры даёт список, а не
            // разметка внутри текста.
            <ul className="proposal-notes__list">
              {proposal.notes
                .split("\n")
                .filter((line) => line.trim() !== "")
                .map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
            </ul>
          )}
        </section>
      </div>

      {/* Итоги — карточкой сбоку, на виду при любой прокрутке: «сколько
          всего» спрашивают, не дочитав смету. */}
      <aside className="proposal-summary" aria-label={t("proposal.summary.title")}>
        <h3 className="proposal-summary__title">{t("proposal.summary.title")}</h3>
        <dl>
          <div className="proposal-summary__row">
            <dt>{t("proposal.summary.total_hours")}</dt>
            <dd>{hoursLabel(totalHours)}</dd>
          </div>
          <div className="proposal-summary__row">
            <dt>{t("proposal.summary.total_duration")}</dt>
            <dd>{days(totalDays)}</dd>
          </div>
          <div className="proposal-summary__row proposal-summary__row--first">
            <dt>{t("proposal.summary.subtotal")}</dt>
            <dd>{money(subtotal)}</dd>
          </div>
          <div className="proposal-summary__row">
            <dt>{t("proposal.summary.tax", { rate: proposal.tax_rate_pct })}</dt>
            <dd>{money(tax)}</dd>
          </div>
          <div className="proposal-summary__row proposal-summary__total">
            <dt>
              {t("proposal.summary.total")}
              <span className="proposal-summary__currency">{proposal.currency}</span>
            </dt>
            <dd className="proposal-summary__amount">{money(subtotal + tax)}</dd>
          </div>
        </dl>
        {/* «Дальше» — что делать с предложением, когда итоги прочитаны.
            Документ для клиента — главное действие черновика: смета пишется,
            чтобы уйти клиенту. Перенос в план — следующий шаг, уже после
            согласования, и стоит тихой кнопкой под ним.

            Документ — ссылка с `download`, а не запрос из скрипта: файл
            собирает сервер, и браузер сохраняет его сам под именем из ответа.
            Пустая смета ссылку гасит: адреса у неё нет, и документа тоже. */}
        {(canExport || canWrite) && (
          <section className="proposal-next" aria-label={t("proposal.next.title")}>
            <h4 className="proposal-next__title">{t("proposal.next.title")}</h4>
            {canExport && (
              <a
                className="button-link proposal-next__action proposal-next__pdf"
                href={tasks.length > 0 ? proposalPdfUrl(projectId, locale) : undefined}
                download
                aria-disabled={tasks.length === 0}
              >
                {t("proposal.next.download_pdf")}
              </a>
            )}
            {canWrite && (
              <button
                type="button"
                className="button--quiet proposal-next__action"
                disabled={tasks.length === 0 || push.isPending}
                onClick={() => push.mutate()}
              >
                {t("proposal.push.action")}
              </button>
            )}
          </section>
        )}
      </aside>

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

/**
 * Раздел в таблице: строка-заголовок со сводкой и строки работ под ней.
 *
 * Сводка раздела — суммы его строк; ставка показывается, только когда она у
 * всех строк одна: среднее от разных ставок не значит ничего, а первое
 * попавшееся врёт.
 */
function CategoryRows({
  category,
  open,
  canWrite,
  toDays,
  toHours,
  effortOfDays,
  effortOfHours,
  days,
  hoursLabel,
  money,
  rate,
  addingTask,
  onToggle,
  onAddTask,
  onCloseNewTask,
  onCreateTask,
  onDelete,
  onEdit,
  onPatch,
  onPatchTask,
  onDeleteTask,
  onOpenTask,
  t,
}: {
  category: ProposalCategory;
  open: boolean;
  canWrite: boolean;
  toDays: (effort: number) => number;
  toHours: (effort: number) => number;
  effortOfDays: (value: number) => number;
  effortOfHours: (value: number) => number;
  days: (value: number) => string;
  hoursLabel: (value: number) => string;
  money: (value: number) => string;
  rate: (value: number) => string;
  addingTask: boolean;
  onToggle: () => void;
  onAddTask: () => void;
  onCloseNewTask: () => void;
  onCreateTask: (name: string) => void;
  onDelete: () => void;
  /** Открыть окно раздела: имя и описание с клавиатуры правятся там. */
  onEdit: () => void;
  onPatch: (patch: Partial<{ name: string; description: string }>) => void;
  onPatchTask: (taskId: string, patch: ProposalTaskPatch) => void;
  onDeleteTask: (taskId: string) => void;
  onOpenTask: (taskId: string) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const categoryDays = category.tasks.reduce((sum, task) => sum + toDays(task.effort), 0);
  const categoryHours = category.tasks.reduce((sum, task) => sum + toHours(task.effort), 0);
  const categoryPrice = category.tasks.reduce(
    (sum, task) => sum + task.effort * task.rate,
    0,
  );
  const rates = new Set(category.tasks.map((task) => task.rate));
  const uniformRate = rates.size === 1 ? [...rates][0] : null;

  const toggleLabel = t(open ? "proposal.category.collapse" : "proposal.category.expand", {
    name: category.name,
  });

  return (
    <>
      <tr className="proposal-row proposal-row--category">
        <td>
          <span className="proposal-row__name">
            <button
              type="button"
              className="row-chevron"
              aria-expanded={open}
              aria-label={toggleLabel}
              title={toggleLabel}
              onClick={onToggle}
            >
              {open ? "▾" : "▸"}
            </button>
            {/* Имя раздела — содержимое пользователя: не переводится. */}
            <span className="proposal-row__field">
              <EditableCell
                type="text"
                value={category.name}
                display={category.name}
                disabled={!canWrite}
                label={t("proposal.category.rename", { name: category.name })}
                onCommit={(value) => {
                  const name = value.trim();
                  if (name !== "" && name !== category.name) onPatch({ name });
                }}
              />
            </span>
            {canWrite && (
              // Знаки строки — те же, что у строки ленты, и молчат так же:
              // постоянное удаление возле каждого раздела читается как угроза.
              // Подпись каждого включает название раздела — на десятке
              // разделов безымянные «плюсы» при чтении с экрана неразличимы.
              <span className="row-icons">
                <RowIcon
                  label={t("proposal.category.add_task", { name: category.name })}
                  onClick={onAddTask}
                >
                  +
                </RowIcon>
                <RowIcon
                  label={t("proposal.category.edit", { name: category.name })}
                  onClick={onEdit}
                >
                  <PencilIcon />
                </RowIcon>
                <ConfirmAction
                  className="row-icon row-icon--danger"
                  icon="×"
                  label={t("proposal.category.delete", { name: category.name })}
                  warning={t("proposal.category.delete_warning", { name: category.name })}
                  confirm={t("proposal.category.delete_confirm")}
                  onConfirm={onDelete}
                />
              </span>
            )}
          </span>
        </td>
        <td className="proposal-table__desc">
          <EditableCell
            type="text"
            value={category.description}
            display={category.description}
            disabled={!canWrite}
            allowEmpty
            label={t("proposal.category.describe", { name: category.name })}
            onCommit={(description) => onPatch({ description })}
          />
        </td>
        {/* Числа раздела — сводка его строк, а не значения: править их значило
            бы менять неизвестно какую из работ. Как строка категории в ленте. */}
        <td className="proposal-table__num">{days(categoryDays)}</td>
        <td className="proposal-table__num">{hoursLabel(categoryHours)}</td>
        <td className="proposal-table__num muted">
          {uniformRate !== null && uniformRate > 0 ? rate(uniformRate) : ""}
        </td>
        <td className="proposal-table__num proposal-table__price">
          {money(categoryPrice)}
        </td>
      </tr>

      {open &&
        category.tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            canWrite={canWrite}
            days={days}
            hoursLabel={hoursLabel}
            toDays={toDays}
            toHours={toHours}
            effortOfDays={effortOfDays}
            effortOfHours={effortOfHours}
            money={money}
            rate={rate}
            onOpen={() => onOpenTask(task.id)}
            onPatch={(patch) => onPatchTask(task.id, patch)}
            onDelete={() => onDeleteTask(task.id)}
            t={t}
          />
        ))}

      {addingTask && (
        <NewProposalTaskRow
          columns={COLUMNS}
          label={t("proposal.task.new_label", { name: category.name })}
          placeholder={t("proposal.task.new_placeholder")}
          onCreate={onCreateTask}
          onClose={onCloseNewTask}
        />
      )}
    </>
  );
}

/**
 * Строка работы: каждая ячейка правится на месте.
 *
 * Оценка живёт в трудоёмкости строки, а показана двумя колонками — днями и
 * часами; правится любая, и написанное переводится обратно тем же «часов в
 * дне». Цена — произведение оценки на ставку, и правка её меняет ставку: «эта
 * строка стоит пять тысяч» говорят именно так, а оценку в этот момент не
 * пересматривают. У строки без оценки множителя нет, и цену ей задать нечем.
 *
 * Карточка остаётся для того, чего в таблице нет: роли, подробностей, рисков,
 * допущений и разговора. Её открывает знак «править» — и он же единственный
 * путь туда с клавиатуры: ячейки открываются щелчком (см. components/rows).
 */
function TaskRow({
  task,
  canWrite,
  days,
  hoursLabel,
  toDays,
  toHours,
  effortOfDays,
  effortOfHours,
  money,
  rate,
  onOpen,
  onPatch,
  onDelete,
  t,
}: {
  task: ProposalTask;
  canWrite: boolean;
  days: (value: number) => string;
  hoursLabel: (value: number) => string;
  toDays: (effort: number) => number;
  toHours: (effort: number) => number;
  effortOfDays: (value: number) => number;
  effortOfHours: (value: number) => number;
  money: (value: number) => string;
  rate: (value: number) => string;
  onOpen: () => void;
  onPatch: (patch: ProposalTaskPatch) => void;
  onDelete: () => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  /** «Изменить: {колонка} у „{имя}“» — подпись поля, открытого на месте. */
  const label = (column: string) =>
    t("proposal.cell.edit", { column: t(column), name: task.name });

  const commit = {
    name: (value: string) => {
      const name = value.trim();
      if (name !== "" && name !== task.name) onPatch({ name });
    },
    effort: (value: number | null) => {
      const effort = value === null ? null : rounded(value);
      if (effort !== null && effort !== task.effort) onPatch({ effort });
    },
    rate: (value: string) => {
      const parsed = amount(value);
      if (parsed !== null && rounded(parsed) !== task.rate) onPatch({ rate: rounded(parsed) });
    },
    price: (value: string) => {
      const parsed = amount(value);
      // Делить не на что: у строки без оценки цена не разложится на ставку.
      if (parsed === null || task.effort === 0) return;
      const next = rounded(parsed / task.effort);
      if (next !== task.rate) onPatch({ rate: next });
    },
  };

  return (
    <tr className="proposal-row proposal-row--task">
      <td>
        <span className="proposal-row__name proposal-row__name--task">
          {/* Имя строки — содержимое пользователя: не переводится.

              У читателя щелчок по имени открывает карточку — как и раньше:
              правкой он быть не может, а карточка со всем, чего в таблице нет,
              для чтения открыта и ему. Тому, кто пишет, то же движение
              открывает ячейку, а карточку — знак «править» справа: два разных
              дела на одном щелчке не помещаются. */}
          <span className="proposal-row__field">
            {canWrite ? (
              <EditableCell
                type="text"
                value={task.name}
                display={task.name}
                label={label("proposal.columns.work_item")}
                onCommit={commit.name}
              />
            ) : (
              <button type="button" className="cell-value proposal-row__open" onClick={onOpen}>
                {task.name}
              </button>
            )}
          </span>
          <span className="row-icons">
            {(task.comment_count > 0 || canWrite) && (
              <RowBadge
                // Подпись та же, что у счётчика на строке ленты: разговор —
                // один и тот же разговор, где бы его ни открыли.
                label={t("comments.aria", { name: task.name, count: task.comment_count })}
                set={task.comment_count > 0}
                onClick={onOpen}
              >
                <CommentIcon />
                {task.comment_count > 0 && task.comment_count}
              </RowBadge>
            )}
            {canWrite && (
              <>
                <RowIcon label={t("proposal.task.edit", { name: task.name })} onClick={onOpen}>
                  <PencilIcon />
                </RowIcon>
                <ConfirmAction
                  className="row-icon row-icon--danger"
                  icon="×"
                  label={t("proposal.task.remove", { name: task.name })}
                  warning={t("proposal.task.delete_warning", { name: task.name })}
                  confirm={t("proposal.task.delete_confirm")}
                  onConfirm={onDelete}
                />
              </>
            )}
          </span>
        </span>
      </td>
      <td className="proposal-table__desc">
        <EditableCell
          type="text"
          value={task.description}
          display={task.description}
          disabled={!canWrite}
          allowEmpty
          label={label("proposal.columns.description")}
          onCommit={(description) => onPatch({ description })}
        />
      </td>
      <td className="proposal-table__num">
        <EditableCell
          type="number"
          step="any"
          min={0}
          value={String(toDays(task.effort))}
          display={days(toDays(task.effort))}
          disabled={!canWrite}
          label={label("proposal.columns.effort")}
          onCommit={(value) => {
            const parsed = amount(value);
            commit.effort(parsed === null ? null : effortOfDays(parsed));
          }}
        />
      </td>
      <td className="proposal-table__num">
        <EditableCell
          type="number"
          step="any"
          min={0}
          value={String(toHours(task.effort))}
          display={hoursLabel(toHours(task.effort))}
          disabled={!canWrite}
          label={label("proposal.columns.hours")}
          onCommit={(value) => {
            const parsed = amount(value);
            commit.effort(parsed === null ? null : effortOfHours(parsed));
          }}
        />
      </td>
      <td className="proposal-table__num muted">
        <EditableCell
          type="number"
          step="any"
          min={0}
          value={String(task.rate)}
          display={task.rate > 0 ? rate(task.rate) : ""}
          disabled={!canWrite}
          label={label("proposal.columns.rate")}
          onCommit={commit.rate}
        />
      </td>
      <td className="proposal-table__num">
        <EditableCell
          type="number"
          step="any"
          min={0}
          value={String(task.effort * task.rate)}
          display={money(task.effort * task.rate)}
          disabled={!canWrite || task.effort === 0}
          label={label("proposal.columns.price")}
          onCommit={commit.price}
        />
      </td>
    </tr>
  );
}

/**
 * Число из ячейки — или `null`, если написано не число.
 *
 * Отрицательные не проходят: ни оценка, ни ставка, ни цена меньше нуля не
 * бывают, и сервер откажет — но сказать об этом можно и здесь, не спрашивая
 * никого.
 */
function amount(text: string): number | null {
  const value = Number(text);
  return text.trim() === "" || !Number.isFinite(value) || value < 0 ? null : value;
}

/**
 * Два знака после запятой — ровно столько, сколько хранит сервер.
 *
 * Пересчёты сметы делят: 25 часов при восьмичасовом дне — это 3,125 дня, а
 * колонка цены, разложенная на ставку, и вовсе даёт бесконечную дробь.
 * Отправить её целиком значит попросить сервер о точности, которой у его
 * колонки нет, и получить в ответ округление, о котором никто не просил.
 */
function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Правка примечаний: текст, по пункту на строку.
 *
 * Уход фокуса заканчивает правку в любом случае — изменённый текст уходит на
 * сервер, неизменённый просто закрывает поле: режим правки, из которого нет
 * выхода без изменения, читался бы как заевшая кнопка.
 */
function NotesEditor({
  initial,
  onDone,
}: {
  initial: string;
  onDone: (value: string) => void;
}) {
  const [draft, setDraft] = useState(initial);

  return (
    <textarea
      className="proposal-notes__field"
      aria-labelledby="proposal-notes-title"
      rows={4}
      value={draft}
      // Фокус — сразу: «править» нажали ради того, чтобы писать.
      autoFocus
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => onDone(draft)}
    />
  );
}

