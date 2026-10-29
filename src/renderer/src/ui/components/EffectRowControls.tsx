import React, {useEffect, useState} from "react";
import type {EffectCatalogRow, EffectExtent, GameGraphicsSettings, GraphicsDepthInput, NeuralEffectSettings, ReShadeState, VideoEffectNode} from "../types";
import type {EffectsEditor} from "../useEffectsEditor";
import {shaderGeometry} from "../../../../modules/shared/effects/contracts.mjs";
import {NEURAL, MODEL_OPERATIONS} from "../../../../modules/shared/effects/operation-contracts.mjs";
import {DEPTH_INPUT_DEFAULTS, depthInput} from "../../../../modules/shared/effects/plan.mjs";
import {implementationOutputSummary, implementationHelp} from "../../../../modules/shared/effects/presentation.mjs";
import {selectNeuralModel, compatibleNeuralModel} from "../../../../modules/shared/effects/neural-selection.mjs";
import {editableShaderExtent, selectedEffectExtent} from "../shader-implementations";
import {losslessRequirement, neuralImplementation, resizeKind} from "../effects-catalog";
import {ShaderParameters} from "./ShaderParameters";
import {GraphicsNumber, GraphicsRange} from "./GraphicsNumber";
import {AdaptiveQualityControls} from "./AdaptiveQualityControls";
import {HelpTip} from "./HelpTip";

const resizeHeightPresets = [540, 720, 1080];
const NEURAL_DEFAULTS = {modelPath: null, temporal: false, intensity: 1};

/**
 * Settings of one effect row, shared by Simple Options and Advanced rows:
 * observed resolution, model, size, adaptive quality and method settings.
 */
