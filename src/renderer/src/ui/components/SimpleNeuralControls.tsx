import React, { useRef, useState } from "react";
import type { GameGraphicsSettings, RecentGame, ReShadeState } from "../types";
import { HelpTip } from "./HelpTip";

export function SimpleNeuralControls({ game, status, available, nativeVideo, running, live, defaultFrameGeneration = false, frameSelectionRevision = 0, onChange, onBusyChange }: {
  game: Pick<RecentGame, "gamePath" | "graphics">; status?: ReShadeState; available: boolean; nativeVideo: boolean; running: boolean;
  live?: boolean;
  defaultFrameGeneration?: boolean;
  frameSelectionRevision?: number;
  onChange: (path: string, patch: Partial<GameGraphicsSettings>) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}) {
  type Patch = Partial<GameGraphicsSettings>;
  const [, refresh] = useState(0);
  const writes = useRef({observed: game.graphics, saved: game.graphics || {} as Patch, queued: null as Patch | null,
    active: null as Patch | null, task: null as Promise<void> | null, onChange});
  const state = writes.current;state.onChange = onChange;
  if (state.observed !== game.graphics) {state.observed = game.graphics;state.saved = game.graphics || {};}
  const setup = useRef({ revision: 0, patch: null as Patch | null,
    enabledBefore: game.graphics?.neuralMethod === "mlx-dlss" || Boolean(game.graphics?.neuralModelPath) });
  const frameChoice = useRef(frameSelectionRevision);frameChoice.current = frameSelectionRevision;
  const value = {...state.saved, ...setup.current.patch, ...state.active, ...state.queued};
  const enabled = value.neuralMethod === "mlx-dlss", path = value.neuralModelPath || "";
  const models = status?.neuralModels || [];
  const inputScale = value.neuralInputScale === undefined ? (nativeVideo ? 1 : null) : value.neuralInputScale;
  const pending = useRef(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  if (!available && !enabled) return null;
  function working(value: boolean) {setBusy(value);onBusyChange?.(value);}
  function drain(): Promise<void> {
    if (!state.task) state.task = (async () => {
      while (state.queued) {
        const next = state.queued;state.queued = null;state.active = next;
        try {await state.onChange(game.gamePath, next);state.saved = {...state.saved, ...next};}
        catch (error) {setError(error instanceof Error ? error.message : "Neural rendering could not be updated.");}
        finally {state.active = null;refresh(value => value + 1);}
      }
    })().finally(() => {state.task = null;if (state.queued) return drain();});
    return state.task;
  }
  function change(patch: Patch) {
    state.queued = {...state.queued, ...patch};setError("");refresh(value => value + 1);
    return drain();
  }
  async function pick() {
    if (pending.current) return;
    pending.current = true;working(true);setError("");
    try {
      if (state.task) await state.task;
      const api = window.MacLauncher?.launcher;if (!api) throw new Error("Model selection is unavailable.");
      const selected = await api.pickGameEffectFile(game.gamePath, "neural-model");
      if (selected) await onChange(game.gamePath, { neuralModelPath: selected });
    } catch (error) { setError(error instanceof Error ? error.message : "Model selection is unavailable."); }
    finally { pending.current = false;working(false); }
  }
  async function toggle(next: boolean) {
    if (!next) {
      setup.current.revision++;setup.current.patch = null;pending.current = false;working(false);
      state.saved = {...state.saved, neuralMethod: "off"};refresh(value => value + 1);
      // Off must reach the backend immediately, including while an older
      // parameter publication or model preparation is still pending.
      try {await state.onChange(game.gamePath, {neuralMethod: "off"});}
      catch (error) {setError(error instanceof Error ? error.message : "Neural rendering could not be disabled.");}
      return;
    }
    const initialFrames = {frameGeneration: state.saved.frameGeneration, frameMultiplier: state.saved.frameMultiplier};
    const initialFrameRevision = frameChoice.current;
    const patch: Patch = { neuralMethod: "mlx-dlss", neuralInputScale: inputScale, neuralInputHeight: null,
      ...(!setup.current.enabledBefore && defaultFrameGeneration ? {frameGeneration: "lsfg", frameMultiplier: 4} : {}) };
    if (pending.current) return;
    const revision = ++setup.current.revision;
    setup.current.patch = patch;refresh(value => value + 1);
    pending.current = true;working(true);setError("");
    try {
      if (state.task) await state.task;
      if (revision !== setup.current.revision) return;
      const api = window.MacLauncher?.launcher;
      if (!api?.ensureGameGraphicsModel) throw new Error("Automatic model setup is unavailable.");
      const prepared = await api.ensureGameGraphicsModel(game.gamePath, "neural", patch);
      if (revision !== setup.current.revision) return;
      if (!prepared) return;
      if (!prepared.modelPath) throw new Error("A compatible neural model is required.");
      // An independent frame-generation choice made during setup takes priority
      // over the first-enable suggestion.
      if (frameChoice.current !== initialFrameRevision || state.saved.frameGeneration !== initialFrames.frameGeneration || state.saved.frameMultiplier !== initialFrames.frameMultiplier) {
        delete patch.frameGeneration;delete patch.frameMultiplier;
      }
      await state.onChange(game.gamePath, { ...patch, neuralModelPath: prepared.modelPath });
      if (revision === setup.current.revision) {
        state.saved = {...state.saved, ...patch, neuralModelPath: prepared.modelPath};
        setup.current.enabledBefore = true;
      }
    } catch (error) {
      if (revision === setup.current.revision) setError(error instanceof Error ? error.message : "The neural model could not be prepared.");
    }
    finally {
      if (revision === setup.current.revision) {setup.current.patch = null;pending.current = false;working(false);refresh(value => value + 1);}
    }
  }
  async function manage() {
    try { await window.MacLauncher?.launcher.openUtilityWindow({ view: "runtimes", managerId: "graphics-neural-models" }); }
    catch (error) { setError(error instanceof Error ? error.message : "Model management is unavailable."); }
  }
  return <section className="graphicsGroup" aria-label="Simple neural reconstruction">
    <div className="graphicsGroupHeader"><div className="graphicsGroupTitle"><h4 className="detailSectionHeading">Neural reconstruction</h4>
        <HelpTip label="About Simple neural reconstruction">Uses MLX-DLSS on Apple Silicon with a compatible model, including model packages imported from DLSSMac. Reconstructs completed color frames, then uses the independent upscaler to fit the result. Game processing adapts to the window; video starts at its decoded size. Frame generation and shaders remain separate choices.
          <p>Auto uses the current physical output size to select a reduction from 1× to 4×, aiming near 540 pixels on the shorter edge. Existing saved scales remain explicit. Reducing a completed image lowers neural processing work; it does not reduce the work used to render that image. Advanced exposes each size and processing step separately.</p>
          {running && <p>{live ? "Supported processing changes can update during play. Provider and model bindings may require a restart." : "Changes apply on the next launch."}</p>}</HelpTip></div></div>
    <fieldset className="effectsEditor" aria-label="Neural reconstruction settings" disabled={false} aria-busy={busy}>
      <label className="inlineCheck"><input type="checkbox" checked={enabled} disabled={!available && !enabled}
        onChange={event => void toggle(event.target.checked)} />DLSS 5 · Experimental</label>
      {enabled && <>
        <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor="simple-neural-model">Model</label>
          <select id="simple-neural-model" className="input" value={path} onChange={event => void change({ neuralModelPath: event.target.value || null })}>
            <option value="" disabled>Select model</option>
            {path && !models.some(model => model.modelPath === path) && <option value={path}>Local model</option>}
            {models.map(model => <option key={model.version} value={model.modelPath}>{model.versionLabel || model.version}</option>)}
          </select></div>
        {!nativeVideo && inputScale !== null && <button className="btn small" onClick={() => void change({ neuralInputScale: null, neuralInputHeight: null })}>Use Auto</button>}
        <details className="effectNodeSettings"><summary>Options</summary>
          <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor="simple-neural-intensity">Intensity <HelpTip label="About neural intensity">Ranges from 0 to 1. The default, 1, uses full model output; lower values blend the reconstruction with the input.</HelpTip></label>
            <input id="simple-neural-intensity" type="range" min="0" max="1" step="0.05" value={value.neuralIntensity ?? 1}
              onChange={event => void change({ neuralIntensity: Number(event.target.value) })} /></div>
          <label className="inlineCheck"><input type="checkbox" checked={value.neuralTemporal === true}
            onChange={event => void change({ neuralTemporal: event.target.checked })} />Temporal reconstruction
            <HelpTip label="About neural motion estimation">Estimates motion between captured frames and retains reconstruction history. Uses additional GPU time.</HelpTip></label>
        </details>
        <div className="detailActions"><button className="btn small" onClick={() => void pick()}>Choose model…</button><button className="btn small" onClick={() => void manage()}>Manage models…</button></div>
      </>}
      {!available && <p className="detailMeta" role="status">Requires a compatible Apple Silicon graphics renderer and the neural rendering provider.</p>}
      {busy && <p className="detailMeta" role="status">Preparing neural reconstruction…</p>}
    </fieldset>
    {error && <p className="detailMeta" role="alert">{error}</p>}
  </section>;
}
