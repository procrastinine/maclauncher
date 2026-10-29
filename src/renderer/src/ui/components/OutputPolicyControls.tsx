import React from "react";
import type {GameEffectsInfo, GameEffectsPlan, GameGraphicsSettings} from "../types";
import type {EffectsEditor} from "../useEffectsEditor";
import {GraphicsNumber, GraphicsRange} from "./GraphicsNumber";
import {HelpTip} from "./HelpTip";

// Plan-wide policies shared by both views: the game's source resolution and
// the presenter's output settings. Each change is one edit operation.

export function SourceResolutionControls({value, capabilities, onChange}: {value?: GameEffectsPlan["renderResolution"]; capabilities?: GameEffectsInfo["sourceResolution"]; onChange: (value: GameEffectsPlan["renderResolution"]) => void}) {
  const mode = value ? "height" in value ? "height" : "percentage" : "original";
  const height = value && "height" in value ? value.height : 720, percent = value && "multiplier" in value ? 100 / value.multiplier : 50;
  const method = value?.method ? {method: value.method} : {};
  return <>
    <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor="effects-game-rendering">Game resolution
      <HelpTip label="About game resolution">Sets the image produced by the game before effects. Percentages use the visible window's pixel size, or the display in fullscreen. The adapter tries game rendering controls, an available virtual window, then GPU downsampling. GPU downsampling changes the image size without reducing the game's rendering work. The visible window keeps its size. {capabilities?.live ? "Updates during play." : "Applies on the next launch."}</HelpTip></label>
      <select id="effects-game-rendering" className="input" value={mode} onChange={event => onChange(event.target.value === "percentage" ? {multiplier: 100 / percent, ...method} : event.target.value === "height" ? {height, ...method} : undefined)}>
        <option value="original">Game default</option><option value="percentage">Percentage of window</option><option value="height">Height in pixels</option>
      </select></div>
    {mode === "percentage" && <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor="effects-game-percentage">Percentage</label><div className="detailActions">
      <GraphicsNumber id="effects-game-percentage" className="input" min="0.01" max="100" step="any" value={Number(percent.toPrecision(8))}
        onValue={percentage => {if (percentage > 0 && percentage <= 100 && Number.isFinite(100 / percentage)) onChange({multiplier: 100 / percentage, ...method});}} /><span className="unitLabel">%</span>
    </div></div>}
    {mode === "height" && <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor="effects-game-height">Height</label><div className="detailActions">
      <GraphicsNumber id="effects-game-height" className="input" min="1" max="16384" step="1" value={height} onValue={height => onChange({height, ...method})} /><span className="unitLabel">px</span>
    </div></div>}
  </>;
}

/** Game resolution and the source renderer's filter, when the game declares them or the plan holds a request. */
export function SourcePolicyControls({editor}: {editor: EffectsEditor}) {
  const {plan, info} = editor, capabilities = info?.sourceResolution, source = plan.renderResolution;
  const available = Boolean(capabilities && (capabilities.heights || capabilities.percentages || capabilities.processing || capabilities.multipliers.length > 0));
  if (!available && !source) return null;
  const methods = capabilities?.methods || [], temporal = capabilities?.filterExclusiveWithTemporal === true && plan.video.some(node => node.enabled && node.kind === "temporal");
  return <>
    <SourceResolutionControls value={source} capabilities={capabilities} onChange={value => void editor.setSource(value)} />
    {source && methods.length > 0 && <div className="detailRow detailControlRow">
      <label className="detailLabel" htmlFor="effects-source-filter">Source filter <HelpTip label="About source filtering">Selects the source renderer's scaling filter. Game original retains its existing filter. Shared effects remain separate. {capabilities?.live ? "Updates during play." : "Applies on the next launch."}{temporal && " Source filter choices require temporal stages to be off; Game original remains available."}</HelpTip></label>
      <select id="effects-source-filter" className="input" value={source.method || ""} onChange={event => editor.setSourceFilter(event.target.value)}>
        <option value="">Game original</option>
        {source.method && !methods.includes(source.method) && <option value={source.method} disabled>{source.method} · Unavailable</option>}
        {methods.map(method => <option key={method} value={method} disabled={temporal}>{capabilities?.methodLabels?.[method] || method}</option>)}
      </select></div>}
  </>;
}

