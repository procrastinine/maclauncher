import React, { useEffect, useRef, useState } from "react";
import type { EffectsPreset, GameEffectsInfo, GameEffectsPlan, GraphicsNotice, ReShadeState } from "../types";
import { EffectsControls } from "./EffectsControls";
import { HelpTip } from "./HelpTip";
import { ErrorText } from "./ErrorText";
import { confirmAction } from "../confirm-action";
import {effectSelectionKey} from "../../../../modules/shared/effects/selection-key.mjs";
import {NEURAL} from "../../../../modules/shared/effects/operation-contracts.mjs";

export type EffectsPresetApi = Pick<NonNullable<Window["MacLauncher"]>["launcher"], "listEffectsPresets" | "getEffectsPresetNotices" | "onEffectsPresetsChanged" | "saveEffectsPreset" | "deleteEffectsPreset" |
  "getEffectsPresetEditor" | "getEffectsPresetParameters" | "pickEffectsPresetFile">;
const emptyPlan = (): GameEffectsPlan => ({ schema: 2, mode: "advanced", enabled: true, video: [] });
export function EffectsPresetManager({ api: suppliedApi, status, selectedId, navigationKey }: {
  api?: Partial<EffectsPresetApi>; status?: ReShadeState; selectedId?: string; navigationKey?: number;
}) {
  const api = suppliedApi || (typeof window === "undefined" ? undefined : window.MacLauncher?.launcher);
  const [presets, setPresets] = useState<EffectsPreset[]>([]), [info, setInfo] = useState<GameEffectsInfo | null>(null);
  const [selected, setSelected] = useState<EffectsPreset | null>(null), [plan, setPlan] = useState<GameEffectsPlan>(emptyPlan);
  const [name, setName] = useState(""), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [libraryNotices, setLibraryNotices] = useState<GraphicsNotice[]>([]);
  const unsaved = useRef(false);unsaved.current = dirty;
  const currentSelection = useRef(selected);currentSelection.current = selected;
  const rowsRequest = useRef(0), latestRows = useRef<EffectsPreset[]>([]);
  const catalogKey = JSON.stringify([status?.version, status?.available, status?.presets, status?.models, status?.neuralModels, status?.graphics,
    status?.defaultNeuralModelVersion, status?.defaultNeuralModelVersions]);
  const nodeMetadataKey = JSON.stringify(plan.video.filter(node => node.kind === "shader" ? node.shader.preset === "custom" || Object.hasOwn(node.settings || {},"modelPath") : Boolean(NEURAL[node.method])).map(node => [node.id,effectSelectionKey(node)]));
  function choose(row?: EffectsPreset) {
    unsaved.current = false;currentSelection.current = row || null;
    setSelected(row || null);setName(row?.name || "");setPlan(row ? structuredClone(row.plan) : emptyPlan());setDirty(false);setError("");
  }
  // Presets that cannot be read are kept in the library file and reported here.
  function receiveRows(rows: EffectsPreset[]) {
    latestRows.current = rows;setPresets(rows);
    api?.getEffectsPresetNotices?.().then(notices => setLibraryNotices(Array.isArray(notices) ? notices : []), () => setLibraryNotices([]));
  }
  async function readRows() {
    const token = ++rowsRequest.current, rows = await api?.listEffectsPresets?.();
    if (!rows) throw new Error("Graphics presets are unavailable.");
    if (token === rowsRequest.current) receiveRows(rows);
    return latestRows.current;
  }
  useEffect(() => {
    let disposed = false;
    readRows().then(rows => {
      if (disposed) return;
      if (selectedId && !unsaved.current) {
        const row = rows.find(row => row.id === selectedId);
        if (row) choose(row);else setError("The selected preset was removed. Choose another preset.");
      } else if (selectedId && selectedId !== selected?.id) setError("Save or discard changes before opening another preset.");
    }).catch(error => { if (!disposed) setError(error instanceof Error ? error.message : "Presets could not be loaded."); });
    return () => { disposed = true;rowsRequest.current++; };
  }, [api, selectedId, navigationKey]);
  useEffect(() => api?.onEffectsPresetsChanged?.(rows => {
    rowsRequest.current++;receiveRows(rows);
    if (!unsaved.current && currentSelection.current) {
      const updated = rows.find(row => row.id === currentSelection.current?.id);
      choose(updated);
      if (!updated) setError("The selected preset was removed.");
    }
  }), [api]);
  // The draft editor waits for the graphics catalog its view requested.
  const awaitingCatalog = !status && !suppliedApi && typeof window !== "undefined" && Boolean(window.MacLauncher?.launcher?.requestGraphicsCatalog);
  useEffect(() => {
    if (awaitingCatalog) return;
    let disposed = false;
    Promise.resolve(api?.getEffectsPresetEditor?.(plan)).then(catalog => {
      if (disposed) return;
      if (!catalog) throw new Error("The effects editor is unavailable.");
      setInfo(catalog);
    }).catch(error => { if (!disposed) setError(error instanceof Error ? error.message : "Effects could not be loaded."); });
    return () => { disposed = true; };
  }, [api, catalogKey, nodeMetadataKey, awaitingCatalog]);
  async function save(copy = false) {
    if (!api?.saveEffectsPreset || !name.trim() || busy) return;
    setBusy(true);setError("");
    try {
      const saved = await api.saveEffectsPreset({ name, plan, ...(!copy && selected ? { id: selected.id, updatedAt: selected.updatedAt } : {}) });
      const rows = await readRows(), current = rows.find(row => row.id === saved.id);
      choose(current && current.updatedAt >= saved.updatedAt ? current : saved);
    } catch (error) { setError(error instanceof Error ? error.message : "The preset could not be saved."); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!selected || busy || !api?.deleteEffectsPreset) return;
    if (!await confirmAction({ message: `Delete the preset “${selected.name}”?`, detail: "Games that applied it keep their own copies.",
      confirmLabel: "Delete", destructive: true })) return;
    setBusy(true);setError("");
    try { const token = ++rowsRequest.current, rows = await api.deleteEffectsPreset(selected.id, selected.updatedAt);if (token === rowsRequest.current) receiveRows(rows);choose(); }
    catch (error) { setError(error instanceof Error ? error.message : "The preset could not be removed."); }
    finally { setBusy(false); }
  }
  async function reload() {
    if (busy || !api?.listEffectsPresets) return;
    setBusy(true);setError("");
    try { const rows = await readRows();choose(rows.find(row => row.id === selected?.id)); }
    catch (error) { setError(error instanceof Error ? error.message : "Presets could not be loaded."); }
    finally { setBusy(false); }
  }
  return <section className="settingsSection" aria-label="Graphics presets">
    <div className="settingsTitle">Presets <HelpTip label="About graphics presets">Save ordered effects for reuse. Applying a preset creates an independent copy for each game. Save or discard changes before choosing another preset.</HelpTip></div>
    <fieldset className="effectsEditor" disabled={busy}>
      <legend className="srOnly">Manage graphics presets</legend>
      <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor="graphics-preset-selection">Preset</label>
        <select id="graphics-preset-selection" className="input" value={selected?.id || ""} disabled={dirty}
          onChange={event => choose(presets.find(row => row.id === event.target.value))}>
          <option value="">New preset</option>{presets.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
        </select>
        <button className="btn small" disabled={dirty} onClick={() => choose()}>New</button>
      </div>
      <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor="graphics-preset-name">Name</label>
        <input id="graphics-preset-name" className="input" value={name} maxLength={128} onChange={event => { unsaved.current = true;setName(event.target.value);setDirty(true); }} /></div>
      <div className="detailActions">
        <button className="btn small" disabled={!name.trim() || !dirty} onClick={() => void save()}>Save</button>
        {selected && <button className="btn small" disabled={!name.trim() || name.trim() === selected.name} onClick={() => void save(true)}>Save copy</button>}
        <button className="btn small" disabled={!dirty} onClick={() => choose(selected || undefined)}>Discard</button>
        <button className="btn small" onClick={() => void reload()}>{dirty ? "Discard and reload" : "Reload"}</button>
        {selected && <button className="btn small danger" onClick={() => void remove()}>Delete…</button>}
      </div>
      {dirty && <p className="detailMeta" role="status">Unsaved changes.</p>}
      {info && <EffectsControls key={selected?.id || "new"} game={{ gamePath: "graphics-preset-editor", runtimeId: "native", effects: plan }} status={status}
        graphicsHost="window" running={false} editor={{ info, onChange: next => { unsaved.current = true;setPlan(next);setDirty(true); },
          pickFile: async (kind,expectedOperation) => { if (!api?.pickEffectsPresetFile) throw new Error("Effect file selection is unavailable.");return api.pickEffectsPresetFile(kind,expectedOperation); },
          parameters: async (nodeId, draft) => { if (!api?.getEffectsPresetParameters) throw new Error("Shader controls are unavailable.");return api.getEffectsPresetParameters(nodeId, draft); } }}>
        {null}
      </EffectsControls>}
    </fieldset>
    {[...libraryNotices, ...(selected?.notices || [])].map((notice, index) => <p key={index} className="detailMeta" role="status">{notice.message}</p>)}
    <ErrorText error={error} inline />
  </section>;
}
