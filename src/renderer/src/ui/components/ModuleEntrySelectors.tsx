import { Select } from "./Select";
import React, { useEffect, useId, useRef, useState } from "react";
import type { ModuleEntrySelector, RecentGame } from "../types";
import { matchesAnyCondition } from "../ui-helpers";
import { RefreshIcon } from "../icons";
import { HelpTip } from "./HelpTip";
import { ErrorText } from "./ErrorText";

type Selection = {
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  value: string;
  description?: string;
};

function selectionResult(value: any): Selection {
  if (!value || typeof value.value !== "string" || !Array.isArray(value.options) ||
      value.options.some((option: any) => !option || typeof option.value !== "string" || typeof option.label !== "string"))
    throw new Error("The available choices could not be read.");
  return value;
}

export function ModuleEntrySelectorControl({ gamePath, field, visible, running, preparing }: {
  gamePath: string;
  field: ModuleEntrySelector;
  visible: boolean;
  running: boolean;
  preparing: boolean;
}) {
  const id = useId();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const request = ++generation.current;
    if (!visible || running || preparing) return;
    setBusy(true);setError(null);
    const api = window.MacLauncher?.launcher;
    Promise.resolve().then(() => {
      if (!api) throw new Error("Entry selection is unavailable in this window.");
      return api.moduleAction(gamePath, field.optionsAction, {});
    }).then(value => {
      if (request === generation.current) setSelection(selectionResult(value));
    }).catch(error => {
      if (request === generation.current) setError(String(error?.message || error));
    }).finally(() => {
      if (request === generation.current) setBusy(false);
    });
    return () => { generation.current++; };
  }, [gamePath, field.optionsAction, field.setAction, visible, running, preparing, refresh]);

  async function select(value: string) {
    if (busy || running || preparing || !selection?.options.some(option => option.value === value && !option.disabled)) return;
    const request = ++generation.current;
    setBusy(true);setError(null);
    try {
      const api = window.MacLauncher?.launcher;
      if (!api) throw new Error("Entry selection is unavailable in this window.");
      const result = selectionResult(await api.moduleAction(gamePath, field.setAction, { value }));
      if (request === generation.current) setSelection(result);
    } catch (error: any) {
      if (request === generation.current) setError(String(error?.message || error));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }

  const description = selection?.description || field.description;
  const selectedAvailable = selection?.options.some(option => option.value === selection.value);
  return <>
    <div className="detailRow">
      <label className="detailLabel" htmlFor={id}>{field.label}{description && <> <HelpTip label={`About ${field.label.toLowerCase()}`}>{description}</HelpTip></>}</label>
      <div className="detailValue">
        <Select id={id} className="input" style={{ width: "100%", maxWidth: "100%" }} aria-label={field.label} aria-busy={busy || undefined}
          value={selection?.value || ""} disabled={!visible || busy || running || preparing || !selection?.options.length}
          onChange={event => { void select(event.target.value); }}>
          {!selectedAvailable && <option value={selection?.value || ""} disabled>{selection ? "Saved selection unavailable" : busy ? "Loading…" : "No choices available"}</option>}
          {selection?.options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
        </Select>
      </div>
      <div className="detailActions">
        <button type="button" className="btn small iconOnly" title={`Refresh ${field.label.toLowerCase()} choices`} aria-label={`Refresh ${field.label.toLowerCase()} choices`}
          disabled={!visible || busy || running || preparing} onClick={() => setRefresh(value => value + 1)}><RefreshIcon /></button>
      </div>
    </div>
    <ErrorText error={error} inline />
  </>;
}

export function ModuleEntrySelectors({ game, fields, visible, running, preparing }: {
  game: RecentGame;
  fields?: ModuleEntrySelector[];
  visible: boolean;
  running: boolean;
  preparing: boolean;
}) {
  return <>{fields?.filter(field => !matchesAnyCondition(game, field.hiddenWhen)).map(field =>
    <ModuleEntrySelectorControl key={`${game.gamePath}:${field.id}`} gamePath={game.gamePath} field={field}
      visible={visible} running={running} preparing={preparing} />)}</>;
}