export function EffectRowControls({editor, row: node, choice, simple = false}: {editor: EffectsEditor; row: VideoEffectNode; choice?: EffectCatalogRow; simple?: boolean}) {
  const {plan, reshade: status, support, running, info, graphics} = editor, type = editor.typeOf(node);
  const reported = graphics.stages.find(stage => stage.id === node.id && (stage.completed > 0 || stage.encoded > 0) && !["failed", "bypassed", "stopped"].includes(stage.phase) &&
    stage.input.width > 0 && stage.input.height > 0 && stage.output.width > 0 && stage.output.height > 0);
  const groupedResolution = reported?.resolutionScope?.kind === "shader-group";
  const dimensions = reported ? `${reported.input.width} × ${reported.input.height} → ${reported.output.width} × ${reported.output.height}` :
    !node.enabled || plan.enabled === false ? "Off" : "Waiting for frame dimensions";
  const quality = plan.output?.adaptiveQuality;
  const qualityEligible = type === "downsample" && (resizeKind(node.kind) || node.kind === "shader" && choice?.outputContract?.extentEditable === true && choice.outputContract.sizing !== "intrinsic");
  const qualityControls = qualityEligible || quality?.nodeId === node.id ? <AdaptiveQualityControls nodeId={node.id} available={support?.adaptiveQuality === true && qualityEligible} policy={quality}
    observation={graphics.adaptiveQuality(node.id)} onChange={adaptiveQuality => void editor.setOutput({adaptiveQuality})} /> : null;
  const filter = node.kind === "shader" ? status?.filters?.find(row => `filter:${row.id}` === node.shader.preset) : undefined;
  const policy = choice?.colorPolicy?.conversion === "local-gpu-island" && choice.colorPolicy.provider === "srgb-sdr"
    ? <div className="detailRow"><span className="detailLabel">Processing</span><span className="detailValue">sRGB SDR<HelpTip label="About SDR processing">This provider uses a local GPU conversion. HDR input is tone mapped for this stage, then restored to the source encoding. Highlights discarded by the provider are not reconstructed. Compatible effects retain their native HDR range.</HelpTip></span></div> : null;
  const settings = (patch: Partial<GameGraphicsSettings>) => void editor.setSettings(node.id, {settings: patch});
  // Observed sizes exist only while the game runs.
  const resolution = running && <div className="detailRow effectObservedResolution"><span className="detailLabel">{groupedResolution ? "Group resolution" : "Resolution"}
    <HelpTip label="About observed resolution">{groupedResolution ? "Input and final output pixels of the shared shader group. These rows execute together to preserve their original image references. Private intermediate sizes are not measured separately." : "Input and output pixels reported by this step with the current settings. Same-size filters report both sizes too."} Frame completion is reported separately.</HelpTip></span>
    <span className="detailValue" role="status">{dimensions}</span></div>;
  if (node.kind === "shader") return <>{resolution}{policy}
    {choice?.modelOperation && <ModelSelectionControls nodeId={node.id} method={choice.modelOperation} modelPath={node.settings?.modelPath || null}
      models={status?.neuralModels} defaultVersion={status?.defaultNeuralModelVersion} defaultVersions={status?.defaultNeuralModelVersions}
      onChange={modelPath => void editor.changeModel(node, modelPath)} onImport={() => editor.pickModel(node)} onManage={editor.manageNeuralModels} />}
    {shaderSize(editor, node, choice, simple)}
    {qualityControls}
    {node.shader.preset === "chain" && (node.shader.effects || ["cas", "crt"]).map((effect, effectIndex, effects) => <div className="detailRow detailControlRow" key={effectIndex}>
      <label className="detailLabel" htmlFor={`effect-${node.id}-pass-${effectIndex}`}>Shader {effectIndex + 1}</label>
      <div className="detailActions"><select id={`effect-${node.id}-pass-${effectIndex}`} className="input" value={effect}
        onChange={event => void editor.setSettings(node.id, {shader: {effects: effects.map((item, i) => i === effectIndex ? event.target.value : item), parameters: null}})}>
        {status?.presets.filter(row => !row.installed && !["chain", "custom"].includes(row.id)).map(row => <option key={row.id} value={row.id} disabled={row.available === false}>{row.label}</option>)}
      </select></div>
    </div>)}
    {node.shader.preset === "custom" && <div className="detailRow"><span className="detailLabel">File</span>
      <span className="detailValue ellipsis" title={node.shader.effectPath || undefined}>{node.shader.effectPath?.split(/[\\/]/).pop() || "No shader selected"}</span>
      <button className="btn small" onClick={() => editor.pick(node)}>Choose shader…</button></div>}
    {status?.shaderParameters && <ShaderParameters key={JSON.stringify([node.id, node.shader.preset, node.shader.effects, node.shader.effectPath, filter?.path, filter?.sourceRevision || choice?.sourceRevision])}
      disclosure={false} idPrefix={`effect-${node.id}`} gamePath={editor.game.gamePath} settings={node.shader} live={running && info?.live === true && info.shaderBindingsNextLaunch !== true}
      loadParameters={async () => editor.loadParameters(node.id)} onChange={async (_, patch) => {await editor.setSettings(node.id, {shader: patch}, true);}}
      after={loaded => support?.depthInput === true && loaded.requirements?.depth === true ? <DepthInputControls nodeId={node.id} value={plan.depthInput}
        onChange={patch => void editor.setDepthInput(patch)} /> : null} />}
  </>;
  if (neuralImplementation(node, choice)) return <>{resolution}{policy}
    <NeuralSettingsControls nodeId={node.id} method={node.method} value={node.settings || {}} models={status?.neuralModels} defaultVersion={status?.defaultNeuralModelVersion}
      intrinsicScale={choice?.intrinsicScale} defaultVersions={status?.defaultNeuralModelVersions}
      onChange={patch => Object.hasOwn(patch, "modelPath") ? void editor.changeModel(node, patch.modelPath || null)
        : void editor.setSettings(node.id, {settings: {...NEURAL_DEFAULTS, ...node.settings, ...patch}})}
      onImport={() => editor.pickModel(node)} onManage={editor.manageNeuralModels} />
    {node.kind === "frame-generation" && <EffectGraphicsSettings node={node} choice={choice} status={status} adaptive={support?.adaptive === true}
      onChange={settings} onExtentChange={() => {}} />}{qualityControls}</>;
  return <>{resolution}{policy}{node.kind !== "neural" && <EffectGraphicsSettings node={node} choice={choice} status={status} adaptive={support?.adaptive === true}
    onChange={settings} onExtentChange={extent => void editor.setExtent(node.id, extent)}
    processingOptions={qualityControls} onManageModels={editor.onManageModels} />}</>;
}

