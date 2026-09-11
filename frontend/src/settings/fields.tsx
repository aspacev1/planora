import { useEffect, useMemo, useState } from "react";

import type { SlugCheck } from "../api/org";
import { SaveMark } from "../components/autosave";
import type { FieldSave } from "../components/autosave";
import { useLocale } from "../i18n/LocaleProvider";
import { browserTimeZone, timeZoneNames } from "../time/zone";

/**
 * The fields both settings screens need.
 *
 * The organization and the project configure the same quantities — working days,
 * the date calendar, the slug — and written separately on the two screens they
 * will diverge on the first edit: one screen will learn to understand an empty
 * string, the other will not.
 */

/**
 * The mask of the week's working days.
 *
 * The numbering is the server's: bit 0 is Monday. Converting it to another
 * numbering along the way would mean keeping a second representation of one and
 * the same thing, and they would diverge on the very first project with a working
 * Saturday.
 */
export function WorkingDaysField({
  value,
  onChange,
  disabled,
  save,
}: {
  value: number;
  onChange: (mask: number) => void;
  disabled?: boolean;
  save?: FieldSave;
}) {
  const { t } = useLocale();
  const [emptied, setEmptied] = useState(false);

  // A week with no working days is not a setting but an impossible state: the
  // server will not accept such a mask, and the last unticked checkbox would come
  // back with an answer of "check the form", where not a single field is named.
  // The refusal is explained right here — the same way the date list explains a
  // date it did not understand without sending it.
  const toggle = (day: number, on: boolean) => {
    const mask = on ? value & ~(1 << day) : value | (1 << day);
    if (mask === 0) {
      setEmptied(true);
      return;
    }
    setEmptied(false);
    onChange(mask);
  };

  return (
    <fieldset className="settings__fieldset">
      {/* The mark stands under the days rather than in the caption: the caption
          is the whole group's name, and a "Saved" landing in it would be read by a screen reader as part of the name. */}
      <legend>{t("settings.working_days")}</legend>
      <div className="settings__days">
        {[0, 1, 2, 3, 4, 5, 6].map((day) => {
          // The weekday captions live in the dictionaries under `getUTCDay`
          // numbers, where zero is Sunday. Here the numbering is the server's, so
          // exactly one conversion is needed and exactly here.
          const label = t(`calendar.weekday.${(day + 1) % 7}`);
          const on = (value & (1 << day)) !== 0;
          return (
            <label key={day} className="settings__day">
              <input
                type="checkbox"
                checked={on}
                disabled={disabled}
                onChange={() => toggle(day, on)}
              />
              {label}
            </label>
          );
        })}
      </div>
      <SaveMark save={save} />
      {emptied && (
        <span className="error" role="alert">
          {t("settings.working_days_empty")}
        </span>
      )}
    </fieldset>
  );
}

/**
 * The time zone — as a choice from a list rather than as a string.
 *
 * An IANA database name ("Europe/Moscow") is hard to type from memory without a
 * typo, and a mistake in it is invisible: the server will refuse, and the person
 * is left guessing what is wrong with "Europe/Moskva". The list is supplied by
 * the browser itself — our own copy of the zone database would age along with the
 * application.
 *
 * An empty value is not "empty" but a separate, meaningful choice: count the day
 * by the browser's clock. It stands first and is selected by default because it
 * is almost always right; the zone is set by hand by those whose browser lies —
 * people who have moved away and people behind a VPN.
 */
export function TimeZoneField({
  id,
  label,
  hint,
  autoLabel,
  value,
  onChange,
  disabled,
  save,
}: {
  id: string;
  label: string;
  hint?: string;
  /** The caption of the "by the browser" choice — with the zone the browser reports. */
  autoLabel: string;
  /** `null` — no zone is chosen, the day is counted by the browser. */
  value: string | null;
  onChange: (zone: string | null) => void;
  disabled?: boolean;
  /** The submission mark next to the field — as with the other settings fields. */
  save?: FieldSave;
}) {
  // The saved choice and the machine's zone are added to the list forcibly: a
  // browser older than the IANA database does not know about a recently created
  // zone, and without this the field would show something other than what is
  // recorded in the profile.
  const zones = useMemo(() => timeZoneNames(value, browserTimeZone()), [value]);

  return (
    <p className="field">
      <label htmlFor={id}>{label}</label>
      {hint && <span className="muted">{hint}</span>}
      <select
        id={id}
        name={id}
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
      >
        <option value="">{autoLabel}</option>
        {zones.map((zone) => (
          <option key={zone} value={zone}>
            {zone}
          </option>
        ))}
      </select>
      <SaveMark save={save} />
    </p>
  );
}