function FramePacingControls({idPrefix, value, adaptive, onChange}: {
  idPrefix: string; value: Partial<GameGraphicsSettings>; adaptive: boolean; onChange: (patch: Partial<GameGraphicsSettings>) => void;
}) {
  return <>
    <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={`${idPrefix}-pacing`}>Frame pacing
      <HelpTip label="About frame pacing">Adaptive generation approaches the output target within the selected multiplier and display refresh. Game rendering is not capped.</HelpTip></label>
      <select id={`${idPrefix}-pacing`} className="input" value={value.framePacing || "fixed"} onChange={event => onChange({framePacing: event.target.value as "fixed" | "adaptive"})}>
        <option value="fixed">Fixed</option><option value="adaptive" disabled={!adaptive}>Adaptive{adaptive ? "" : " · Unavailable"}</option>
      </select></div>
    {value.framePacing === "adaptive" && <>
      <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={`${idPrefix}-target`}>Target frame rate</label>
        <GraphicsNumber id={`${idPrefix}-target`} className="input" min="30" max="240" step="1" value={value.targetFps ?? 120} onValue={targetFps => onChange({targetFps})} />
      </div>
      <label className="inlineCheck"><input type="checkbox" checked={value.smoothCadence ?? false} onChange={event => onChange({smoothCadence: event.target.checked})} />Smooth cadence</label>
    </>}
  </>;
}

/**
 * The Output section: motion clarity, tone mapping, pacing, comparison and an
 * orphaned adaptive-quality policy. It opens by itself when one is set.
 */
