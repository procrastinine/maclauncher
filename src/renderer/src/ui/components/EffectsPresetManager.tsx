import React, { useEffect, useRef, useState } from "react";
import type { EffectsPreset, GameEffectsInfo, GameEffectsPlan, ReShadeState } from "../types";
import { EffectsControls } from "./EffectsControls";
import { HelpTip } from "./HelpTip";

export type EffectsPresetApi = Pick<NonNullable<Window["MacLauncher"]>["launcher"], "listEffectsPresets" | "saveEffectsPreset" | "deleteEffectsPreset" |
  "getEffectsPresetEditor" | "getEffectsPresetParameters" | "pickEffectsPresetFile">;
const emptyPlan = (): GameEffectsPlan => ({ schema: 1, mode: "advanced", video: [] });
export function EffectsPresetManager({ api: suppliedApi, status, selectedId, navigationKey }: {
  api?: Partial<EffectsPresetApi>; status?: ReShadeState; selectedId?: string; navigationKey?: number;
}) {
  const api = suppliedApi || (typeof window === "undefined" ? undefined : window.MacLauncher?.launcher);
  const [presets, setPresets] = useState<EffectsPreset[]>([]), [info, setInfo] = useState<GameEffectsInfo | null>(null);
  const [selected, setSelected] = useState<EffectsPreset | null>(null), [plan, setPlan] = useState<GameEffectsPlan>(emptyPlan);
  const [name, setName] = useState(""), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const unsaved = useRef(false);unsaved.current = dirty;
  function choose(row?: EffectsPreset) {
    setSelected(row || null);setName(row?.name || "");setPlan(row ? structuredClone(row.plan) : emptyPlan());setDirty(false);setError("");
  }
  useEffect(() => {
    let disposed = false;
    Promise.resolve(api?.listEffectsPresets?.()).then(rows => {
      if (disposed) return;
      if (!rows) throw new Error("Graphics presets are unavailable.");
      setPresets(rows);
      if (selectedId && !unsaved.current) {
        const row = rows.find(row => row.id === selectedId);
        if (row) choose(row);else setError("The selected preset was removed. Choose another preset.");
      } else if (selectedId && selectedId !== selected?.id) setError("Save or discard changes before opening another preset.");
    }).catch(error => { if (!disposed) setError(error instanceof Error ? error.message : "Presets could not be loaded."); });
    return () => { disposed = true; };
  }, [api, selectedId, navigationKey]);
  useEffect(() => {
    let disposed = false;
    Promise.resolve(api?.getEffectsPresetEditor?.()).then(catalog => {
      if (disposed) return;
      if (!catalog) throw new Error("The effects editor is unavailable.");
      setInfo(catalog);
    }).catch(error => { if (!disposed) setError(error instanceof Error ? error.message : "Effects could not be loaded."); });
    return () => { disposed = true; };
  }, [api, status]);
  async function save(copy = false) {
    if (!api?.saveEffectsPreset || !name.trim() || busy) return;
    setBusy(true);setError("");
    try {
      const saved = await api.saveEffectsPreset({ name, plan, ...(!copy && selected ? { id: selected.id, updatedAt: selected.updatedAt } : {}) });
      const rows = await api.listEffectsPresets?.();if (rows) setPresets(rows);choose(saved);
    } catch (error) { setError(error instanceof Error ? error.message : "The preset could not be saved."); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!selected || busy || !api?.deleteEffectsPreset) return;
    setBusy(true);setError("");
    try { setPresets(await api.deleteEffectsPreset(selected.id, selected.updatedAt));choose(); }
    catch (error) { setError(error instanceof Error ? error.message : "The preset could not be removed."); }
    finally { setBusy(false); }
  }
  async function reload() {
    if (busy || !api?.listEffectsPresets) return;
    setBusy(true);setError("");
    try { const rows = await api.listEffectsPresets();setPresets(rows);choose(rows.find(row => row.id === selected?.id)); }
    catch (error) { setError(error instanceof Error ? error.message : "Presets could not be loaded."); }
    finally { setBusy(false); }
  }
  return <section className="settingsSection" aria-label="Advanced graphics presets">
    <div className="settingsTitle">Advanced presets <HelpTip label="About Advanced presets">Save ordered effects for reuse. Applying a preset creates an independent copy for each game. Save or discard changes before choosing another preset.</HelpTip></div>
    <fieldset className="effectsEditor" disabled={busy}>
      <legend className="srOnly">Manage Advanced presets</legend>
      <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor="graphics-preset-selection">Preset</label>
        <select id="graphics-preset-selection" className="input" value={selected?.id || ""} disabled={dirty}
          onChange={event => choose(presets.find(row => row.id === event.target.value))}>
          <option value="">New preset</option>{presets.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
        </select>
        <button className="btn small" disabled={dirty} onClick={() => choose()}>New</button>
      </div>
      <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor="graphics-preset-name">Name</label>
        <input id="graphics-preset-name" className="input" value={name} maxLength={128} onChange={event => { setName(event.target.value);setDirty(true); }} /></div>
      <div className="detailActions">
        <button className="btn small" disabled={!name.trim() || !dirty} onClick={() => void save()}>Save</button>
        {selected && <button className="btn small" disabled={!name.trim() || name.trim() === selected.name} onClick={() => void save(true)}>Save copy</button>}
        <button className="btn small" disabled={!dirty} onClick={() => choose(selected || undefined)}>Discard</button>
        <button className="btn small" onClick={() => void reload()}>{dirty ? "Discard and reload" : "Reload"}</button>
        {selected && <button className="btn small" onClick={() => void remove()}>Delete</button>}
      </div>
      {dirty && <p className="detailMeta" role="status">Unsaved changes.</p>}
      {info && <EffectsControls key={selected?.id || "new"} game={{ gamePath: "graphics-preset-editor", runtimeId: "native", effects: plan }} status={status}
        graphicsHost="window" running={false} editor={{ info, onChange: next => { setPlan(next);setDirty(true); },
          pickFile: async kind => { if (!api?.pickEffectsPresetFile) throw new Error("Effect file selection is unavailable.");return api.pickEffectsPresetFile(kind); },
          parameters: async (nodeId, draft) => { if (!api?.getEffectsPresetParameters) throw new Error("Shader controls are unavailable.");return api.getEffectsPresetParameters(nodeId, draft); } }}>
        {null}
      </EffectsControls>}
    </fieldset>
    {error && <p className="detailMeta" role="alert">{error}</p>}
  </section>;
}
