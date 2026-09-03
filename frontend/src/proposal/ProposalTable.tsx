import type { ProposalCategory, ProposalTask, ProposalTaskPatch } from "../api/proposal";
import { ConfirmAction } from "../components/ConfirmAction";
import { CommentIcon, EditableCell, PencilIcon, RowBadge, RowIcon } from "../components/rows";
import { NewProposalTaskRow } from "./NewProposalTaskRow";

/** Колонки таблицы: работа, описание, оценка, часы, ставка, цена. */
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

/** Числа словами и деньгами — форматтеры экрана, знающие язык и валюту. */
export type Formats = {
  days: (value: number) => string;
  hoursLabel: (value: number) => string;
  money: (value: number) => string;
  rate: (value: number) => string;
};

/**
 * Раздел в таблице: строка-заголовок со сводкой и строки работ под ней.
 *
 * Сводка раздела — суммы его строк; ставка показывается, только когда она у
 * всех строк одна: среднее от разных ставок не значит ничего, а первое
 * попавшееся врёт.
 */
export function CategoryRows({
  category,
  open,
  canWrite,
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
  category: ProposalCategory;
  open: boolean;
  canWrite: boolean;
  math: EffortMath;
  formats: Formats;
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
  t: Translate;
}) {
  const categoryDays = category.tasks.reduce((sum, task) => sum + math.toDays(task.effort), 0);
  const categoryHours = category.tasks.reduce((sum, task) => sum + math.toHours(task.effort), 0);
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
        <td className="proposal-table__num">{formats.days(categoryDays)}</td>
        <td className="proposal-table__num">{formats.hoursLabel(categoryHours)}</td>
        <td className="proposal-table__num muted">
          {uniformRate !== null && uniformRate > 0 ? formats.rate(uniformRate) : ""}
        </td>
        <td className="proposal-table__num proposal-table__price">
          {formats.money(categoryPrice)}
        </td>
      </tr>

      {open &&
        category.tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            canWrite={canWrite}
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
  math,
  formats,
  onOpen,
  onPatch,
  onDelete,
  t,
}: {
  task: ProposalTask;
  canWrite: boolean;
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
          value={String(math.toDays(task.effort))}
          display={formats.days(math.toDays(task.effort))}
          disabled={!canWrite}
          label={label("proposal.columns.effort")}
          onCommit={(value) => {
            const parsed = amount(value);
            commit.effort(parsed === null ? null : math.effortOfDays(parsed));
          }}
        />
      </td>
      <td className="proposal-table__num">
        <EditableCell
          type="number"
          step="any"
          min={0}
          value={String(math.toHours(task.effort))}
          display={formats.hoursLabel(math.toHours(task.effort))}
          disabled={!canWrite}
          label={label("proposal.columns.hours")}
          onCommit={(value) => {
            const parsed = amount(value);
            commit.effort(parsed === null ? null : math.effortOfHours(parsed));
          }}
        />
      </td>
      <td className="proposal-table__num muted">
        <EditableCell
          type="number"
          step="any"
          min={0}
          value={String(task.rate)}
          display={task.rate > 0 ? formats.rate(task.rate) : ""}
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
          display={formats.money(task.effort * task.rate)}
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
