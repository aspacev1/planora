import { Link } from "react-router-dom";

import type {
  EffortUnit,
  NewProposalTask,
  ProposalCategory,
  ProposalTask,
  ProposalTaskPatch,
  RoleSuggestion,
} from "../api/proposal";
import { ConfirmAction } from "../components/ConfirmAction";
import { CommentIcon, EditableCell, PencilIcon, RowBadge, RowIcon } from "../components/rows";
import { NewProposalTaskRow } from "./NewProposalTaskRow";

/** Колонки таблицы: работа, роль, описание, оценка, ставка, цена. */
export const COLUMNS = 6;

/** Подпись, переведённая экраном: таблица сама словарь не открывает. */
type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * Пересчёты между трудоёмкостью строки и тем, что показано в колонках.
 *
 * Оценка живёт в единице сметы, а показывается в обеих: дни и часы
 * пересчитываются через «часов в дне» — теми же правилами, по которым перенос
 * в план считает длительности. Обратный пересчёт нужен правке: правят ту
 * колонку, в которую смотрят, а в трудоёмкость написанное переводится тем же
 * числом, каким и показано.
 */
export type EffortMath = {
  toDays: (effort: number) => number;
  toHours: (effort: number) => number;
  effortOfDays: (value: number) => number;
  effortOfHours: (value: number) => number;
};

/**
 * Числа словами и деньгами — форматтеры экрана, знающие язык и валюту.
 *
 * В ячейках таблицы деньги без валюты (`amount`): валюта названа в шапке
 * колонки один раз, и «$» в каждой из сорока ячеек только теснил бы числа.
 * В итогах — с валютой (`money`): итог читают отдельно от шапки.
 */
export type Formats = {
  days: (value: number) => string;
  hoursLabel: (value: number) => string;
  amount: (value: number) => string;
  money: (value: number) => string;
};

/**
 * Раздел в таблице: строка-заголовок со сводкой и строки работ под ней.
 *
 * Сводка раздела — суммы его строк; ставка показывается, только когда она у
 * всех строк одна: среднее от разных ставок не значит ничего, а первое
 * попавшееся врёт.
 */
