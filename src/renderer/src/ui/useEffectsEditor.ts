import type React from "react";
import {useEffect, useMemo, useRef, useState} from "react";
import type {EffectCatalogRow, EffectExtent, GameEffectsInfo, GameEffectsPlan, GraphicsDepthInput, GraphicsNotice, GraphicsOutputSettings, RecentGame, ReShadeState,
  RuntimeEntry, VideoEffectNode} from "./types";
import {createEditContext, project, setSlot, setEnabled, remove, move, setExtent, setSettings, add, changeMethod, placeImported,
  setSource, setOutput, setDepthInput, setMaster, clear, type Extent, type RowPatch} from "../../../modules/shared/effects/edit-operations.mjs";
import {implementationsFor, type GraphicsType} from "../../../modules/shared/effects/contracts.mjs";
import {orderImplementationGroups} from "../../../modules/shared/effects/presentation.mjs";
import {effectSelectionKey} from "../../../modules/shared/effects/selection-key.mjs";
import {NEURAL} from "../../../modules/shared/effects/operation-contracts.mjs";
import {selectNeuralModel} from "../../../modules/shared/effects/neural-selection.mjs";
import {importedShaderImplementation} from "./shader-implementations";
import {droppedShaderPaths} from "./shader-drop";
import {useGraphicsEdits, editablePlan} from "./useGraphicsEdits";
import {useGraphicsStatus} from "./useGraphicsStatus";
import {effectChooserRows, effectTypes, customShader, incompatibleShader, modelChoice, modelOperation, rowAvailability, type EffectTypeId} from "./effects-catalog";

export type EffectsDraftEditor = {
  info: GameEffectsInfo;
  onChange: (plan: GameEffectsPlan) => void;
  pickFile: (kind?: "neural-model",expectedOperation?:string) => Promise<string | null>;
  parameters: (nodeId: string, plan: GameEffectsPlan) => ReturnType<NonNullable<Window["MacLauncher"]>["launcher"]["getEffectsPresetParameters"]>;
};
export type EffectsEditorProps = {
  game: Pick<RecentGame, "gamePath" | "runtimeId" | "effects" | "reshade" | "graphics" | "graphicsPlanError" | "effectsNotices">;
  status?: ReShadeState;
  graphicsHost?: RuntimeEntry["graphicsHost"];
  running: boolean;
  live?: boolean;
  onManageModels?: () => void;
  editor?: EffectsDraftEditor;
  /** The editor reads its effects only while a view shows it (editor demand). */
  active?: boolean;
};
export type EffectsView = "simple" | "advanced";
type Edit = (plan: GameEffectsPlan) => GameEffectsPlan;

// The chosen view follows the user across games and reopened editors for the
// window's session, like the Graphics section's collapsed state.
let chosenView: EffectsView = "simple";

const errorText = (error: unknown) => error instanceof Error ? error.message : "Effects could not be updated.";
const implementationIdentity = (node: VideoEffectNode | undefined) => node?.kind === "shader"
  ? JSON.stringify([node.kind, node.shader.preset, node.shader.effectPath || null, node.shader.effects || null])
  : node ? JSON.stringify([node.kind, node.method]) : null;
const rowById = (plan: GameEffectsPlan, id: string) => plan.video.find(row => row.id === id);
// A chosen file without registered metadata is a custom shader at that path.
const shaderFile = (row: EffectCatalogRow | undefined, file: string): EffectCatalogRow => {
  const base = row || {id: "shader:custom", kind: "shader", label: "Custom shader", group: "Image filters", available: true,
    template: {kind: "shader", enabled: true, shader: {enabled: true, preset: "custom", effectPath: null}}};
  const template = base.template.kind === "shader" ? base.template : {kind: "shader" as const, enabled: true, shader: {enabled: true, preset: "custom"}};
  return {...base, template: {...template, shader: {...template.shader, preset: "custom", effectPath: file, parameters: null}}};
};

/**
 * State and actions of one graphics editor. Every plan change is one edit
 * operation from `edit-operations.mjs` applied to the latest draft, so Simple
 * and Advanced share ownership, placement and sizing rules. Views render
 * from the returned projection and call its actions.
 */