// ReShade's depth-input definitions belong to the game and apply to each of
// its shaders whose compiled program reads depth.
function DepthInputControls({nodeId, value, onChange}: {nodeId: string; value?: Partial<GraphicsDepthInput>; onChange: (patch: Partial<GraphicsDepthInput>) => void}) {
  const input = depthInput(value), id = (name: string) => `effect-${nodeId}-depth-${name}`;
  return <details className="effectNodeSettings graphicsOutput" open={value ? true : undefined}><summary>Depth input
    <HelpTip label="About depth input">Applies to every depth shader in this game; changing a value recompiles them.</HelpTip></summary>
    <label className="inlineCheck"><input type="checkbox" checked={input.reversed} onChange={event => onChange({reversed: event.target.checked})} />Reversed</label>
    <label className="inlineCheck"><input type="checkbox" checked={input.logarithmic} onChange={event => onChange({logarithmic: event.target.checked})} />Logarithmic</label>
    <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={id("far-plane")}>Far plane</label>
      <GraphicsNumber id={id("far-plane")} className="input" min={1} max={1000000} step="any" value={input.farPlane} onValue={farPlane => onChange({farPlane})} /></div>
    <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={id("multiplier")}>Multiplier</label>
      <GraphicsNumber id={id("multiplier")} className="input" min={0.001} max={1000} step="any" value={input.multiplier} onValue={multiplier => onChange({multiplier})} /></div>
    {value && <div className="detailActions"><button type="button" className="btn small" onClick={() => onChange(DEPTH_INPUT_DEFAULTS)}>Reset</button></div>}
  </details>;
}

// Shader sizes use the shared resize controls: the requested output size of
// a target-sized shader, or the owned fit after a fixed-scale scaler.
function shaderSize(editor: EffectsEditor, node: Extract<VideoEffectNode, {kind: "shader"}>, choice: EffectCatalogRow | undefined, simple: boolean) {
  const type = editor.typeOf(node), geometry = shaderGeometry(choice), fit = editor.fitOf(node);
  return <>
    {choice && ["scale", "size", "conditional", "unknown"].includes(geometry.kind) && <div className="detailRow"><span className="detailLabel">Shader output</span>
      <span className="detailValue">{implementationOutputSummary(choice)}<HelpTip label="About shader output size">{implementationHelp(choice) ||
        "The shader declares this scale. A separate resize changes the resulting image size."}</HelpTip></span></div>}
    {editableShaderExtent(choice) && (node.extent || !simple || type !== "image") && <ResizeOutputSettings nodeId={node.id} extent={node.extent}
      downsample={type === "downsample"} automatic={false} anyDirection={type === "image"} direction={(type === "downsample" || type === "upscale") && geometry.directions.length !== 1 ? type : undefined}
      onChange={extent => void editor.setExtent(node.id, extent)} />}
    {simple && fit?.enabled && fit.kind !== "shader" && fit.kind !== "neural" && geometry.kind === "scale" && <ResizeOutputSettings nodeId={fit.id}
      extent={selectedEffectExtent(fit)} downsample={false} anyDirection onChange={extent => void editor.setExtent(fit.id, extent, true)} />}
  </>;
}

