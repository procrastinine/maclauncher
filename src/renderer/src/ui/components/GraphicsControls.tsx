import React, { useRef, useState } from "react";
import type { GameGraphicsSettings, GameReShadeSettings, GraphicsInputs, RecentGame, ReShadeState, RuntimeEntry } from "../types";
import { GraphicsNumber } from "./GraphicsNumber";
import { HelpTip } from "./HelpTip";
import { SimpleNeuralControls } from "./SimpleNeuralControls";
import { SimpleRenderResolution } from "./SimpleRenderResolution";
import { spatialMethodLabel } from "../spatial-options";
import { ShaderParameters } from "./ShaderParameters";
import { scalingShader, shaderBehaviorGroup } from "../shader-format";

const labels: Record<string, string> = { off: "Off", nearest: "Nearest neighbor", bicubic: "Bicubic", bilinear: "Bilinear", metalfx: "MetalFX Spatial", fsr1: "FSR 1 · Spatial", mako: "Sharpened cubic", ls1: "LS1" };
const temporalLabels: Record<string, string> = { off: "Game default", metalfx: "MetalFX Temporal", fsr2: "FSR 2.2", fsr3: "FSR 3.1", fsr4: "FSR 4.1" };
const scalerGroups = [
  { label: "Apple MetalFX", methods: ["metalfx"] },
  { label: "AMD FidelityFX", methods: ["fsr1", "fsr2", "fsr3", "fsr4"] },
  { label: "Lossless Scaling", methods: ["ls1"] },
  { label: "Standard", methods: ["nearest", "bilinear", "bicubic", "mako"] }
];
function requiredModels(value: Partial<GameGraphicsSettings>) {
  return [value.spatialMethod === "ls1" ? value.ls1Mode === "performance" ? "ls1Performance" : "ls1Quality" : null,
    value.frameGeneration === "lsfg" ? "lsfg" + (value.lsfgFp16 === false ? "Fp32" : "Fp16") + (value.lsfgMode === "performance" ? "Performance" : "Quality") : null]
    .filter((capability): capability is string => capability !== null);
}
function mergeGraphics(base: Partial<GameGraphicsSettings>, patch: Partial<GameGraphicsSettings>) {
  const next = {...base, ...patch};
  if (patch.spatialMethod !== undefined && (patch.spatialMethod !== "off" || !patch.spatialShader)) next.spatialShader = null;
  else if (patch.spatialShader) next.spatialMethod = "off";
  return next;
}
function scalingOptions(methods: string[], names: Record<string, string>, selected?: string) {
  return scalerGroups.map(group => {
    const available = group.methods.filter(method => methods.includes(method));
    return available.length ? <optgroup key={group.label} label={group.label}>
      {available.map(method => <option key={method} value={method}>{spatialMethodLabel(method, names)}</option>)}
    </optgroup> : null;
  }).concat(selected?.startsWith("libplacebo:") && methods.includes(selected) ? [
    <optgroup key="selected-filter" label="Selected filter"><option value={selected}>{spatialMethodLabel(selected, names)}</option></optgroup>
  ] : []);
}
export function GraphicsControls({ game, status, graphicsHost, graphicsArchitecture, graphicsInputs, running, live, onChange, onManageModels }: {
  game: Pick<RecentGame, "gamePath" | "graphics" | "reshade" | "runtimeId">; status?: ReShadeState; running: boolean;
  live?: boolean;
  graphicsHost?: RuntimeEntry["graphicsHost"];
  graphicsArchitecture?: RuntimeEntry["graphicsArchitecture"];
  graphicsInputs?: GraphicsInputs;
  onManageModels?: () => void;
  onChange: (gamePath: string, patch: Partial<GameGraphicsSettings>, expectedSpatialShader?: Pick<GameReShadeSettings, "preset" | "effectPath" | "effects">) => Promise<void>;
}) {
  const [, refresh] = useState(0);
  const updates = useRef({observed: game.graphics, optimistic: {} as Partial<GameGraphicsSettings>});
  if (updates.current.observed !== game.graphics) {
    updates.current.observed = game.graphics;
    for (const key of Object.keys(updates.current.optimistic) as Array<keyof GameGraphicsSettings>)
      if (JSON.stringify(game.graphics?.[key]) === JSON.stringify(updates.current.optimistic[key])) delete updates.current.optimistic[key];
  }
  const value = {...game.graphics, ...updates.current.optimistic} as GameGraphicsSettings;
  const spatialShader = value.spatialShader;
  const spatial = spatialShader ? `shader:${spatialShader.preset}` : value.spatialMethod || "off", temporal = value.temporalMethod || "off", generation = value.frameGeneration || "off";
  const queued = useRef<Partial<GameGraphicsSettings> | null>(null), activeModel = useRef<Partial<GameGraphicsSettings> | null>(null);
  const frameSelectionRevision = useRef(0);
  const pending = useRef(false), [busy, setBusy] = useState(false), [neuralBusy, setNeuralBusy] = useState(false), [error, setError] = useState("");
  const support = status?.graphics?.hosts
    ? graphicsHost ? status.graphics.hosts[graphicsHost] : undefined : status?.graphics;
  const spatialMethods = [...new Set([...(support?.spatial ? support.spatialMethods : [])
    .filter(method => !graphicsInputs?.nativeSpatialMethods || !method.startsWith("libplacebo:")), ...(graphicsInputs?.nativeSpatialMethods || [])])];
  const temporalMethods = (support?.temporal ? [...new Set([...(support.temporalMethods || []),
    ...(graphicsInputs?.cameraProjection === true ? (support.cameraTemporalMethods || [])
      .filter(method => graphicsInputs.methods?.includes(method)) : [])])] : [])
    .filter(method => !Array.isArray(graphicsInputs?.methods) || graphicsInputs.methods.includes(method));
  const generationAvailable = support?.frameGeneration && support.frameGenerationMethods.includes("lsfg");
  const neuralAvailable = status?.neuralAvailable === true && ["window", "remote", "explicit", "catalyst"].includes(graphicsHost || "") && (graphicsInputs?.architecture || graphicsArchitecture) !== "x86_64";
  const frameMultiplier = value?.frameMultiplier ?? 2;
  const sourceResolution = graphicsInputs?.sourceResolution;
  const resolutionMultipliers = sourceResolution ? sourceResolution.multipliers
    : sourceResolution !== false && (graphicsHost === "explicit" || graphicsHost === "window" && Boolean(support?.virtualWindow) && !graphicsInputs?.nativeVideo)
      ? support?.resolutionMultipliers || [] : [];
  const processingResolution = support?.spatial === true && support.spatialMethods.includes("bilinear") &&
    (Boolean(spatialShader) || spatial === "off" || support.spatialMethods.includes(spatial)) && temporal === "off" && graphicsInputs?.nativeVideo !== true;
  const spatialShadersAvailable = Boolean(status?.available && (support?.spatial || graphicsInputs?.nativeSpatialMethods?.length));
  const spatialPresets = (status?.presets || []).filter(item => scalingShader(item.traits) &&
    (graphicsInputs?.nativeVideo === true || !item.nativeVideo && !item.traits?.requiresVideoPlanes));
  const spatialShaderGroups = [...new Set(spatialPresets.map(item => shaderBehaviorGroup(item.traits)))];
  if (!spatialShadersAvailable && !spatialShader && !spatialMethods.length && !temporalMethods.length && !generationAvailable && !neuralAvailable && game.graphics?.neuralMethod !== "mlx-dlss" && !game.reshade?.enabled && spatial === "off" && temporal === "off" && generation === "off") return null;
  function preview(patch: Partial<GameGraphicsSettings>) {
    updates.current.optimistic = mergeGraphics(updates.current.optimistic, patch);refresh(value => value + 1);
  }
  async function change(patch: Partial<GameGraphicsSettings>, expected?: Pick<GameReShadeSettings, "preset" | "effectPath" | "effects">, propagate = false) {
    if (pending.current && activeModel.current) queued.current = mergeGraphics({...activeModel.current, ...queued.current}, patch);
    preview(patch);
    try {setError("");await onChange(game.gamePath, patch, ...(expected === undefined ? [] : [expected]));}
    catch (error) {
      const applied = mergeGraphics({}, patch);
      for (const key of Object.keys(applied) as Array<keyof GameGraphicsSettings>)
        if (JSON.stringify(updates.current.optimistic[key]) === JSON.stringify(applied[key])) delete updates.current.optimistic[key];
      refresh(value => value + 1);setError(error instanceof Error ? error.message : "Graphics settings could not be updated.");
      if (propagate) throw error;
    }
  }
  async function chooseSpatialShader() {
    try {
      const file = await window.MacLauncher?.launcher.pickGameEffectFile(game.gamePath);
      if (file) await change({spatialShader: {enabled: true, preset: "custom", effectPath: file, parameters: null}});
    } catch (error) {setError(error instanceof Error ? error.message : "The shader could not be selected.");}
  }
  const modelNeeded = spatial === "ls1" || generation === "lsfg";
  const models = status?.models || [];
  const required = requiredModels(value || {});
  const matchesModels = (model: typeof models[number]) => required.every(capability => model.capabilities.includes(capability));
  const automaticModel = models.find(model => model.version === status?.defaultModelVersion && matchesModels(model)) || models.find(matchesModels);
  const selectedModel = value?.modelVersion ? models.find(model => model.version === value.modelVersion) : automaticModel;
  const compatibleModel = selectedModel && required.every(capability => selectedModel.capabilities.includes(capability!));
  async function selectModelGraphics(patch: Partial<GameGraphicsSettings>, propagate = false) {
    if (patch.frameGeneration !== undefined || patch.frameMultiplier !== undefined) frameSelectionRevision.current++;
    const next = mergeGraphics({...game.graphics, ...updates.current.optimistic}, patch), capabilities = requiredModels(next);
    const needsSetup = patch.spatialMethod === "ls1" || patch.frameGeneration === "lsfg" ||
      patch.ls1Mode !== undefined && next.spatialMethod === "ls1" ||
      (patch.lsfgMode !== undefined || patch.lsfgFp16 !== undefined) && next.frameGeneration === "lsfg";
    if (!needsSetup) return change(patch, undefined, propagate);
    preview(patch);
    if (pending.current) {queued.current = mergeGraphics({...activeModel.current, ...queued.current}, patch);return;}
    const selected = models.find(model => model.version === (next.modelVersion || status?.defaultModelVersion));
    if (!capabilities.length || selected && capabilities.every(capability => selected.capabilities.includes(capability))) return change(patch, undefined, propagate);
    const installed = !next.modelVersion && models.find(model => capabilities.every(capability => model.capabilities.includes(capability)));
    if (installed) return change({...patch, modelVersion: installed.version}, undefined, propagate);
    pending.current = true;activeModel.current = patch;setBusy(true);setError("");
    let publishing = false;
    async function unavailableModels() {
      const latest = {...patch, ...queued.current};queued.current = null;
      pending.current = false;activeModel.current = null;
      for (const key of Object.keys(latest) as Array<keyof GameGraphicsSettings>) delete updates.current.optimistic[key];
      refresh(value => value + 1);
      // The first-enable frame-generation suggestion is optional. A usable
      // neural selection remains independent when those models are unavailable.
      if (latest.neuralMethod === "mlx-dlss" && latest.neuralModelPath) {
        delete latest.lsfgMode;delete latest.lsfgFp16;delete latest.frameMultiplier;
        publishing = true;await change({...latest, frameGeneration: "off"}, undefined, propagate);
        return true;
      }
      return false;
    }
    try {
      const api = window.MacLauncher?.launcher;
      if (!api?.ensureGameGraphicsModel) throw new Error("Automatic model setup is unavailable.");
      const prepared = await api.ensureGameGraphicsModel(game.gamePath, "lossless", patch);
      if (!prepared) {await unavailableModels();return;}
      if (!prepared.modelVersion) throw new Error("Compatible Lossless Scaling models are required.");
      const latest = {...patch, ...queued.current};queued.current = null;
      pending.current = false;activeModel.current = null;
      if (requiredModels({...game.graphics, ...updates.current.optimistic, ...latest}).some(capability => !capabilities.includes(capability))) {
        publishing = true;
        return await selectModelGraphics({...latest, modelVersion: prepared.modelVersion}, propagate);
      }
      publishing = true;await change({...latest, modelVersion: prepared.modelVersion}, undefined, propagate);
    } catch (error) {
      if (publishing) throw error;
      const preserved = await unavailableModels();setError(error instanceof Error ? error.message : "Graphics models could not be prepared.");
      if (propagate && !preserved) throw error;
    }
    finally {pending.current = false;activeModel.current = null;setBusy(false);}
  }
  return <fieldset className="effectsEditor graphicsProcessingControls" aria-label="Graphics settings" disabled={false} aria-busy={busy || neuralBusy}>
    <SimpleNeuralControls game={{...game, graphics: value}} status={status} available={neuralAvailable} nativeVideo={graphicsInputs?.nativeVideo === true} running={running} live={live}
      defaultFrameGeneration={Boolean(generationAvailable)} frameSelectionRevision={frameSelectionRevision.current}
      onChange={(_path, patch) => selectModelGraphics(patch, true)} onBusyChange={setNeuralBusy} />
    <section className="graphicsGroup" aria-label="Scaling and frame generation">
    {(spatialMethods.length > 0 || temporalMethods.length > 0 || generationAvailable || spatial !== "off" || temporal !== "off" || generation !== "off") &&
      <div className="graphicsGroupHeader"><div className="graphicsGroupTitle"><h4 className="detailSectionHeading">Scaling and frame generation</h4><HelpTip label="About graphics changes">{sourceResolution && sourceResolution.live ? "Render resolution updates during play. " : "Source allocation changes apply on the next launch. "}Compatible managed models can be selected during play.
      {running && (!live ? " Applies on the next launch." : graphicsInputs?.spatialBindingsNextLaunch ? " Native scaling changes apply on the next launch. Other supported controls update during play."
        : support?.liveSwitching ? " Supported controls update during play." : " Applies on the next launch.")}
      {(temporalMethods.length > 0 || temporal !== "off") && " Temporal selection updates during play when the game supplies compatible inputs. Enabling Wine's game temporal integration requires another launch."}
    </HelpTip></div></div>}
    {(temporalMethods.length > 0 || temporal !== "off") && <>
      <div className="detailRow detailControlRow">
        <label className="detailLabel" htmlFor="game-temporal-method">Temporal upscaling <HelpTip label="About temporal upscaling">Requires motion vectors, depth and jitter from the game's MetalFX integration or renderer. Render resolution follows game settings.
          {["fsr2", "fsr3"].includes(temporal) && (graphicsInputs?.cameraProjection
            ? " Camera projection comes from the game's renderer. Unsupported views keep the game's original upscaler."
            : " FSR 2.2 and FSR 3.1 also require camera projection data from the renderer.")}
        </HelpTip></label>
        <select id="game-temporal-method" className="input" value={temporal}
          onChange={event => change({ temporalMethod: event.target.value as GameGraphicsSettings["temporalMethod"] })}>
          <option value="off">Game default</option>
          {temporal !== "off" && !temporalMethods.includes(temporal) && <option value={temporal} disabled>{temporalLabels[temporal]} · Unavailable</option>}
          {scalingOptions(temporalMethods, temporalLabels)}
        </select>
      </div>
      {temporal !== "off" && !temporalMethods.includes(temporal) && <p className="detailMeta" role="status">This method requires compatible scene inputs from the selected renderer. Game default retains the game's original rendering.</p>}
      {["fsr2", "fsr3", "fsr4"].includes(temporal) && <div className="detailRow detailControlRow">
        <label className="detailLabel" htmlFor="game-temporal-sharpness">Temporal sharpness</label>
        <input id="game-temporal-sharpness" type="range" min="0" max="1" step="0.05" value={value?.temporalSharpness ?? 0.5}
          onChange={event => change({ temporalSharpness: Number(event.target.value) })} />
      </div>}
      {["fsr2", "fsr3"].includes(temporal) && graphicsInputs?.requiresDownload &&
        <p className="detailMeta">Additional graphics libraries download before the next launch, after confirmation.</p>}
    </>}
    {(spatialShadersAvailable || spatialMethods.length > 0 || spatial !== "off") && <div className="detailRow detailControlRow">
      <label className="detailLabel" htmlFor="game-spatial-method">{value?.neuralMethod === "mlx-dlss" ? "Upscaler" : "Spatial upscaling"} <HelpTip label="About spatial upscaling">{graphicsInputs?.nativeSpatialMethods
        ? "Native filters scale decoded frames to the video window. Off uses the player's basic bilinear resize. Other effects use the shared graphics processor."
        : "Scales smaller game frames to the window's physical pixels, including Retina scaling. Scaling stays inactive when input and output sizes match."}
        {value?.neuralMethod === "mlx-dlss" && " Automatic fit selects an available spatial filter after neural reconstruction. MetalFX and FSR can also be selected independently."}</HelpTip></label>
      <select id="game-spatial-method" className="input" value={spatial}
        onChange={event => event.target.value === "shader:custom" ? void chooseSpatialShader()
          : event.target.value.startsWith("shader:") ? void change({spatialShader: {enabled: true, preset: event.target.value.slice(7), effectPath: null, parameters: null}})
            : void selectModelGraphics({ spatialMethod: event.target.value as GameGraphicsSettings["spatialMethod"] })}>
        <option value="off">{value?.neuralMethod === "mlx-dlss" ? "Automatic fit" : "Off"}</option>
        {!spatialShader && spatial !== "off" && !spatialMethods.includes(spatial) && <option value={spatial} disabled>{spatialMethodLabel(spatial, {...labels, ...support?.spatialMethodLabels, ...graphicsInputs?.nativeSpatialMethodLabels})} · Unavailable</option>}
        {scalingOptions(spatialMethods, {...labels, ...support?.spatialMethodLabels, ...graphicsInputs?.nativeSpatialMethodLabels}, spatial)}
        {spatialShader && !spatialPresets.some(item => item.id === spatialShader.preset) && spatialShader.preset !== "custom" && <option value={spatial}>Selected shader · Unavailable</option>}
        {spatialShaderGroups.map(group => <optgroup key={group} label={group}>
          {spatialPresets.filter(item => shaderBehaviorGroup(item.traits) === group).map(item => <option key={item.id} value={`shader:${item.id}`} disabled={item.available === false} title={item.reason}>{item.label}{item.available === false ? " · Unavailable" : ""}</option>)}
        </optgroup>)}
        {(spatialShadersAvailable || spatialShader?.preset === "custom") && <option value="shader:custom" disabled={!spatialShadersAvailable}>Custom shader…</option>}
      </select>
    </div>}
    {spatialShader && <>
      {spatialShader.effectPath && <div className="detailRow"><div className="detailLabel">Shader</div><div className="detailValue ellipsis" title={spatialShader.effectPath}>{spatialShader.effectPath.split(/[\\/]/).pop()}</div></div>}
      <p className="detailMeta">Declared shader scaling is preserved, then the result fits the window. Source resolution changes only when requested.</p>
      {status?.shaderParameters && <ShaderParameters key={JSON.stringify([game.gamePath, spatialShader.preset, spatialShader.effectPath, spatialShader.effects])}
        idPrefix="spatial-shader" gamePath={game.gamePath} settings={spatialShader} live={running && live === true}
        loadParameters={async () => {const api = window.MacLauncher?.launcher;if (!api) throw new Error("Shader controls are unavailable.");return api.getGameEffectParameters(game.gamePath, "legacy-spatial-shader");}}
        onChange={(_path, patch) => change({spatialShader: {...spatialShader, ...patch}}, {preset: spatialShader.preset, effectPath: spatialShader.effectPath, effects: spatialShader.effects})} />}
    </>}
    <SimpleRenderResolution game={{...game, graphics: value}} multipliers={resolutionMultipliers} sourceResolution={sourceResolution} processingAvailable={processingResolution}
      shaderTraits={status?.presets.find(row => row.id === game.reshade?.preset)?.traits} onChange={(_path, patch) => change(patch)} />
    {spatial !== "off" && <>
      {["fsr1", "mako", "ls1"].includes(spatial) && <div className="detailRow detailControlRow">
        <label className="detailLabel" htmlFor="game-spatial-sharpness">Sharpness</label>
        <input id="game-spatial-sharpness" type="range" min="0" max="1" step="0.05" value={value?.spatialSharpness ?? 0.5}
          onChange={event => change({ spatialSharpness: Number(event.target.value) })} />
      </div>}
      {spatial === "ls1" && <div className="detailRow detailControlRow">
        <label className="detailLabel" htmlFor="game-ls1-mode">LS1 mode</label>
        <select id="game-ls1-mode" className="input" value={value?.ls1Mode || "quality"}
          onChange={event => void selectModelGraphics({ ls1Mode: event.target.value as "quality" | "performance" })}>
          <option value="quality">Quality</option><option value="performance">Performance</option>
        </select>
      </div>}
    </>}
    {(generationAvailable || generation !== "off") && <div className="detailRow detailControlRow">
      <label className="detailLabel" htmlFor="game-frame-generation">Frame generation <HelpTip label="About frame generation">{frameMultiplier}× requests {frameMultiplier - 1} generated {frameMultiplier === 2 ? "frame" : "frames"} per completed real frame. A 30 fps processed source targets {30 * frameMultiplier} fps before display and processing limits. Requires Lossless Scaling models and opaque SDR output. Generated frames can add delay and artifacts; the multiplier does not guarantee the displayed frame rate.</HelpTip></label>
      <select id="game-frame-generation" className="input" value={generation === "off" ? "off" : String(frameMultiplier)}
        onChange={event => event.target.value === "off" ? void selectModelGraphics({ frameGeneration: "off" })
          : void selectModelGraphics({ frameGeneration: "lsfg", frameMultiplier: Number(event.target.value) })}>
        <option value="off">Off</option>
        {[2, 3, 4, 5].map(factor => <option key={factor} value={factor} disabled={!generationAvailable}>
          {factor}× frame rate · LSFG{generationAvailable ? "" : " · Unavailable"}</option>)}
      </select>
    </div>}
    {generation === "lsfg" && <details className="effectNodeSettings"><summary>Frame generation options</summary>
      {(support?.adaptive || value?.framePacing === "adaptive") && <div className="detailRow detailControlRow">
        <label className="detailLabel" htmlFor="game-frame-pacing">Frame pacing <HelpTip label="About frame pacing">Adaptive varies generated frames toward the target, limited by display refresh and the selected {frameMultiplier}× ceiling. Smooth cadence favors evenly spaced output. Game rendering is not capped.</HelpTip></label>
        <select id="game-frame-pacing" className="input" value={value?.framePacing || "fixed"}
          onChange={event => change({ framePacing: event.target.value as "fixed" | "adaptive" })}>
          <option value="fixed">Fixed</option><option value="adaptive" disabled={!support?.adaptive}>Adaptive{support?.adaptive ? "" : " · Unavailable"}</option>
        </select>
      </div>}
      {value?.framePacing === "adaptive" ? <>
        <div className="detailRow detailControlRow">
          <label className="detailLabel" htmlFor="game-frame-target">Target frame rate</label>
          <GraphicsNumber id="game-frame-target" className="input" min="30" max="240" step="1" value={value?.targetFps ?? 120}
            onValue={targetFps => change({ targetFps })} />
        </div>
        <div className="detailRow detailControlRow">
          <label className="detailLabel" htmlFor="game-smooth-cadence">Smooth cadence</label>
          <input id="game-smooth-cadence" type="checkbox" checked={value?.smoothCadence ?? false}
            onChange={event => change({ smoothCadence: event.target.checked })} />
        </div>
      </> : null}
      <div className="detailRow detailControlRow">
        <label className="detailLabel" htmlFor="game-lsfg-mode">LSFG mode</label>
        <select id="game-lsfg-mode" className="input" value={value?.lsfgMode || "quality"}
          onChange={event => void selectModelGraphics({ lsfgMode: event.target.value as "quality" | "performance" })}>
          <option value="quality">Quality</option><option value="performance">Performance</option>
        </select>
      </div>
      <div className="detailRow detailControlRow">
        <label className="detailLabel" htmlFor="game-lsfg-precision">Precision</label>
        <select id="game-lsfg-precision" className="input" value={value?.lsfgFp16 === false ? "fp32" : "fp16"}
          onChange={event => void selectModelGraphics({ lsfgFp16: event.target.value === "fp16" })}>
          <option value="fp16">16-bit</option><option value="fp32">32-bit</option>
        </select>
      </div>
      <div className="detailRow detailControlRow">
        <label className="detailLabel" htmlFor="game-lsfg-flow-scale">Motion estimation scale <HelpTip label="About motion estimation scale">Lower motion estimation scale reduces processing work and detail.</HelpTip></label>
        <input id="game-lsfg-flow-scale" type="range" min="0.25" max="1" step="0.05" value={value?.lsfgFlowScale ?? 1}
          onChange={event => change({ lsfgFlowScale: Number(event.target.value) })} />
      </div>
    </details>}
    {modelNeeded && <div className="detailRow detailControlRow">
      <label className="detailLabel" htmlFor="game-graphics-model">Models <HelpTip label="About graphics models">Manage models offers DLL import, installed-copy discovery and Steam download. Models must support the selected quality and precision settings.</HelpTip></label>
      <div className="detailActions">
      <select id="game-graphics-model" className="input" value={value?.modelVersion || ""}
        onChange={event => change({ modelVersion: event.target.value || null })}>
        <option value="">Automatic · {automaticModel?.label || "None available"}</option>
        {value?.modelVersion && !models.some(model => model.version === value.modelVersion) && <option value={value.modelVersion} disabled>Unavailable model</option>}
        {models.map(model => {
          const compatible = required.every(capability => model.capabilities.includes(capability!));
          return <option key={model.version} value={model.version} disabled={!compatible}>{model.label}{compatible ? "" : " · Incompatible"}</option>;
        })}
      </select>
      {onManageModels && <button className="btn small" onClick={onManageModels}>Manage models…</button>}
      </div>
    </div>}
    {modelNeeded && !compatibleModel && <p className="detailMeta" role="status">{selectedModel
      ? "The selected models do not support these processing options. Choose compatible models or change the quality and precision settings."
      : "Compatible Lossless Scaling models are required."}</p>}
    </section>
    {busy && <p className="detailMeta" role="status">Preparing graphics models…</p>}
    {error && <p className="detailMeta" role="alert">{error}</p>}
  </fieldset>;
}
