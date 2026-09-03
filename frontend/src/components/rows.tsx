import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import "./rows.css";

/**
 * Строки таблиц: ячейка, которую правят на месте, и знаки действий на строке.
 *
 * Один набор на ленту Ганта и смету. Смета — та же таблица строк с колонками,
 * и «как в ленте» здесь означает буквально то же самое: тот же способ открыть
 * ячейку, те же кнопки под курсором, та же скорость появления. Свой набор в
 * каждом месте держался бы одинаковым ровно до первой правки одного из них.
 */

/**
 * Ячейка, которую правят на месте: показ до щелчка, поле после.
 *
 * Не кнопка намеренно: колонок шесть, строк — сотня, и шестьсот шагов Tab не
 * вели бы никуда, куда нельзя дойти иначе, — те же поля лежат в карточке
 * строки, до которой с клавиатуры один шаг (её открывает знак «править» на
 * строке). Щелчок остаётся доступен указателю и не обещает того, чего не
 * выполняет.
 */
export function EditableCell({
  value,
  display,
  type,
  step,
  disabled,
  label,
  min,
  max,
  allowEmpty = false,
  editTrigger,
  className,
  id,
  placeholder,
  onCommit,
}: {
  /** Значение в том виде, в каком его примет поле ввода. */
  value: string;
  /** Значение в том виде, в каком его читают глазами. */
  display: string;
  type: "text" | "date" | "number";
  /** Шаг числового поля: «any» — там, где значение бывает дробным. */
  step?: string;
  disabled?: boolean;
  label: string;
  min?: number;
  max?: number;
  /**
   * Считать ли пустое поле значением.
   *
   * По умолчанию нет: у числа и имени пустота — середина набора, и отправлять
   * её значит просить сервер отказать в том, чего человек не просил. У
   * описания пустота — настоящее значение: описание стирают.
   */
  allowEmpty?: boolean;
  /**
   * Открыть поле не щелчком по ячейке, а откуда-то ещё — например, пунктом
   * «Переименовать» в меню строки. Ячейка сама не знает об этом внешнем
   * поводе, поэтому повод передаётся значением: каждое новое (по ссылке или
   * по значению) открывает поле, а не открывшее ничего первое совпадение с
   * тем, что уже лежит в пропсе при монтировании.
   */
  editTrigger?: unknown;
  /** Класс поверх «cell-value» — там, где ячейка донашивает чужое оформление
      (жирность строки категории, обрезка многоточием той же меры, что у имени
      задачи), а не только своё. */
  className?: string;
  /** Узел, на который ссылаются описанием — например, кнопка «⋯» строки. */
  id?: string;
  /**
   * Что показать вместо прочерка, пока значения нет: «роль», «ставка».
   * Прочерк говорит «пусто», подсказка — «сюда пишут вот это», и у строки,
   * которую только что завели, второе полезнее.
   */
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  // Первый рендер — не повод открываться: без этой отметки ячейка, которой
  // сразу дали неопределённый `editTrigger`, распахивалась бы едва появившись.
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (editTrigger !== undefined) setEditing(true);
  }, [editTrigger]);

  // Пока ячейку не открывали, черновик обязан идти за правдой: сосед по
  // проекту правит ту же строку, и ячейка рядом не должна показывать
  // вчерашнее. Открытую ячейку правда не трогает — иначе чужая правка стирала
  // бы то, что человек в этот момент набирает.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [editing, value]);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  if (!editing || disabled) {
    const hint = display === "" && placeholder !== undefined && !disabled;
    return (
      <span
        id={id}
        className={`cell-value${disabled ? "" : " cell-value--editable"}${hint ? " cell-value--hint" : ""}${className ? ` ${className}` : ""}`}
        title={display === "" ? undefined : display}
        onClick={disabled ? undefined : () => setEditing(true)}
      >
        {display === "" ? (hint ? placeholder : "—") : display}
      </span>
    );
  }

  const commit = () => {
    setEditing(false);
    if (draft === value) return;
    if (draft === "" && !allowEmpty) return;
    onCommit(draft);
  };

  return (
    <input
      ref={input}
      id={id}
      className="cell-input"
      type={type}
      value={draft}
      min={min}
      max={max}
      step={step}
      aria-label={label}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
        if (event.key === "Escape") {
          // Передумать посреди набора — обычное дело, и выходом иначе было бы
          // вспомнить прежнее значение и набрать его обратно.
          event.preventDefault();
          setDraft(value);
          setEditing(false);
        }
      }}
    />
  );
}

/**
 * Знак действия на строке: кнопка величиной со значок, молчащая до наведения.
 *
 * Кнопка, а не значок с обработчиком: удаление и правка — действия, до
 * которых обязан доходить Tab и которые обязаны срабатывать по Enter. Видимость
 * доступному дереву не мешает: прозрачная кнопка остаётся в нём и всплывает
 * от фокуса (см. rows.css).
 */
export function RowIcon({
  label,
  tone = "quiet",
  disabled = false,
  onClick,
  children,
}: {
  /**
   * Подпись включает имя строки: на сотне строк безымянные крестики при чтении
   * с экрана неразличимы, и выбрать нужный нельзя иначе как считая их по
   * порядку.
   */
  label: string;
  /** «danger» — необратимое действие: цветом под курсором. */
  tone?: "quiet" | "danger";
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`row-icon${tone === "danger" ? " row-icon--danger" : ""}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * Значок со счётчиком: обсуждение строки.
 *
 * Не кнопка — в отличие от знаков действий рядом: то же обсуждение открывается
 * с клавиатуры карточкой строки, а вторая кнопка на каждой из ста строк была
 * бы сотней лишних шагов Tab, ни один из которых не ведёт туда, куда нельзя
 * дойти иначе. Числу при этом нужно имя: без него с экрана читается голая
 * цифра.
 */
export function RowBadge({
  label,
  set = false,
  onClick,
  children,
}: {
  label: string;
  /** Есть ли что показывать: значение видно всегда, приглашение — по наведению. */
  set?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <span
      className={`row-badge${set ? " is-set" : ""}${onClick ? " is-clickable" : ""}`}
      role="img"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </span>
  );
}

/** Знак «обсуждение». */
export function CommentIcon() {
  return (
    <svg className="glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M13.6 2.8H2.4a1 1 0 0 0-1 1v6.1a1 1 0 0 0 1 1h1.9v2.6l2.9-2.6h6.4a1 1 0 0 0 1-1V3.8a1 1 0 0 0-1-1Z" />
    </svg>
  );
}

/** Знак «править»: карандаш. Им открывают карточку строки. */
export function PencilIcon() {
  return (
    <svg className="glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M11.4 2.3a1.4 1.4 0 0 1 2 2l-7.2 7.2-2.7.7.7-2.7 7.2-7.2Z" />
      <path d="M2.6 14h10.8" />
    </svg>
  );
}
