import React from "react";
import type {EffectCatalogRow, VideoEffectNode} from "../types";
import type {EffectsEditor} from "../useEffectsEditor";
import {implementationsFor, orderImplementations, type GraphicsType} from "../../../../modules/shared/effects/contracts.mjs";
import {implementationHeading, implementationMore, implementationName, orderImplementationGroups, implementationHelp} from "../../../../modules/shared/effects/presentation.mjs";
import {MAX_NODES} from "../../../../modules/shared/effects/plan.mjs";
import {shaderFormat, shaderFormatLabel} from "../shader-format";
import {spatialMenuMethods, spatialMethodLabel} from "../spatial-options";
import {acceptsShaders, choiceDetail, customShader, effectAvailability, effectTypes, inputsLabel, kindLabels, resizeKind, selectable} from "../effects-catalog";
import {ImplementationPicker, type ImplementationOption} from "./ImplementationPicker";
import {EffectRowControls} from "./EffectRowControls";
import {HelpTip} from "./HelpTip";
import {isolatedItem} from "./ItemBoundary";
import {StatusBadge} from "./StatusBadge";

const resizeHeightPresets = [540, 720, 1080];
const EFFECT_DRAG = "application/x-maclauncher-effect";

function effectOptions({catalog, type, selectedMethod, selected, windowEnlargement = false}: {catalog: readonly EffectCatalogRow[]; type: GraphicsType; selectedMethod?: string; selected?: EffectCatalogRow; windowEnlargement?: boolean}): ImplementationOption[] {
  const methods = spatialMenuMethods(catalog.filter(row => resizeKind(row.template.kind)).map(row => (row.template as {method: string}).method), selectedMethod);
  // As in the Simple and Add menus, a saved combined-effects row lists itself only while selected.
  const library = catalog.filter(row => !row.nodeId && selectable(row) && !(row.template.kind === "shader" && row.template.shader.preset === "chain"));
  const compatible = orderImplementationGroups(orderImplementations(implementationsFor(type, library)), type);
  if (selected) {const index = compatible.findIndex(row => row.id === selected.id);if (index >= 0) compatible[index] = selected;else compatible.unshift(selected);}
  return compatible.filter(row => !resizeKind(row.template.kind) || row.template.kind !== "shader" && methods.includes(row.template.method)).map(row => {
    const reductionLimited = windowEnlargement && row.template.kind === "spatial" && row.template.method === "downsample";
    const label = customShader(row) ? "Import custom…" : resizeKind(row.template.kind) && row.template.kind !== "shader" ? spatialMethodLabel(row.template.method, {[row.template.method]: row.label}, true) : implementationName(row, type);
    return {value: row.id, label, status: reductionLimited ? "Requires 100% or less" : effectAvailability(row) || undefined, help: implementationHelp(row), detail: choiceDetail(row, type), group: implementationHeading(row, type), more: implementationMore(row), action: customShader(row), disabled: !selectable(row) || reductionLimited,
      title: reductionLimited ? "Choose a window size of 100% or less to use Downsample." : row.reason || row.inputReason,
      keywords: `${row.label} ${row.category || ""} ${row.purpose || ""} ${row.group} ${row.kind}`};
  });
}
function sizeSummary(node: VideoEffectNode, choice?: EffectCatalogRow) {
  if (node.kind !== "downsample" && node.kind !== "upscale") return "";
  if (choice?.intrinsicScale) return `${choice.intrinsicScale}× input`;
  const extent = node.extent;
  if (!extent) return node.kind === "downsample" ? "50% of image" : "100% of window / fullscreen";
  if ("automatic" in extent) return "Legacy sizing";
  if ("relativeTo" in extent) return `${Math.round(extent.factor * 1000) / 10}% of ${extent.relativeTo === "input" ? "image" : "window"}`;
  return extent.width && extent.height ? `${extent.width} × ${extent.height}` : extent.width ? `${extent.width}px wide` : resizeHeightPresets.includes(extent.height || 0) ? `${extent.height}p` : `${extent.height}px high`;
}

