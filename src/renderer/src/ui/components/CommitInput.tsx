import React, { useEffect, useRef, useState } from "react";
import { createQueuedWriter, type QueuedWriter } from "./queued-write-model";

/** A rejected commit (false) keeps the draft and marks the field invalid. */
export type CommitResult = boolean | void | Promise<boolean | void>;

export type NumberBounds = { min?: number; max?: number; integer?: boolean };

/** Empty, partial or non-finite text is never a value; bounds clamp a valid one. */
export function parseCommitNumber(text: string, { min, max, integer = false }: NumberBounds = {}): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  const value = integer ? Math.round(parsed) : parsed;
  return Math.min(max ?? Infinity, Math.max(min ?? -Infinity, value));
}

// Drafts stay local while focused. Enter (Cmd-Enter in multiline fields) or blur
// commits one change; Escape, or text that does not parse, restores the saved
// value. Outside changes replace an unedited draft.
function useCommitDraft<Element extends HTMLInputElement | HTMLTextAreaElement>(value: string,
  commit: (text: string) => CommitResult, { multiline = false, parse }: { multiline?: boolean; parse?: (text: string) => string | null } = {}) {
  const [draft, setDraft] = useState(value);
  const [invalid, setInvalid] = useState(false);
  const focused = useRef(false), dirty = useRef(false), edits = useRef(0), cancelBlur = useRef(false), saved = useRef(value);
  saved.current = value;
  useEffect(() => {
    if (focused.current && dirty.current) return;
    setDraft(value); setInvalid(false); dirty.current = false;
  }, [value]);
  function finish(text: string) {
    const next = parse ? parse(text) : text;
    if (!dirty.current || next === null || next === saved.current) {
      dirty.current = false; setDraft(saved.current); setInvalid(false); return;
    }
    const edit = edits.current;
    setDraft(next);
    void Promise.resolve(commit(next)).then(result => {
      setInvalid(result === false);
      if (result !== false && edits.current === edit) dirty.current = false;
    }, () => setInvalid(true));
  }
  return {
    value: draft,
    "aria-invalid": invalid || undefined,
    onFocus: () => { focused.current = true; },
    onChange: (event: React.ChangeEvent<Element>) => {
      dirty.current = true; edits.current++; setDraft(event.currentTarget.value); setInvalid(false);
    },
    onBlur: (event: React.FocusEvent<Element>) => {
      focused.current = false;
      if (cancelBlur.current) { cancelBlur.current = false; return; }
      finish(event.currentTarget.value);
    },
    onKeyDown: (event: React.KeyboardEvent<Element>) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Enter" && (!multiline || event.metaKey || event.ctrlKey)) {
        event.preventDefault(); event.currentTarget.blur();
      } else if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        cancelBlur.current = true; dirty.current = false; setDraft(saved.current); setInvalid(false); event.currentTarget.blur();
      }
    }
  };
}

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue" | "onChange" | "type" | "min" | "max">;

export function CommitTextInput({ value, onCommit, className = "input", ...props }: InputProps & {
  value: string; onCommit: (value: string) => CommitResult;
}) {
  const draft = useCommitDraft<HTMLInputElement>(value, onCommit);
  return <input {...props} type="text" className={className} {...draft} />;
}

export function CommitNumberInput({ value, onCommit, min, max, integer, className = "input", ...props }: InputProps & NumberBounds & {
  value: number | null | undefined; onCommit: (value: number) => CommitResult;
}) {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  const draft = useCommitDraft<HTMLInputElement>(text, next => onCommit(Number(next)), { parse: next => {
    const parsed = parseCommitNumber(next, { min, max, integer });
    return parsed === null ? null : String(parsed);
  } });
  return <input {...props} type="number" inputMode={integer ? "numeric" : "decimal"} min={min} max={max}
    className={className} {...draft} />;
}

export function CommitTextArea({ value, onCommit, className = "input", ...props }:
  Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "defaultValue" | "onChange"> & {
    value: string; onCommit: (value: string) => CommitResult;
  }) {
  const draft = useCommitDraft<HTMLTextAreaElement>(value, onCommit, { multiline: true });
  return <textarea {...props} className={className} {...draft} />;
}

/**
 * A text draft saved through one queued writer: a later edit replaces a pending
 * write instead of racing it, and outside changes replace an unedited draft.
 */
export function useQueuedDraft(value: string, onSave: (value: string) => Promise<void>) {
  const [draft, setDraftState] = useState(value), [saved, setSaved] = useState(value);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const draftRef = useRef(draft), savedRef = useRef(saved), callback = useRef(onSave), requests = useRef(0);
  draftRef.current = draft; savedRef.current = saved; callback.current = onSave;
  const writerRef = useRef<QueuedWriter<string> | null>(null);
  if (!writerRef.current) writerRef.current = createQueuedWriter(text => callback.current(text));
  const writer = writerRef.current;
  useEffect(() => {
    setDraftState(current => !writer.busy && current === saved ? value : current);
    setSaved(value);
  }, [value]);
  function setDraft(text: string) { draftRef.current = text; setDraftState(text); setError(null); }
  async function save() {
    const text = draftRef.current;
    if (!writer.busy && text === savedRef.current) return;
    requests.current++; setBusy(true); setError(null);
    try { const written = await writer.save(text); savedRef.current = written; setSaved(written); }
    catch (failure: any) { setError(String(failure?.message || failure)); }
    finally { requests.current--; setBusy(requests.current > 0); }
  }
  return { draft, setDraft, dirty: draft !== saved, busy, error, save };
}
