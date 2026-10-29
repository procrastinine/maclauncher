import React from "react";
import type {EffectCatalogRow, VideoEffectNode} from "../types";
import type {EffectsEditor} from "../useEffectsEditor";
import {graphicsType, type GraphicsType} from "../../../../modules/shared/effects/contracts.mjs";
import {implementationHeading, implementationMore, implementationName, orderImplementationGroups, implementationHelp} from "../../../../modules/shared/effects/presentation.mjs";
import {acceptsShaders, choiceDetail, customShader, effectAvailability, selectable} from "../effects-catalog";
import {ImplementationPicker} from "./ImplementationPicker";
import {EffectRowControls} from "./EffectRowControls";
import {HelpTip} from "./HelpTip";
import {isolatedItem} from "./ItemBoundary";
import {StatusBadge} from "./StatusBadge";

/**
 * One dropdown per graphics type in the default order. Rows come from the
 * shared projection; sizing helpers stay with their owner and are not listed.
 */
export function SimpleEffectsView({editor}: {editor: EffectsEditor}) {
  const {projection, simpleChoices, extraFilter, setExtraFilter} = editor, images = projection.imageRows, imageChoices = simpleChoices.get("image") || [];
  const rows = (type: GraphicsType) => projection.slots.find(slot => slot.id === type)?.rows || [];
  const row = (key: string, label: string, nodes: VideoEffectNode[], options: EffectCatalogRow[], category: string) =>
    isolatedItem(key, {label, reset: projection}, () => simpleRow(editor, key, label, nodes, options, category));
  return <div className="simpleEffects" aria-label="Simple graphics">
    {projection.customOrder && <div className="detailMeta">Custom order <HelpTip label="About custom effect order">The existing order is retained. Advanced shows every effect and its position.</HelpTip></div>}
    <section className="simpleEffectGroup" aria-label="Image filters"><h4>Image filters</h4>
      {images.map((node, index) => row(`image-${node.id}`, images.length > 1 ? `Filter ${index + 1}` : "Filter", [node], imageChoices, "image"))}
      {(!images.length || extraFilter) && row("image-new", images.length ? "New filter" : "Filter", [], imageChoices, "image")}
      {images.length > 0 && !extraFilter && <button type="button" className="btn small" onClick={() => setExtraFilter(true)}>Add filter…</button>}
    </section>
    <section className="simpleEffectGroup" aria-label="Resize"><h4>Resize</h4>
      {(["downsample", "upscale"] as const).map(kind => row(kind, kind === "downsample" ? "Downsample" : "Upscale",
        rows(kind), simpleChoices.get(kind) || [], kind === "downsample" ? "downscaling" : "upscaling"))}
    </section>
    <section className="simpleEffectGroup" aria-label="Temporal"><h4>Temporal</h4>
      {(["temporal", "generation"] as const).map(kind => row(kind === "temporal" ? "scene" : kind, kind === "temporal" ? "Temporal upscaling" : "Frame generation",
        rows(kind), simpleChoices.get(kind) || [], kind))}
    </section>
  </div>;
}

function simpleRow(editor: EffectsEditor, key: string, label: string, nodes: VideoEffectNode[], options: EffectCatalogRow[], category: string) {
  const {catalog, simpleOptions, setSimpleOptions} = editor;
  const enabled = nodes.filter(node => node.enabled), custom = enabled.length > 1;
  const node = enabled.length === 1 ? enabled[0] : nodes.length === 1 ? nodes[0] : undefined;
  const selected = node ? editor.choiceFor(node) : undefined, unavailable = node?.enabled && selected?.available === false ? selected.reason : undefined;
  const attention = node ? editor.attention(node.id, true) : undefined;
  const menu = selected ? options.some(row => row.id === selected.id) ? options.map(row => row.id === selected.id ? selected : row) : [selected, ...options] : options;
  const slot = (category === "downscaling" ? "downsample" : category === "upscaling" ? "upscale" : category) as GraphicsType;
  return <React.Fragment key={key}><div className="detailRow detailControlRow simpleEffectRow"
    onDrop={event => editor.dropShaders(event, node, slot)}>
    <label className="detailLabel" htmlFor={`simple-effect-${key}`}>{label}
      {selected && (unavailable || selected.inputReason || implementationHelp(selected)) && <HelpTip label={`About ${label.toLowerCase()} inputs`}>
        {[unavailable, selected.inputReason, implementationHelp(selected)].filter(Boolean).join(" ")}</HelpTip>}</label>
    <ImplementationPicker id={`simple-effect-${key}`} label={label} value={custom ? "__custom" : node?.enabled ? selected?.id || "__saved" : "off"}
      options={[{value: "off", label: "Off"}, ...(custom ? [{value: "__custom", label: `Custom · ${enabled.length} effects`}] : []),
        ...(node?.enabled && !selected ? [{value: "__saved", label: "Saved effect"}] : []),
        ...orderImplementationGroups(menu, slot).map(row => ({value: row.id, group: implementationHeading(row, slot), more: implementationMore(row), action: customShader(row), disabled: !selectable(row), title: row.reason || row.inputReason,
          detail: choiceDetail(row, slot),
          help: implementationHelp(row),
          keywords: `${row.label} ${row.category || ""} ${row.purpose || ""} ${row.group} ${row.kind}`,
          label: customShader(row) ? "Import custom…" : implementationName(row, slot), status: effectAvailability(row) || undefined})),
        ...(acceptsShaders(slot) && !menu.some(customShader) ? [{value: "__import", label: "Import custom…"}] : []),
        ...(acceptsShaders(slot) ? [{value: "__manage", label: "Manage filters…"}] : [])]}
      onChange={event => {
        const value = event.target.value;
        if (value === "__manage") {void editor.manageFilters(category);return;}
        if (value === "__import") {const custom = catalog.find(customShader);if (custom) void editor.chooseSimple(slot, node, custom);return;}
        if (["__custom", "__saved"].includes(value)) return;
        const row = menu.find(item => item.id === value);
        const type = category === "downscaling" ? "downsample" : category === "upscaling" ? "upscale" : row ? graphicsType(row.template, row) : node ? editor.typeOf(node) : "image";
        void editor.chooseSimple(type, node, row);
      }} />
    <div className="detailActions simpleEffectActions">
    {custom ? <button type="button" className="btn small" onClick={() => editor.setView("advanced")}>Edit…</button>
      : node?.enabled && <button type="button" className="btn small" aria-expanded={simpleOptions === key}
        onClick={() => setSimpleOptions(simpleOptions === key ? null : key)}>Options…</button>}
    {category === "image" && node && <button type="button" className="btn small iconOnly" aria-label={`Remove ${selected?.label || label}`} title="Remove filter"
      onClick={() => void editor.remove(node.id)}>×</button>}</div>
    {attention && <span className="graphicsState simpleEffectAttention"><StatusBadge tone="warning">Needs attention</StatusBadge>
      <HelpTip label={`Why ${label.toLowerCase()} needs attention`}>{attention}</HelpTip></span>}
  </div>
  {!custom && node?.enabled && simpleOptions === key && <div className="simpleEffectOptions" onDrop={event => editor.dropShaders(event, node, slot)}>
    <EffectRowControls editor={editor} row={node} choice={selected} simple /></div>}
  </React.Fragment>;
}