export function useEffectsEditor({game, status, graphicsHost, running, live, onManageModels, editor: draft, active = true}: EffectsEditorProps) {
  const [info, setInfo] = useState<GameEffectsInfo | null>(draft?.info || null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [adding, setAdding] = useState(false), [query, setQuery] = useState("");
  const [addType, setAddType] = useState<EffectTypeId | null>(null);
  // The Add chooser type whose specialised variants are listed after More.
  const [moreType, setMoreType] = useState<EffectTypeId | null>(null);
  const [view, setViewState] = useState<EffectsView>(chosenView), [simpleOptions, setSimpleOptions] = useState<string | null>(null), [extraFilter, setExtraFilter] = useState(false);
  const [motionOptions, setMotionOptions] = useState(false);
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>({});
  // The plan before Clear effects or Apply preset and the edit revision that replaced it.
  const [replaced, setReplaced] = useState<{before: GameEffectsPlan; revision: number} | null>(null);
  // Parts of the last save that the main process left out; the next save replaces them.
  const [saveNotices, setSaveNotices] = useState<GraphicsNotice[]>([]);
  const request = useRef(0);
  const picking = useRef(false);
  const fileSelectionEpoch = useRef(0);
  const metadataRequestKey = useRef("");
  const infoContext = useRef("");
  const loadedKey = useRef("");
  const modelEditor = useRef<string | null>(game.gamePath);
  modelEditor.current = game.gamePath;
  useEffect(() => {modelEditor.current = game.gamePath;return () => {modelEditor.current = null;};}, [game.gamePath]);
  const search = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const saved = useMemo(() => editablePlan(game.effects), [game.effects]);
  const edits = useGraphicsEdits({saved,
    save: async (value, options) => {
      if (draft) {draft.onChange(value);return;}
      const api = window.MacLauncher?.launcher;
      if (!api) throw new Error("Effects controls are unavailable.");
      return api.setGameEffects(game.gamePath, value, options);
    },
    onAcknowledged: result => {
      setSaveNotices(result.notices || []);
      if (result.activeLaunch !== undefined) setInfo(current => current ? {...current, activeLaunch: result.activeLaunch} : current);
    }});
  const {plan} = edits;
  // A plan saved in another window reaches this editor with its status.
  const graphics = useGraphicsStatus({gamePath: game.gamePath, subscribe: !draft, plan, pending: edits.pending, onEvent: event => {
    if (event.plan) edits.observe(event.plan);
    if (event.activeLaunch !== undefined) setInfo(current => current ? {...current, activeLaunch: event.activeLaunch} : current);
  }});
  const library = useMemo(() => (info?.catalog || []).map(row => {
    const operation = row.modelOperation || (row.template.kind !== "shader" ? row.template.method : "");
    const model = NEURAL[operation] && selectNeuralModel(operation, status?.neuralModels,
      {defaultVersion: status?.defaultNeuralModelVersion, defaultVersions: status?.defaultNeuralModelVersions}), scale = model && model.intrinsicScale;
    return scale ? {...row, intrinsicScale: scale, outputContract: row.outputContract ? {...row.outputContract, ...(row.outputContract.domain === "image" ? {scale} : {})} : row.outputContract} : row;
  }), [info?.catalog, status?.neuralModels, status?.defaultNeuralModelVersion, status?.defaultNeuralModelVersions]);
  const catalog = useMemo(() => [...library, ...Object.values(info?.nodeCatalog || {})], [library, info?.nodeCatalog]);
  const nativeVideo = info?.graphicsInputs?.nativeVideo === true;
  // Each row resolves to its implementation with the selected model's scale.
  const ctx = useMemo(() => createEditContext(catalog, {nativeVideo,
    implementation: (row, matched) => modelChoice(row as VideoEffectNode, matched, status)}),
  [catalog, nativeVideo, status?.neuralModels, status?.defaultNeuralModelVersion, status?.defaultNeuralModelVersions]);
  const context = useRef(ctx);context.current = ctx;
  const projection = project(plan, ctx);
  const chooserRows = useMemo(() => effectChooserRows(catalog, "", false), [catalog]);
  const simpleChoices = useMemo(() => new Map(effectTypes.map(type => [type.id, implementationsFor(type.id, chooserRows)])), [chooserRows]);
  const addChoices = useMemo(() => addType ? orderImplementationGroups(implementationsFor(addType, query ? effectChooserRows(catalog, query, false) : chooserRows), addType) : [],
    [addType, catalog, query, chooserRows]);
  const activeHost = running ? info?.activeLaunch?.graphicsHost || graphicsHost : graphicsHost;
  const support = status?.graphics?.hosts && activeHost ? status.graphics.hosts[activeHost] : status?.graphics;
  const capabilityKey = useMemo(() => JSON.stringify([status?.version, status?.available, status?.presets, status?.filters?.map(filter => [filter.id, filter.path, filter.sourceRevision]), status?.models, status?.neuralModels, status?.graphics, status?.defaultNeuralModelVersion, status?.defaultNeuralModelVersions]),
    [status?.version, status?.available, status?.presets, status?.filters, status?.models, status?.neuralModels, status?.graphics, status?.defaultNeuralModelVersion, status?.defaultNeuralModelVersions]);
  // Rows whose metadata depends on their own source (custom shaders, model
  // paths) refresh the catalog when that selection changes.
  if (!edits.pending) metadataRequestKey.current = JSON.stringify(plan.video.filter(node => node.kind === "shader" ? node.shader.preset === "custom" || Object.hasOwn(node.settings || {}, "modelPath") : Boolean(NEURAL[node.method])).map(node => [node.id, effectSelectionKey(node)]));
  const nodeMetadataKey = metadataRequestKey.current;
  // The launch binding follows the status owner: a run whose binding was not
  // readable yet when it started is read again once it binds.
  const liveLaunch = graphics.status?.live ? graphics.status.launchId ?? true : false;
  useEffect(() => {
    if (draft) {setInfo(draft.info);return;}
    // A closed editor reads nothing; reopening it reads again only what changed.
    const contextKey = JSON.stringify([running, liveLaunch, game.gamePath, game.runtimeId, capabilityKey, graphicsHost]);
    const loadKey = JSON.stringify([contextKey, nodeMetadataKey]);
    if (!active || loadedKey.current === loadKey) {setLoading(false);return;}
    const metadataOnly = infoContext.current === contextKey;infoContext.current = contextKey;
    const token = ++request.current, atRevision = edits.revision();
    setLoading(true);setError("");
    Promise.resolve().then(() => {
      const api = window.MacLauncher?.launcher;
      if (!api) throw new Error("Effects controls are unavailable.");
      return api.getGameEffects(game.gamePath);
    }).then(result => {
      if (token !== request.current) return;
      loadedKey.current = loadKey;setInfo(result);
      // Selected-source metadata is descriptive. A late read must not replace
      // a newer desired plan.
      if (!metadataOnly && edits.revision() === atRevision) edits.observe(result.plan);
    }).catch(failure => {if (token === request.current) setError(errorText(failure));})
      .finally(() => {if (token === request.current) setLoading(false);});
    return () => {request.current++;};
  }, [running, liveLaunch, game.gamePath, game.runtimeId, capabilityKey, graphicsHost, draft?.info, nodeMetadataKey, active]);
  useEffect(() => {if (adding && addType) search.current?.focus();}, [adding, addType]);

  const ops = () => context.current;
  function commit(update: Edit, propagateError = false) {
    setError("");
    return edits.apply(update).catch(failure => {if (propagateError) throw failure;});
  }
  async function pickFile(kind?: "neural-model", expectedOperation?: string) {
    if (draft) return draft.pickFile(kind, expectedOperation);
    const api = window.MacLauncher?.launcher;
    if (!api?.pickGameEffectFile) throw new Error("Effect file selection is unavailable.");
    return api.pickGameEffectFile(game.gamePath, kind, expectedOperation);
  }
  // Imported choices join the catalog so the new rows resolve to them.
  function rememberChoices(rows: EffectCatalogRow[]) {
    setInfo(value => ({...(value || {mode: "advanced", plan: edits.currentPlan()}), catalog: [...(value?.catalog || []).filter(row => !rows.some(next => next.id === row.id)), ...rows]}));
  }
  async function pickShaderFile() {
    if (picking.current) return null;
    const origin = game.gamePath, epoch = fileSelectionEpoch.current;
    picking.current = true;setBusy(true);
    try {
      const file = await pickFile();
      const api = typeof window === "undefined" ? undefined : window.MacLauncher?.launcher;
      const rows = file && api?.importReShadeFilters ? await api.importReShadeFilters(undefined, [file]) : null;
      const choice = rows?.[0] ? importedShaderImplementation(rows[0]) : undefined;
      if (choice) rememberChoices([choice]);
      return file && modelEditor.current === origin && fileSelectionEpoch.current === epoch ? {file, choice} : null;
    } finally {picking.current = false;setBusy(false);}
  }
  // Clear effects and Apply preset replace the chain; Undo restores it until another edit.
  async function replace(update: Edit) {
    const before = edits.currentPlan(), saved = edits.apply(update), revision = edits.revision();
    if (edits.currentPlan() === before) return saved.catch(() => {});
    try {await saved;} catch {return;}
    setReplaced({before, revision});
  }
  async function reset() {
    fileSelectionEpoch.current++;
    // An unreadable saved plan has nothing to edit; main clears it directly.
    if (game.graphicsPlanError && !draft) {
      setError("");
      try {await window.MacLauncher?.launcher.resetGameEffects(game.gamePath);} catch (failure) {setError(errorText(failure));}
      return;
    }
    await replace(clear);
  }
  function restore() {
    if (replaced) void edits.apply(() => replaced.before).catch(() => {});
    setReplaced(null);
  }
  function applyPreset(next: GameEffectsPlan) {
    let copy: GameEffectsPlan;
    try {copy = editablePlan(next);} catch (failure) {setError(errorText(failure));return Promise.resolve();}
    // The depth input describes the game's renderer, so a preset keeps it.
    return replace(latest => {const {depthInput: _preset, ...plan} = copy;return latest.depthInput ? {...plan, depthInput: latest.depthInput} : plan;});
  }
  // Advanced Choose shader…, Import custom… and a custom method replace the
  // row's shader after the file is chosen, if the row still holds it.
  async function pick(node: VideoEffectNode) {
    if (picking.current) return;
    setError("");
    try {
      const selection = await pickShaderFile();if (!selection) return;
      const {file, choice} = selection, custom = catalog.find(customShader);
      await edits.apply(latest => {
        const current = rowById(latest, node.id);
        if (!current || effectSelectionKey(current) !== effectSelectionKey(node)) return latest;
        if (choice && !implementationsFor(ops().type(current), [choice], {contextual: true}).length) throw incompatibleShader(choice.label);
        if (choice) return changeMethod(latest, current.id, choice, ops());
        return current.kind === "shader" && current.shader.preset === "custom"
          ? setSettings(latest, current.id, {shader: {effectPath: file, parameters: null}}, ops())
          : changeMethod(latest, current.id, shaderFile(custom, file), ops());
      });
    } catch (failure) {setError(errorText(failure));}
  }
  async function pickModel(node: VideoEffectNode) {
    if (picking.current) return;
    const origin = game.gamePath, expectedSelection = effectSelectionKey(node), operation = modelOperation(node, ops().implementation(node));
    picking.current = true;setBusy(true);setError("");
    try {
      const file = await pickFile("neural-model", operation);
      if (file && modelEditor.current === origin) await changeModel(node, file,
        current => modelOperation(current, ops().implementation(current)) === operation && effectSelectionKey(current) === expectedSelection);
    } catch (failure) {setError(errorText(failure));}
    finally {picking.current = false;setBusy(false);}
  }
  // A model whose intrinsic scale differs refits the sizing its row owns.
  function changeModel(node: VideoEffectNode, modelPath: string | null, still: (current: VideoEffectNode) => boolean = () => true) {
    return edits.apply(latest => {
      const current = rowById(latest, node.id);
      if (!current || implementationIdentity(current) !== implementationIdentity(node) || !still(current)) return latest;
      return setSettings(latest, current.id, {settings: {modelPath}}, ops());
    }).catch(failure => setError(errorText(failure)));
  }
  async function manageNeuralModels() {
    try {await window.MacLauncher?.launcher.openUtilityWindow({view: "runtimes", managerId: "graphics-neural-models"});}
    catch (failure) {setError(errorText(failure));}
  }
  async function manageFilters(shaderCategory: string) {
    try {await window.MacLauncher?.launcher.openUtilityWindow({view: "runtimes", managerId: "graphics-shader-library", shaderCategory});}
    catch (failure) {setError(errorText(failure));}
  }
  async function addEffect(row: EffectCatalogRow) {
    if (picking.current) return;
    setError("");
    try {
      let choice = row;
      if (customShader(row)) {
        const selection = await pickShaderFile();
        if (!selection) return;
        if (selection.choice) {
          if (addType && !implementationsFor(addType, [selection.choice], {contextual: true}).length) throw incompatibleShader(selection.choice.label);
          choice = selection.choice;
        } else choice = shaderFile(row, selection.file);
      }
      const type = addType || undefined;
      setAdding(false);setAddType(null);setQuery("");
      await edits.apply(latest => add(latest, choice, ops(), {type, view: "advanced"}).plan);
    } catch (failure) {setError(errorText(failure));}
  }
  function dropShaders(event: React.DragEvent, target?: VideoEffectNode, slot?: GraphicsType) {
    if (event.defaultPrevented) return;
    const api = typeof window === "undefined" ? undefined : window.MacLauncher?.launcher;
    const paths = droppedShaderPaths(event.dataTransfer, api);if (!paths.length) return;
    event.preventDefault();void attachShaderFiles(paths, target, slot);
  }
  async function attachShaderFiles(paths: string[], target?: VideoEffectNode, slot?: GraphicsType) {
    if (picking.current) return;
    const origin = game.gamePath, epoch = fileSelectionEpoch.current, identity = target ? effectSelectionKey(target) : null;
    picking.current = true;setBusy(true);setError("");
    try {
      const api = window.MacLauncher?.launcher;if (!api?.importReShadeFilters) throw new Error("Shader import is unavailable.");
      const filters = await api.importReShadeFilters(undefined, paths);if (!filters) return;
      if (modelEditor.current !== origin || fileSelectionEpoch.current !== epoch) return;
      const imported = filters.map(importedShaderImplementation), current = target ? rowById(edits.currentPlan(), target.id) : undefined;
      if (target && (!current || effectSelectionKey(current) !== identity)) return;
      rememberChoices(imported);
      let incompatible: string[] = [];
      await edits.apply(latest => {
        const placed = placeImported(latest, imported, {rowId: current?.id, slot}, ops(), view);
        incompatible = placed.incompatible;
        // In Simple a row turned off while its import was pending stays off.
        return view === "simple" && target?.enabled && current && !current.enabled ? setEnabled(placed.plan, current.id, false, ops()) : placed.plan;
      });
      if (incompatible.length) setError(incompatibleShader(incompatible.join(", ")).message);
    } catch (failure) {setError(errorText(failure));}
    finally {picking.current = false;setBusy(false);}
  }
  async function chooseSimple(slot: GraphicsType, current: VideoEffectNode | undefined, row?: EffectCatalogRow) {
    if (!row) {await commit(latest => current ? setSlot(latest, slot, current.id, null, ops()) : latest);return;}
    try {
      let choice = row;
      if (customShader(row)) {
        const selection = await pickShaderFile();if (!selection) return;
        if (selection.choice && !implementationsFor(slot, [selection.choice], {contextual: true}).length) throw incompatibleShader(selection.choice.label);
        choice = selection.choice || shaderFile(row, selection.file);
      }
      const previous = current;
      await edits.apply(latest => {
        const target = previous ? rowById(latest, previous.id) : undefined;
        if (previous && (!target || effectSelectionKey(target) !== effectSelectionKey(previous))) return latest;
        // A slot filled while the file was being chosen keeps its choice.
        if (!previous && choice !== row && slot !== "image" && project(latest, ops()).slots.find(item => item.id === slot)?.rows.length) return latest;
        const next = setSlot(latest, slot, target?.id ?? null, choice, ops());
        return choice !== row && previous?.enabled && target && !target.enabled ? setEnabled(next, target.id, false, ops()) : next;
      });
      setExtraFilter(false);
    } catch (failure) {setError(errorText(failure));}
  }
  function setView(next: EffectsView) {chosenView = next;setViewState(next);}

  return {
    game, running, live, embedded: Boolean(draft), reshade: status, info, loading, busy, error: error || edits.error, onManageModels,
    plan, pending: edits.pending, catalog, ctx, projection, support, chooserRows, simpleChoices, addChoices, graphics,
    /** Undo is offered until the next edit after Clear or Apply. */
    undo: replaced && replaced.revision === edits.revision() ? replaced.before : null,
    saveNotices,
    /** Why a row needs attention: its saved-settings notices and a bypass or failure the status owner reports. Simple includes the rows it owns. */
    attention: (id: string, owned = false) => {
      const ids = new Set([id, ...owned ? plan.video.filter(row => row.ownedBy?.id === id).map(row => row.id) : []]);
      const reasons = [...(draft ? [] : game.effectsNotices || []).filter(notice => notice.rowId && ids.has(notice.rowId)).map(notice => notice.message),
        ...[...ids].map(row => graphics.status?.rows[row]).filter(row => row && (row.state === "bypassed" || row.state === "failed")).map(row => row!.reason || "This effect is not applied.")];
      return reasons.filter(Boolean).join(" ") || undefined;
    },
    view, setView, simpleOptions, setSimpleOptions, extraFilter, setExtraFilter, motionOptions, setMotionOptions,
    expandedSteps, setExpandedSteps, adding, setAdding, addType, setAddType, moreType, setMoreType, query, setQuery, search, addButton,
    /** The row's implementation with model scale and model availability. */
    choiceFor: (row: VideoEffectNode) => rowAvailability(row, ctx.implementation(row), status),
    typeOf: (row: VideoEffectNode) => ctx.type(row),
    /** The fit helper a row owns, if any. */
    fitOf: (row: VideoEffectNode) => projection.helpers.get(row.id)?.find(helper => helper.ownedBy?.role === "fit"),
    reset, restore, applyPreset, pick, pickModel, changeModel, manageNeuralModels, manageFilters, addEffect, dropShaders, chooseSimple,
    setMaster: (enabled: boolean) => commit(latest => setMaster(latest, enabled)),
    setSource: (value: GameEffectsPlan["renderResolution"]) => commit(latest => setSource(latest, value ?? null)),
    setSourceFilter: (method: string) => commit(latest => {
      if (!latest.renderResolution) return latest;
      const {method: _method, ...source} = latest.renderResolution;
      return setSource(latest, method ? {...source, method} : source);
    }),
    setEnabled: (id: string, enabled: boolean) => commit(latest => setEnabled(latest, id, enabled, ops())),
    remove: (id: string) => commit(latest => remove(latest, id, ops())),
    move: (id: string, to: number) => commit(latest => move(latest, id, to, ops())),
    changeMethod: (id: string, choice: EffectCatalogRow) => commit(latest => changeMethod(latest, id, choice, ops())),
    // The size controls produce explicit extents only, never the legacy automatic marker.
    setExtent: (id: string, extent: EffectExtent | undefined, asOwner = false) => commit(latest => setExtent(latest, id, (extent ?? null) as Extent | null, ops(), {asOwner})),
    setSettings: (id: string, patch: RowPatch, propagateError = false) => commit(latest => setSettings(latest, id, patch, ops()), propagateError),
    setOutput: (patch: Partial<GraphicsOutputSettings> | ((output: GraphicsOutputSettings) => Partial<GraphicsOutputSettings>)) =>
      commit(latest => setOutput(latest, typeof patch === "function" ? patch(latest.output || {}) : patch)),
    setDepthInput: (patch: Partial<GraphicsDepthInput>) => commit(latest => setDepthInput(latest, patch)),
    loadParameters: (id: string) => {
      if (draft) return draft.parameters(id, plan);
      const api = window.MacLauncher?.launcher;if (!api) throw new Error("Shader controls are unavailable.");
      return api.getGameEffectParameters(game.gamePath, id, plan);
    }
  };
}
export type EffectsEditor = ReturnType<typeof useEffectsEditor>;
