import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { Cell, shownColumns } from "./Cells";
import type { ColumnLayout } from "./columns";
import type { Scale } from "./timescale";

/**
 * Заведение задачи — строкой в ленте, а не окном с девятью полями.
 *
 * Задачи заводят пачками: план пишут списком, по строке на дело, и окно между
 * строками означало открыть, заполнить, закрыть — и так двадцать раз подряд.
 * Здесь у новой задачи спрашивается только имя: остальное у неё уже есть
 * (день — сегодняшний, срок — один день), а поправить это можно в карточке,
 * до которой один щелчок по строке.
 *
 * Enter не закрывает строку, а отправляет написанное и оставляет поле пустым и
 * в фокусе: следующую задачу пишут сразу, не касаясь мыши. Пустой Enter значит
 * «больше не нужно» и строку закрывает — иначе выходом из режима была бы
 * единственная клавиша Esc, о которой никто не догадывается.
 */

export function NewTaskRow({
  layout,
  scale,
  label,
  placeholder,
  onCreate,
  onClose,
}: {
  layout: ColumnLayout;
  scale: Scale;
  /** Имя поля при чтении с экрана: «Новая задача в „Дизайн“». */
  label: string;
  placeholder: string;
  /**
   * Отправить написанное. Строка при этом остаётся открытой.
   *
   * Номер, на который ляжет задача, строка не считает: «а», «б», «в» подряд
   * обязаны лечь в набранном порядке, но сколько из них сервер уже принял и
   * подвинул соседей, знает лента, а не поле (см. `insertPosition` в Gantt).
   */
  onCreate: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const input = useRef<HTMLInputElement>(null);

  // Фокус — сразу: «плюс» нажимают ради того, чтобы писать, и щелчок по полю
  // после этого был бы вторым нажатием ради того же самого.
  useEffect(() => {
    input.current?.focus();
  }, []);

  /** Отправлено или нет: пустое поле — не задача, а середина набора. */
  const submit = (): boolean => {
    const trimmed = name.trim();
    if (trimmed === "") return false;
    onCreate(trimmed);
    setName("");
    return true;
  };

  return (
    <NameRow className="gantt__row--new" layout={layout} scale={scale}>
      <input
        ref={input}
        className="cell-input"
        type="text"
        value={name}
        placeholder={placeholder}
        aria-label={label}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (!submit()) onClose();
          }
          if (event.key === "Escape") {
            // Передумать посреди набора — обычное дело. Строка закрывается
            // размонтированием поля, и `onBlur` до него не доходит: набранное
            // пропадает, как и обещано.
            event.preventDefault();
            onClose();
          }
        }}
        // Уход фокуса сохраняет — так же, как ячейка даты в этой же таблице
        // (см. EditableCell). Набранное имя, пропавшее от щелчка мимо поля,
        // человек считал бы потерянной задачей, а не отменённым вводом.
        onBlur={() => {
          submit();
          onClose();
        }}
      />
    </NameRow>
  );
}

/**
 * Строка задачи, которую уже отправили, а сервер ещё не ответил.
 *
 * Оптимистичной задачи здесь нет намеренно: идентификатор и дату окончания
 * назначает сервер — первый неоткуда взять, вторая считается по рабочему
 * календарю. Придуманная строка была бы кнопкой, за которой ничего не стоит:
 * её можно открыть, потянуть за грань и связать с соседкой, а операции с
 * несуществующим идентификатором сервер отобьёт. Поэтому не догадка, а
 * ожидание: имя уже видно, полоски ещё нет.
 */
export function PendingRow({
  layout,
  scale,
  name,
  title,
}: {
  layout: ColumnLayout;
  scale: Scale;
  name: string;
  /** «Создаётся…» — подсказка указателю; строка помечена и `aria-busy`. */
  title: string;
}) {
  return (
    <NameRow className="gantt__row--pending" layout={layout} scale={scale} busy>
      <span className="gantt__label-name" title={title}>
        {name}
      </span>
    </NameRow>
  );
}

/**
 * Строка ленты, у которой занята одна колонка — название.
 *
 * Остальные пусты, а не заполнены прочерками: прочерк означает «значения нет»,
 * а у этих строк значения ещё не назначены — они появятся вместе с задачей.
 */
function NameRow({
  className,
  layout,
  scale,
  busy = false,
  children,
}: {
  className: string;
  layout: ColumnLayout;
  scale: Scale;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`gantt__row ${className}`} aria-busy={busy || undefined}>
      <div className="gantt__label">
        {shownColumns(layout).map((column) => (
          <Cell key={column} column={column} layout={layout}>
            {column === "task" ? children : null}
          </Cell>
        ))}
      </div>
      {/* Полоса шкалы пустая, но своей ширины: без неё строка обрывалась бы по
          краю таблицы, и лента под черновиком выглядела бы разорванной. */}
      <div className="gantt__lane" style={{ width: scale.width }} />
    </div>
  );
}
