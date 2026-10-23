import React, { useEffect, useRef, useState } from "react";
import { fromLegacy, MAX_NODES, validate } from "../../../../modules/shared/effects/plan.mjs";
import type { EffectCatalogRow, GameEffectsInfo, GameEffectsPlan, GameGraphicsSettings,
  RecentGame, ReShadeState, RuntimeEntry, VideoEffectNode } from "../types";
import { ShaderParameters } from "./ShaderParameters";
import { GraphicsNumber } from "./GraphicsNumber";
import { shaderFormat, shaderFormatLabel } from "../shader-format";
import { HelpTip } from "./HelpTip";
import { EffectsPresetPicker } from "./EffectsPresetPicker";
import { spatialMenuMethods, spatialMethodLabel } from "../spatial-options";

export type EffectsDraftEditor = {
  info: GameEffectsInfo;
  onChange: (plan: GameEffectsPlan) => void;
  pickFile: (kind?: "neural-model") => Promise<string | null>;
  parameters: (nodeId: string, plan: GameEffectsPlan) => ReturnType<NonNullable<Window["MacLauncher"]>["launcher"]["getEffectsPresetParameters"]>;
};

type Props = {
  game: Pick<RecentGame, "gamePath" | "runtimeId" | "effects" | "reshade" | "graphics">;
  status?: ReShadeState;
  graphicsHost?: RuntimeEntry["graphicsHost"];
  running: boolean;
  live?: boolean;
  onManageModels?: () => void;
  editor?: EffectsDraftEditor;
  children: React.ReactNode;
  footer?: React.ReactNode;
};

function losslessRequirement(node: VideoEffectNode) {
  if (node.kind === "spatial" && node.method === "ls1") return node.settings?.ls1Mode === "performance" ? "ls1Performance" : "ls1Quality";
  if (node.kind === "frame-generation") return "lsfg" + (node.settings?.lsfgFp16 === false ? "Fp32" : "Fp16") + (node.settings?.lsfgMode === "performance" ? "Performance" : "Quality");
  return null;
}

export function effectChoice(node: VideoEffectNode, catalog: EffectCatalogRow[], status?: ReShadeState) {
  const choice = catalog.find(row => row.kind === node.kind && (node.kind === "shader"
    ? row.template.kind === "shader" && row.template.shader.preset === node.shader.preset
    : row.template.kind !== "shader" && row.template.method === node.method));
  const required = losslessRequirement(node);
  if (!choice || !required || choice.availableWithoutModel === undefined || !status?.models) return choice;
  const version = node.kind !== "shader" && node.kind !== "neural" ? node.settings?.modelVersion : null;
  const models = status.models.filter(model => model.capabilities.includes(required));
  const model = version ? models.find(model => model.version === version)
    : models.find(model => model.version === status.defaultModelVersion) || models[0];
  const {reason, ...row} = choice;
  return {...row, available: choice.availableWithoutModel && Boolean(model),
    ...(!choice.availableWithoutModel ? {reason} : !model ? {reason: "Compatible Lossless Scaling models are required."} : {})};
}

export function moveVideoEffect(plan: GameEffectsPlan, id: string, offset: number): GameEffectsPlan {
  const index = plan.video.findIndex(node => node.id === id), target = index + offset;
  if (index < 0 || target < 0 || target >= plan.video.length) return plan;
  const video = [...plan.video];[video[index], video[target]] = [video[target], video[index]];
  return { ...plan, video };
}

export function effectChooserRows(catalog: EffectCatalogRow[], query: string): EffectCatalogRow[] {
  const search = query.trim().toLocaleLowerCase();
  const methods = spatialMenuMethods(catalog.filter(row => row.template.kind === "spatial").map(row => (row.template as {method: string}).method));
  const choices = catalog.filter(row => row.template.kind !== "spatial" || methods.includes(row.template.method))
    .map(row => row.template.kind === "spatial" ? {...row, label: spatialMethodLabel(row.template.method, {[row.template.method]: row.label}, true)} : row)
    .filter(row => `${row.label} ${row.group} ${row.category || ""} ${row.kind} ${row.reason || ""}`.toLocaleLowerCase().includes(search));
  if (search) return choices;
  const standard = choices.filter(row => row.kind === "spatial" && row.group === "Upscaling" && row.category === "Standard filters");
  const defaultFilter = standard.find(row => row.template.kind === "spatial" && row.template.method === "bilinear" && row.available)
    || standard.find(row => row.available) || standard[0];
  return choices.flatMap(row => standard.includes(row)
    ? row === defaultFilter ? [{ ...row, label: "Standard filters" }] : [] : [row]);
}

