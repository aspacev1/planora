import { useState } from "react";

import { SaveMark } from "../components/autosave";
import type { FieldSave } from "../components/autosave";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * Допущения и примечания — свойство предложения целиком, карточкой под
 * таблицей: «оценки по текущему объёму», «ставки без лицензий» относятся ко
 * всем строкам сразу.
 */
export function ProposalNotes({
  notes,
  canWrite,
  save,
  onCommit,
}: {
  notes: string;
  canWrite: boolean;
  /** Состояние последней отправки — отметка у заголовка, как у полей. */
  save?: FieldSave;
  onCommit: (value: string) => void;
}) {
  const { t } = useLocale();
  const [editing, setEditing] = useState(false);

  return (
    <section className="proposal-notes" aria-label={t("proposal.notes.title")}>
      <header className="proposal-notes__head">
        <h3 className="proposal-notes__title" id="proposal-notes-title">
          {t("proposal.notes.title")}
        </h3>
        <SaveMark save={save} />
        {canWrite && !editing && (
          <button type="button" className="button--quiet" onClick={() => setEditing(true)}>
            {t("proposal.notes.edit")}
          </button>
        )}
      </header>
      {editing ? (
        <NotesEditor
          initial={notes}
          onDone={(value) => {
            if (value !== notes) onCommit(value);
            setEditing(false);
          }}
        />
      ) : notes.trim() === "" ? (
        <p className="muted">{t("proposal.notes.empty")}</p>
      ) : (
        // Пункт на строку, как их и пишут: маркеры даёт список, а не
        // разметка внутри текста.
        <ul className="proposal-notes__list">
          {notes
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line, index) => (
              <li key={index}>{line}</li>
            ))}
        </ul>
      )}
    </section>
  );
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
