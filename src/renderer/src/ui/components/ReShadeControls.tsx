import React, { useRef, useState } from "react";
import type { GameReShadeSettings, GameGraphicsSettings, GraphicsInputs, RecentGame, ReShadeState, RuntimeEntry } from "../types";
import { HelpTip } from "./HelpTip";
import { ShaderParameters } from "./ShaderParameters";
import { shaderFormat, shaderFormatLabel, scalingShader, shaderBehaviorGroup } from "../shader-format";

type ReShadeControlsProps = {
  game: Pick<RecentGame, "gamePath" | "reshade" | "graphics">;
  status?: ReShadeState;
  graphicsHost?: RuntimeEntry["graphicsHost"];
  graphicsInputs?: GraphicsInputs | null;
  running: boolean;
  live?: boolean;
  onChange: (gamePath: string, patch: Partial<GameReShadeSettings>, expectedSelection?: Pick<GameReShadeSettings, "preset" | "effectPath" | "effects">) => Promise<void>;
  onGraphicsChange?: (gamePath: string, patch: Partial<GameGraphicsSettings>) => Promise<void>;
  onChooseEffect: (gamePath: string) => Promise<void>;
};

export function ReShadeControls({ game, status, graphicsHost, graphicsInputs, running, live, onChange, onGraphicsChange }: ReShadeControlsProps) {
  const [choosing, setChoosing] = useState(false), [pickerError, setPickerError] = useState("");
  const picking = useRef(false);
  const enabled = game.reshade?.enabled === true;
  const available = status?.available === true;
  const savedPreset = game.reshade?.preset || "crt";
  const expectedSelection = {preset: savedPreset, effectPath: game.reshade?.effectPath || null,
    effects: game.reshade?.effects ? [...game.reshade.effects] : null};
  const placement = game.graphics?.effectPlacement || "before";
  const automaticOrder = game.graphics?.neuralMethod === "mlx-dlss" || game.graphics?.frameGeneration === "lsfg" ||
    Boolean(game.graphics?.spatialMethod && game.graphics.spatialMethod !== "off") ||
    Boolean(game.graphics?.temporalMethod && game.graphics.temporalMethod !== "off");
  const presentation = status?.graphics?.hosts
    ? graphicsHost ? status.graphics.hosts[graphicsHost] : undefined : status?.graphics;
  const presets = (status?.presets || []).filter(item => graphicsInputs?.nativeVideo === true || !(item.nativeVideo || item.traits?.requiresVideoPlanes))
    .map(item => {
      if (item.depthHosts && (!graphicsHost || !item.depthHosts.includes(graphicsHost)))
        return { ...item, available: false, reason: "Requires game depth, which this presentation path does not provide." };
      return graphicsInputs?.nativeVideo === true && item.nativeVideoAvailable === true
        ? { ...item, available: true, reason: undefined } : item;
    });
  const legacyPreset = /^pack:([^:]+):[A-Za-z0-9][A-Za-z0-9._+-]*:([^:]+)$/.exec(savedPreset);
  const bundledAlias = legacyPreset ? `shader:${legacyPreset[1]}:${legacyPreset[2]}` : null;
  const preset = !presets.some(item => item.id === savedPreset) && bundledAlias && presets.some(item => item.id === bundledAlias)
    ? bundledAlias : savedPreset;
  const registered = status?.filters?.find(filter => `filter:${filter.id}` === preset);
  const filterPath = registered?.path;
  const effects = game.reshade?.effects || ["cas", "crt"];
  const included = presets.filter(item => item.id !== "custom" && item.id !== "chain" && !item.installed);
  const selected = presets.find(item => item.id === preset);
  const appearancePresets = presets.filter(item => !scalingShader(item.traits) || item.id === preset);
  const presetGroups = [...new Set(appearancePresets.map(item => shaderBehaviorGroup(item.traits)))];
  async function change(patch: Partial<GameReShadeSettings>) {
    setPickerError("");
    try {await onChange(game.gamePath, patch);}
    catch (error) {setPickerError(error instanceof Error ? error.message : "Shader settings could not be saved.");}
  }
  const changeEffects = (next: string[]) => void change({ effects: next });
  const moveEffect = (index: number, offset: number) => {
    const next = [...effects];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    changeEffects(next);
  };
  const filename = game.reshade?.effectPath?.split(/[\\/]/).pop();
  const format = registered ? registered.format === undefined ? shaderFormat(registered.path) : registered.format
    : shaderFormat(preset === "custom" ? game.reshade?.effectPath : filterPath);
  const reason = status?.reason || "Shaders and filters are unavailable in this installation.";
  async function chooseEffect() {
    if (picking.current) return;
    picking.current = true;setChoosing(true);setPickerError("");
    try {
      const api = window.MacLauncher?.launcher;
      if (!api?.pickGameEffectFile) throw new Error("Shader selection is unavailable.");
      const file = await api.pickGameEffectFile(game.gamePath);
      if (file) await onChange(game.gamePath, { preset: "custom", effectPath: file, parameters: null });
    } catch (error) { setPickerError(error instanceof Error ? error.message : "The shader file could not be selected."); }
    finally { picking.current = false;setChoosing(false); }
  }
  async function manageEffects() {
    try {
      const api = window.MacLauncher?.launcher;if (!api) throw new Error("Settings are unavailable.");
      await api.openUtilityWindow({ view: "settings", sectionId: "graphics:filters" });
    } catch (error) { setPickerError(error instanceof Error ? error.message : "Settings could not be opened."); }
  }
  return <section className="graphicsGroup" aria-label="Shaders and filters">
    <div className="graphicsGroupHeader">
      <div className="graphicsGroupTitle"><h4 className="detailSectionHeading">Shaders and filters</h4>
        <HelpTip label="About shaders and filters">ReShade, RetroArch Slang and MPV/libplacebo shaders for compatible graphics renderers. Some applications block effects.
          {onGraphicsChange && automaticOrder && <p>Effects use automatic order with reconstruction, scaling and frame generation. Advanced provides manual ordering.</p>}
          {running && <p>{graphicsInputs?.shaderBindingsNextLaunch === true ? "Video shader selections and parameters apply on the next launch."
            : live && status?.shaderLiveSwitching ? "Updates during play." : "Effect selection and order apply on the next launch."} Loading a different effect can briefly pause rendering.</p>}
        </HelpTip>
      </div>
      <div className="graphicsGroupActions">
        <label className="inlineCheck"><input type="checkbox" aria-label="Enable shaders and filters" checked={enabled}
          disabled={!available && !enabled} onChange={event => void change({ enabled: event.target.checked })} />Enable</label>
        <button className="btn small" onClick={() => void manageEffects()}>Manage effects…</button>
      </div>
    </div>
    {!available && <p className="detailMeta" role="status">{reason}</p>}
    {enabled && <>
      <div className="detailRow detailControlRow">
        <label className="detailLabel" htmlFor="game-reshade-preset">Preset <HelpTip label="About shader files">Included effects are available offline. Custom shader accepts ReShade .fx, RetroArch .slangp or .slang, and MPV/libplacebo .glsl or .hook files. Chains run from top to bottom.
          {(registered || preset === "custom" && filename) && <p>{shaderFormatLabel(format)}</p>}
        </HelpTip></label>
        <div className="detailActions">
          <select id="game-reshade-preset" className="input" aria-label="Shader or filter preset" value={preset}
            disabled={!available || choosing} onChange={event => event.target.value === "custom"
              ? chooseEffect() : change({ preset: event.target.value })}>
            {!presets.some(item => item.id === preset) && <option value={preset} disabled>{preset === "custom" ? "Custom effect" : "Unavailable preset"}</option>}
            {presetGroups.map(group => <optgroup key={group} label={group}>
              {appearancePresets.filter(item => shaderBehaviorGroup(item.traits) === group).map(item => <option key={item.id} value={item.id} disabled={item.available === false} title={item.reason}>{item.label}{item.available === false ? " — unavailable" : ""}</option>)}
            </optgroup>)}
          </select>
        </div>
      </div>
      {selected?.reason && <p className="detailMeta" role="status">{selected.reason}</p>}
      {scalingShader(selected?.traits) && <p className="detailMeta">This saved shader changes resolution. Scaling shaders are also available under Spatial upscaling.</p>}
      {preset === "chain" && <>
        {effects.map((id, index) => <div className="detailRow detailControlRow" key={index}>
          <label className="detailLabel" htmlFor={`game-reshade-effect-${index}`}>Effect {index + 1}</label>
          <div className="detailActions">
            <select id={`game-reshade-effect-${index}`} className="input" aria-label={`ReShade effect ${index + 1}`}
              value={id} disabled={!available} onChange={event => changeEffects(effects.map((value, i) => i === index ? event.target.value : value))}>
              {included.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
            <button className="btn small" aria-label={`Move effect ${index + 1} up`} title="Move up"
              disabled={!available || index === 0} onClick={() => moveEffect(index, -1)}>↑</button>
            <button className="btn small" aria-label={`Move effect ${index + 1} down`} title="Move down"
              disabled={!available || index === effects.length - 1} onClick={() => moveEffect(index, 1)}>↓</button>
            <button className="btn small" aria-label={`Remove effect ${index + 1}`} title="Remove effect"
              disabled={!available || effects.length <= 2} onClick={() => changeEffects(effects.filter((_, i) => i !== index))}>−</button>
          </div>
        </div>)}
        <div className="detailRow">
          <div className="detailLabel" />
          <div className="detailActions"><button className="btn small" disabled={!available || effects.length >= 4}
            onClick={() => changeEffects([...effects, "sharpen"])}>Add effect</button></div>
        </div>
      </>}
      {preset === "custom" && <div className="detailRow">
        <div className="detailLabel">Effect</div>
        <div className="detailValue ellipsis" title={game.reshade?.effectPath || undefined}>{filename || "No effect selected"}</div>
        <div className="detailActions"><button className="btn small" disabled={!available || choosing}
          onClick={chooseEffect}>Choose shader…</button></div>
      </div>}
      {onGraphicsChange && !automaticOrder && (presentation?.effectPlacement || placement === "after") && <>
        <div className="detailRow detailControlRow">
          <label className="detailLabel" htmlFor="game-effect-placement">Effects placement <HelpTip label="About effects placement">{placement === "after"
            ? "Temporal upscaling → Spatial upscaling → Effects → Frame generation. Effects run at output resolution and can cost more GPU time. Depth effects require Before spatial scaling when the image is resized."
            : "Temporal upscaling → Effects → Spatial upscaling → Frame generation."}
            {running && <p>Effects placement {live && presentation?.liveSwitching ? "updates during play." : "applies on the next launch."}</p>}
          </HelpTip></label>
          <select id="game-effect-placement" className="input" value={placement} disabled={!available}
            onChange={event => {
              setPickerError("");void onGraphicsChange(game.gamePath, { effectPlacement: event.target.value as "before" | "after" })
                .catch(error => setPickerError(error instanceof Error ? error.message : "Effects placement could not be saved."));
            }}>
            <option value="before">Before spatial scaling</option>
            <option value="after" disabled={!presentation?.effectPlacement}>After spatial scaling{presentation?.effectPlacement ? "" : " · Unavailable"}</option>
          </select>
        </div>
      </>}
      {status?.shaderParameters && <ShaderParameters key={JSON.stringify([game.gamePath, expectedSelection, filterPath])}
        gamePath={game.gamePath} settings={game.reshade} live={running && live === true && graphicsInputs?.shaderBindingsNextLaunch !== true}
        onChange={(path, patch) => onChange(path, patch, expectedSelection)} />}
    </>}
    {pickerError && <p className="detailMeta" role="alert">{pickerError}</p>}
  </section>;
}
