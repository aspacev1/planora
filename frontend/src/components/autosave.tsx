import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { errorKey } from "../api/errors";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * Fields that save themselves.
 *
 * Neither the task card nor the settings has a separate edit mode and a "Save"
 * button. A value goes to the server on its own — the only question is when
 * exactly, and the answer depends on what the person is doing.
 *
 * Text is typed letter by letter, and sending it letter by letter would mean
 * writing twenty entries into the task's history instead of one — so text leaves
 * on blur. A date, a list and a number are chosen whole, in one motion, and
 * expecting a blur from them on top of that means keeping a made choice unsaved
 * for who knows how long.
 *
 * Since there is no button, the server's answer must arrive where the field is.
 * A shared banner at the top of the page will not do for that, twice over: you
 * have to look up at it, and it says nothing about which of the ten fields was
 * rejected. And silence on success is indistinguishable from "nothing was sent
 * at all" — with a button its press was an answer in itself, here there is
 * nothing to press. So every field has its own mark: "saving", "saved" or a
 * refusal in words.
 *
 * Fields show what arrived from above: both the whitespace trimmed by the server
 * and the rollback after a refusal must be visible in the field. Watching the
 * value alone is not enough for that — the server answers with the very same
 * value in both cases while the field holds something else — so a field returns
 * to the truth by the `settled` counter: it grows at the moment a submission
 * ends, however it ended.
 */

/** The state of one field's last submission. */
export type FieldSave = {
  state: "saving" | "saved" | "failed";
  /** The dictionary key the refusal is explained by. */
  message?: string;
  /** How many submissions of this field have already finished — with success or refusal. */
  settled: number;
};

  /** What an erased field is explained by. */
const BLANK = "settings.blank";

/** The default parse: anything finite will do, except an empty string. */
function defaultNumber(text: string): number | null {
  const value = Number(text);
  return text.trim() === "" || !Number.isFinite(value) ? null : value;
}

/**
 * One screen's field submissions.
 *
 * There is one mutation per screen — it can send any field and refresh the cache
 * — while every field has its own state: the mutation's own `isPending` and
 * `error` tell you about the last change in general, and they cannot tell whose
 * field is in flight right now and whose was rejected.
 */
export function useFieldSaves<Patch>(send: (patch: Patch) => Promise<unknown>) {
  const [saves, setSaves] = useState<Record<string, FieldSave>>({});

  const mark = (field: string, next: (previous: FieldSave | undefined) => FieldSave) =>
    setSaves((all) => ({ ...all, [field]: next(all[field]) }));

  /** Sends one field's change and remembers how it ended. */
  const commit = (field: string, patch: Patch) => {
    mark(field, (was) => ({ state: "saving", settled: was?.settled ?? 0 }));
    // The refusal ends right here: it is already said by the field's state, and
    // there is no point repeating it as an unhandled promise in the console.
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
   * A refusal that never reached the server.
   *
   * The server will not accept an empty name either, but the field can say so
   * without asking it — and staying silent will not do: an erased field would
   * stay empty on screen while the server holds the previous name.
   */
  const refuse = (field: string, message: string) => {
    mark(field, (was) => ({ state: "failed", message, settled: (was?.settled ?? 0) + 1 }));
  };

  return {
    commit,
    refuse,
    /** Text that is never empty: a title, a name, a time zone. */
    commitText(field: string, value: string, patch: (value: string) => Patch) {
      const trimmed = value.trim();
      if (trimmed === "") refuse(field, BLANK);
      else commit(field, patch(trimmed));
    },
    /**
     * A number parsed by somebody else's rule.
     *
     * The parse is passed in rather than written here: what counts as a number
     * is known by the field, not by the shared submission layer — for the shift
     * threshold it is also "not less than zero" (see `parseThresholdDays`). A
     * `null` from the parse means "there is nothing to send": an erased field and
     * junk in it are the same empty answer, not a `NaN`.
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

/** The submission mark — where the field is, not at the top of the page. */
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

  // `status` rather than `alert`: this is a confirmation of something already
  // done, and there is no reason to interrupt a screen reader with it. But
  // staying silent will not do either — the mark by the field is the only answer
  // to the edit here, and a blind person needs it no less.
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
  /** Not set — the caption stands outside, and the field takes it via `aria-labelledby`. */
  label?: string;
  hint?: string;
  /** The row's layout: the task card has its own, the settings have theirs. */
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

/** Text: leaves on blur and only if it changed. */
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
  /** The caption's id, when it stands outside the field. */
  labelledBy?: string;
  hint?: string;
  className?: string;
  value: string;
  type?: "text" | "number";
  min?: number;
  /** Set — a multiline field. */
  rows?: number;
  disabled?: boolean;
  /** Changes when the server refuses: the field must return to the truth. */
  resetToken?: unknown;
  save?: FieldSave;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  // Whether the field is being typed in right now. The mark about the previous
  // submission goes out at that: "Saved" next to an unfinished word tells a lie.
  const [typing, setTyping] = useState(false);
  // The same "being typed in right now", but as a ref — for the effect below. It
  // must see the current value without resubscribing to it: were we to include
  // `typing` in the dependencies, the end of typing would itself trigger a
  // return to the value from above — still the old one until the server answers
  // — and the field would flash the previous text.
  const typingNow = useRef(false);

  // A return to the truth from above — but not under the person's hands. The
  // value from above changes not only from their own edit: a colleague moved a
  // task and the project's state was refetched whole; one's own previous
  // submission finished while the field is already being typed in again. An open
  // field is not touched at that — the same as a table cell (see EditableCell):
  // what is typed will leave on blur and be compared with whatever is above by
  // that moment.
  useEffect(() => {
    if (typingNow.current) return;
    setDraft(value);
    setTyping(false);
  }, [value, resetToken, save?.settled]);

  // Compared with what arrived from above rather than with what was there on
  // focus: a field that was left without changing anything must not leave a
  // "changed the description" entry in the history. Otherwise the feed fills
  // with noise and stops being readable — and it is read in order to understand
  // who changed what.
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

/**
 * A date or a number.
 *
 * A date leaves as soon as it is chosen: the calendar gives it whole in one
 * choice. A number leaves on blur or on Enter rather than on every key: typing
 * "15" would send "1" first, and for a task with a baseline plan that was enough
 * for the "explain the shift" dialog to open — mid-typing, over a number the
 * person never named. An empty field returns to the truth on blur: emptiness is
 * the middle of typing, not a value (except in fields where "empty" is an
 * answer, see `allowEmpty`).
 */
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
  /** An empty value is meaningful — for example, "there is no deadline". */
  allowEmpty?: boolean;
  /** Changes when the server refuses: the field must return to the truth. */
  resetToken?: unknown;
  save?: FieldSave;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value, resetToken, save?.settled]);

  // An empty field is the middle of typing, not a value. Sending it means asking
  // the server to refuse something the person never asked for — except in those
  // fields where "empty" is an answer in itself.
  const commit = (next: string) => {
    if ((allowEmpty === true || next !== "") && next !== value) onCommit(next);
  };

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
          if (type === "date") commit(next);
        }}
        onBlur={() => {
          if (type === "date") return;
          if (draft === "" && allowEmpty !== true) {
            setDraft(value);
            return;
          }
          commit(draft);
        }}
        onKeyDown={(event) => {
          // Enter is the same as leaving the field: the number is ready, and one
          // submission path is better than two that will one day diverge.
          if (type === "number" && event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
    </FieldRow>
  );
}

/** A list: leaves on choice. */
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
