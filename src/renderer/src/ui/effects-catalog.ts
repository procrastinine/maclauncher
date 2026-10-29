import type {EffectCatalogRow, ReShadeState, VideoEffectNode} from "./types";
import {GRAPHICS_TYPES, orderImplementations, sameImplementation} from "../../../modules/shared/effects/contracts.mjs";
import {orderImplementationGroups, implementationOutputSummary} from "../../../modules/shared/effects/presentation.mjs";
import {effectSelectionKey} from "../../../modules/shared/effects/selection-key.mjs";
import {NEURAL} from "../../../modules/shared/effects/operation-contracts.mjs";
import {selectNeuralModel, compatibleNeuralModel} from "../../../modules/shared/effects/neural-selection.mjs";
import {spatialMenuMethods, spatialMethodLabel} from "./spatial-options";
import {availabilityLabel} from "./ui-helpers";

// Catalog presentation shared by the graphics views. Rows are typed by the
// shared classifier; these helpers only label and filter them.
export const kindLabels = {shader: "Shader", spatial: "Scaling", downsample: "Downsample", upscale: "Upscale", temporal: "Temporal upscaling", neural: "Neural reconstruction", "frame-generation": "Frame generation"};
export const effectTypes = GRAPHICS_TYPES.map(type => ({...type, category: type.id}));
export type EffectTypeId = typeof effectTypes[number]["id"];
export const resizeKind = (kind: VideoEffectNode["kind"]) => ["spatial", "upscale", "downsample"].includes(kind);
export const selectable = (row: EffectCatalogRow) => row.available || row.availableWithoutInputs;
export const customShader = (row?: EffectCatalogRow) => row?.template.kind === "shader" && row.template.shader.preset === "custom";
// Shader files never satisfy scene reconstruction or frame generation, so
// those rows offer no shader import or filter-library action.
export const acceptsShaders = (type: string) => !["temporal", "generation"].includes(type);
export const incompatibleShader = (label: string) => new Error(`${label} has a different input/output type. It remains available in the filter library.`);
export const neuralImplementation = (node: {kind: string; method?: string}, row?: EffectCatalogRow) => node.kind === "neural" ||
  row?.runtimeManagerId === "graphics-neural-models" || Boolean(row?.modelOperation) || Object.hasOwn(NEURAL, node.method || "");
export const modelOperation = (node: VideoEffectNode, row?: EffectCatalogRow) => row?.modelOperation || (node.kind !== "shader" ? node.method : "");

const pendingLabel = (inputs: string[]) => inputs.length > 2 ? "scene inputs" : inputs.filter(input => input !== "scene-frame" || inputs.length === 1)
  .map(input => input === "scene-frame" ? "scene inputs" : input.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/-/g, " ").toLowerCase()).join(" / ");
export const inputsLabel = (inputs: string[]) => `Needs ${pendingLabel(inputs)}`;
// Option labels carry one state word from the shared vocabulary; the reason
// goes in the option's title and the selected row's help.
export function effectAvailability(row: EffectCatalogRow): string {
  if (!row.available && row.reason) return availabilityLabel(row.availableWithoutRuntime || row.availableWithoutModel ? "notInstalled" : "unavailable");
  if (!selectable(row)) return availabilityLabel("unavailable");
  return row.pendingInputs?.length ? inputsLabel(row.pendingInputs) : "";
}

/**
 * A picker entry's size tag. A tag the slot already implies is omitted: every
 * image filter keeps its input size.
 */
// A slot's shared size says nothing: every image filter keeps its size, and
// every built-in resize or temporal method takes its size from its options.
// Shaders keep the size detail, which tells a fixed scale from the row's size.
export function choiceDetail(row: EffectCatalogRow, type: string | null): string | undefined {
  if (customShader(row)) return undefined;
  const summary = implementationOutputSummary(row, type ?? undefined);
  if (type === "image" && summary === "Same size") return undefined;
  return type && type !== "image" && row.kind !== "shader" && summary === "Size set in options" ? undefined : summary;
}

