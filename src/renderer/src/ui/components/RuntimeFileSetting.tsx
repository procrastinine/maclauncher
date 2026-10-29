import React, { useEffect, useRef, useState } from "react";
import type { RuntimeSettingField } from "../types";
import { HelpTip } from "./HelpTip";
import { ErrorText } from "./ErrorText";
import { StatusBadge } from "./StatusBadge";

type FileStatus = { status: string; reason?: string; name?: string };

// Modules validate their own files; the shared control only registers a path.
export function RuntimeFileSetting({ field, value, disabled, request, onChange }: {
  field: RuntimeSettingField; value: string; disabled: boolean;
  request: ((action: string, payload?: Record<string, unknown>) => Promise<unknown>) | null;
  onChange: (value: string) => Promise<boolean>;
}) {
  const [status, setStatus] = useState<FileStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const scope = useRef(0);
  useEffect(() => {
    const generation = ++scope.current;
    setStatus(null); setError(null); setBusy(false);
    if (request && field.fileStatusAction) void request(field.fileStatusAction, { filePath: value }).then(result => {
      if (generation === scope.current) setStatus(result as FileStatus);
    }).catch(failure => { if (generation === scope.current) setError(String(failure?.message || failure)); });
    return () => { scope.current++; };
  }, [field.fileStatusAction, value, request]);

  async function select(filePaths?: string[]) {
    if (!request || !field.pickerAction || disabled || busy) return;
    const generation = scope.current;
    setBusy(true); setError(null);
    try {
      const result = await request(field.pickerAction, filePaths ? { filePaths } : undefined) as Record<string, unknown>;
      if (generation !== scope.current) return;
      const selected = result?.[field.pickerResultKey || "filePath"];
      if (selected == null) return;
      if (typeof selected !== "string") throw new Error("The selected file path is invalid.");
      if (field.fileStatusAction) {
        const checked = await request(field.fileStatusAction, { filePath: selected });
        if (generation !== scope.current) return;
        setStatus(checked as FileStatus);
      }
      await onChange(selected);
    } catch (failure: any) { if (generation === scope.current) setError(String(failure?.message || failure)); }
    finally { if (generation === scope.current) setBusy(false); }
  }

  return <div className="settingsRow">
    <div className="settingsLabel">{field.label}{field.description && <HelpTip label={`About ${field.label}`}>{field.description}</HelpTip>}</div>
    <div className="settingsStack" role="group" aria-label={`${field.label} registration`}
      onDragOver={event => { event.preventDefault(); event.stopPropagation(); if (!disabled && !busy) { event.dataTransfer.dropEffect = "link"; setDragging(true); } }}
      onDragLeave={() => setDragging(false)}
      onDrop={event => {
        event.preventDefault(); event.stopPropagation(); setDragging(false);
        if (disabled || busy) return;
        const files = Array.from(event.dataTransfer.files);
        const paths = files.map(file => window.MacLauncher?.launcher?.getPathForFile(file)).filter((file): file is string => Boolean(file));
        if (files.length !== 1 || paths.length !== 1) { setError("Drop one local file, or use Choose file."); return; }
        void select(paths);
      }}>
      <div className="settingsControl">
        <StatusBadge tone={status?.status === "registered" ? "positive" : status?.status === "invalid" ? "warning" : "neutral"}>
          {status?.status === "registered" ? "Registered" : status?.status === "invalid" ? "Invalid" : status?.status === "missing" ? "Missing" : "Checking…"}
        </StatusBadge>
        {value && <span title={status?.name}>{status?.name || value.split(/[\\/]/).pop()}</span>}
        <button type="button" className="btn" disabled={disabled || busy || !request} onClick={() => void select()}>
          {busy ? "Choosing…" : value ? "Replace…" : "Choose file…"}
        </button>
        {value && <button type="button" className="btn" disabled={disabled || busy} onClick={() => void onChange("")}>Remove</button>}
      </div>
      <div className="dim" role="status">{dragging ? "Drop to register this file." : status?.reason}</div>
      <div className="dim">Drop {field.label} here or choose a file.</div>
      <ErrorText error={error} inline />
    </div>
  </div>;
}
