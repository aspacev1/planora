import { useEffect, useId, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent } from "react";

import type { EffortUnit, NewProposalTask, RoleSuggestion } from "../api/proposal";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * Заведение строки сметы — строкой в таблице, тем же движением, что задача в
 * ленте (gantt/NewTaskRow): смету пишут списком, по строке на работу, и окно
 * между строками означало бы открыть, заполнить, закрыть — двадцать раз
 * подряд.
 *
 * Спрашиваются сразу четыре поля — работа, роль, оценка, ставка, — а не одно
 * имя: смета без денег не смета, и дописывать их потом в карточке значило бы
 * открыть, поправить, закрыть на каждой строке. Роль подсказывается из того,
 * что организация уже писала, и тянет за собой свою ставку: ставка дизайнера
 * одна на студию, второй раз её не набирают.
 *
 * Правила клавиш — те же, что в ленте. Enter отправляет написанное и
 * оставляет строку пустой и в фокусе: следующую пишут сразу, не касаясь
 * мыши. Пустой Enter значит «больше не нужно» и строку закрывает. Esc
 * отменяет набранное. Уход фокуса из строки сохраняет: имя, пропавшее от
 * щелчка мимо, человек считал бы потерянной работой, а не отменённым вводом.
 */
export function NewProposalTaskRow({
  columns,
  label,
  placeholder,
  unit,
  currency,
  suggestions,
  onCreate,
  onClose,
}: {
  /** Сколько колонок накрыть: поля тянутся на всю ширину таблицы. */
  columns: number;
  /** Имя поля работы при чтении с экрана: «Новая работа в „Discovery“». */
  label: string;
  placeholder: string;
  unit: EffortUnit;
  currency: string;
  /** Роли организации с последними ставками — для подсказки. */
  suggestions: RoleSuggestion[];
  /** Отправить написанное. Строка при этом остаётся открытой. */
  onCreate: (input: NewProposalTask) => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [effort, setEffort] = useState("");
  const [rate, setRate] = useState("");
  // Список ролей открыт, и какой пункт в нём выбран стрелками.
  const [listOpen, setListOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLTableRowElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const effortInput = useRef<HTMLInputElement>(null);
  const listId = useId();

  // Фокус — сразу: «плюс» нажимают ради того, чтобы писать.
  useEffect(() => {
    nameInput.current?.focus();
  }, []);

  const unitLetter = t(unit === "hours" ? "proposal.format.hour_letter" : "proposal.format.day_letter");
  const needle = role.trim().toLocaleLowerCase();
  const matches = suggestions
    .filter((suggestion) => suggestion.role.toLocaleLowerCase().includes(needle))
    .slice(0, 8);

  /** Число из поля — или ничего: пустое поле и мусор в нём не отправляются. */
  const number = (text: string): number | undefined => {
    const value = Number(text);
    return text.trim() === "" || !Number.isFinite(value) || value < 0 ? undefined : value;
  };

  /** Отправлено или нет: пустое имя — не работа, а середина набора. */
  const submit = (): boolean => {
    const trimmed = name.trim();
    if (trimmed === "") return false;
    onCreate({
      name: trimmed,
      role: role.trim() === "" ? undefined : role.trim(),
      effort: number(effort),
      rate: number(rate),
    });
    setName("");
    setRole("");
    setEffort("");
    setRate("");
    setListOpen(false);
    nameInput.current?.focus();
    return true;
  };

  const pick = (suggestion: RoleSuggestion) => {
    setRole(suggestion.role);
    // Ставку подставляем, только если её ещё не написали: набранное рукой
    // весит больше подсказки.
    if (rate.trim() === "" && suggestion.rate > 0) setRate(String(suggestion.rate));
    setListOpen(false);
    effortInput.current?.focus();
  };

  const onRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (!submit()) onClose();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  const onRoleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (matches.length === 0) return;
      setListOpen(true);
      setActive((index) =>
        event.key === "ArrowDown"
          ? (index + 1) % matches.length
          : (index - 1 + matches.length) % matches.length,
      );
      return;
    }
    if (event.key === "Enter" && listOpen && matches[active] !== undefined) {
      // Enter в открытом списке выбирает роль, а не отправляет строку:
      // строка уйдёт следующим Enter, уже с ролью и ставкой.
      event.preventDefault();
      event.stopPropagation();
      pick(matches[active]);
      return;
    }
    if (event.key === "Escape" && listOpen) {
      event.preventDefault();
      event.stopPropagation();
      setListOpen(false);
    }
  };

  const onRowBlur = (event: FocusEvent<HTMLTableRowElement>) => {
    // Фокус остался в строке — переход между её полями, а не уход.
    if (root.current?.contains(event.relatedTarget as Node | null)) return;
    submit();
    onClose();
  };

  return (
    <tr
      ref={root}
      className="proposal-row proposal-entry"
      onKeyDown={onRowKeyDown}
      onBlur={onRowBlur}
    >
      <td colSpan={columns}>
        <div className="proposal-entry__fields">
          <span className="proposal-entry__field">
            <input
              ref={nameInput}
              type="text"
              value={name}
              placeholder={placeholder}
              aria-label={label}
              onChange={(event) => setName(event.target.value)}
            />
          </span>
          <span className="proposal-entry__field">
            <input
              type="text"
              role="combobox"
              value={role}
              placeholder={t("proposal.entry.role_placeholder")}
              aria-label={t("proposal.entry.role")}
              aria-autocomplete="list"
              aria-expanded={listOpen && matches.length > 0}
              aria-controls={listId}
              aria-activedescendant={
                listOpen && matches[active] !== undefined ? `${listId}-${active}` : undefined
              }
              onChange={(event) => {
                setRole(event.target.value);
                setListOpen(true);
                setActive(0);
              }}
              onFocus={() => setListOpen(true)}
              onKeyDown={onRoleKeyDown}
            />
            {listOpen && matches.length > 0 && (
              <ul className="proposal-suggest" role="listbox" id={listId}>
                <li className="proposal-suggest__head" aria-hidden="true">
                  {t("proposal.entry.roles")}
                </li>
                {matches.map((suggestion, index) => (
                  <li
                    key={suggestion.role}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === active}
                    className={`proposal-suggest__item${index === active ? " is-active" : ""}`}
                    // mousedown, а не click: щелчок по пункту не должен
                    // увести фокус из строки — иначе она закроется раньше,
                    // чем пункт успеет выбраться.
                    onMouseDown={(event) => {
                      event.preventDefault();
                      pick(suggestion);
                    }}
                  >
                    <span>{suggestion.role}</span>
                    {suggestion.rate > 0 && (
                      <span className="proposal-suggest__rate">{suggestion.rate}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </span>
          <span className="proposal-entry__field">
            <input
              ref={effortInput}
              type="number"
              step="any"
              min={0}
              value={effort}
              placeholder={t("proposal.entry.effort_placeholder", { unit: unitLetter })}
              aria-label={t("proposal.entry.effort", { unit: unitLetter })}
              onChange={(event) => setEffort(event.target.value)}
            />
          </span>
          <span className="proposal-entry__field">
            <input
              type="number"
              step="any"
              min={0}
              value={rate}
              placeholder={t("proposal.entry.rate_placeholder", { currency, unit: unitLetter })}
              aria-label={t("proposal.entry.rate", { currency, unit: unitLetter })}
              onChange={(event) => setRate(event.target.value)}
            />
          </span>
        </div>
        <p className="proposal-entry__hint">
          <span>
            <b>Enter</b> — {t("proposal.entry.hint_enter")}
          </span>
          <span>
            <b>Tab</b> — {t("proposal.entry.hint_tab")}
          </span>
          <span>
            <b>Esc</b> — {t("proposal.entry.hint_esc")}
          </span>
          <span>{t("proposal.entry.hint_rate")}</span>
        </p>
      </td>
    </tr>
  );
}