export function losslessRequirement(node: VideoEffectNode) {
  if (["spatial", "upscale"].includes(node.kind) && node.kind !== "shader" && node.kind !== "neural" && node.method === "ls1") return node.settings?.ls1Mode === "performance" ? "ls1Performance" : "ls1Quality";
  if (node.kind === "frame-generation" && node.method === "lsfg") return "lsfg" + (node.settings?.lsfgFp16 === false ? "Fp32" : "Fp16") + (node.settings?.lsfgMode === "performance" ? "Performance" : "Quality");
  return null;
}
export function matchingEffect(node: VideoEffectNode, catalog: readonly EffectCatalogRow[]) {
  return catalog.find(row => row.nodeId === node.id && row.selectionKey === effectSelectionKey(node)) || catalog.find(row => !row.nodeId && sameImplementation(node, row));
}
/** The selected or default model sets a model row's intrinsic scale. */
export function modelChoice(node: VideoEffectNode, choice: EffectCatalogRow | undefined, status?: ReShadeState) {
  const operation = choice && modelOperation(node, choice);
  if (!choice || !operation || !NEURAL[operation]) return choice;
  const model = node.settings?.modelPath ? status?.neuralModels?.find(row => row.modelPath === node.settings?.modelPath && compatibleNeuralModel(row, operation))
    : selectNeuralModel(operation, status?.neuralModels, {defaultVersion: status?.defaultNeuralModelVersion, defaultVersions: status?.defaultNeuralModelVersions});
  return model?.intrinsicScale ? {...choice, nodeId: node.id, intrinsicScale: model.intrinsicScale,
    outputContract: choice.outputContract ? {...choice.outputContract, ...(choice.outputContract.domain === "image" ? {scale: model.intrinsicScale} : {})} : choice.outputContract} : choice;
}
/** Lossless Scaling rows are usable only with a model for the row's own mode. */
export function rowAvailability(node: VideoEffectNode, choice: EffectCatalogRow | undefined, status?: ReShadeState) {
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
export function effectChoice(node: VideoEffectNode, catalog: readonly EffectCatalogRow[], status?: ReShadeState) {
  return rowAvailability(node, modelChoice(node, matchingEffect(node, catalog), status), status);
}

/** Add and Simple menus: selectable methods, with standard Downsample and Upscale filters folded to one entry unless searched. */
export function effectChooserRows(catalog: readonly EffectCatalogRow[], query: string, compact = true): EffectCatalogRow[] {
  const search = query.trim().toLocaleLowerCase();
  const methods = spatialMenuMethods(catalog.filter(row => resizeKind(row.template.kind)).map(row => (row.template as {method: string}).method));
  const choices = orderImplementationGroups(orderImplementations(catalog.filter(row => !row.nodeId && selectable(row) && !(row.template.kind === "shader" && row.template.shader.preset === "chain"))))
    .filter(row => !resizeKind(row.template.kind) || row.template.kind !== "shader" && methods.includes(row.template.method))
    .map(row => resizeKind(row.template.kind) && row.template.kind !== "shader" ? {...row, label: spatialMethodLabel(row.template.method, {[row.template.method]: row.label}, true)} : row)
    .filter(row => `${row.label} ${row.group} ${row.category || ""} ${row.collection || ""} ${row.kind} ${row.reason || ""}`.toLocaleLowerCase().includes(search));
  if (search || !compact) return choices;
  const standard = choices.filter(row => (row.kind === "downsample" || row.kind === "upscale") && row.category === "Standard filters");
  const defaults = new Map((["downsample", "upscale"] as const).map(kind => {
    const rows = standard.filter(row => row.kind === kind);
    return [kind, rows.find(row => row.template.kind !== "shader" && row.template.method === "bilinear" && row.available) || rows.find(row => row.available) || rows[0]];
  }));
  return choices.flatMap(row => standard.includes(row)
    ? row === defaults.get(row.kind as "downsample" | "upscale") ? [{...row, label: kindLabels[row.kind]}] : [] : [row]);
}
