import React from "react";
import { useQueuedDraft } from "./CommitInput";
import { ErrorText } from "./ErrorText";
import { FieldRow } from "./FieldRow";

export function GameArguments({ value, onSave }: { value: string; onSave: (value: string) => Promise<void> }) {
  const { draft, setDraft, dirty, busy, error, save } = useQueuedDraft(value, onSave);
  return <FieldRow label="Launch arguments" help={<>
      Additional arguments for this game. Quotes keep spaces inside one argument, such as --windowed --name "Example name".
      Shell commands and environment variables are not expanded. The game or runtime determines which options it recognizes. Applies on the next launch.
    </>}
    actions={(dirty || busy) && <button className="btn small" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>}>
    <textarea className="input" rows={2} aria-label="Launch arguments" value={draft} maxLength={32768}
      placeholder="Add arguments…" aria-invalid={Boolean(error)}
      onChange={event => setDraft(event.target.value)}
      onBlur={() => void save()}
      onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); void save(); } }} />
    <ErrorText error={error} inline />
  </FieldRow>;
}
