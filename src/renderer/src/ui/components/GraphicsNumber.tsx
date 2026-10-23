import React, { useEffect, useState } from "react";
export function GraphicsNumber({ value, onValue, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: number; onValue: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <input {...props} type="number" value={draft} onChange={event => {
    const text = event.target.value;setDraft(text);
    if (text !== "" && event.target.validity.valid && Number.isFinite(Number(text))) onValue(Number(text));
  }} onBlur={() => setDraft(String(value))} />;
}
