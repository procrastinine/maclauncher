import React, { useEffect, useRef, useState } from "react";
import { HelpTip } from "./HelpTip";
import { createQueuedWriter, type QueuedWriter } from "./queued-write-model";

export function GameArguments({ value, onSave }: { value: string; onSave: (value: string) => Promise<void> }) {
  const [draft, setDraft] = useState(value), [saved, setSaved] = useState(value);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const draftRef = useRef(draft), savedRef = useRef(saved), callback = useRef(onSave), requests = useRef(0);
  draftRef.current = draft; savedRef.current = saved; callback.current = onSave;
  const writerRef = useRef<QueuedWriter<string> | null>(null);
  if (!writerRef.current) writerRef.current = createQueuedWriter(text => callback.current(text));
  const writer = writerRef.current;
  useEffect(() => {
    setDraft(current => !writer.busy && current === saved ? value : current);
    setSaved(value);
  }, [value]);
  async function save() {
    const text = draftRef.current;
    if (!writer.busy && text === savedRef.current) return;
    requests.current++; setBusy(true); setError(null);
    try { const written = await writer.save(text); savedRef.current = written; setSaved(written); }
    catch (failure: any) { setError(String(failure?.message || failure)); }
    finally { requests.current--; setBusy(requests.current > 0); }
  }
  return <div className="detailRow">
    <div className="detailLabel">Launch arguments <HelpTip label="About launch arguments">
      Additional arguments for this game. Quotes keep spaces inside one argument, such as --windowed --name "Example name".
      Shell commands and environment variables are not expanded. The game or runtime determines which options it recognizes. Applies on the next launch.
    </HelpTip></div>
    <div className="detailValue">
      <textarea className="input" rows={2} aria-label="Launch arguments" value={draft} maxLength={32768}
        placeholder="Add arguments…" aria-invalid={Boolean(error)}
        onChange={event => { draftRef.current = event.target.value; setDraft(event.target.value); setError(null); }}
        onBlur={() => void save()}
        onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); void save(); } }} />
      {error && <div className="error" role="status">{error}</div>}
    </div>
    <div className="detailActions">{(draft !== saved || busy) && <button className="btn small" disabled={busy}
      onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>}</div>
  </div>;
}