/** Every row of the chain in order, including sizing helpers, with its own settings, and the typed Add chooser. */
export function AdvancedEffectsView({editor}: {editor: EffectsEditor}) {
  const {plan, catalog, adding, addType, query, addChoices} = editor;
  // Specialised variants stay behind More until it is chosen or a search is entered.
  const listed = addChoices.filter(row => !customShader(row)), shown = editor.moreType === addType || query.trim() ? listed : listed.filter(row => !implementationMore(row));
  const close = () => {editor.setAdding(false);editor.setQuery("");editor.addButton.current?.focus();};
  return <><ol className="effectsList" aria-label="Video effects">
    {plan.video.map((node, index) => isolatedItem(node.id, {label: "This effect", as: "li", reset: node,
      action: <button className="btn small" onClick={() => void editor.remove(node.id)}>Remove</button>}, () => advancedRow(editor, node, index)))}
  </ol>
  {plan.video.length === 0 && <p className="detailMeta">No effects.</p>}
  <button ref={editor.addButton} className="btn small" aria-expanded={adding} aria-controls="add-video-effect" disabled={!editor.info || plan.video.length >= MAX_NODES}
    onClick={() => {editor.setAdding(!adding);editor.setAddType(null);editor.setQuery("");}}>Add effect…</button>
  {adding && <div id="add-video-effect" className="effectChooser" role="region" aria-label="Add video effect">
    {!addType ? <div className="effectTypes" aria-label="Effect type">{effectTypes.map(type => <button key={type.id} type="button" className="effectType btn"
      onClick={() => {editor.setAddType(type.id);editor.setQuery("");}}>{type.label}</button>)}</div> : <>
    <div className="detailActions"><button type="button" className="btn small" onClick={() => {editor.setAddType(null);editor.setQuery("");}}>‹ Types</button>
      <strong>{effectTypes.find(type => type.id === addType)?.label}</strong></div>
    <input ref={editor.search} className="input" type="search" aria-label="Search methods" placeholder="Search methods" value={query}
      onChange={event => editor.setQuery(event.target.value)} onKeyDown={event => {if (event.key === "Escape") {event.stopPropagation();close();}}} />
    <div className="effectChoiceGroup" aria-label="Methods">{shown.map((row, index, rows) => <React.Fragment key={row.id}>
      {(index === 0 || implementationHeading(row, addType) !== implementationHeading(rows[index - 1], addType)) && <div className="implementationGroup">{implementationHeading(row, addType)}</div>}
      <button className="effectChoice" disabled={!selectable(row)}
        title={row.reason || row.inputReason} onClick={() => void editor.addEffect(row)}><span>{implementationName(row, addType)}</span>
        {choiceDetail(row, addType) && <small>{choiceDetail(row, addType)}</small>}
        {effectAvailability(row) && <small>{effectAvailability(row)}</small>}</button></React.Fragment>)}
      {shown.length < listed.length && <button type="button" className="implementationMore" aria-expanded="false" onClick={() => editor.setMoreType(addType)}>More ({listed.length - shown.length})…</button>}</div>
    {!addChoices.length && <p className="detailMeta" role="status">No matching effects.</p>}
    {acceptsShaders(addType) && <div className="implementationActions">
      <button className="btn small" onClick={() => {const custom = catalog.find(customShader);if (custom) void editor.addEffect(custom);}}>Import custom…</button>
      <button className="btn small" onClick={() => void editor.manageFilters(effectTypes.find(type => type.id === addType)?.category || "all")}>Manage filters…</button>
    </div>}
    </>}
  </div>}</>;
}