function EffectOptions({ catalog, kind, selectedMethod, sizeLimited = false, windowEnlargement = false }: { catalog: EffectCatalogRow[]; kind: VideoEffectNode["kind"]; selectedMethod?: string; sizeLimited?: boolean; windowEnlargement?: boolean }) {
  const methods = spatialMenuMethods(catalog.filter(row => row.template.kind === "spatial").map(row => (row.template as {method: string}).method), selectedMethod);
  const rows = catalog.filter(row => row.kind === kind && (row.template.kind !== "spatial" || methods.includes(row.template.method))), categories = [...new Set(rows.map(row => row.category || row.group))];
  return <>{categories.map(category => <optgroup key={category} label={category}>
    {rows.filter(row => (row.category || row.group) === category).map(row => {
      const limited = sizeLimited && row.template.kind === "spatial" && row.template.method !== "downsample";
      const reductionLimited = windowEnlargement && row.template.kind === "spatial" && row.template.method === "downsample";
      return <option key={row.id} value={row.id} disabled={!row.available || limited || reductionLimited} title={limited ? "Set both output dimensions to use another filter." : reductionLimited ? "Choose a window size of 100% or less to use Downsample." : row.reason}>{row.template.kind === "spatial" ? spatialMethodLabel(row.template.method, {[row.template.method]: row.label}, true) : row.label}{limited ? " · Requires width and height" : reductionLimited ? " · Requires 100% or less" : row.available ? "" : " · Unavailable"}</option>;
    })}
  </optgroup>)}</>;
}

const kindLabels = { shader: "Shader", spatial: "Spatial scaling", temporal: "Temporal upscaling", neural: "Neural reconstruction", "frame-generation": "Frame generation" };
const errorText = (error: unknown) => error instanceof Error ? error.message : "Effects could not be updated.";
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

