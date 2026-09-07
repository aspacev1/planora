import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { errorKey } from "../api/errors";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * Поля, сохраняющие себя сами.
 *
 * Ни в карточке задачи, ни в настройках нет отдельного режима правки и кнопки
 * «Сохранить». Значение уходит на сервер само — вопрос только в том, когда
 * именно, и ответ на него зависит от того, чем человек занят.
 *
 * Текст набирают по букве, и отправлять его по букве значило бы писать в
 * историю задачи двадцать записей вместо одной, — поэтому текст уходит при
 * потере фокуса. Дату, список и число выбирают целиком, одним движением, и
 * ждать от них ещё и потери фокуса значит держать сделанный выбор
 * несохранённым неизвестно сколько.
 *
 * Раз кнопки нет, ответ сервера обязан приходить туда же, где стоит поле.
 * Общий баннер вверху страницы для этого не годится дважды: до него надо
 * доглядеть, и он ничего не говорит о том, какое из десяти полей отвергнуто.
 * А молчание в случае успеха неотличимо от «ничего и не отправилось» — с
 * кнопкой её нажатие было ответом само по себе, здесь нажимать нечего.
 * Поэтому у каждого поля своя отметка: «сохранение», «сохранено» или отказ
 * словами.
 *
 * Поля показывают то, что пришло сверху: и подрезанные сервером пробелы, и
 * откат после отказа обязаны быть видны в поле. Одной слежки за значением для
 * этого мало — сервер отвечает тем же самым значением и в том, и в другом
 * случае, а в поле стоит другое, — поэтому поле возвращается к правде по
 * счётчику `settled`: он растёт в тот момент, когда отправка кончилась, чем
 * бы она ни кончилась.
 */

/** Состояние последней отправки одного поля. */
export type FieldSave = {
  state: "saving" | "saved" | "failed";
  /** Ключ словаря, которым объясняется отказ. */
  message?: string;
  /** Сколько отправок этого поля уже завершилось — успехом или отказом. */
  settled: number;
};

/** Чем объясняется стёртое поле. */
const BLANK = "settings.blank";

/** Разбор по умолчанию: годится всё конечное, кроме пустой строки. */
function defaultNumber(text: string): number | null {
  const value = Number(text);
  return text.trim() === "" || !Number.isFinite(value) ? null : value;
}

/**
 * Отправки полей одного экрана.
 *
 * Мутация на экране одна — она умеет послать любое поле и обновить кэш, — а
 * состояние у каждого поля своё: `isPending` и `error` самой мутации
 * рассказывают про последнее изменение вообще, и по ним нельзя понять, чьё
 * именно поле сейчас летит и чьё отвергнуто.
 */
export function useFieldSaves<Patch>(send: (patch: Patch) => Promise<unknown>) {
  const [saves, setSaves] = useState<Record<string, FieldSave>>({});

  const mark = (field: string, next: (previous: FieldSave | undefined) => FieldSave) =>
    setSaves((all) => ({ ...all, [field]: next(all[field]) }));

  /** Отправляет изменение одного поля и запоминает, чем оно кончилось. */
  const commit = (field: string, patch: Patch) => {
    mark(field, (was) => ({ state: "saving", settled: was?.settled ?? 0 }));
    // Отказ на этом и заканчивается: он уже сказан состоянием поля, и
    // повторять его необработанным промисом в консоли незачем.
    send(patch).then(
      () => mark(field, (was) => ({ state: "saved", settled: (was?.settled ?? 0) + 1 })),
      (error: unknown) =>
        mark(field, (was) => ({
          state: "failed",
          message: errorKey(error),
          settled: (was?.settled ?? 0) + 1,
        })),
    );
  };

  /**
   * Отказ, до сервера не дошедший.
   *
   * Пустое название сервер тоже не примет, но сказать об этом у поля можно,
   * не спрашивая его, — а промолчать нельзя: стёртое поле осталось бы пустым
   * на экране, где на сервере лежит прежнее название.
   */
  const refuse = (field: string, message: string) => {
    mark(field, (was) => ({ state: "failed", message, settled: (was?.settled ?? 0) + 1 }));
  };

  return {
    commit,
    refuse,
    /** Текст, который не бывает пустым: название, имя, часовой пояс. */
    commitText(field: string, value: string, patch: (value: string) => Patch) {
      const trimmed = value.trim();
      if (trimmed === "") refuse(field, BLANK);
      else commit(field, patch(trimmed));
    },
    /**
     * Число, разобранное чужим правилом.
     *
     * Разбор передаётся, а не написан здесь: что считать числом, знает поле, а
     * не общий слой отправки, — у порога сдвига это ещё и «не меньше нуля»
     * (см. `parseThresholdDays`). `null` от разбора означает «отправлять
     * нечего»: стёртое поле и мусор в нём — тот же пустой ответ, а не `NaN`.
     */
    commitNumber(
      field: string,
      value: string,
      patch: (value: number) => Patch,
      parse: (text: string) => number | null = defaultNumber,
    ) {
      const number = parse(value);
      if (number === null) refuse(field, BLANK);
      else commit(field, patch(number));
    },
    at: (field: string): FieldSave | undefined => saves[field],
  };
}

/** Отметка об отправке — там же, где поле, а не вверху страницы. */
export function SaveMark({ save }: { save?: FieldSave }) {
  const { t } = useLocale();

  if (save === undefined) return null;

  if (save.state === "failed") {
    return (
      <span className="field__mark error" role="alert">
        {t(save.message ?? "error.unknown")}
      </span>
    );
  }

  // `status`, а не `alert`: это подтверждение уже сделанного, и перебивать им
  // чтение с экрана не за что. Но и промолчать нельзя — отметка у поля здесь
  // единственный ответ на правку, и незрячему он нужен не меньше.
  const saved = save.state === "saved";
  return (
    <span className={saved ? "field__mark ok" : "field__mark muted"} role="status">
      {t(saved ? "common.saved" : "common.saving")}
    </span>
  );
}