function advancedRow(editor: EffectsEditor, node: VideoEffectNode, index: number) {
  const {plan, catalog, reshade: status, graphics, running, game} = editor, type = editor.typeOf(node);
  const choice = editor.choiceFor(node), methodName = resizeKind(node.kind) && node.kind !== "shader" && node.kind !== "neural"
    ? spatialMethodLabel(node.method, choice ? {[node.method]: choice.label} : {}, true)
    : choice ? implementationName(choice, type) : node.kind === "shader" ? node.shader.preset : node.method;
  const name = node.kind === "downsample" || node.kind === "upscale" ? `${kindLabels[node.kind]} · ${methodName}` : methodName, summary = sizeSummary(node, choice);
  const filter = node.kind === "shader" ? status?.filters?.find(row => `filter:${row.id}` === node.shader.preset) : undefined;
  const stage = graphics.stage(node.id), attention = editor.attention(node.id);
  // Native code keeps a row's previous working version when an edit to it fails.
  const pending = graphics.pendingRow(node.id) || (stage?.activeMethod === "retained" ? {id: node.id, reason: stage.reason, retained: true} : undefined);
  const actualMethod = node.kind !== "shader" && stage && stage.completed > 0 && stage.activeMethod && stage.activeMethod !== node.method &&
    !["failed", "bypassed", "stopped"].includes(stage.phase) && !["passthrough", "pending", "off", "retained"].includes(stage.activeMethod) ? stage.activeMethod : undefined;
  const actualLabel = actualMethod ? catalog.find(row => row.template.kind !== "shader" && row.template.method === actualMethod)?.label || actualMethod : undefined;
  const actualReason = actualLabel ? stage?.reason || `This stage uses ${actualLabel}. ${methodName} remains the saved choice.` : undefined;
  const inputPending = !stage?.completed && choice?.pendingInputs?.length && (choice.available || !choice.reason && selectable(choice));
  const unavailable = !stage?.completed && choice?.available === false && choice.reason;
  const state = plan.enabled === false ? "" : !node.enabled ? "Off" : unavailable ? "Unavailable" : inputPending ? inputsLabel(choice.pendingInputs!) : !running ? "" : pending ? pending.retained ? "Using previous" : "Pending"
    : stage?.phase === "preparing" ? "Preparing…" : stage && ["failed", "bypassed", "stopped"].includes(stage.phase) ? "Fallback" : stage && stage.completed > 0 ? "Active" : "";
  const moveBy = (offset: number) => void editor.move(node.id, index + offset);
  return <li key={node.id} draggable onDragStart={event => {
    event.dataTransfer.setData(EFFECT_DRAG, JSON.stringify({gamePath: game.gamePath, id: node.id}));event.dataTransfer.effectAllowed = "move";event.stopPropagation();
  }} onDragOver={event => {if (event.dataTransfer.types.includes(EFFECT_DRAG)) {event.preventDefault();event.stopPropagation();}}}
    onDrop={event => {
      const value = event.dataTransfer.getData(EFFECT_DRAG);if (!value) return;
      event.preventDefault();event.stopPropagation();
      try {
        const moved = JSON.parse(value);if (moved.gamePath !== game.gamePath || moved.id === node.id) return;
        void editor.move(moved.id, index);
      } catch { /* Ignore unrelated drag payloads. */ }
    }}><details className="effectNode" onToggle={event => {if (event.target === event.currentTarget) {const opened = event.currentTarget.open;editor.setExpandedSteps(current => ({...current, [node.id]: opened}));}}}>
    <summary className="effectNodeHeader" onKeyDown={event => {
      if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {event.preventDefault();event.stopPropagation();moveBy(event.key === "ArrowUp" ? -1 : 1);}
    }}>
      <span className="inlineCheck effectEnabled"><input id={`effect-${node.id}-enabled`} type="checkbox" checked={node.enabled}
        aria-label={`Enable ${name}`} onClick={event => event.stopPropagation()}
        onChange={event => void editor.setEnabled(node.id, event.target.checked)} />
        <span className="effectNodeTitle">{name}{summary && <small>{summary}</small>}</span></span>
      {state && <span className="graphicsState" title={pending?.reason || stage?.reason || actualReason || undefined}>{state}{state === "Active" && actualLabel ? ` · ${actualLabel}` : ""}
        {state === "Active" && actualReason && <HelpTip label={`About the active ${name} method`}>{actualReason}</HelpTip>}
        {(state === "Using previous" || state === "Pending") && pending?.reason && <HelpTip label={`Why ${name} is ${state.toLowerCase()}`}>{pending.reason}</HelpTip>}
        {inputPending && choice.inputReason && <HelpTip label={`About ${name} inputs`}>{choice.inputReason}</HelpTip>}</span>}
      {choice?.available === false && <span className="graphicsState"><HelpTip label={`About ${name} availability`}>{choice.reason || "Unavailable for the current inputs."}</HelpTip></span>}
      {attention && <span className="graphicsState"><StatusBadge tone="warning">Needs attention</StatusBadge>
        <HelpTip label={`Why ${name} needs attention`}>{attention}</HelpTip></span>}
      <div className="effectNodeActions" onClick={event => event.stopPropagation()}>
        <button className="btn small" aria-label={`Move ${name} up`} title="Move up" disabled={index === 0} onClick={() => moveBy(-1)}>↑</button>
        <button className="btn small" aria-label={`Move ${name} down`} title="Move down" disabled={index === plan.video.length - 1} onClick={() => moveBy(1)}>↓</button>
        <button className="btn small" aria-label={`Remove ${name}`} title="Remove effect" onClick={() => void editor.remove(node.id)}>×</button>
      </div>
    </summary>
    <div className="effectNodeSettings">
      <div className="detailRow detailControlRow effectMethodRow" onDrop={event => editor.dropShaders(event, node, type)}><label className="detailLabel" htmlFor={`effect-choice-${node.id}`}>Method
        {node.kind === "temporal" && <HelpTip label="About temporal inputs">Requires renderer motion vectors, depth and jitter. Render resolution follows game settings.</HelpTip>}
        {node.kind === "shader" && (filter || node.shader.preset === "custom" && node.shader.effectPath) && <HelpTip label="About shader format">{shaderFormatLabel(filter ? filter.format === undefined ? shaderFormat(filter.path) : filter.format : shaderFormat(node.shader.effectPath))}</HelpTip>}</label>
        <ImplementationPicker id={`effect-choice-${node.id}`} label="Method" value={choice?.id || ""}
          options={[...(!choice ? [{value: "", label: name, disabled: true}] : []),
            ...effectOptions({catalog, selected: choice, type,
              selectedMethod: resizeKind(node.kind) && node.kind !== "shader" && node.kind !== "neural" ? node.method : undefined, windowEnlargement: node.kind === "spatial" && (node.presentationScale ?? 0) > 1}),
            ...(acceptsShaders(type) && !implementationsFor(type, catalog).some(customShader) ? [{value: "__import", label: "Import custom…"}] : []),
            ...(acceptsShaders(type) ? [{value: "__manage", label: "Manage filters…"}] : [])]} onChange={event => {
            const value = event.target.value;
            if (value === "__manage") {void editor.manageFilters(effectTypes.find(item => item.id === type)?.category || "all");return;}
            if (value === "__import") return editor.pick(node);
            const selected = catalog.find(row => row.id === value);
            if (selected && customShader(selected)) return editor.pick(node);
            if (selected) return editor.changeMethod(node.id, selected);
          }} />
      </div>
      <EffectRowControls editor={editor} row={node} choice={choice} />
    </div>
  </details></li>;
}
