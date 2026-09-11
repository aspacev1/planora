import { useState } from "react";

import { SaveMark } from "../components/autosave";
import type { FieldSave } from "../components/autosave";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * The assumptions and notes are a property of the whole proposal, as a card under the table:
 * "estimates for the current scope", "rates excluding licences" apply to all the lines at once.
 */
export function ProposalNotes({
  notes,
  canWrite,
  save,
  onCommit,
}: {
  notes: string;
  canWrite: boolean;
  /** The last submission's state — a mark by the heading, as with the fields. */
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
        // One item per line, as they are written: the bullets are given by the list rather than by
        // markup inside the text.
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
 * Editing the notes: text, one item per line.
 *
 * Blur ends the edit in any case — changed text goes to the server, unchanged text simply closes the
 * field: an edit mode there is no way out of without a change would read as a stuck button.
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
      // The focus goes in at once: "edit" was pressed in order to write.
      autoFocus
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => onDone(draft)}
    />
  );
}