function ModelSelectionControls({nodeId, method, modelPath, models = [], defaultVersion, defaultVersions, onChange, onImport, onManage}: {
  nodeId: string; method: string; modelPath: string | null; models?: ReShadeState["neuralModels"];
  defaultVersion?: string | null;
  defaultVersions?: Record<string, string>;
  onChange: (modelPath: string | null) => void; onImport: () => Promise<void>; onManage: () => Promise<void>;
}) {
  const compatible = models.filter(model => compatibleNeuralModel(model, method));
  const automatic = selectNeuralModel(method, models, {defaultVersion, defaultVersions});
  return <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={`effect-${nodeId}-model`}>Model
      {MODEL_OPERATIONS[method]?.kind === "attachment" && <HelpTip label="About inferred depth">Infers relative depth from the image for this filter. It does not provide renderer depth, motion or camera guides.</HelpTip>}</label>
    <select id={`effect-${nodeId}-model`} className="input" value={modelPath || ""} onChange={event => {
      if (event.target.value === "__import") {void onImport();return;}
      if (event.target.value === "__manage") {void onManage();return;}
      onChange(event.target.value || null);
    }}>
      <option value="" title={automatic?.versionLabel || automatic?.version}>{compatible.length ? "Automatic" : "Model needed"}</option>
      {modelPath && !compatible.some(model => model.modelPath === modelPath) && <option value={modelPath}>Selected local model</option>}
      {compatible.map(model => <option key={model.version} value={model.modelPath}>{model.versionLabel || model.version}</option>)}
      <option value="__import">Import model…</option><option value="__manage">Get / manage models…</option>
    </select></div>;
}
function NeuralSettingsControls({nodeId, method, value, models = [], defaultVersion, defaultVersions, intrinsicScale, onChange, onImport, onManage}: {
  nodeId: string; method: string; value: Partial<NeuralEffectSettings>; models?: ReShadeState["neuralModels"]; intrinsicScale?: number;
  defaultVersion?: string | null;
  defaultVersions?: Record<string, string>;
  onChange: (patch: Partial<NeuralEffectSettings>) => void; onImport: () => Promise<void>; onManage: () => Promise<void>;
}) {
  const compatible = models.filter(model => compatibleNeuralModel(model, method));
  const selected = value.modelPath || "";
  const effective = selected ? compatible.find(model => model.modelPath === selected) : selectNeuralModel(method, models, {defaultVersion, defaultVersions});
  return <>
    <ModelSelectionControls nodeId={nodeId} method={method} modelPath={value.modelPath || null} models={models} defaultVersion={defaultVersion} defaultVersions={defaultVersions}
      onChange={modelPath => onChange({modelPath})} onImport={onImport} onManage={onManage} />
    {intrinsicScale && intrinsicScale !== 1 ? <div className="detailRow"><span className="detailLabel">Output size</span><span className="detailValue">{intrinsicScale}× input
      <HelpTip label="About model output size">The model determines this scale. Add a separate Downsample or Upscale effect to change the resulting image size.</HelpTip></span></div> : null}
    {NEURAL[method]?.history === "optional-image" && <>
      <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={`effect-${nodeId}-intensity`}>Intensity
        <HelpTip label="About neural intensity">Blends the reconstructed image with the input. 1 uses the full model output.</HelpTip></label>
        <GraphicsRange id={`effect-${nodeId}-intensity`} min="0" max="1" step="0.05" value={value.intensity ?? 1}
          onValue={intensity => onChange({intensity})} /></div>
      <label className="inlineCheck"><input type="checkbox" checked={value.temporal === true} onChange={event => onChange({temporal: event.target.checked})} />Temporal reconstruction
        <HelpTip label="About neural history">Estimates motion between real frames and retains reconstruction history, using additional GPU time.</HelpTip></label>
    </>}
    {effective?.pairedDenoiser === true && <div className="detailRow detailControlRow">
      <label className="detailLabel" htmlFor={`effect-${nodeId}-denoise`}>Denoising
        <HelpTip label="About restoration denoising">Blends the paired restoration models. Higher strength removes more noise and can soften fine detail.</HelpTip></label>
      <GraphicsRange id={`effect-${nodeId}-denoise`} min="0" max="1" step="0.05" value={value.denoiseStrength ?? 1}
        onValue={denoiseStrength => onChange({denoiseStrength})} />
    </div>}
  </>;
}