export function EffectsControls({ game, status, graphicsHost, running, live, onManageModels, editor, children, footer }: Props) {
  const [advanced, setAdvanced] = useState(Boolean(editor || game.effects));
  const [plan, setPlan] = useState<GameEffectsPlan>(() => fromLegacy(game) as GameEffectsPlan);
  const [info, setInfo] = useState<GameEffectsInfo | null>(editor?.info || null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [adding, setAdding] = useState(false), [query, setQuery] = useState("");
  const saving = useRef(false), resetting = useRef(false), revision = useRef(0), request = useRef(0);
  const picking = useRef(false);
  const search = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const catalog = info?.catalog || [];
  const support = status?.graphics?.hosts ? graphicsHost ? status.graphics.hosts[graphicsHost] : undefined : status?.graphics;
  const sourceAvailable = Boolean(info?.sourceResolution && (info.sourceResolution.heights || info.sourceResolution.multipliers.length > 0));
  const sourceControls = sourceAvailable || Boolean(plan.renderResolution);
  const sourceMethods = info?.sourceResolution?.methods || [], sourceTemporal = plan.video.some(node => node.enabled && node.kind === "temporal");
  useEffect(() => {
    if (saving.current) return;
    setPlan(fromLegacy(game) as GameEffectsPlan);
    if (game.effects) setAdvanced(true);
  }, [game.effects, game.reshade, game.graphics]);
  useEffect(() => {
    if (editor) { setInfo(editor.info);return; }
    if (!advanced) return;
    const token = ++request.current, atRevision = revision.current;
    setLoading(true);setError("");
    Promise.resolve().then(() => {
      const api = window.MacLauncher?.launcher;
      if (!api) throw new Error("Effects controls are unavailable.");
      return api.getGameEffects(game.gamePath);
    }).then(result => {
      if (token !== request.current) return;
      setInfo(result);
      if (!saving.current && revision.current === atRevision) setPlan(result.plan);
    }).catch(error => { if (token === request.current) setError(errorText(error)); })
      .finally(() => { if (token === request.current) setLoading(false); });
    return () => { request.current++; };
  }, [advanced, running, game.gamePath, game.runtimeId, game.effects, game.reshade, game.graphics, status, graphicsHost, editor?.info]);
  useEffect(() => { if (adding) search.current?.focus(); }, [adding]);

  async function commit(next: GameEffectsPlan, propagateError = false) {
    if (saving.current) return;
    const previous = plan;
    saving.current = true;const atRevision = ++revision.current;setBusy(true);setError("");
    let saved = false;
    try {
      const canonical = validate(next) as GameEffectsPlan;
      if (editor) { editor.onChange(canonical);setPlan(canonical);return; }
      const api = window.MacLauncher?.launcher;
      if (!api) throw new Error("Effects controls are unavailable.");
      setPlan(canonical);
      if (!await api.setGameEffects(game.gamePath, canonical)) throw new Error("Effects could not be saved.");
      saved = true;
      if (revision.current !== atRevision) return;
      const result = await api.getGameEffects(game.gamePath);
      if (revision.current === atRevision) {setInfo(result);setPlan(result.plan);}
    } catch (error) {
      if (revision.current !== atRevision) return;
      if (!saved) setPlan(previous);if (propagateError && !saved) throw error;setError(errorText(error));
    } finally { if (revision.current === atRevision) {saving.current = false;setBusy(false);} }
  }
  async function pickFile(kind?: "neural-model") {
    if (editor) return editor.pickFile(kind);
    const api = window.MacLauncher?.launcher;
    if (!api?.pickGameEffectFile) throw new Error("Effect file selection is unavailable.");
    return api.pickGameEffectFile(game.gamePath, kind);
  }
  function update(node: VideoEffectNode, propagateError = false) { return commit({ ...plan, video: plan.video.map(current => current.id === node.id ? node : current) }, propagateError); }
  async function reset() {
    if (resetting.current || picking.current) return;
    if (!game.effects && info?.mode !== "advanced" && !saving.current) {
      request.current++;setAdvanced(false);setAdding(false);setInfo(null);return;
    }
    resetting.current = true;saving.current = true;const atRevision = ++revision.current;setBusy(true);setError("");
    try {
      const api = window.MacLauncher?.launcher;
      if (!api || !await api.resetGameEffects(game.gamePath)) throw new Error("Effects could not be reset.");
      request.current++;setAdvanced(false);setAdding(false);setInfo(null);
    } catch (error) { setError(errorText(error)); }
    finally { resetting.current = false;if (revision.current === atRevision) {saving.current = false;setBusy(false);} }
  }
  async function pick(node: Extract<VideoEffectNode, { kind: "shader" }>) {
    if (picking.current || saving.current) return;
    picking.current = true;setBusy(true);setError("");
    try {
      const file = await pickFile();
      if (file) await update({ ...node, shader: { ...node.shader, preset: "custom", effectPath: file, parameters: null } });
    } catch (error) { setError(errorText(error)); }
    finally { picking.current = false;setBusy(false); }
  }
  async function pickModel(node: Extract<VideoEffectNode, { kind: "neural" }>) {
    if (picking.current || saving.current) return;
    picking.current = true;setBusy(true);setError("");
    try {
      const file = await pickFile("neural-model");
      if (file) await update({ ...node, settings: { ...node.settings, modelPath: file } });
    } catch (error) { setError(errorText(error)); }
    finally { picking.current = false;setBusy(false); }
  }
  async function manageNeuralModels() {
    try { await window.MacLauncher?.launcher.openUtilityWindow({ view: "runtimes", managerId: "graphics-neural-models" }); }
    catch (error) { setError(errorText(error)); }
  }
  async function manageEffects() {
    try {
      const api = window.MacLauncher?.launcher;if (!api) throw new Error("Settings are unavailable.");
      await api.openUtilityWindow({ view: "settings", sectionId: "graphics:filters" });
    } catch (error) { setError(errorText(error)); }
  }
  async function add(row: EffectCatalogRow) {
    if (picking.current || saving.current) return;
    setError("");
    try {
      const node: VideoEffectNode = { ...clone(row.template), id: crypto.randomUUID(), enabled: true };
      if (node.kind === "shader" && node.shader.preset === "custom") {
        picking.current = true;setBusy(true);
        const file = await pickFile();
        if (!file) return;
        node.shader = { ...node.shader, effectPath: file, parameters: null };
      }
      if (node.kind === "neural") {
        picking.current = true;setBusy(true);
        const file = await pickFile("neural-model");
        if (!file) return;
        node.settings = { ...node.settings, modelPath: file };
      }
      setAdding(false);setQuery("");await commit({ ...plan, video: [...plan.video, node] });
    } catch (error) { setError(errorText(error)); }
    finally { picking.current = false;setBusy(false); }
  }
  const choices = effectChooserRows(catalog, query);
  const groups = [...new Set(choices.map(row => row.group))];
  return <section className="effectsControls" aria-label={editor ? "Ordered graphics effects" : "Graphics"}>
    {!editor && <div className="effectsModeRow graphicsHeader">
      <div className="graphicsHeaderTitle"><h3 className="detailSectionHeading">Graphics</h3>
        <HelpTip label="About effects modes">Effects run from top to bottom. Advanced keeps simple settings until the first edit.
          {running && (advanced ? info?.live ? info.shaderBindingsNextLaunch ? " Video shader selections apply on the next launch; other supported changes update during play." : " Supported changes update during play." : " Changes apply on the next launch."
            : live ? " Supported changes can update during play." : " Changes apply on the next launch.")}</HelpTip>
      </div>
      {advanced ? <div className="graphicsGroupActions"><span className="detailMeta">{game.effects || info?.mode === "advanced" ? "Advanced" : "Advanced preview"}</span><button className="btn small" disabled={resetting.current || picking.current} onClick={() => reset()}>Return to simple</button>
        <HelpTip label="About returning to simple">{game.effects || info?.mode === "advanced"
          ? "Return to simple clears this chain and turns off this game's shaders, scaling and frame generation."
          : "Return to simple keeps the current simple settings. The preview changes no settings until the first edit."}</HelpTip></div>
        : <button className="btn small" onClick={() => setAdvanced(true)}>Advanced…</button>}
    </div>}
    {!advanced ? children : <>
      {!editor && <>
        <EffectsPresetPicker plan={plan} templates={info?.templates} disabled={busy || loading || !info} onApply={commit} /></>}
      {loading && !info && <p className="detailMeta" role="status">Loading available effects…</p>}
      <fieldset className="effectsEditor" disabled={busy || loading || !info}>
        <legend className="srOnly">Ordered video effects</legend>
        {sourceControls ? <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor="effects-game-rendering">Game rendering <HelpTip label="About game rendering">Auto preserves the game's render size. Divisors reduce each dimension from the presentation size; fixed heights preserve its aspect ratio. The selected runtime's source adapter controls its render target. Window size, dragging and fullscreen remain independent. {info?.sourceResolution?.live ? "Updates during play." : "Applies on the next launch."}</HelpTip></label>
          <select id="effects-game-rendering" className="input"
            value={plan.renderResolution ? "height" in plan.renderResolution ? `${plan.renderResolution.maximum ? "maximum" : "height"}:${plan.renderResolution.height}` : `multiplier:${plan.renderResolution.multiplier}` : "auto"}
            onChange={event => {
              const [kind, value] = event.target.value.split(":");
              const method = plan.renderResolution?.method ? { method: plan.renderResolution.method } : {};
              return commit({ ...plan, renderResolution: kind === "height" ? { height: Number(value), ...method } : kind === "multiplier" ? { multiplier: Number(value), ...method } : undefined });
            }}>
            <option value="auto">Auto · Game resolution</option>
            {plan.renderResolution && "height" in plan.renderResolution && plan.renderResolution.maximum && <option value={`maximum:${plan.renderResolution.height}`} disabled>Up to {plan.renderResolution.height}p{info?.sourceResolution?.heights ? "" : " · Unavailable"}</option>}
            {plan.renderResolution && "multiplier" in plan.renderResolution && !info?.sourceResolution?.multipliers.includes(plan.renderResolution.multiplier) && <option value={`multiplier:${plan.renderResolution.multiplier}`} disabled>÷{plan.renderResolution.multiplier} · Unavailable</option>}
            {plan.renderResolution && "multiplier" in plan.renderResolution && plan.renderResolution.multiplier === 1 && info?.sourceResolution?.multipliers.includes(1) && <option value="multiplier:1">÷1 · Presentation size</option>}
            {(info?.sourceResolution?.multipliers || []).filter(factor => factor !== 1).map(factor => <option key={factor} value={`multiplier:${factor}`}>÷{factor} · Each dimension</option>)}
            {plan.renderResolution && "height" in plan.renderResolution && !plan.renderResolution.maximum && (!info?.sourceResolution?.heights || ![480, 720].includes(plan.renderResolution.height)) && <option value={`height:${plan.renderResolution.height}`} disabled={!info?.sourceResolution?.heights}>{plan.renderResolution.height}p{info?.sourceResolution?.heights ? "" : " · Unavailable"}</option>}
            {info?.sourceResolution?.heights && <><option value="height:480">480p</option><option value="height:720">720p</option></>}
          </select></div> : null}
        {sourceControls && plan.renderResolution && sourceMethods.length > 0 && <div className="detailRow detailControlRow">
          <label className="detailLabel" htmlFor="effects-source-filter">Source filter <HelpTip label="About source filtering">Selects the source renderer's scaling filter. Game original retains its existing filter. Shared effects remain separate. {info?.sourceResolution?.live ? "Updates during play." : "Applies on the next launch."}{sourceTemporal && " Source filter choices require temporal stages to be off; Game original remains available."}</HelpTip></label>
          <select id="effects-source-filter" className="input" value={plan.renderResolution.method || ""} onChange={event => {
            if (!plan.renderResolution) return;
            const renderResolution = { ...plan.renderResolution };
            if (event.target.value) renderResolution.method = event.target.value;else delete renderResolution.method;
            return commit({ ...plan, renderResolution });
          }}>
            <option value="">Game original</option>
            {plan.renderResolution.method && !sourceMethods.includes(plan.renderResolution.method) && <option value={plan.renderResolution.method} disabled>{plan.renderResolution.method} · Unavailable</option>}
            {sourceMethods.map(method => <option key={method} value={method} disabled={sourceTemporal}>{info?.sourceResolution?.methodLabels?.[method] || method}</option>)}
          </select></div>}
        <ol className="effectsList" aria-label="Video effects">
          {plan.video.map((node, index) => {
            const choice = effectChoice(node, catalog, status), name = node.kind === "spatial"
              ? spatialMethodLabel(node.method, choice ? {[node.method]: choice.label} : {}, true)
              : choice?.label || (node.kind === "shader" ? node.shader.preset : node.method);
            const filter = node.kind === "shader" ? status?.filters?.find(row => `filter:${row.id}` === node.shader.preset) : undefined;
            const sizeLimited = node.kind === "spatial" && Boolean(node.outputSize && (node.outputSize.width == null || node.outputSize.height == null));
            return <li className="effectNode" key={node.id}>
              <div className="effectNodeHeader">
                <span className="effectOrdinal" aria-hidden="true">{index + 1}</span>
                <label className="inlineCheck effectEnabled"><input type="checkbox" checked={node.enabled}
                  aria-label={`Enable ${name}`} disabled={!node.enabled && choice?.available === false}
                  onChange={event => void update({ ...node, enabled: event.target.checked })} />
                  <span className="effectNodeTitle">{name}<small>{kindLabels[node.kind]}</small></span></label>
                <div className="effectNodeActions">
                  <button className="btn small" aria-label={`Move ${name} up`} title="Move up" disabled={index === 0}
                    onClick={() => void commit(moveVideoEffect(plan, node.id, -1))}>↑</button>
                  <button className="btn small" aria-label={`Move ${name} down`} title="Move down" disabled={index === plan.video.length - 1}
                    onClick={() => void commit(moveVideoEffect(plan, node.id, 1))}>↓</button>
                  <button className="btn small" aria-label={`Remove ${name}`} title="Remove effect"
                    onClick={() => void commit({ ...plan, video: plan.video.filter(item => item.id !== node.id) })}>Remove</button>
                </div>
              </div>
              {choice?.available === false && <p className="detailMeta" role="status">{choice.reason || "This effect is unavailable for this runtime."}</p>}
              {!choice && info && <p className="detailMeta" role="status">Effect unavailable. Select another effect.</p>}
              <details className="effectNodeSettings"><summary>Settings</summary>
                <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={`effect-choice-${node.id}`}>Effect
                  {node.kind === "temporal" && <HelpTip label="About temporal inputs">Requires renderer motion vectors, depth and jitter. Render resolution follows game settings.</HelpTip>}
                  {node.kind === "shader" && (filter || node.shader.preset === "custom" && node.shader.effectPath) && <HelpTip label="About shader format">{shaderFormatLabel(filter ? filter.format === undefined ? shaderFormat(filter.path) : filter.format : shaderFormat(node.shader.effectPath))}</HelpTip>}</label>
                  <select id={`effect-choice-${node.id}`} className="input" value={choice?.id || ""} onChange={event => {
                    const selected = catalog.find(row => row.id === event.target.value);
                    if (selected?.template.kind === "shader" && selected.template.shader.preset === "custom" && node.kind === "shader") return pick(node);
                    if (selected?.template.kind === "spatial" && node.kind === "spatial") {
                      return update({ ...clone(selected.template), id: node.id, enabled: node.enabled,
                        ...(node.outputSize ? {outputSize: node.outputSize} : {}),
                        ...(node.presentationScale != null ? {presentationScale: node.presentationScale} : {}),
                        settings: {...selected.template.settings, ...node.settings,
                          spatialMethod: selected.template.method as GameGraphicsSettings["spatialMethod"]} });
                    }
                    if (selected) return update({ ...clone(selected.template), id: node.id, enabled: node.enabled });
                  }}>
                    {!choice && <option value="" disabled>{name}</option>}
                    <EffectOptions catalog={catalog.map(row => choice && row.id === choice.id ? choice : row)} kind={node.kind} selectedMethod={node.kind === "spatial" ? node.method : undefined} sizeLimited={sizeLimited} windowEnlargement={node.kind === "spatial" && (node.presentationScale ?? 0) > 1} />
                  </select>
                </div>
                {sizeLimited && <p className="detailMeta">Another filter requires both dimensions.</p>}
                {node.kind === "shader" ? <>
                  {node.shader.preset === "chain" && <>
                    {(node.shader.effects || ["cas", "crt"]).map((effect, effectIndex, effects) => <div className="detailRow detailControlRow" key={effectIndex}>
                      <label className="detailLabel" htmlFor={`effect-${node.id}-pass-${effectIndex}`}>Shader {effectIndex + 1}</label>
                      <div className="detailActions"><select id={`effect-${node.id}-pass-${effectIndex}`} className="input" value={effect}
                        onChange={event => void update({ ...node, shader: { ...node.shader, effects: effects.map((item, i) => i === effectIndex ? event.target.value : item), parameters: null } })}>
                        {status?.presets.filter(row => !row.installed && !["chain", "custom"].includes(row.id)).map(row => <option key={row.id} value={row.id} disabled={row.available === false}>{row.label}</option>)}
                      </select><button className="btn small" aria-label={`Remove shader ${effectIndex + 1}`} disabled={effects.length <= 2}
                        onClick={() => void update({ ...node, shader: { ...node.shader, effects: effects.filter((_, i) => i !== effectIndex), parameters: null } })}>Remove</button></div>
                    </div>)}
                    <button className="btn small" disabled={(node.shader.effects || ["cas", "crt"]).length >= 4}
                      onClick={() => void update({ ...node, shader: { ...node.shader, effects: [...(node.shader.effects || ["cas", "crt"]), "sharpen"], parameters: null } })}>Add shader</button>
                  </>}
                  {node.shader.preset === "custom" && <div className="detailRow"><span className="detailLabel">File</span>
                    <span className="detailValue ellipsis" title={node.shader.effectPath || undefined}>{node.shader.effectPath?.split(/[\\/]/).pop() || "No shader selected"}</span>
                    <button className="btn small" onClick={() => pick(node)}>Choose shader…</button></div>}
                  {status?.shaderParameters && <ShaderParameters key={JSON.stringify([node.id, node.shader.preset, node.shader.effects, node.shader.effectPath, filter?.path])}
                    idPrefix={`effect-${node.id}`} gamePath={game.gamePath} settings={node.shader} live={running && info?.live === true && info.shaderBindingsNextLaunch !== true}
                    loadParameters={async () => {
                      if (editor) return editor.parameters(node.id, plan);
                      const api = window.MacLauncher?.launcher;if (!api) throw new Error("Shader controls are unavailable.");
                      return api.getGameEffectParameters(game.gamePath, node.id, plan);
                    }} onChange={async (_, patch) => { await update({ ...node, shader: { ...node.shader, ...patch } }, true); }} />}
                </> : node.kind === "neural" ? <>
                  <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={`effect-${node.id}-model`}>Model</label>
                    <select id={`effect-${node.id}-model`} className="input" value={node.settings.modelPath || ""} onChange={event => {
                      if (!event.target.value) return pickModel(node);
                      return update({ ...node, settings: { ...node.settings, modelPath: event.target.value } });
                    }}>
                      <option value="">Choose local file…</option>
                      {node.settings.modelPath && !status?.neuralModels?.some(model => model.modelPath === node.settings.modelPath) && <option value={node.settings.modelPath}>Local model</option>}
                      {status?.neuralModels?.map(model => <option key={model.version} value={model.modelPath}>{model.versionLabel || model.version}</option>)}
                    </select><button className="btn small" onClick={() => void manageNeuralModels()}>Manage models…</button></div>
                  <div className="detailRow"><span className="detailLabel">File</span>
                    <span className="detailValue ellipsis" title={node.settings.modelPath || undefined}>{node.settings.modelPath?.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "No model selected"}</span>
                    <button className="btn small" onClick={() => pickModel(node)}>Choose model…</button></div>
                  <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={`effect-${node.id}-intensity`}>Intensity <HelpTip label="About neural intensity">Ranges from 0 to 1. The default, 1, uses full model output; lower values blend the reconstruction with the input.</HelpTip></label>
                    <input id={`effect-${node.id}-intensity`} type="range" min="0" max="1" step="0.05" value={node.settings.intensity}
                      onChange={event => void update({ ...node, settings: { ...node.settings, intensity: Number(event.target.value) } })} /></div>
                  <label className="inlineCheck"><input type="checkbox" checked={node.settings.temporal}
                    onChange={event => void update({ ...node, settings: { ...node.settings, temporal: event.target.checked } })} />Temporal reconstruction
                    <HelpTip label="About neural temporal reconstruction">Estimate motion between captured frames and retain rendering history. Uses additional GPU time.</HelpTip></label>
                </> : <EffectGraphicsSettings node={node} status={status} adaptive={support?.adaptive === true}
                  onChange={settings => void update({ ...node, settings: { ...node.settings, ...settings } })}
                  onSpatialSizeChange={size => void update({ ...node, outputSize: size.outputSize, presentationScale: size.presentationScale, settings: { ...node.settings, spatialMultiplier: size.spatialMultiplier } })}
                  onManageModels={onManageModels} />}
              </details>
            </li>;
          })}
        </ol>
        {plan.video.length === 0 && <p className="detailMeta">No effects.</p>}
        <button ref={addButton} className="btn small" aria-expanded={adding} aria-controls="add-video-effect" disabled={!info || plan.video.length >= MAX_NODES}
          onClick={() => setAdding(!adding)}>Add effect…</button>
        {adding && <div id="add-video-effect" className="effectChooser" role="region" aria-label="Add video effect">
          <input ref={search} className="input" type="search" aria-label="Search effects" placeholder="Search effects" value={query}
            onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation();setAdding(false);setQuery("");addButton.current?.focus(); } }} />
          <div className="detailActions"><button className="btn small" onClick={() => void manageEffects()}>Manage effects…</button></div>
          {groups.map(group => <div key={group} className="effectChoiceGroup"><h4>{group}</h4>
            {choices.filter(row => row.group === group).map(row => <button key={row.id} className="effectChoice" disabled={!row.available}
              title={row.reason} onClick={() => void add(row)}><span>{row.label}</span><small>{row.available ? kindLabels[row.kind] : row.reason || "Unavailable"}</small></button>)}
          </div>)}
          {!choices.length && <p className="detailMeta" role="status">No matching effects.</p>}
        </div>}
      </fieldset>
    </>}
    {error && <p className="detailMeta" role="alert">{error}</p>}
    {footer}
  </section>;
}