/** The lines of the date list: empty ones are dropped, the order and duplicates are the server's concern. */
export function parseDates(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/**
 * The shift threshold from an input field: `null` — "there is no number here,
 * nothing to send".
 *
 * An empty field does not mean "zero": a zero threshold demands an explanation
 * for every shift, and a person who erased the number before typing a new one
 * asked for no such thing. And `Number` on its own does exactly that — it turns
 * an empty string into zero and junk into `NaN` — so both checks stand here,
 * shared by both screens, rather than being written separately on each.
 */
export function parseThresholdDays(text: string): number | null {
  const value = text.trim();
  if (value === "") return null;
  const days = Number(value);
  // A negative threshold is the same thing as the field's `min={0}`: there is no
  // such thing as "minus five" days, and the server will refuse; a refusal that
  // can be left unshown is better left unshown.
  if (!Number.isFinite(days) || days < 0) return null;
  return days;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The date list — holidays and working Saturdays.
 *
 * A multiline field rather than a set of date pickers: holidays are typed in as a
 * list once a year, and ten fields with little calendars are worse for that than
 * one the list is pasted into whole.
 */
export function DateListField({
  id,
  label,
  hint,
  value,
  onCommit,
  disabled,
  save,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string[];
  onCommit: (dates: string[]) => void;
  disabled?: boolean;
  save?: FieldSave;
}) {
  const { t } = useLocale();
  // The list is compared by content rather than by reference: the project's and
  // the organization's state is rewritten whole by the answer to any edit, and
  // the date array arrives as a new object with the same dates after any
  // neighbouring field is saved. Were we to check the reference, a deadline saved
  // a second ago would erase the holidays being typed here.
  const joined = value.join("\n");
  const [text, setText] = useState(joined);
  const [typing, setTyping] = useState(false);

  // The server normalizes the list — sorts it and removes duplicates — and the
  // field must show what it returned rather than what the person typed. A sorted
  // list is often equal to the one sent, so `value` alone is not enough for this:
  // the return to the truth is also triggered by a finished submission.
  useEffect(() => {
    setText(joined);
    setTyping(false);
  }, [joined, save?.settled]);

  const broken = parseDates(text).filter((item) => !ISO_DATE.test(item));

  return (
    <p className="field">
      <label htmlFor={id}>{label}</label>
      {hint && <span className="muted">{hint}</span>}
      <textarea
        id={id}
        name={id}
        rows={4}
        value={text}
        disabled={disabled}
        onChange={(event) => {
          setText(event.target.value);
          setTyping(true);
        }}
        onBlur={() => {
          setTyping(false);
          if (broken.length > 0) return;
          const dates = parseDates(text);
          // The order in the list means nothing: this is a set of dates.
          if (dates.join(",") !== [...value].join(",")) onCommit(dates);
        }}
      />
      {broken.length > 0 ? (
        <span className="error" role="alert">
          {t("settings.bad_dates", { dates: broken.join(", ") })}
        </span>
      ) : (
        <SaveMark save={typing ? undefined : save} />
      )}
    </p>
  );
}

/**
 * The slug field with a suggestion of a free variant.
 *
 * Availability is asked of the server as you type rather than on submit: section
 * 12 promises a free variant "right in the input field before the form is
 * submitted". The check is deferred by half a second after the last keystroke —
 * otherwise a request leaves on every letter and answers about an unfinished word.
 */
export function SlugField({
  id,
  label,
  value,
  check,
  onCommit,
  disabled,
  save,
}: {
  id: string;
  label: string;
  value: string;
  check: (slug: string) => Promise<SlugCheck>;
  onCommit: (slug: string) => void;
  disabled?: boolean;
  save?: FieldSave;
}) {
  const { t } = useLocale();
  const [draft, setDraft] = useState(value);
  const [status, setStatus] = useState<SlugCheck | null>(null);
  const [typing, setTyping] = useState(false);

  // The server brings the slug into its own form — "Редизайн 2026" comes back as
  // `redizayn-2026` — and the field must show what it returned.
  useEffect(() => {
    setDraft(value);
    setTyping(false);
  }, [value, save?.settled]);

  useEffect(() => {
    const candidate = draft.trim();
    if (candidate === "" || candidate === value) {
      setStatus(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      check(candidate)
        .then((result) => {
          // The answer to a stale request is ignored: the person has managed to
          // type another letter, and a suggestion about the previous word would
          // only confuse.
          if (alive) setStatus(result);
        })
        .catch(() => {
          if (alive) setStatus(null);
        });
    }, 400);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [draft, value, check]);

  const commit = (slug: string) => {
    setDraft(slug);
    setTyping(false);
    if (slug !== value) onCommit(slug);
  };

  return (
    <p className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={id}
        value={draft}
        disabled={disabled}
        onChange={(event) => {
          setDraft(event.target.value);
          setTyping(true);
        }}
        onBlur={() => {
          const candidate = draft.trim();
          if (candidate !== "" && (status === null || status.available)) commit(candidate);
        }}
      />
      {status && !status.available && (
        <span className="settings__slug-hint">
          {t("settings.slug_taken")}{" "}
          {/* The suggestion is a button, not text: a person can read a free
              variant and retype it by hand without our help. */}
          <button type="button" className="button--quiet" onClick={() => commit(status.suggestion)}>
            {status.suggestion}
          </button>
        </span>
      )}
      {/* A taken slug is already explained by the suggestion next to it: a second
          line about the same thing is noise. */}
      {!(status && !status.available) && <SaveMark save={typing ? undefined : save} />}
    </p>
  );
}