// A shader whose direction follows its size offers only sizes in that direction:
// reductions or fixed processing sizes, or enlargements and window fits.
function ResizeOutputSettings({nodeId, extent, downsample, anyDirection = false, direction, onChange}: {
  nodeId: string; extent?: EffectExtent; downsample: boolean; automatic?: boolean; anyDirection?: boolean; direction?: "downsample" | "upscale"; onChange: (extent?: EffectExtent) => void;
}) {
  const pixels = extent && !("relativeTo" in extent) ? extent : undefined;
  const presetHeight = pixels?.width === undefined && resizeHeightPresets.includes(pixels?.height || 0) ? pixels?.height : undefined;
  const [custom, setCustom] = useState(Boolean(pixels)), [customPixels, setCustomPixels] = useState(!presetHeight);
  const [scaleUnits, setScaleUnits] = useState<"percent" | "factor">("percent");
  const [width, setWidth] = useState(pixels?.width?.toString() || ""), [height, setHeight] = useState(pixels?.height?.toString() || "");
  useEffect(() => {setCustom(Boolean(pixels));setCustomPixels(!presetHeight);setWidth(pixels?.width?.toString() || "");setHeight(pixels?.height?.toString() || "");}, [JSON.stringify(extent)]);
  const valid = (value: string) => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 16384;
  function save() {
    if ((!width && !height) || width && !valid(width) || height && !valid(height)) return;
    onChange(width ? {width: Number(width), ...(height ? {height: Number(height)} : {})} : {height: Number(height)});
  }
  const relative = extent && "factor" in extent ? extent : !pixels ? {relativeTo: downsample ? "input" as const : "presentation" as const, factor: downsample ? .5 : 1} : undefined;
  const selected = custom ? "custom" : relative ? `${relative.relativeTo}:${relative.factor}` : "custom";
  const unitScale = scaleUnits === "percent" ? 100 : 1;
  return <>
    <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={`effect-${nodeId}-extent`}>Output size
      <HelpTip label="About processing size">Scale uses the previous step's image: 0.5× = 50%. Window fraction uses the current window or fullscreen drawable; 100% fits it. A single width or height preserves aspect ratio; setting both uses those exact dimensions. {downsample && "Downsample preserves smaller inputs."} These settings do not resize the game or window.</HelpTip></label>
      <select id={`effect-${nodeId}-extent`} className="input" value={selected} onChange={event => {
        if (event.target.value === "custom") {setCustom(true);return;}
        setCustom(false);
        const [relativeTo, factor] = event.target.value.split(":");if (["input", "presentation"].includes(relativeTo)) onChange({relativeTo: relativeTo as "input" | "presentation", factor: Number(factor)});
      }}>
        {(direction === "downsample" ? ["input"] as const : ["input", "presentation"] as const).map(relativeTo => <option key={relativeTo} value={`${relativeTo}:${relative?.relativeTo === relativeTo ? relative.factor : (relativeTo === "input" && downsample ? .5 : 1)}`}>{relativeTo === "input" ? "Scale of previous image" : "Fraction of window / fullscreen"}</option>)}
        {direction !== "upscale" && <option value="custom">Fixed resolution</option>}
      </select></div>
    {!custom && relative && <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={`effect-${nodeId}-percentage`}>{relative.relativeTo === "input" ? "Scale factor" : "Window fraction"}</label>
      <div className="detailActions"><GraphicsNumber id={`effect-${nodeId}-percentage`} className="input" min={(relative.relativeTo === "input" && !downsample && !anyDirection || direction === "upscale" ? 1 : .0625) * unitScale}
        max={(relative.relativeTo === "input" && downsample ? 1 : 16) * unitScale} step="any" value={Number((relative.factor * unitScale).toPrecision(8))}
        onValue={value => onChange({relativeTo: relative.relativeTo, factor: value / unitScale})} />
        <select className="input" style={{width: "4.5em", minWidth: 0, flex: "0 0 auto"}} aria-label="Scale units" value={scaleUnits} onChange={event => setScaleUnits(event.target.value as "percent" | "factor")}><option value="percent">%</option><option value="factor">×</option></select>
      </div></div>}
    {custom && <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={`effect-${nodeId}-pixel-preset`}>Resolution</label>
      <select id={`effect-${nodeId}-pixel-preset`} className="input" value={customPixels ? "custom" : `height:${presetHeight}`} onChange={event => {
        if (event.target.value === "custom") {setCustomPixels(true);return;}setCustomPixels(false);onChange({height: Number(event.target.value.slice(7))});
      }}>{resizeHeightPresets.map(height => <option key={height} value={`height:${height}`}>{height}p</option>)}<option value="custom">Custom width / height…</option></select></div>}
    {custom && customPixels && <div className="detailRow detailControlRow"><span className="detailLabel">Pixels</span><div className="detailActions">
      <input className="input effectExtentInput" aria-label="Output width" placeholder="Width" inputMode="numeric" value={width}
        aria-invalid={width !== "" && !valid(width) || undefined} onChange={event => setWidth(event.target.value)} onBlur={save}
        onKeyDown={event => {if (event.key === "Enter") {event.preventDefault();save();}}} />
      <span aria-hidden="true">×</span>
      <input className="input effectExtentInput" aria-label="Output height" placeholder="Height" inputMode="numeric" value={height}
        aria-invalid={height !== "" && !valid(height) || undefined} onChange={event => setHeight(event.target.value)} onBlur={save}
        onKeyDown={event => {if (event.key === "Enter") {event.preventDefault();save();}}} />
    </div></div>}
  </>;
}