type SpatialSize = { spatialMultiplier: number | null; outputSize?: { width?: number; height?: number }; presentationScale?: number };

function SpatialOutputSettings({ nodeId, multiplier, outputSize, presentationScale, downsample, onChange }: {
  nodeId: string; multiplier: number | null | undefined; outputSize?: SpatialSize["outputSize"];
  presentationScale?: number;
  downsample: boolean;
  onChange: (size: SpatialSize) => void;
}) {
  const [custom, setCustom] = useState(Boolean(outputSize));
  const [width, setWidth] = useState(outputSize?.width != null ? String(outputSize.width) : "");
  const [height, setHeight] = useState(outputSize?.height != null ? String(outputSize.height) : "");
  useEffect(() => {
    setCustom(Boolean(outputSize));setWidth(outputSize?.width != null ? String(outputSize.width) : "");setHeight(outputSize?.height != null ? String(outputSize.height) : "");
  }, [outputSize?.width, outputSize?.height, multiplier, presentationScale]);
  const valid = (value: string) => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 16384;
  const saveCustom = () => {
    if ((!width && !height) || width && !valid(width) || height && !valid(height) || !downsample && (!width || !height)) return;
    const next = { ...(width ? {width: Number(width)} : {}), ...(height ? {height: Number(height)} : {}) };
    if (outputSize?.width !== next.width || outputSize?.height !== next.height) onChange({ spatialMultiplier: null, outputSize: next });
  };
  const id = (name: string) => `effect-${nodeId}-${name}`;
  const factors = downsample ? [2 / 3, 0.5, 0.25] : [0.25, 0.5, 2 / 3, 1, 1.5, 2, 3, 4];
  const windowFactors = downsample ? [0.25, 1 / 3, 0.5, 2 / 3, 1] : [0.25, 1 / 3, 0.5, 2 / 3, 1, 1.5, 2, 3, 4];
  const factorLabel = (factor: number) => factor < 1 ? `÷${factor === 2 / 3 ? 1.5 : 1 / factor}` : `${factor}×`;
  return <>
    <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={id("output-size")}>Output size <HelpTip label="About effect output size">Auto fits the window. Factors scale the previous stage or the window size. Downsample never enlarges its input. Custom accepts whole pixels from 1 to 16384 per dimension; both dimensions set a fixed size. For Downsample, a single dimension limits size while preserving aspect ratio. Other filters require both dimensions. Game rendering stays unchanged.</HelpTip></label>
      <select id={id("output-size")} className="input" value={custom ? "custom" : presentationScale != null ? `window:${presentationScale}` : multiplier ?? "auto"}
        onChange={event => {
          const selected = event.target.value;setCustom(selected === "custom");
          if (selected !== "custom") onChange(selected.startsWith("window:")
            ? { spatialMultiplier: null, presentationScale: Number(selected.slice(7)) }
            : { spatialMultiplier: selected === "auto" ? null : Number(selected) });
        }}>
        {!downsample && <option value="auto">Auto · Presentation size</option>}
        {downsample && multiplier == null && !outputSize && <option value="auto" disabled>Select output size</option>}
        <optgroup label="Previous stage">
          {multiplier != null && !factors.includes(multiplier) && <option value={multiplier}>{factorLabel(multiplier)} · Previous stage</option>}
          {factors.map(factor => <option key={factor} value={factor}>{factorLabel(factor)} · Previous stage</option>)}
        </optgroup>
        <optgroup label="Window size">
          {presentationScale != null && !windowFactors.includes(presentationScale) && <option value={`window:${presentationScale}`}>{factorLabel(presentationScale)} · Window size</option>}
          {windowFactors.map(factor => <option key={factor} value={`window:${factor}`}>{factorLabel(factor)} · Window size</option>)}
        </optgroup>
        <option value="custom">Custom · Pixels</option>
      </select></div>
    {custom && <>
      {(["width", "height"] as const).map(axis => {
        const value = axis === "width" ? width : height;
        return <div className="detailRow detailControlRow" key={axis}><label className="detailLabel" htmlFor={id(`output-${axis}`)}>{axis === "width" ? "Width" : "Height"}</label>
          <input id={id(`output-${axis}`)} className="input" type="number" min="1" max="16384" step="1" inputMode="numeric" placeholder="Pixels" value={value}
            aria-invalid={value !== "" && !valid(value) || undefined}
            onChange={event => (axis === "width" ? setWidth : setHeight)(event.target.value)} onBlur={saveCustom}
            onKeyDown={event => { if (event.key === "Enter") { event.preventDefault();saveCustom(); } }} /></div>;
      })}
    </>}
  </>;
}

