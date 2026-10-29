import React, { useEffect, useRef, useState } from "react";
import { CommitNumberInput } from "./CommitInput";

const bound = (value?: number | string) => value === undefined || value === "" ? undefined : Number(value);
/**
 * A graphics number commits one edit on Enter or blur, clamped to its bounds.
 * Escape, an empty field or text that does not parse restores the saved value.
 */
export function GraphicsNumber({ value, onValue, min, max, step, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & {
  value: number; onValue: (value: number) => void;
}) {
  return <CommitNumberInput {...props} step={step} value={value} min={bound(min)} max={bound(max)} integer={Number(step) === 1}
    onCommit={next => onValue(next)} />;
}
/** Range drafts move freely; a pause, release or blur commits one graphics edit. */
export function GraphicsRange({ value, onValue, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & {
  value: number; onValue: (value: number) => void;
}) {
  const [draft, setDraft] = useState(value), callback = useRef(onValue);callback.current = onValue;
  const pending = useRef<number | null>(null), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {if (pending.current === null) setDraft(value);}, [value]);
  const flush = () => {
    clearTimeout(timer.current);const next = pending.current;pending.current = null;
    if (next !== null) callback.current(next);
  };
  useEffect(() => flush, []);
  return <input {...props} type="range" value={draft} onChange={event => {
    const next = Number(event.target.value);setDraft(next);pending.current = next;
    clearTimeout(timer.current);timer.current = setTimeout(flush, 150);
  }} onPointerUp={flush} onKeyUp={flush} onBlur={flush} />;
}