export function OutputPolicyControls({editor}: {editor: EffectsEditor}) {
  const {plan, support, motionOptions, setMotionOptions, setOutput} = editor, output = plan.output;
  const generation = plan.video.find(node => node.kind === "frame-generation" && node.enabled);
  const orphanQuality = output?.adaptiveQuality?.enabled && !plan.video.some(node => node.id === output.adaptiveQuality?.nodeId);
  const motion = output?.motionClarity && output.motionClarity !== "off";
  // Automatic display subframes come only from an enabled subframe shader.
  const automaticMotion = plan.enabled !== false && plan.video.some(node => node.enabled && node.kind === "shader") ? "Automatic" : "Automatic (Off)";
  const set = Boolean(output?.motionClarity || output?.framePacing || output?.comparison || output?.toneMapping || orphanQuality);
  return <details className="effectNodeSettings graphicsOutput" open={set || undefined}><summary>Output</summary>
    <div className="graphicsMotion" aria-label="Motion clarity">
      <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor="effects-motion-clarity">Motion clarity
        <HelpTip label="About motion clarity">Automatic follows a selected subframe shader. Black frame insertion and CRT beam scheduling use display subframes, reducing brightness to shorten visible persistence. Frame generation uses the same display clock. Display refresh and actual presentation determine the available benefit.</HelpTip></label>
        <select id="effects-motion-clarity" className="input" value={output?.motionClarity || "auto"}
          onChange={event => void setOutput(event.target.value === "auto" ? {motionClarity: undefined, subframes: undefined, duty: undefined, brightness: undefined}
            : {motionClarity: event.target.value as "off" | "bfi" | "beam"})}>
          <option value="auto">{automaticMotion}</option><option value="off">Off</option><option value="bfi" disabled={!support?.motionClarity}>Black frame insertion{support?.motionClarity ? "" : " · Unavailable"}</option>
          <option value="beam" disabled={!support?.motionClarity}>CRT beam{support?.motionClarity ? "" : " · Unavailable"}</option>
        </select>
        {motion && <button type="button" className="btn small" aria-expanded={motionOptions}
          onClick={() => setMotionOptions(!motionOptions)}>Options…</button>}
      </div>
      {motion && motionOptions && <div className="simpleEffectOptions">
        <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor="effects-subframes">Subframes</label>
          <select id="effects-subframes" className="input" value={output.subframes ?? 2}
            onChange={event => void setOutput({subframes: Number(event.target.value)})}>
            {[2, 3, 4, 5, 6, 7, 8].map(value => <option key={value} value={value}>{value}</option>)}
          </select></div>
        <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor="effects-duty">Visible duty</label>
          <GraphicsRange id="effects-duty" min="0.125" max="1" step="0.025" value={output.duty ?? .5}
            onValue={duty => void setOutput({duty})} /></div>
        <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor="effects-beam-brightness">Brightness
          <HelpTip label="About subframe brightness">Compensates for dark intervals. Higher values can clip highlights; display brightness and refresh constrain the result.</HelpTip></label>
          <GraphicsNumber id="effects-beam-brightness" className="input" min="1" max="8" step="0.1" value={output.brightness ?? 1}
            onValue={brightness => void setOutput({brightness})} /></div>
      </div>}
    </div>
      {(support?.outputColor || output?.toneMapping) && <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor="effects-tone-mapping">Tone mapping
        <HelpTip label="About output tone mapping">Automatic follows the declared source color and display range. None skips highlight compression; required color conversion still applies. Reinhard maps display-referred highlights. PBR Neutral requires declared scene-referred source metadata; otherwise Automatic applies.</HelpTip></label>
        <select id="effects-tone-mapping" className="input" value={output?.toneMapping || "auto"}
          title={!support?.outputColor ? "The selected graphics processor does not support explicit output tone mapping." : undefined}
          onChange={event => void setOutput({toneMapping: event.target.value === "auto" ? undefined : event.target.value as "preserve" | "reinhard" | "pbr-neutral"})}>
          <option value="auto">Automatic</option><option value="preserve" disabled={!support?.outputColor}>None</option>
          <option value="reinhard" disabled={!support?.outputColor}>Reinhard</option><option value="pbr-neutral" disabled={!support?.outputColor}>PBR Neutral</option>
        </select>
        {!support?.outputColor && output?.toneMapping && output.toneMapping !== "auto" && <span className="detailMeta" role="status"
          title={editor.graphics.pendingOutput("tone-mapping")?.reason || "Output tone mapping requires an updated graphics runtime. Automatic mapping remains active."}>Runtime update needed</span>}
      </div>}
      {(generation || output?.framePacing) && <FramePacingControls idPrefix="effects-output" value={{...(generation && "settings" in generation ? generation.settings : {}), ...output}} adaptive={support?.adaptive === true}
        onChange={settings => void setOutput(settings)} />}
      {orphanQuality && <div className="detailRow"><span className="detailLabel">Adaptive quality</span><span className="detailValue">Target removed</span>
        <button className="btn small" onClick={() => void setOutput(current => ({adaptiveQuality: {...current.adaptiveQuality!, enabled: false}}))}>Off</button></div>}
      {(support?.comparison || output?.comparison) && <>
        <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor="effects-comparison">Compare
          <HelpTip label="About image comparison">Source is the real image handed to the presenter, including earlier scene reconstruction. Generated phases use their closing real source. Difference compares RGB in one color encoding, without extra inference.</HelpTip></label>
          <select id="effects-comparison" className="input" value={output?.comparison?.mode || "off"}
            onChange={event => void setOutput(current => ({comparison: {position: .5, gain: 1, ...current.comparison, mode: event.target.value as "off" | "before" | "wipe" | "difference"}}))}>
            <option value="off">Off</option><option value="before" disabled={!support?.comparison}>Source</option><option value="wipe" disabled={!support?.comparison}>Source / processed</option><option value="difference" disabled={!support?.comparison}>Difference</option>
          </select></div>
        {output?.comparison?.mode === "wipe" && <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor="effects-comparison-position">Divider</label>
          <GraphicsRange id="effects-comparison-position" min="0" max="1" step="0.01" value={output.comparison.position ?? .5}
            onValue={position => void setOutput(current => ({comparison: {...current.comparison!, position}}))} /></div>}
        {output?.comparison?.mode === "difference" && <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor="effects-comparison-gain">Difference gain</label>
          <GraphicsNumber id="effects-comparison-gain" className="input" min="1" max="16" step="0.25" value={output.comparison.gain ?? 1}
            onValue={gain => void setOutput(current => ({comparison: {...current.comparison!, gain}}))} /></div>}
      </>}
  </details>;
}