function EffectGraphicsSettings({ node, status, adaptive, onChange, onSpatialSizeChange, onManageModels }: {
  node: Exclude<VideoEffectNode, { kind: "shader" | "neural" }>; status?: ReShadeState; adaptive: boolean;
  onChange: (patch: Partial<GameGraphicsSettings>) => void; onManageModels?: () => void;
  onSpatialSizeChange: (size: SpatialSize) => void;
}) {
  const value = node.settings || {}, id = (name: string) => `effect-${node.id}-${name}`;
  const required = losslessRequirement(node);
  return <>
    {node.kind === "spatial" && <>
      <SpatialOutputSettings nodeId={node.id} multiplier={value.spatialMultiplier} outputSize={node.outputSize} presentationScale={node.presentationScale} downsample={node.method === "downsample"} onChange={onSpatialSizeChange} />
      {["fsr1", "mako", "ls1"].includes(node.method) && <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={id("sharpness")}>Sharpness</label>
        <input id={id("sharpness")} type="range" min="0" max="1" step="0.05" value={value.spatialSharpness ?? 0.5} onChange={event => onChange({ spatialSharpness: Number(event.target.value) })} /></div>}
      {node.method === "ls1" && <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={id("ls1-mode")}>LS1 mode</label>
        <select id={id("ls1-mode")} className="input" value={value.ls1Mode || "quality"} onChange={event => onChange({ ls1Mode: event.target.value as "quality" | "performance" })}>
          <option value="quality">Quality</option><option value="performance">Performance</option></select></div>}
    </>}
    {node.kind === "temporal" && <>
      {["fsr2", "fsr3", "fsr4"].includes(node.method) && <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={id("temporal-sharpness")}>Sharpness</label>
        <input id={id("temporal-sharpness")} type="range" min="0" max="1" step="0.05" value={value.temporalSharpness ?? 0.5} onChange={event => onChange({ temporalSharpness: Number(event.target.value) })} /></div>}
    </>}
    {node.kind === "frame-generation" && <>
      <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={id("multiplier")}>Frame multiplier <HelpTip label="About frame multiplication">Requires compatible Lossless Scaling models and opaque SDR output. Generated frames can add delay and artifacts. Displayed frame rate depends on the game, processing and display.</HelpTip></label>
        <select id={id("multiplier")} className="input" value={value.frameMultiplier ?? 2} onChange={event => onChange({ frameMultiplier: Number(event.target.value) })}>
          {[2, 3, 4, 5].map(factor => <option key={factor} value={factor}>{factor}× frame rate</option>)}</select></div>
      <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={id("pacing")}>Frame pacing</label>
        <select id={id("pacing")} className="input" value={value.framePacing || "fixed"} onChange={event => onChange({ framePacing: event.target.value as "fixed" | "adaptive" })}>
          <option value="fixed">Fixed</option><option value="adaptive" disabled={!adaptive}>Adaptive{adaptive ? "" : " · Unavailable"}</option></select></div>
      {value.framePacing === "adaptive" && <>
        <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={id("target")}>Target frame rate</label>
          <GraphicsNumber id={id("target")} className="input" min="30" max="240" step="1" value={value.targetFps ?? 120} onValue={targetFps => onChange({ targetFps })} /></div>
        <label className="inlineCheck"><input type="checkbox" checked={value.smoothCadence ?? false} onChange={event => onChange({ smoothCadence: event.target.checked })} />Smooth cadence</label>
      </>}
      <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={id("mode")}>LSFG mode</label>
        <select id={id("mode")} className="input" value={value.lsfgMode || "quality"} onChange={event => onChange({ lsfgMode: event.target.value as "quality" | "performance" })}>
          <option value="quality">Quality</option><option value="performance">Performance</option></select></div>
      <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={id("precision")}>Precision</label>
        <select id={id("precision")} className="input" value={value.lsfgFp16 === false ? "fp32" : "fp16"} onChange={event => onChange({ lsfgFp16: event.target.value === "fp16" })}>
          <option value="fp16">16-bit</option><option value="fp32">32-bit</option></select></div>
      <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={id("flow")}>Motion estimation scale</label>
        <input id={id("flow")} type="range" min="0.25" max="1" step="0.05" value={value.lsfgFlowScale ?? 1} onChange={event => onChange({ lsfgFlowScale: Number(event.target.value) })} /></div>
    </>}
    {required && <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={id("models")}>Models</label><div className="detailActions">
      <select id={id("models")} className="input" value={value.modelVersion || ""} onChange={event => onChange({ modelVersion: event.target.value || null })}>
        <option value="">Default{status?.defaultModelVersion ? "" : " · None selected"}</option>
        {value.modelVersion && !status?.models?.some(model => model.version === value.modelVersion) && <option value={value.modelVersion} disabled>Unavailable model</option>}
        {status?.models?.map(model => <option key={model.version} value={model.version} disabled={!model.capabilities.includes(required)}>{model.label}{model.capabilities.includes(required) ? "" : " · Incompatible"}</option>)}
      </select>{onManageModels && <button className="btn small" onClick={onManageModels}>Manage models…</button>}</div></div>}
  </>;
}
