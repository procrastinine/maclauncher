import React, { useEffect, useId, useRef, useState } from "react";
import type { EffectsChainTemplate, EffectsPreset, GameEffectsPlan } from "../types";
import { withAvailability } from "../ui-helpers";
import { ErrorText } from "./ErrorText";

const launcherApi = () => typeof window === "undefined" ? undefined : window.MacLauncher?.launcher;

// Saved presets follow change broadcasts; a list that arrives after a newer
// broadcast is ignored.
function useSavedPresets() {
  const [presets, setPresets] = useState<EffectsPreset[]>([]), [error, setError] = useState("");
  useEffect(() => {
    const api = launcherApi();
    let active = true, request = 0;
    const unsubscribe = api?.onEffectsPresetsChanged?.(rows => { request++; setPresets(rows); setError(""); });
    const token = ++request;
    api?.listEffectsPresets?.().then(rows => { if (active && token === request) setPresets(rows); },
      failure => { if (active && token === request) setError(failure instanceof Error ? failure.message : "Presets could not be loaded."); });
    return () => { active = false; unsubscribe?.(); };
  }, []);
  return { presets, error };
}

/**
 * Preset entries for a graphics menu. Applying copies a chain into the game, so
 * no preset stays selected; later edits never change the preset.
 */
export function EffectsPresetMenuItems({ templates = [], disabled, onApply, onSave }: {
  templates?: EffectsChainTemplate[]; disabled: boolean;
  onApply: (plan: GameEffectsPlan) => void; onSave: () => void;
}) {
  const { presets, error: loadError } = useSavedPresets();
  const [error, setError] = useState(""), labelId = useId();
  async function manage() {
    setError("");
    try { await launcherApi()?.openUtilityWindow({ view: "runtimes", managerId: "graphics-presets" }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Runtimes could not be opened."); }
  }
  return <>
    {(templates.length > 0 || presets.length > 0) && <div className="menuGroup" role="group" aria-labelledby={labelId}>
      <div className="menuGroupLabel" id={labelId}>Apply preset</div>
      {templates.map(row => <button key={`template:${row.id}`} type="button" className="btn small" disabled={disabled || !row.available}
        onClick={() => onApply(structuredClone(row.plan))}>
        {row.available ? row.name : withAvailability(row.name, "unavailable")}
        {!row.available && row.reason && <span className="menuItemDetail">{row.reason}</span>}
      </button>)}
      {presets.map(row => <button key={row.id} type="button" className="btn small" disabled={disabled}
        onClick={() => onApply(structuredClone(row.plan))}>{row.name}</button>)}
    </div>}
    <hr className="menuSeparator" />
    <button type="button" className="btn small" disabled={disabled} onClick={onSave}>Save as preset…</button>
    <button type="button" className="btn small" onClick={() => void manage()}>Manage presets…</button>
    <ErrorText error={error || loadError} inline />
  </>;
}

/** Names the current chain as a new preset. Escape or Cancel closes it. */
export function EffectsPresetSaveForm({ plan, onClose }: { plan: GameEffectsPlan; onClose: () => void }) {
  const [name, setName] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  async function save() {
    const api = launcherApi();
    if (!api?.saveEffectsPreset || busy || !name.trim()) return;
    setBusy(true); setError("");
    try { await api.saveEffectsPreset({ name, plan }); onClose(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The preset could not be saved."); setBusy(false); }
  }
  return <form className="effectsPresetSave" aria-label="Save as preset" onSubmit={event => { event.preventDefault(); void save(); }}
    onKeyDown={event => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault(); event.stopPropagation(); onClose();
    }}>
    <div className="detailRow detailControlRow">
      <label className="detailLabel" htmlFor="effects-preset-name">Preset name</label>
      <div className="detailActions">
        <input ref={input} id="effects-preset-name" className="input" maxLength={128} value={name} disabled={busy}
          onChange={event => setName(event.target.value)} />
        <button type="submit" className="btn small primary" disabled={busy || !name.trim()}>{busy ? "Saving…" : "Save"}</button>
        <button type="button" className="btn small" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </div>
    <ErrorText error={error} inline />
  </form>;
}
