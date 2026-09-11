import { useEffect, useId, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent } from "react";

import type { EffortUnit, NewProposalTask, RoleSuggestion } from "../api/proposal";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * Creating a quote line — as a row in the table, by the same motion as a task in the strip
 * (gantt/NewTaskRow): a quote is written as a list, a row per work item, and a dialog between
 * rows would mean opening, filling in, closing — twenty times in a row.
 *
 * Four fields are asked for at once — the work, the role, the estimate, the rate — rather than
 * one name: a quote without money is not a quote, and adding it later in the card would mean
 * opening, correcting, closing on every row. The role is suggested from what the organization
 * has already written and pulls its rate along with it: a designer's rate is one per studio, it
 * is not typed a second time.
 *
 * The key rules are the strip's. Enter sends what was written and leaves the row empty and
 * focused: the next one is written straight away without touching the mouse. An empty Enter
 * means "no more needed" and closes the row. Esc cancels what was typed. Leaving the row saves:
 * a name that vanished from a stray click would be counted by a person as lost work rather than
 * as a cancelled input.
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
  /** How many columns to cover: the fields stretch across the table's whole width. */
  columns: number;
  /** The work field's name on a screen reader: "New work in “Discovery”". */
  label: string;
  placeholder: string;
  unit: EffortUnit;
  currency: string;
  /** The organization's roles with their latest rates — for the suggestion. */
  suggestions: RoleSuggestion[];
  /** Send what was written. The row stays open at that. */
  onCreate: (input: NewProposalTask) => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [effort, setEffort] = useState("");
  const [rate, setRate] = useState("");
  // Whether the list of roles is open, and which item in it is selected with the arrows.
  const [listOpen, setListOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLTableRowElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const effortInput = useRef<HTMLInputElement>(null);
  const listId = useId();

  // The focus goes in at once: the "plus" is pressed in order to write.
  useEffect(() => {
    nameInput.current?.focus();
  }, []);

  const unitLetter = t(unit === "hours" ? "proposal.format.hour_letter" : "proposal.format.day_letter");
  const needle = role.trim().toLocaleLowerCase();
  const matches = suggestions
    .filter((suggestion) => suggestion.role.toLocaleLowerCase().includes(needle))
    .slice(0, 8);

  /** The number from a field — or nothing: an empty field and junk in it are not sent. */
  const number = (text: string): number | undefined => {
    const value = Number(text);
    return text.trim() === "" || !Number.isFinite(value) || value < 0 ? undefined : value;
  };

  /** Sent or not: an empty name is not work but the middle of typing. */
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
    // We substitute the rate only if it has not been written yet: what was typed by hand weighs
    // more than a suggestion.
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
      // An Enter in an open list picks a role rather than sending the row: the row will leave on
      // the next Enter, already with a role and a rate.
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
    // The focus stayed in the row — a move between its fields rather than a departure.
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
                    // mousedown rather than click: a click on an item must not take the focus out
                    // of the row — otherwise it closes before the item manages to be chosen.
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