export function CategoryRows({
  projectId,
  category,
  open,
  canWrite,
  unit,
  currency,
  suggestions,
  math,
  formats,
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
  projectId: string;
  category: ProposalCategory;
  open: boolean;
  canWrite: boolean;
  unit: EffortUnit;
  currency: string;
  suggestions: RoleSuggestion[];
  math: EffortMath;
  formats: Formats;
  addingTask: boolean;
  onToggle: () => void;
  onAddTask: () => void;
  onCloseNewTask: () => void;
  onCreateTask: (input: NewProposalTask) => void;
  onDelete: () => void;
  /** Открыть окно раздела: имя и описание с клавиатуры правятся там. */
  onEdit: () => void;
  onPatch: (patch: Partial<{ name: string; description: string }>) => void;
  onPatchTask: (taskId: string, patch: ProposalTaskPatch) => void;
  onDeleteTask: (taskId: string) => void;
  onOpenTask: (taskId: string) => void;
  t: Translate;
}) {
  const categoryEffort = category.tasks.reduce((sum, task) => sum + task.effort, 0);
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
              // разделов безымянные знаки при чтении с экрана неразличимы.
              // «Плюса» здесь нет: работу заводят строкой в конце раздела.
              <span className="row-icons">
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
        <td></td>
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
        <td className="proposal-table__num">
          <Estimate effort={categoryEffort} unit={unit} math={math} formats={formats} />
        </td>
        <td className="proposal-table__num muted">
          {uniformRate !== null && uniformRate > 0 ? formats.amount(uniformRate) : ""}
        </td>
        <td className="proposal-table__num proposal-table__price">
          {categoryPrice > 0 ? formats.amount(categoryPrice) : ""}
        </td>
      </tr>

      {open &&
        category.tasks.map((task) => (
          <TaskRow
            key={task.id}
            projectId={projectId}
            task={task}
            canWrite={canWrite}
            unit={unit}
            math={math}
            formats={formats}
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
          unit={unit}
          currency={currency}
          suggestions={suggestions}
          onCreate={onCreateTask}
          onClose={onCloseNewTask}
        />
      )}

      {/* Работу заводят строкой в конце её раздела — как задачу в ленте: у
          каждого уровня списка свой «плюс», и тулбару кнопки не нужны. В
          свёрнутом разделе строки нет: класть работу в то, чего не видно,
          не за чем. */}
      {open && canWrite && !addingTask && (
        <tr className="proposal-row proposal-row--add">
          <td colSpan={COLUMNS}>
            <button type="button" className="proposal-add" onClick={onAddTask}>
              <span className="proposal-add__plus" aria-hidden="true">
                +
              </span>
              {t("proposal.category.add_task", { name: category.name })}
            </button>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Оценка в единице сметы и рядом — в другой, мелко: обе нужны, но одна из
 * них главная, и вторая не должна читаться как ещё одна колонка.
 */
function Estimate({
  effort,
  unit,
  math,
  formats,
}: {
  effort: number;
  unit: EffortUnit;
  math: EffortMath;
  formats: Formats;
}) {
  if (effort === 0) return <span className="cell-value faint">—</span>;
  const days = math.toDays(effort);
  const hours = math.toHours(effort);
  return (
    <span className="proposal-estimate">
      <span className="cell-value">
        {unit === "hours" ? formats.hoursLabel(hours) : formats.days(days)}
      </span>
      <span className="proposal-hours">
        {unit === "hours" ? formats.days(days) : formats.hoursLabel(hours)}
      </span>
    </span>
  );
}

/**
 * Строка работы: каждая ячейка правится на месте.
 *
 * Оценка живёт в трудоёмкости строки и правится в единице сметы; вторая
 * единица стоит рядом мелко, для сверки. Цена — произведение оценки на
 * ставку, и правка её меняет ставку: «эта строка стоит пять тысяч» говорят
 * именно так, а оценку в этот момент не пересматривают. У строки без оценки
 * множителя нет, и цену ей задать нечем. Пустые роль, оценка и ставка
 * подсказывают, что в них пишут: прочерк говорил бы «пусто», а не «сюда».
 *
 * Карточка остаётся для того, чего в таблице нет: подробностей, рисков,
 * допущений и разговора. Её открывает знак «править» — и он же единственный
 * путь туда с клавиатуры: ячейки открываются щелчком (см. components/rows).
 */
function TaskRow({
  projectId,
  task,
  canWrite,
  unit,
  math,
  formats,
  onOpen,
  onPatch,
  onDelete,
  t,
}: {
  projectId: string;
  task: ProposalTask;
  canWrite: boolean;
  unit: EffortUnit;
  math: EffortMath;
  formats: Formats;
  onOpen: () => void;
  onPatch: (patch: ProposalTaskPatch) => void;
  onDelete: () => void;
  t: Translate;
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
          {/* Строка уже в плане: отметка ведёт к её задаче на диаграмме.
              Ссылкой, а не текстом, — «где она теперь» и есть вопрос, который
              задают этой отметке. */}
          {task.plan_task_id && (
            <Link
              className="proposal-chip proposal-chip--plan"
              to={`/projects/${projectId}?task=${task.plan_task_id}`}
              aria-label={t("proposal.task.in_plan_aria", { name: task.name })}
            >
              {t("proposal.task.in_plan")}
            </Link>
          )}
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
      <td className="role">
        <EditableCell
          type="text"
          value={task.role}
          display={task.role}
          disabled={!canWrite}
          allowEmpty
          placeholder={t("proposal.cell.role_hint")}
          label={label("proposal.columns.role")}
          onCommit={(role) => onPatch({ role: role.trim() })}
        />
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
        <span className="proposal-estimate">
          <EditableCell
            type="number"
            step="any"
            min={0}
            value={String(task.effort)}
            display={
              task.effort > 0
                ? unit === "hours"
                  ? formats.hoursLabel(task.effort)
                  : formats.days(task.effort)
                : ""
            }
            placeholder={t("proposal.cell.effort_hint")}
            disabled={!canWrite}
            label={label("proposal.columns.effort")}
            onCommit={(value) => commit.effort(amount(value))}
          />
          {task.effort > 0 && (
            <span className="proposal-hours">
              {unit === "hours"
                ? formats.days(math.toDays(task.effort))
                : formats.hoursLabel(math.toHours(task.effort))}
            </span>
          )}
        </span>
      </td>
      <td className="proposal-table__num muted">
        <EditableCell
          type="number"
          step="any"
          min={0}
          value={String(task.rate)}
          display={task.rate > 0 ? formats.amount(task.rate) : ""}
          placeholder={t("proposal.cell.rate_hint")}
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
          display={task.effort * task.rate > 0 ? formats.amount(task.effort * task.rate) : ""}
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