function EffectGraphicsSettings({node, choice, status, onChange, onExtentChange, onManageModels, processingOptions}: {
  node: Exclude<VideoEffectNode, {kind: "shader" | "neural"}>; status?: ReShadeState; adaptive: boolean;
  choice?: EffectCatalogRow;
  onChange: (patch: Partial<GameGraphicsSettings>) => void; onManageModels?: () => void;
  onExtentChange: (extent?: EffectExtent) => void; processingOptions?: React.ReactNode;
}) {
  const value = node.settings || {}, id = (name: string) => `effect-${node.id}-${name}`;
  const required = losslessRequirement(node);
  const losslessModels = (status?.models || []).filter(model => !value.modelVersion || model.version === value.modelVersion);
  const supportsLossless = (capability: string) => losslessModels.some(model => model.capabilities.includes(capability));
  return <>
    {resizeKind(node.kind) && <>
      <ResizeOutputSettings nodeId={node.id} extent={selectedEffectExtent(node)} downsample={node.kind === "downsample" || node.method === "downsample"} automatic={node.kind === "downsample"} onChange={onExtentChange} />
      {["fsr1", "mako", "ls1"].includes(node.method) && <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={id("sharpness")}>Sharpness</label>
        <GraphicsRange id={id("sharpness")} min="0" max="1" step="0.05" value={value.spatialSharpness ?? 0.5} onValue={spatialSharpness => onChange({spatialSharpness})} /></div>}
      {node.method === "ls1" && <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={id("ls1-mode")}>LS1 mode</label>
        <select id={id("ls1-mode")} className="input" value={value.ls1Mode || "quality"} onChange={event => onChange({ls1Mode: event.target.value as "quality" | "performance"})}>
          {([["quality", "Quality"], ["performance", "Performance"]] as const).filter(([mode]) => supportsLossless(`ls1${mode === "quality" ? "Quality" : "Performance"}`) || mode === (value.ls1Mode || "quality")).map(([mode, label]) => {
            const supported = supportsLossless(`ls1${mode === "quality" ? "Quality" : "Performance"}`);return <option key={mode} value={mode} disabled={!supported}>{label}{supported ? "" : " · Unavailable"}</option>;})}</select></div>}
    </>}
    {processingOptions}
    {node.method === "xess" && <>
      <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={id("backend")}>Compute backend
        <HelpTip label="About XeSS compute">The compute backend runs Intel XeSS on the GPU. It is independent of the game's renderer. Available choices depend on the installed compute host.</HelpTip></label>
        <select id={id("backend")} className="input" value={value.xessBackend || "auto"}
          onChange={event => onChange({xessBackend: event.target.value as "auto" | "d3d12" | "vulkan"})}>
          <option value="auto">Automatic</option>
          {["d3d12", "vulkan"].filter(backend => choice?.backends?.includes(backend) || value.xessBackend === backend).map(backend => <option key={backend} value={backend} disabled={!choice?.backends?.includes(backend)}>{backend === "d3d12" ? "Direct3D 12" : "Vulkan"}{choice?.backends?.includes(backend) ? "" : " · Unavailable"}</option>)}
        </select></div>
      {choice?.runtimeManagerId && <div className="detailActions"><button className="btn small"
        onClick={() => void window.MacLauncher?.launcher.openUtilityWindow({view: "runtimes", managerId: choice.runtimeManagerId})}>Get / manage XeSS…</button>
        {choice.reason && <HelpTip label="About XeSS availability">{choice.reason}</HelpTip>}</div>}
    </>}
    {node.kind === "temporal" && <>
      {node.method === "fsr4" && <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={id("fsr4-profile")}>Profile
        <HelpTip label="About FSR 4 profiles">Selects the original shader profile. Input and output sizes remain independent.</HelpTip></label>
        <select id={id("fsr4-profile")} className="input" value={value.fsr4Profile || "exact-fast"}
          onChange={event => onChange({fsr4Profile: event.target.value as GameGraphicsSettings["fsr4Profile"]})}>
          {([["exact-fast", "Exact Fast"], ["lite", "Lite"], ["lite2", "Lite 2"]] as const).filter(([profile]) => choice?.profiles?.includes(profile) || profile === (value.fsr4Profile || "exact-fast")).map(([profile, label]) => {
            const installed = choice?.profiles?.includes(profile) ?? (profile === "exact-fast" && choice?.available === true);
            return <option key={profile} value={profile} disabled={!installed}>{label}{installed ? "" : " · Not installed"}</option>;
          })}
        </select></div>}
      {node.method === "asr" && <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={id("asr-quality")}>Quality</label>
        <select id={id("asr-quality")} className="input" value={value.asrQuality || "quality"}
          onChange={event => onChange({asrQuality: event.target.value as GameGraphicsSettings["asrQuality"]})}>
          <option value="quality">Quality</option><option value="balanced">Balanced</option><option value="performance">Performance</option><option value="ultra-performance">Ultra performance</option>
        </select></div>}
      {["fsr2", "fsr3", "fsr4"].includes(node.method) && <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={id("temporal-sharpness")}>Sharpness</label>
        <GraphicsRange id={id("temporal-sharpness")} min="0" max="1" step="0.05" value={value.temporalSharpness ?? 0.5} onValue={temporalSharpness => onChange({temporalSharpness})} /></div>}
    </>}
    {node.kind === "frame-generation" && <>
      <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={id("multiplier")}>Frame multiplier <HelpTip label="About frame multiplication">{node.method === "lsfg" && "Requires compatible Lossless Scaling models and an opaque image. "}Generated frames can add delay and artifacts. Displayed frame rate depends on the game, processing and display.</HelpTip></label>
        {choice?.outputContract?.maximumMultiplier === 2 && (value.frameMultiplier ?? 2) === 2 ? <span className="detailValue">2× frame rate</span> : <select id={id("multiplier")} className="input" value={value.frameMultiplier ?? 2} onChange={event => onChange({frameMultiplier: Number(event.target.value)})}>
          {[2, 3, 4, 5].filter(factor => factor <= (choice?.outputContract?.maximumMultiplier || 5) || factor === value.frameMultiplier).map(factor => <option key={factor} value={factor} disabled={factor > (choice?.outputContract?.maximumMultiplier || 5)}>{factor}× frame rate{factor > (choice?.outputContract?.maximumMultiplier || 5) ? " · Unsupported" : ""}</option>)}</select>}</div>
      {node.method === "lsfg" && <><div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={id("mode")}>LSFG mode</label>
        <select id={id("mode")} className="input" value={value.lsfgMode || "quality"} onChange={event => onChange({lsfgMode: event.target.value as "quality" | "performance"})}>
          {([["quality", "Quality"], ["performance", "Performance"]] as const).filter(([mode]) => supportsLossless(`lsfg${value.lsfgFp16 === false ? "Fp32" : "Fp16"}${mode === "quality" ? "Quality" : "Performance"}`) || mode === (value.lsfgMode || "quality")).map(([mode, label]) => {
            const supported = supportsLossless(`lsfg${value.lsfgFp16 === false ? "Fp32" : "Fp16"}${mode === "quality" ? "Quality" : "Performance"}`);return <option key={mode} value={mode} disabled={!supported}>{label}{supported ? "" : " · Unavailable"}</option>;})}</select></div>
      <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={id("precision")}>Precision</label>
        <select id={id("precision")} className="input" value={value.lsfgFp16 === false ? "fp32" : "fp16"} onChange={event => onChange({lsfgFp16: event.target.value === "fp16"})}>
          {([["fp16", "16-bit"], ["fp32", "32-bit"]] as const).filter(([precision]) => supportsLossless(`lsfg${precision === "fp16" ? "Fp16" : "Fp32"}${value.lsfgMode === "performance" ? "Performance" : "Quality"}`) || precision === (value.lsfgFp16 === false ? "fp32" : "fp16")).map(([precision, label]) => {
            const supported = supportsLossless(`lsfg${precision === "fp16" ? "Fp16" : "Fp32"}${value.lsfgMode === "performance" ? "Performance" : "Quality"}`);return <option key={precision} value={precision} disabled={!supported}>{label}{supported ? "" : " · Unavailable"}</option>;})}</select></div>
      <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={id("flow")}>Motion estimation scale</label>
        <GraphicsRange id={id("flow")} min="0.25" max="1" step="0.05" value={value.lsfgFlowScale ?? 1} onValue={lsfgFlowScale => onChange({lsfgFlowScale})} /></div></>}
    </>}
    {required && <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={id("models")}>Models</label><div className="detailActions">
      <select id={id("models")} className="input" value={value.modelVersion || ""} onChange={event => {
        if (event.target.value === "__manage") {onManageModels?.();return;}
        onChange({modelVersion: event.target.value || null});
      }}>
        <option value="">Default{status?.defaultModelVersion ? "" : " · None selected"}</option>
        {value.modelVersion && !status?.models?.some(model => model.version === value.modelVersion) && <option value={value.modelVersion} disabled>Unavailable model</option>}
        {status?.models?.filter(model => model.capabilities.includes(required) || model.version === value.modelVersion).map(model => <option key={model.version} value={model.version} disabled={!model.capabilities.includes(required)}>{model.label}{model.capabilities.includes(required) ? "" : " · Incompatible"}</option>)}
        {onManageModels && <option value="__manage">Get / manage models…</option>}
      </select></div></div>}
  </>;
}
