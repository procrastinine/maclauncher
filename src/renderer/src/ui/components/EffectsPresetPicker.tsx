import React, { useEffect, useRef, useState } from "react";
import type { EffectsChainTemplate, EffectsPreset, GameEffectsPlan } from "../types";
import { HelpTip } from "./HelpTip";

export function EffectsPresetPicker({ plan, templates = [], disabled, onApply }: {
  plan: GameEffectsPlan; templates?: EffectsChainTemplate[]; disabled: boolean; onApply: (plan: GameEffectsPlan) => Promise<void>;
}) {
  const [presets, setPresets] = useState<EffectsPreset[]>([]), [selected, setSelected] = useState("");
  const [saving, setSaving] = useState(false), [name, setName] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  const api = typeof window === "undefined" ? undefined : window.MacLauncher?.launcher;
  async function load() {
    try { if (api?.listEffectsPresets) setPresets(await api.listEffectsPresets()); }
    catch (error) { setError(error instanceof Error ? error.message : "Presets could not be loaded."); }
  }
  useEffect(() => {
    const refresh = () => { void load(); };
    refresh();window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  useEffect(() => { if (saving) nameInput.current?.focus(); }, [saving]);
  const preset = presets.find(row => row.id === selected);
  const template = templates.find(row => `template:${row.id}` === selected);
  const selectedPlan = preset?.plan || (template?.available ? template.plan : undefined);
  async function save() {
    if (!api || busy || !name.trim()) return;
    setBusy(true);setError("");
    try {
      const saved = await api.saveEffectsPreset({ name, plan });
      await load();setSelected(saved.id);setSaving(false);setName("");
    } catch (error) { setError(error instanceof Error ? error.message : "The preset could not be saved."); }
    finally { setBusy(false); }
  }
  async function manage() {
    try { await api?.openUtilityWindow({ view: "settings", sectionId: `graphics:presets${preset ? ":" + preset.id : ""}` }); }
    catch (error) { setError(error instanceof Error ? error.message : "Settings could not be opened."); }
  }
  return <details className="effectNodeSettings" onToggle={event => { if (event.currentTarget.open) void load(); }}>
    <summary>Presets</summary>
    <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor="effects-preset">Preset <HelpTip label="About presets">Apply replaces this chain with a copy. Changes to a saved preset do not update games.</HelpTip></label>
      <select id="effects-preset" className="input" disabled={busy || disabled} value={preset?.id || (template ? selected : "")} onChange={event => setSelected(event.target.value)}>
        <option value="">Select preset</option>
        {templates.length > 0 && <optgroup label="Templates">{templates.map(row =>
          <option key={row.id} value={`template:${row.id}`} disabled={!row.available} title={row.reason}>{row.name}{row.available ? "" : " · Unavailable"}</option>)}</optgroup>}
        {presets.length > 0 && <optgroup label="Saved presets">{presets.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</optgroup>}
      </select></div>
    <div className="detailActions">
      <button className="btn small" disabled={busy || disabled || !selectedPlan} onClick={() => selectedPlan && void onApply(structuredClone(selectedPlan))}>Apply</button>
      <button className="btn small" disabled={busy || disabled} onClick={() => setSaving(!saving)}>Save as preset…</button>
      <button className="btn small" disabled={busy} onClick={() => void manage()}>{preset ? "Edit preset…" : "Manage presets…"}</button>
    </div>
    {saving && <form className="detailRow detailControlRow" onSubmit={event => { event.preventDefault();void save(); }}>
      <label className="detailLabel" htmlFor="effects-preset-name">Name</label>
      <input ref={nameInput} id="effects-preset-name" className="input" maxLength={128} value={name} disabled={busy}
        onChange={event => setName(event.target.value)} />
      <button className="btn small" disabled={busy || !name.trim()}>Save</button>
    </form>}
    {templates.filter(row => !row.available && row.reason).map(row => <p className="detailMeta" key={row.id}>{row.name}: {row.reason}</p>)}
    {error && <p className="detailMeta" role="alert">{error}</p>}
  </details>;
}
