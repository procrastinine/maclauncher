import React, { useEffect, useRef, useState } from "react";
import { formatUserError } from "../ui-helpers";
import { createQueuedWriter, type QueuedWriter } from "./queued-write-model";

export function GameNotes({ notes, onSave }: { notes: string; onSave: (notes: string) => Promise<void> }) {
  const [draft, setDraft] = useState(notes);
  const [saved, setSaved] = useState(notes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef(draft), savedRef = useRef(saved), saveCallback = useRef(onSave), requests = useRef(0);
  draftRef.current = draft; savedRef.current = saved; saveCallback.current = onSave;
  const writerRef = useRef<QueuedWriter<string> | null>(null);
  if (!writerRef.current) writerRef.current = createQueuedWriter(value => saveCallback.current(value));
  const writer = writerRef.current;
  useEffect(() => {
    setDraft(current => !writer.busy && current === saved ? notes : current);
    setSaved(notes);
  }, [notes]);

  const dirty = draft !== saved;
  async function save() {
    const value = draftRef.current;
    if (!writer.busy && value === savedRef.current) return;
    requests.current++;
    setBusy(true);
    setError(null);
    try {
      const written = await writer.save(value);
      savedRef.current = written;
      setSaved(written);
      setError(null);
    } catch (error: any) {
      setError(String(error?.message || error));
    } finally {
      requests.current--;
      setBusy(requests.current > 0);
    }
  }

  return <section className="gameNotes" aria-label="Game notes">
    <div className="gameNotesHeader">
      <label className="detailSectionHeading" htmlFor="game-notes">Notes</label>
      {(dirty || busy) && <button className="btn small" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save notes"}</button>}
    </div>
    <textarea id="game-notes" className="input gameNotesInput" value={draft} maxLength={65536} rows={2}
      onChange={event => { draftRef.current = event.target.value; setDraft(event.target.value); setError(null); }}
      onBlur={() => void save()}
      onKeyDown={event => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault(); event.stopPropagation(); void save();
        }
      }} />
    {error && <div className="error" role="status">{formatUserError(error)}</div>}
  </section>;
}
