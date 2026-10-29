import React from "react";
import { useQueuedDraft } from "./CommitInput";
import { ErrorText } from "./ErrorText";

export function GameNotes({ notes, onSave }: { notes: string; onSave: (notes: string) => Promise<void> }) {
  const { draft, setDraft, dirty, busy, error, save } = useQueuedDraft(notes, onSave);
  return <section className="gameNotes" aria-label="Game notes">
    <div className="gameNotesHeader">
      <label className="detailSectionHeading" htmlFor="game-notes">Notes</label>
      {(dirty || busy) && <button className="btn small" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save notes"}</button>}
    </div>
    <textarea id="game-notes" className="input gameNotesInput" value={draft} maxLength={65536} rows={2}
      onChange={event => setDraft(event.target.value)}
      onBlur={() => void save()}
      onKeyDown={event => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault(); event.stopPropagation(); void save();
        }
      }} />
    <ErrorText error={error} inline />
  </section>;
}