export function FieldRow({
  id,
  label,
  hint,
  className = "field",
  save,
  children,
}: {
  id: string;
  /** Не задана — подпись стоит снаружи, и поле берёт её по `aria-labelledby`. */
  label?: string;
  hint?: string;
  /** Раскладка строки: у карточки задачи она своя, у настроек своя. */
  className?: string;
  save?: FieldSave;
  children: ReactNode;
}) {
  return (
    <p className={className}>
      {label !== undefined && <label htmlFor={id}>{label}</label>}
      {hint !== undefined && <span className="muted">{hint}</span>}
      {children}
      <SaveMark save={save} />
    </p>
  );
}

/** Текст: уходит при потере фокуса и только если изменился. */
export function TextField({
  id,
  label,
  labelledBy,
  hint,
  className,
  value,
  type,
  min,
  rows,
  disabled,
  resetToken,
  save,
  onCommit,
}: {
  id: string;
  label?: string;
  /** Идентификатор подписи, когда она стоит снаружи поля. */
  labelledBy?: string;
  hint?: string;
  className?: string;
  value: string;
  type?: "text" | "number";
  min?: number;
  /** Задано — многострочное поле. */
  rows?: number;
  disabled?: boolean;
  /** Меняется, когда сервер отказал: поле обязано вернуться к правде. */
  resetToken?: unknown;
  save?: FieldSave;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  // Набирают ли поле прямо сейчас. Отметка о прошлой отправке при этом
  // гаснет: «Сохранено» рядом с недописанным словом говорит неправду.
  const [typing, setTyping] = useState(false);
  // То же «набирают сейчас», но ссылкой — для эффекта ниже. Он обязан видеть
  // текущее значение, не переподписываясь на него: включи мы `typing` в
  // зависимости, конец набора сам запускал бы возврат к значению сверху — ещё
  // старому, пока сервер не ответил, — и поле мигало бы прежним текстом.
  const typingNow = useRef(false);

  // Возврат к правде сверху — но не под руками у человека. Значение сверху
  // меняется не только от его собственной правки: сосед подвинул задачу, и
  // состояние проекта перезапросилось целиком; своя же прошлая отправка
  // завершилась, пока поле уже набирают заново. Открытое поле при этом не
  // трогается — так же, как ячейка таблицы (см. EditableCell): набранное
  // уйдёт по уходу фокуса и сравнится с тем, что будет сверху к тому моменту.
  useEffect(() => {
    if (typingNow.current) return;
    setDraft(value);
    setTyping(false);
  }, [value, resetToken, save?.settled]);

  // Сравнение с тем, что пришло сверху, а не с тем, что было при фокусе:
  // поле, из которого вышли, ничего не изменив, не должно оставлять в истории
  // запись «изменил описание». Иначе лента заполняется шумом и перестаёт
  // читаться — а читают её ради того, чтобы понять, кто и что поменял.
  const commit = () => {
    typingNow.current = false;
    setTyping(false);
    if (draft !== value) onCommit(draft);
  };

  const shared = {
    id,
    name: id,
    value: draft,
    disabled,
    "aria-labelledby": label === undefined ? labelledBy : undefined,
    onChange: (event: { target: { value: string } }) => {
      setDraft(event.target.value);
      typingNow.current = true;
      setTyping(true);
    },
    onBlur: commit,
  };

  return (
    <FieldRow
      id={id}
      label={label}
      hint={hint}
      className={className}
      save={typing ? undefined : save}
    >
      {rows === undefined ? (
        <input {...shared} type={type} min={min} />
      ) : (
        <textarea {...shared} rows={rows} />
      )}
    </FieldRow>
  );
}

/** Дата или число: уходит сразу, как только значение изменилось. */
export function ValueField({
  id,
  label,
  labelledBy,
  className,
  type,
  value,
  disabled,
  allowEmpty,
  resetToken,
  save,
  onCommit,
}: {
  id: string;
  label?: string;
  labelledBy?: string;
  className?: string;
  type: "date" | "number";
  value: string;
  disabled?: boolean;
  /** Пустое значение осмысленно — например, «дедлайна нет». */
  allowEmpty?: boolean;
  /** Меняется, когда сервер отказал: поле обязано вернуться к правде. */
  resetToken?: unknown;
  save?: FieldSave;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value, resetToken, save?.settled]);

  return (
    <FieldRow id={id} label={label} className={className} save={save}>
      <input
        id={id}
        name={id}
        type={type}
        value={draft}
        disabled={disabled}
        aria-labelledby={label === undefined ? labelledBy : undefined}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          // Пустое поле — это середина набора, а не значение. Отправлять его
          // значит просить сервер отказать в том, чего человек не просил, —
          // кроме тех полей, где «пусто» само по себе ответ.
          if ((allowEmpty === true || next !== "") && next !== value) onCommit(next);
        }}
      />
    </FieldRow>
  );
}

/** Список: уходит при выборе. */
export function SelectField({
  id,
  label,
  className,
  value,
  disabled,
  options,
  save,
  onCommit,
}: {
  id: string;
  label: string;
  className?: string;
  value: string;
  disabled?: boolean;
  options: { value: string; label: string }[];
  save?: FieldSave;
  onCommit: (value: string) => void;
}) {
  return (
    <FieldRow id={id} label={label} className={className} save={save}>
      <select
        id={id}
        name={id}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          if (event.target.value !== value) onCommit(event.target.value);
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldRow>
  );
}
