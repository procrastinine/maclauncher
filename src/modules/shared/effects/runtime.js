const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Plan = require("./plan"), Graphics = require("../reshade/graphics-settings");
const Providers = require("./providers");
const {sceneInputNames,sceneInputRequirements,gpuWorkScope}=require("./operation-contracts.mjs");
const Live = require("../reshade/live-controls"), Writable = require("../writable-input");
const SourceResolution = require("../reshade/source-resolution"), RuntimeRecord = require("../reshade/runtime-record");
const {isPresentationFit} = require("./contracts.mjs");
const StoredPlan = require("./stored-plan");
const LaunchBinding = require("../reshade/launch-binding");
const warn = require("../graphics-warning"), Items = require("../item-results");
const {info: infoGraphics} = require("../graphics-warning");
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const {preservesCoordinates: declaredPreserving} = require("../reshade/shader-settings");
function file(entry, userDataDir) { return path.join(path.dirname(Live.file(entry, userDataDir)), "effect-plan.json"); }
function supported(root) {
  try { return RuntimeRecord.read(root).features?.graphics?.effectPlanAPI === 1; }
  catch { return false; }
}
function context(options = {}, entry) {
  const ReShade = require("../reshade"), Publication = require("../reshade/publication");
  const payloadEntry = entry || options.payloadEntry;
  const retained = (options.running || options.live) && payloadEntry ? LaunchBinding.payload(payloadEntry, options) : null;
  const supplied = options.graphicsPayload, admitted = supplied?.root && Publication.snapshot(supplied.root);
  const payload = retained || (admitted?.manifest === supplied?.manifest ? admitted : null);
  const root = payload?.root || options.root || ReShade.runtimeRoot(options.app);
  const demand = entry && ReShade.executionRequirements(entry);
  const identifying = Boolean((options.running || options.live) && options.launchBinding && options.graphicsPayload === null && !payload && !options.root);
  // Editor discovery includes all installed choices. Preparation needs only
  // the selected rows and must not inventory unrelated providers or models.
  if (!demand) return {...options, root, ...discovery(options, root, identifying)};
  const state = ReShade.launchState({ ...options, root });
  if (identifying) {
    state.available = false;state.reason = IDENTIFYING;
  }
  state.presets = [];
  if (state.available) {
    const features = state.shaderFeatures, selected = new Set();
    for (const shader of demand.shaders) {
      if (selected.has(shader.preset)) continue;
      selected.add(shader.preset);
      const Packs = require("../reshade/shader-packs"), Managed = require("../reshade/managed-shaders"),
        Filters = require("../reshade/filter-library"), Providers = require("../reshade/shader-providers");
      const pack = Packs.lookup(shader.preset), row = { id: shader.preset, label: shader.preset, available: true };
      try {
        const resolved = Managed.isId(shader.preset) ? Managed.resolveEffect(options.userDataDir, shader.preset, features, options.graphicsHost, options) :
          Filters.isFilterId(shader.preset) ? Filters.resolve(options.userDataDir, shader.preset) :
          pack ? Packs.resolveEffect(options.userDataDir, shader.preset, features, options.graphicsHost, options) :
          // Custom rows share a catalog ID but can select different files
          // and providers. Their own compiler validates each selection.
          { format: shader.preset === "custom" ? null : "fx" };
        row.format = resolved.format;
        if (resolved.traits) row.traits = resolved.traits;
        else if (resolved.format === "libplacebo" && resolved.file)
          row.traits = require("../reshade/shader-traits").analyzeFile(resolved.file, resolved.format).traits;
        const reason = Providers.availability(resolved.format, { ...options, features });
        if (reason) throw new Error(reason);
      } catch (error) { row.available = false;row.reason = error.message; }
      if (pack?.effect.requires.includes("depth") && features.depth !== true)
        row.depthHosts = features.depth?.hosts?.filter(host => ["window", "remote", "explicit"].includes(host)) || [];
      state.presets.push(row);
    }
    if (demand.needed.losslessModel && options.userDataDir) {
      state.models = require("../reshade/models").listInstalled(options.userDataDir).map(item => ({ version: item.version,
        capabilities: Object.keys(item.inspection.capabilities).filter(key => item.inspection.capabilities[key].compatible) }));
      state.defaultModelVersion = require("../runtime/custom-runtime").defaultVersion(options.settings, "graphics-models") || null;
    }
    if(demand.needed.neural&&options.userDataDir)state.neuralModels=require("../reshade/neural").listModels(options.userDataDir);
  }
  return { ...options, root, state, ...providers(options, root, demand) };
}
const IDENTIFYING = "The running graphics processor is being identified.";
function providers(options, root, demand) {
  return { neuralProvider: options.discoverAllProviders===true || !demand || demand.needed.neural ? require("../reshade/neural").resolve(root, options) : null,
    xessProvider:options.discoverAllProviders===true||!demand||demand.methods.temporal.includes("xess")?require("../reshade/xess").state(root,options):null,
    xessGenerationProvider:options.discoverAllProviders===true||!demand||demand.methods.generation.includes("xess")?require("../reshade/xess").state(root,{...options,operation:"interpolate"}):null,
    graphicsCapabilities: Graphics.capabilities(root, options.graphicsHost, { graphicsInputs: options.graphicsInputs,
      graphicsArchitecture: options.graphicsArchitecture, macOSVersion: options.macOSVersion,
      graphicsHardware: options.graphicsHardware,
      ...(demand ? { selectedMethods: demand.methods } : {}) }) };
}
// Editor discovery for one launcher inventory revision (main's graphics
// catalog) and one context. Main changes the revision when shader sources,
// collections, models, runtimes or graphics settings change, so a later
// editor read reuses the discovery and its catalog. Without a revision,
// discovery is read again.
const discoveries = new Map();
function discovery(options, root, identifying) {
  const read = () => {
    const state = require("../reshade").getState({ ...options, root });
    return {state: identifying ? {...state, available: false, reason: IDENTIFYING} : state, ...providers(options, root, null)};
  };
  if (options.inventoryRevision === undefined) return read();
  const inventoryKey = JSON.stringify([options.inventoryRevision, root, identifying, options.platform || null, options.userDataDir || null,
    options.graphicsHost || null, options.graphicsArchitecture || null, options.graphicsInputs || null, options.macOSVersion || null, options.graphicsHardware || null]);
  let found = discoveries.get(inventoryKey);
  if (!found) {
    found = {...read(), inventoryKey};
    discoveries.set(inventoryKey, found);derived.set(inventoryKey, new Map());
    if (discoveries.size > 8) {const oldest = discoveries.keys().next().value;discoveries.delete(oldest);derived.delete(oldest);}
  }
  return found;
}
// Values derived from one discovery (catalog rows, templates) share its life.
const derived = new Map();
function remember(ctx, name, read) {
  const values = ctx.inventoryKey && derived.get(ctx.inventoryKey);
  if (!values) return read();
  if (!values.has(name)) values.set(name, read());
  return values.get(name);
}
// `stage.graphics` carries a row's stage settings into its catalog entry.
function catalog(stage, options) {
  const rows = Plan.catalog({ ...options, reshadeState: options.state, graphicsSettings: stage.graphics });
  if (!supported(options.root)) return rows.map(row => ({ ...row, available: false, availableWithoutModel: false, reason: "Ordered effects are unavailable in this application build." }));
  if (!["window", "remote", "explicit", "catalyst"].includes(options.graphicsHost))
    return rows.map(row => ({ ...row, available: false, availableWithoutModel: false, reason: "Shared frame presentation is unavailable for this runtime." }));
  const graphics = RuntimeRecord.read(options.root).features?.graphics || {};
  return rows.map(row => {
    const nativeKind = Plan.isResize(row) ? Providers.neural(row.template) ? "neural" : "spatial" : row.kind;
    if (Array.isArray(graphics.effectPlanKinds) && !graphics.effectPlanKinds.includes(nativeKind))
      return { ...row, available: false, availableWithoutModel: false, reason: row.reason || "The included processor cannot place this method in an ordered chain. Use Simple controls for this method." };
    const scope = graphics.effectPlanTemporal, input = options.graphicsInputs;
    const sharedScene=input?.sceneFrameAPI===1&&(!input.sceneDestinationAPI||graphics.sceneWindowContinuationAPI===1);
    if (row.kind === "temporal" && !sharedScene && scope && (!["source", "output", "commandBuffer"].every(key => typeof scope[key] === "string") ||
        scope.source !== input?.temporalSource || scope.output !== input?.temporalOutput || scope.commandBuffer !== input?.commandBuffer ||
        Array.isArray(scope.hosts) && !scope.hosts.includes(options.graphicsHost)))
      return { ...row,availableWithoutInputs:row.available===true,pendingInputs:[...new Set([...(row.pendingInputs||[]),"scene-frame"])],inputReason:"This source does not expose a matching scene frame; this row remains pending while other effects run." };
    return row;
  });
}
function selectedNodeCatalog(plan, rows, ctx) {
  const selected = {}, selectionKey = require('./selection-key.mjs').effectSelectionKey;
  for (const node of plan.video) {
    const key = node.kind === 'shader' ? /^(shader|filter):/.test(node.shader.preset) ? node.shader.preset : 'shader:'+node.shader.preset : node.kind+':'+node.method;
    let row = rows.find(value => value.id === key);
    if (!row) continue;
    try {
      if (node.kind === 'shader' && node.shader.preset === 'custom' && node.shader.effectPath) {
        const selection = require('../reshade').resolveShaderSelection({reshade:{...node.shader,enabled:true}},ctx);
        if (!selection) throw Error('Choose a shader entry file.');
        const preset = {id:'custom',label:path.basename(selection.sourcePath||selection.file),format:selection.format,traits:selection.traits,sourceRevision:selection.sourceRevision,outputContract:selection.outputContract,
          modelOperation:selection.modelOperation,available:true};
        row = catalog({}, {...ctx,state:{...ctx.state,presets:[preset]}}).find(value => value.id === 'shader:custom') || row;
      }
      const operation = Providers.modelOperation(node,ctx);
      if (operation) {
        const modelNode = neuralDefault({...node,enabled:true},ctx.state.neuralModels||[],ctx.settings,ctx);
        const file = modelNode.settings?.modelPath;
        if (file) {
          const scale = require('../reshade/neural').modelScale(file,operation);
          if (Providers.NEURAL[operation]) row = {...row,intrinsicScale:scale,
            outputContract:{...row.outputContract,...(row.outputContract?.domain==='image'?{scale,sizing:node.kind==='temporal'?'scene-output':scale===1?'preserve':'intrinsic'}:{})}};
        }
      }
    } catch (error) {
      row = {...row,available:false,availableWithoutModel:row.available===true||row.availableWithoutModel===true,
        reason:error.message||'The selected effect source could not be read.'};
    }
    const {id:_id,...template}=node;
    selected[node.id]={...row,template,nodeId:node.id,selectionKey:selectionKey(node)};
  }
  return selected;
}
// The editor reads the running launch's host, architecture and inputs.
function editorContext(entry, options) {
  const launch = options.running ? options.launchBinding || LaunchBinding.read(entry, options) : null;
  const activeOptions = launch ? {...options, graphicsHost: launch.graphicsHost || options.graphicsHost,
    graphicsArchitecture: launch.graphicsArchitecture || options.graphicsArchitecture, graphicsInputs: launch.graphicsInputs || options.graphicsInputs} : options;
  return {launch, ctx: context({...activeOptions,payloadEntry:entry,discoverAllProviders:true})};
}
function info(entry, options = {}) {
  const {launch, ctx} = editorContext(entry, options);
  // The stored plan is the only source. A salvaged one is edited without the
  // parts it left out, which are reported as notices. An unreadable one is
  // reported with an empty editor plan; it is never replaced by another plan.
  const stored = StoredPlan.read(entry, ctx), editorPlan = stored.source === "invalid" ? EMPTY : stored.plan, notices = StoredPlan.notices(stored);
  let live = false;
  // A retained launch.json from an earlier process supplies catalog context
  // only. Live editing requires the binding of a currently running process.
  if (options.running) live = launch?.effectPlanAPI === 1 && (options.runningPids === undefined || options.runningPids.includes(launch.pid));
  const rows = remember(ctx, "catalog", () => catalog({}, ctx));
  return { mode: "advanced", live, plan: modelDefaults(editorPlan, ctx, launch, false), catalog: rows,
    ...(stored.source === "invalid" ? {graphicsPlanError: stored.error} : {}), ...(notices.length ? {notices} : {}),
    nodeCatalog:selectedNodeCatalog(editorPlan,rows,ctx),
    graphicsInputs:ctx.graphicsInputs||null,
    graphicsHardware:ctx.graphicsCapabilities.hardware,
    ...(launch ? {activeLaunch: {launchId: launch.launchId, pid: launch.pid, runtimeId: launch.runtimeId,
      graphicsHost: ctx.graphicsHost, graphicsArchitecture: ctx.graphicsArchitecture, graphicsInputs: ctx.graphicsInputs}} : {}),
    shaderBindingsNextLaunch: ctx.graphicsInputs?.shaderBindingsNextLaunch === true,
    sourceResolution: sourceResolution(ctx, launch) };
}
const EMPTY = Object.freeze({schema: 2, mode: "advanced", enabled: true, video: Object.freeze([])});
// Chain templates for the graphics menu; the menu reads them when it opens.
function templates(entry, options = {}) {
  const {ctx} = editorContext(entry, options), stored = StoredPlan.read(entry, ctx);
  const current = stored.source === "invalid" ? null : stored.plan;
  return remember(ctx, "templates:" + (current ? stored.revision : ""), () => reconstructionTemplates(current, ctx));
}
function reconstructionTemplates(current, ctx) {
  const Neural = require("../reshade/neural");
  const fit=current?.video.find(node=>node.enabled&&["upscale","spatial"].includes(node.kind)&&Graphics.spatialMethod(node.method));
  let reason;
  const plan = modelDefaults(Plan.reconstructionPreset({effects: current}, fit?{spatialMethod:fit.method}:{}), ctx);
  const modelPath=plan.video.find(node=>node.kind==="neural"&&node.method==="mlx-dlss")?.settings.modelPath||null;
  try {
    Plan.validateOrdering(plan, facts(plan, node => catalog({graphics: node.settings || {}}, ctx)));
    if (!modelPath) throw new Error("Choose a compatible neural rendering model before applying this preset.");
    Neural.model(modelPath,"mlx-dlss");
  } catch (error) { reason = error.message; }
  return [{id: "reconstruction-4x", name: "DLSS · 540p + LSFG 4×", plan, available: !reason, ...(reason ? {reason} : {})}];
}
function sourceResolution(ctx, launch) {
  const support = SourceResolution.capabilities(ctx.graphicsHost, ctx.graphicsInputs, ctx.graphicsCapabilities.resolutionMultipliers, ctx.graphicsCapabilities.virtualWindow);
  const { heights, multipliers, percentages, methods, methodLabels, filterExclusiveWithTemporal } = support;
  // The editor needs the current launch contract as well as the adapter's
  // declaration. In particular, a launched virtual source can already switch
  // live even when this core cannot activate one from an initially-off launch.
  const live = ctx.running ? require("../reshade/source-controls").bindings(launch).some(binding => binding.support?.live === true) : support.live === true;
  return { heights, multipliers, ...(percentages ? {percentages: true} : {}),
    ...(ctx.graphicsCapabilities.spatial && ctx.graphicsCapabilities.spatialMethods.includes("bilinear") ? {processing: true} : {}),
    ...(live ? {live: true} : {}), ...(methods ? {methods} : {}), ...(methodLabels ? {methodLabels} : {}),
    ...(filterExclusiveWithTemporal ? {filterExclusiveWithTemporal: true} : {}) };
}
function neuralDefault(node,models,settings,options={}){
  if(!node.enabled||node.settings?.modelPath)return node;
  const operation=Providers.modelOperation(node,options);if(!operation)return node;
  const selected=require("../runtime/custom-runtime").defaultVersion(settings, "graphics-neural-models");
  const model=require('./neural-selection.mjs').selectNeuralModel(operation,models,{defaultVersion:selected,defaultVersions:settings?.runtimes?.['graphics-neural-models']?.defaultVersions});
  return model?{...node,settings:{...node.settings,modelPath:model.modelPath}}:node;
}
function modelDefaults(plan, ctx, launch,resolveNeural=true) {
  return { ...plan, video: plan.video.map(node => {
    if(node.enabled&&Providers.modelOperation(node,ctx))return resolveNeural?neuralDefault(node,ctx.state.neuralModels||[],ctx.settings,ctx):node;
    if (!node.enabled || node.kind === "shader" || node.settings.modelVersion || !["ls1", "lsfg"].includes(node.method)) return node;
    if (launch) {
      const version = LaunchBinding.modelForNode(launch, node);
      if (version) return {...node, settings: {...node.settings, modelVersion: version}};
      if (launch.effectPlanLiveResources?.schema !== 1) return node;
    }
    const row = Plan.catalog({ ...ctx, reshadeState: ctx.state, graphicsSettings: node.settings })
      .find(row => row.id === node.kind + ":" + node.method || node.kind === "spatial" && row.id === "upscale:" + node.method);
    const version = row?.template.settings.modelVersion;
    return version ? { ...node, settings: { ...node.settings, modelVersion: version } } : node;
  }) };
}
function facts(plan, rows) {
  const nodes = {};
  for (const node of plan.video) {
    const id = node.kind === "shader" ? /^(shader|filter):/.test(node.shader.preset) ? node.shader.preset : "shader:" + node.shader.preset :
      node.kind === "spatial" ? node.method === "downsample" ? "downsample:bilinear" : "upscale:" + node.method : node.kind + ":" + node.method;
    const row = (typeof rows === "function" ? rows(node) : rows).find(item => item.id === id);
    const requirements = row?.requirements || [];
    nodes[node.id] = { available: row?.available === true, label: row?.label || node.method || "Shader", reason: row?.reason || "Choose an available effect.",
      requirements: sceneInputRequirements([...sceneInputNames(requirements),...sceneInputNames(row?.inputContract?.requires),
        ...(Array.isArray(requirements)&&requirements.includes("temporal-inputs")?["motion"]:[])]),
      coordinateTransform: row?.coordinateTransform,
      preservesSceneInputs:row?.preservesSceneInputs===true,
      acceptsSynthetic:row?.acceptsSynthetic,
      preservesCoordinates: row?.preservesCoordinates === true || node.kind === "shader" && declaredPreserving(node.shader) };
  }
  return { nodes };
}
function preparationFacts(plan, rows, ctx) {
  // Custom rows share a catalog ID, but their coordinate/input contracts belong
  // to their exact files. Use the same selected metadata as the editor without
  // inspecting unrelated library entries or model families.
  const selected = selectedNodeCatalog({...plan, video: plan.video.filter(node =>
    node.enabled && node.kind === "shader" && node.shader.preset === "custom")}, rows, ctx);
  return facts(plan, node => {
    if (node.kind !== "shader") return catalog({graphics: node.settings}, ctx);
    // Executable validation and its errors still belong to preparation. Only
    // the exact, positively declared identity transform is needed beforehand.
    return selected[node.id]?.preservesCoordinates === true ? rows.map(row => row.id === selected[node.id].id ?
      {...row, preservesCoordinates: true, coordinateTransform: "identity", preservesSceneInputs: true} : row) : rows;
  });
}
async function describe(entry, nodeId, draft, options = {}) {
  let plan;
  if (draft !== undefined) {
    const salvaged = Plan.salvage(draft);
    if (salvaged.error || !salvaged.plan) throw new Error(salvaged.error?.message || "Choose a valid ordered effects plan.");
    plan = salvaged.plan;
  } else {
    const stored = StoredPlan.read(entry, options);
    if (stored.source === "invalid") throw StoredPlan.error(stored);
    plan = stored.plan;
  }
  const node = plan.video.find(row => row.id === nodeId);
  if (!node || node.kind !== "shader") throw new Error("Choose a shader row to edit its parameters.");
  // Describing a draft must never publish a plan or activate Advanced.
  return require("../reshade").describeParameters({ ...entry, reshade: node.shader }, { ...options, parameterLimit: Plan.MAX_PARAMETERS });
}
function stageSettings(node) {
  return Graphics.updateStageSettings(node.settings, { spatialMultiplier: node.settings.spatialMultiplier,
    spatialMethod: Plan.isResize(node) ? node.method : "off",
    temporalMethod: node.kind === "temporal" ? node.method : "off", frameGeneration: node.kind === "frame-generation" ? node.method : "off",
    effectPlacement: "before" });
}
async function useNeuralModel(node,ctx,launch,options){
  const identity=require("../reshade/neural").modelIdentity?.(ctx.userDataDir,node.settings?.modelPath);
  if(options.live&&!identity&&!launch.effectPlanNeuralModels?.includes(node.settings?.modelPath))
    throw new Error("Import the selected neural model in Runtimes before switching during play.");
  if(identity)await ctx.useRuntime?.(identity);
  if(options.live&&identity)await require("../reshade/neural/models").resolveModel(ctx.userDataDir,identity.version,{signal:options.signal});
}
function requireNeuralBinding(prepared,launch,options){
  if(options.live&&!LaunchBinding.allowsNeural(launch,prepared.settings.modelPath,prepared.environment.RESHADE_NEURAL_LIBRARY))
    throw new Error("Restart the game to use this neural provider or model.");
}
// Ordering is checked row by row (Plan.orderingFailures). A row that breaks it
// is bypassed with its reason and the other rows keep their places. An
// unavailable row is bypassed at launch and in a running game; the check of a
// stopped game's edit reports it instead.
function orderRows(plan, capabilities, bypass, {skipUnavailable = true} = {}) {
  for (const failure of Plan.orderingFailures(plan, capabilities)) {
    if (failure.unavailable && !skipUnavailable) throw new Error(failure.reason);
    bypass(plan.video.find(node => node.id === failure.id), failure.reason);
  }
}
const ORDER = "GRAPHICS_ROW_ORDER";
const describeNode = node => ({id: node.id, kind: node.kind, method: node.kind === "shader" ? node.shader.preset : node.method});
const droppedNode = row => ({id: row.id, ...(row.label ? {method: row.label} : {}), reason: row.reason});
async function prepare(entry, options = {}) {
  if (options.live && require("./execution-requirements").analyze(entry).needed.processor) {
    const attachment = LaunchBinding.read(entry, options)?.graphicsAttachment;
    if (attachment?.available === false) throw Object.assign(new Error(attachment.reason), {code: "GRAPHICS_ATTACHMENT_UNAVAILABLE"});
  }
  // A row that cannot be read is skipped with its reason (Plan.salvage); only an
  // unreadable plan envelope fails the whole preparation.
  const requested = Plan.salvage(entry.effects);
  if (requested.error || !requested.plan) throw Object.assign(new Error(requested.error?.message || "Choose a valid ordered effects plan."), requested.error ? {code: requested.error.code} : {});
  const requestedPlan = requested.plan, dropped = requested.dropped.filter(row => row.part === "row").map(droppedNode);
  let savedPlan = Plan.execution(requestedPlan);
  const modelPreparation=await require('../reshade/neural/model-preparation').prepare(savedPlan,options),modelPending=[...modelPreparation.pending];
  options={...options,modelOperations:modelPreparation.modelOperations||options.modelOperations};
  if(options.userDataDir&&savedPlan.video.some(node=>node.enabled&&Providers.modelOperation(node,options)&&!node.settings?.modelPath)){
    savedPlan={...savedPlan,video:savedPlan.video.map(node=>neuralDefault(node,modelPreparation.models,options.settings,options))};
  }
  if(modelPending.length){
    const missing=new Set(modelPending.map(node=>node.id)),waiting=new Set(missing);
    // A pending owner holds its sizing helpers (owner-unavailable retirement).
    for(const node of savedPlan.video)if(node.ownedBy&&missing.has(node.ownedBy.id)){waiting.add(node.id);modelPending.push({id:node.id,kind:node.kind,method:node.kind==='shader'?node.shader.preset:node.method,requestKey:require('./live-plan').selectionKey(node),retained:false,reason:'Waiting for the selected model.'});}
    savedPlan={...savedPlan,video:savedPlan.video.map(node=>waiting.has(node.id)?{...node,enabled:false}:node)};
    if(savedPlan.renderResolution?.managedBy&&missing.has(savedPlan.renderResolution.managedBy))delete savedPlan.renderResolution;
  }
  // Master bypass is a transient execution projection. Saved rows, parameters
  // and the source-resolution request remain available for the next activation.
  if (savedPlan!==requestedPlan) entry = {...entry, effects: savedPlan};
  const currentLaunch = options.live ? LaunchBinding.read(entry, options) : null;
  options.publication?.observe(file(entry, options.userDataDir), {root: options.userDataDir});
  if (options.live || options.isCurrent) options.publication?.guard(() => options.live ? LaunchBinding.isCurrent(entry, currentLaunch, options) : options.isCurrent() === true);
  // The reason explains to the editor why the running game keeps its current
  // graphics. Projection records the first concrete cause it encountered.
  let deferReason;
  const STOPPED = "The game stopped or restarted while graphics were prepared. Changes apply on the next launch.";
  // A running game that has not confirmed its graph yet (no frame drawn, or
  // the status lease busy) can confirm it shortly; the caller may try again.
  const UNCONFIRMED = "The running game did not confirm its current graphics. Keep the game window drawing and try again, or relaunch.";
  function defer(reason = deferReason) {
    const nodes = Object.fromEntries(savedPlan.video.map(node => [node.id, {preservesCoordinates: node.kind === "shader" &&
      declaredPreserving(node.shader)}]));
    const ordering = [...dropped];
    orderRows({...savedPlan, video: savedPlan.video.map(node => ({...node}))}, {nodes}, (node, why) => {node.enabled = false;ordering.push({...describeNode(node), reason: why});});
    options.publication?.defer();
    infoGraphics(options.logger, "Graphics settings remain pending; current rendering is retained.");
    return {plan: requestedPlan, deferred: true,...(reason?{reason}:{}),...(reason === UNCONFIRMED ? {retryable: true} : {}),...(modelPending.length||ordering.length?{preparationStatus:{schema:1,scope:'shared',
      ...(modelPending.length?{pending:modelPending}:{}),...(ordering.length?{skipped:ordering}:{})}}:{})};
  }
  let projection = null, previousDocument, acceptedState;
  const untouchedActivation = () => {
    const publication = options.publication;
    if (!publication || currentLaunch?.executionRequirements?.mode !== "activation" || currentLaunch.executionRequirements.needed?.processor !== false ||
        Object.hasOwn(currentLaunch, "graphicsPreparation") || Object.hasOwn(currentLaunch, "graphicsLivePreparation") ||
        currentLaunch.effectPlanModels?.length || !LaunchBinding.isCurrent(entry, currentLaunch, options)) return null;
    try {
      const target = file(entry, options.userDataDir), controlsFile = Live.file(entry, options.userDataDir);
      const launchFile = path.join(path.dirname(target), "launch.json"), historyFile = path.join(path.dirname(target), "effect-plan-history.json");
      for (const selected of [launchFile, controlsFile, historyFile]) publication.observe(selected, {root: options.userDataDir});
      const originalLaunch = JSON.parse(publication.readOriginal(launchFile, "utf8"));
      if (JSON.stringify(originalLaunch) !== JSON.stringify(currentLaunch)) return null;
      // A previous prepared graph, including On→Off, requires native proof.
      // No absence/malformed-history fallback may discard those resources.
      try {publication.readOriginal(historyFile);return null;} catch (error) {if (error.code !== "ENOENT") return null;}
      const original = require("./live-plan").readDocument(target, publication), controls = publication.readOriginal(controlsFile);
      // The launch published the empty document (a launch from an earlier
      // version published the empty Simple one).
      if (!original || original.nodes.length || original.output || controls.length !== 19116 || controls.toString("ascii", 0, 8) !== "MLFXCTL2" ||
          (controls.readUInt32LE(16) & (1 | 8)) || controls.readUInt32LE(152) !== 0 || !LaunchBinding.isCurrent(entry, currentLaunch, options)) return null;
      return {schema: 1, mode: "advanced", nodes: [], revision: digest([])};
    } catch {return null;}
  };
  const project = async (candidate, library, unavailable) => {
    options.signal?.throwIfAborted();
    if (currentLaunch?.effectPlanAPI !== 1) {
      deferReason = "This game was started without live graphics editing. Changes apply on the next launch.";return null;
    }
    const direct = unavailable || (node => LaunchBinding.nodeUnavailableReason(currentLaunch, node, library,options));
    // A helper follows its owner: it never runs while the owner cannot.
    const unavailableReason = node => direct(node) || (node.ownedBy && (owner => owner?.enabled && direct(owner))(candidate.video.find(row => row.id === node.ownedBy.id))
      ? "This sizing step waits for the row it belongs to." : null);
    deferReason = candidate.video.map(node => node.enabled ? unavailableReason(node) : null).find(Boolean);
    if (deferReason) deferReason += " The current graphics keep running; this change applies on the next launch.";
    if (!candidate.video.some(node => node.enabled && !unavailableReason(node))) return null;
    const empty = untouchedActivation();
    if (empty) return require("./live-plan").project(candidate, empty, unavailableReason);
    if (!await readAccepted(candidate.video.some(node => node.enabled && node.kind === "neural") ? 5000 : 2500)) {deferReason = UNCONFIRMED;return null;}
    return require("./live-plan").project(candidate, previousDocument, unavailableReason);
  };
  // A published candidate may still have been rejected by the native owner.
  // Retain resources only from its explicitly acknowledged immutable graph.
  const readAccepted = async timeoutMs => {
    acceptedState ??= await acceptance(entry, {...options, launchBinding: currentLaunch, timeoutMs}) || false;
    if (!acceptedState || acceptedState.launchId !== currentLaunch.launchId || acceptedState.launchPid !== currentLaunch.pid) return false;
    previousDocument ??= require("./live-plan").readAcceptedDocument(file(entry, options.userDataDir),
      {launchId: currentLaunch.launchId, revision: acceptedState.revision, publication: options.publication});
    return true;
  };
  // A live edit that breaks a row the game is running keeps that row's
  // accepted version; the saved plan keeps the edit for a later attempt.
  const lastWorking = new Map();
  const lastWorkingRow = async node => {
    if (!options.live || currentLaunch?.effectPlanAPI !== 1 || !await readAccepted(2500)) return null;
    const family = node.kind === "frame-generation" ? "frame-generation" : Providers.neural(node) ? "neural" : Plan.isResize(node) ? "spatial" : node.kind;
    const old = previousDocument?.nodes?.find(row => row.id === node.id && row.kind === family && row.enabled === true);
    // A compiled revision that is gone can no longer be read again.
    return old && (!old.file || fs.existsSync(old.file)) ? structuredClone(old) : null;
  };
  const acceptProjection = next => {
    if (projection) {
      for (const [id, row] of projection.retained) next.retained.set(id, row);
      next.pending = [...new Map([...next.pending, ...projection.pending].map(row => [row.id, row])).values()];
    }
    projection = next;
  };
  if (options.live && options.runningPids !== undefined && !LaunchBinding.supportsPlan(currentLaunch, savedPlan,undefined,options)) {
    projection = await project(savedPlan);
    if (!projection) return defer();
  }
  const processingInput = projection ? {...entry, effects: projection.plan} : entry;
  const processingEntry = await options.prepareEffectsEntry?.(processingInput) || processingInput;
  // A module hook may change rows; its result is salvaged like a stored plan.
  const processed = Plan.salvage(processingEntry.effects);
  if (processed.error || !processed.plan) throw new Error(processed.error?.message || "Choose a valid ordered effects plan.");
  let selectedPlan = processed.plan;
  let ctx = context(options, { ...processingEntry, effects: selectedPlan });
  let plan = modelDefaults(selectedPlan, ctx, currentLaunch);
  const requestedNodes = selectedPlan.video.filter(node => node.enabled).map(describeNode);
  const skipped = new Map([...dropped, ...processed.dropped.filter(row => row.part === "row").map(droppedNode)].map(row => [row.id, row]));
  // Rows a module hook could not prepare are bypassed with their reasons.
  for (const row of Array.isArray(processingEntry.effectsSkipped) ? processingEntry.effectsSkipped : []) {
    const node = processingInput.effects?.video?.find(value => value.id === row?.id);
    if (node && !selectedPlan.video.some(value => value.id === node.id)) skipped.set(node.id, {...describeNode(node), reason: Items.reason(row.reason)});
  }
  const skip = (node, reason) => {
    node.enabled = false;skipped.set(node.id, {...describeNode(node), reason});
    warn(options.logger, `[Graphics] Skipping ${node.id}: ${reason}`);
  };
  if (currentLaunch && !LaunchBinding.supportsPlan(currentLaunch, plan, ctx.neuralProvider?.library || null,ctx)) {
    const next = await project(plan, ctx.neuralProvider?.library || null);
    if (!next) return defer();
    acceptProjection(next);selectedPlan = next.plan;
    ctx = context(options, {...processingEntry, effects: selectedPlan});
    plan = modelDefaults(selectedPlan, ctx, currentLaunch);
  }
  if (!ctx.state.available) throw new Error(ctx.state.reason);
  if (!supported(ctx.root)) throw new Error("Ordered effects are unavailable in this application build.");
  // Edits reuse payload files verified earlier in this process; each launch
  // checks their identities again (decision D3(b)).
  const reuseVerified = options.launchPreparation !== true;
  if (options.verify) options.verify(ctx.root);
  else require("../reshade/payload-verification").verifyLaunch(ctx.root, {}, {presenter: true, reuse: reuseVerified});
  let rows = catalog({}, ctx);
  const ownedFitOriginals = new Map();
  const normalizeFits = value => {
    const video = require("./edit-operations.mjs").normalizeFits(value, require("./edit-operations.mjs").createEditContext(rows)).video;
    if(video===value.video)return value;
    for(let index=0;index<video.length;index++)if(video[index]!==value.video[index])ownedFitOriginals.set(video[index].id,value.video[index]);
    return {...value,video};
  };
  plan = normalizeFits(plan);
  let capabilities = preparationFacts(plan, rows, ctx);
  if (options.live && plan.video.some(node => node.enabled && !projection?.retained.has(node.id) && capabilities.nodes[node.id].available === false)) {
    const next = await project(plan, ctx.neuralProvider?.library || null, node => projection?.retained.has(node.id) ? null :
      capabilities.nodes[node.id].available === false ? capabilities.nodes[node.id].reason :
        LaunchBinding.nodeUnavailableReason(currentLaunch, node, ctx.neuralProvider?.library || null,ctx));
    if (!next) return defer();
    acceptProjection(next);selectedPlan = next.plan;
    ctx = context(options, {...processingEntry, effects: selectedPlan});plan = modelDefaults(selectedPlan, ctx, currentLaunch);
    rows = catalog({}, ctx);plan=normalizeFits(plan);capabilities = preparationFacts(plan, rows, ctx);
  }
  if (projection) {
    // The requested order is checked as if every row could run now; a row it
    // rejects is bypassed in the projection too.
    const requestedFacts = {...capabilities, nodes: {...capabilities.nodes}};
    for (const node of savedPlan.video) requestedFacts.nodes[node.id] = {...requestedFacts.nodes[node.id], available: true};
    orderRows({...savedPlan, video: savedPlan.video.map(node => ({...node}))}, requestedFacts, (requestedNode, reason) => {
      requestedNode.enabled = false;
      const selected = plan.video.find(node => node.id === requestedNode.id);
      if (selected?.enabled) skip(selected, reason);else skipped.set(requestedNode.id, {...describeNode(requestedNode), reason});
    });
    for (const [id, node] of projection.retained) capabilities.nodes[id] = {...capabilities.nodes[id], available: true,
      requirements: node.requirements || {}, preservesCoordinates: node.preservesCoordinates === true};
  }
  // Availability can change after a game was configured; at launch and in a
  // running game an unavailable row is skipped and the other rows stay usable.
  orderRows(plan, capabilities, skip, {skipUnavailable: options.fallback === true || options.live === true || options.bypassRows === true});
  const nodes = [], environment = {}, bindings = {}, directory = path.dirname(file(entry, ctx.userDataDir));
  Writable.assertOwnDirectory(ctx.userDataDir, directory);
  Writable.assertOwnDirectory(ctx.userDataDir, path.join(directory, "plan-nodes"));
  let launch;
  if (options.live) {
    launch = currentLaunch;
    if (launch?.effectPlanAPI !== 1) throw new Error("Restart the game to use ordered effects.");
    ctx.resolveModel = (directory, version, capability, selectedOptions) => LaunchBinding.resolveModel(launch, directory, version, capability, selectedOptions);
    ctx.isCurrent = () => LaunchBinding.isCurrent(entry, launch, options);
  }
  // A live edit prepares only the rows whose inputs changed. A row prepared
  // from immutable inputs (included shaders and collections, stages without a
  // model) keeps its prepared output for the same launch and context.
  const preparedRows = options.live && options.force !== true ? require("./prepared-rows").rows(file(entry, ctx.userDataDir), launch) : null;
  for (const node of plan.video) {
    options.signal?.throwIfAborted();
    if (!node.enabled) { nodes.push({ id: node.id, kind: Plan.isResize(node) ? "spatial" : node.kind, enabled: false }); continue; }
    if (projection?.retained.has(node.id)) {nodes.push(projection.retained.get(node.id));continue;}
    const requirements = capabilities.nodes[node.id].requirements;
    // A shader row also depends on the game's depth input.
    const rowKey = preparedRows && digest([ctx.root, ctx.graphicsHost || null, ctx.graphicsArchitecture || null, ctx.graphicsInputs || null,
      require("../reshade").stateSettings(ctx.settings), node, capabilities.nodes[node.id], ...(node.kind === "shader" && plan.depthInput ? [plan.depthInput] : [])]);
    const kept = rowKey && preparedRows.get(node.id), before = {...environment}, facts = {...capabilities.nodes[node.id]}, at = nodes.length;
    let reusable = false;
    try {
    if (kept?.key === rowKey) {
      Object.assign(requirements, kept.requirements);
      if (kept.preservesCoordinates) Object.assign(capabilities.nodes[node.id], {preservesCoordinates: true, coordinateTransform: "identity", preservesSceneInputs: true});
      // Earlier rows may have changed; the compiled requirements are checked against them again.
      const misplaced = node.kind === "shader" && Plan.orderingFailures(Plan.leading(plan, plan.video.indexOf(node) + 1), capabilities).find(row => row.id === node.id);
      if (misplaced) throw Object.assign(new Error(misplaced.reason), {code: ORDER});
      Object.assign(environment, kept.environment);
      nodes.push({...structuredClone(kept.node), requirements});
      continue;
    }
    // Payload verification covers this row alone; helper ownership names another row.
    if (!options.verify) {const {ownedBy, ...row} = node;require("../reshade/payload-verification").verifyLaunch(ctx.root,
      {effects: {schema: plan.schema, mode: "advanced", video: [row]}}, {...ctx, shaderFeatures: ctx.state.shaderFeatures, reuse: reuseVerified});}
    if (node.kind === "shader") {
      const ownedDirectory = path.join(directory, "plan-nodes", node.id);
      const effects = await require("../reshade/live-effect").prepare({ ...entry, reshade: node.shader },
        // The compiler identity holds the source and dependency stamps, so a
        // launch reuses an unchanged compiled revision.
        { ...ctx, features: ctx.state.shaderFeatures, force: options.force === true || options.forceShaderPresets?.has(node.shader.preset),
          directory: ownedDirectory, depthInput: plan.depthInput, execute: options.execute || require("node:util").promisify(require("node:child_process").execFile) });
      const selectionFile = path.join(ownedDirectory, "live-selection.json");
      const selection = JSON.parse(options.publication ? options.publication.read(selectionFile, "utf8") : await fs.promises.readFile(selectionFile, "utf8"));
      if (!/^[a-f0-9]{64}$/.test(selection.revision || "") || !/^[a-f0-9]{64}$/.test(selection.key || "")) throw new Error("The shader selection is invalid.");
      const SceneBindings=require("../reshade/shader-scene-bindings"),sceneBindings=SceneBindings.validate(selection.sceneBindings||selection.traits?.sceneBindings),
        bindingReason=require("../reshade/shader-providers").traitsAvailability(selection.format||"fx",{...selection.traits,sceneBindings},{features:ctx.state.shaderFeatures});
      if(bindingReason)throw Error(bindingReason);
      Object.assign(requirements,sceneInputRequirements([...sceneInputNames(requirements),...sceneInputNames(SceneBindings.requirements(sceneBindings))]));
      if (selection.requirements) {
        const selected=require("../reshade/requirements").flags(selection.requirements);
        Object.assign(requirements,sceneInputRequirements([...sceneInputNames(requirements),...sceneInputNames(selected)]));
        // A decoder or presentation API may expose only color, while a native
        // scene can start supplying depth after launch. Keep the compiled row
        // and its exact requirement; each real frame decides whether it runs.
      }
      if (selection.preservesCoordinates === true) Object.assign(capabilities.nodes[node.id], {
        preservesCoordinates: true, coordinateTransform: "identity", preservesSceneInputs: true
      });
      // Compiled requirements can make this row break the order; it is then
      // bypassed and the other rows keep running.
      const misplaced = Plan.orderingFailures(Plan.leading(plan, plan.video.indexOf(node) + 1), capabilities).find(row => row.id === node.id);
      if (misplaced) throw Object.assign(new Error(misplaced.reason), {code: ORDER});
      const format = selection.format || "fx", filename = require("../reshade/shader-providers").entryFile(format);
      if(!filename)throw new Error("The prepared shader format is unsupported.");
      const preparedFile = path.join(effects, selection.revision, filename);
      const traits = selection.traits || (format === "libplacebo" ? require("../reshade/shader-traits").inspect(await fs.promises.readFile(preparedFile, "utf8"), format) : null);
      const operation=Providers.modelOperation(node,ctx);let modelInput;
      // Imported and custom sources can change in place, and collections are
      // leased per publication; their compiler checks run on every edit.
      reusable = !operation && node.shader.preset !== "custom" && !require("../reshade/filter-library").isFilterId(node.shader.preset) &&
        !require("../reshade/managed-shaders").isId(node.shader.preset) && !options.forceShaderPresets?.has(node.shader.preset);
      if(operation){
        if(selection.modelOperation!==operation)throw new Error("The filter's model input changed during preparation.");
        await useNeuralModel(node,ctx,launch,options);
        const prepared=require("../reshade/neural").prepare({modelPath:node.settings?.modelPath,temporal:false,intensity:1},{...ctx,modelOperation:operation});
        requireNeuralBinding(prepared,launch,options);Object.assign(environment,prepared.environment);
        modelInput={modelOperation:operation,modelPath:prepared.settings.modelPath};
      }
      nodes.push({ id: node.id, kind: node.kind, enabled: true, format, file: path.join(effects, selection.revision, filename),
        ...modelInput,
        ...((ctx.graphicsCapabilities?.shaderInputPolicy||selection.inputPolicy==="linear-source")&&require("../reshade/shader-input-policy").VALUES.includes(selection.inputPolicy)?{inputPolicy:selection.inputPolicy}:{}),
        ...(traits?.sceneHistory?{sceneHistory:traits.sceneHistory}:{}),
        key: selection.key, revision: selection.revision, ...(node.shader.preset === "chain" ? { technique: "MacLauncherChain" } : {}),
        parameters: node.shader.parameters || {}, requirements,...(Object.keys(sceneBindings).length?{sceneBindings}:{}), preservesCoordinates: capabilities.nodes[node.id].preservesCoordinates === true,
        ...(selection.displaySubframes === true ? {displaySubframes: true} : {}),
        ...(node.extent ? node.extent.automatic?{outputSize:{height:Plan.DEFAULT_PROCESSING_HEIGHT}}:node.extent.relativeTo==="presentation"?{presentationScale:node.extent.factor}:
          node.extent.relativeTo==="input"?{outputScale:{x:node.extent.factor,y:node.extent.factor}}:{outputSize:node.extent}
          : require("./contracts.mjs").shaderDefaultOutput({traits})) });
    } else if (Providers.neural(node)) {
      const Neural = require("../reshade/neural");await useNeuralModel(node,ctx,launch,options);
      const {frameMultiplier,framePacing,targetFps,smoothCadence,...neuralSettings}=node.settings;
      const prepared = node.method === "mlx-dlss" || !Neural.prepareMethod ? Neural.prepare(node.settings, ctx) : Neural.prepareMethod(node.method, neuralSettings, ctx);
      requireNeuralBinding(prepared,launch,options);
      Object.assign(environment, prepared.environment);
      nodes.push({ id: node.id, kind: ["frame-generation","temporal"].includes(node.kind) ? node.kind : "neural", enabled: true, method: node.method,
        settings: {...prepared.settings,...(node.kind === "frame-generation" ? {frameMultiplier,framePacing,targetFps,smoothCadence} : {})},
        ...(!["frame-generation","temporal"].includes(node.kind) ? {intrinsicScale: prepared.intrinsicScale||Providers.descriptor(node.method).scale} : {}),
        modelPath: prepared.settings.modelPath, requirements });
    } else if(["temporal","frame-generation"].includes(node.kind)&&node.method==="xess") {
      const Xess=require("../reshade/xess");
      const binding=launch?.effectPlanLiveResources?.xess||Xess.reserve({...ctx,directory,launchId:options.launchId||LaunchBinding.read(entry,ctx)?.launchId||entry.id});
      const prepared=await Xess.prepare({...ctx,directory,backend:node.settings.xessBackend,xessBinding:binding,publication:options.publication,operation:node.kind==="frame-generation"?"interpolate":"superresolution"});
      // This realm's broker session serves the live registration for the
      // running process; the launch bound only its own realm's session.
      if(options.live&&launch?.pid)require("../runtime/gpu-compute-broker").bind(binding,launch.pid);
      Object.assign(environment,prepared.environment);
      nodes.push({id:node.id,kind:node.kind,enabled:true,method:"xess",settings:{...stageSettings(node),...prepared.settings},requirements});
    } else {
      const settings = stageSettings(node);
      const extent = node.extent;
      if (extent?.relativeTo === "input") settings.spatialMultiplier = extent.factor;
      // A stage controls its own output, not the producer allocation. Pass the
      // scaler implementation through its normal capability/model validation.
      const prepared = await Graphics.prepare({ ...settings, spatialMultiplier: null }, {...ctx,allowPendingInputs:true,stageDirection:Plan.isResize(node)?Providers.resizeDirection(node):undefined});
      if (options.live && prepared.RESHADE_LOSSLESS_MODEL && !LaunchBinding.allowsModel(launch, prepared.RESHADE_LOSSLESS_MODEL, "lossless"))
        throw new Error("Restart the game to use a different Lossless Scaling model.");
      if (prepared.RESHADE_LOSSLESS_MODEL) bindings[settings.modelVersion] = { path: prepared.RESHADE_LOSSLESS_MODEL,
        capabilities: ctx.state.models?.find(model => model.version === settings.modelVersion)?.capabilities || [] };
      // Implementations and the selected model are launch inputs. Each node
      // also retains its own model binding; row order never selects a model.
      for (const [key, value] of Object.entries(prepared)) if (key === "RESHADE_FSR3_GENERATION_LIBRARY" || require("../reshade/temporal/providers").isEnvironmentKey(key)) environment[key] = value;
      reusable = !prepared.RESHADE_LOSSLESS_MODEL;
      nodes.push({ id: node.id, kind: Plan.isResize(node) ? "spatial" : node.kind, enabled: true, method: node.method, settings, requirements,
        ...(Plan.isResize(node) && node.kind !== "spatial" && !(node.kind==="upscale"&&isPresentationFit(node)) ? {resizeDirection: Providers.resizeDirection(node)} : {}),
        ...(extent && !extent.relativeTo ? {outputSize: extent} : {}),
        ...(extent?.relativeTo === "presentation"&&!extent.automatic ? {presentationScale: extent.factor} : {}),
        ...(extent?.automatic ? {outputSize:{height:Plan.DEFAULT_PROCESSING_HEIGHT}} : {}),
        ...(node.outputSize ? { outputSize: node.outputSize } : {}),
        ...(node.presentationScale !== undefined ? { presentationScale: node.presentationScale } : {}),
        ...(prepared.RESHADE_LOSSLESS_MODEL ? { modelPath: prepared.RESHADE_LOSSLESS_MODEL } : {}) });
    }
    if (rowKey && reusable) preparedRows.set(node.id, {key: rowKey, node: structuredClone(nodes.at(-1)), requirements: {...requirements},
      preservesCoordinates: capabilities.nodes[node.id].preservesCoordinates === true,
      environment: Object.fromEntries(Object.entries(environment).filter(([key, value]) => before[key] !== value))});
    else preparedRows?.delete(node.id);
    } catch (error) {
      if (error.code === "GRAPHICS_LIVE_STALE" || options.isCurrent && options.isCurrent() !== true) return defer(STOPPED);
      // A row that cannot be prepared is bypassed at launch and in a running
      // game alike; the other rows still run.
      if (error.code !== ORDER && (!(options.fallback || options.live || options.bypassRows) || Items.fatal(error, options.signal))) throw error;
      preparedRows?.delete(node.id);
      for (const key of Object.keys(environment)) if (!(key in before)) delete environment[key];
      Object.assign(environment, before);nodes.length = at;
      // An unreadable acceptance leaves this row bypassed; it never fails the others.
      const reason = error.bypassReason || error.message, previous = error.code !== ORDER &&
        await lastWorkingRow(node).catch(failure => {if (options.signal?.aborted) throw failure;return null;});
      if (previous) {
        nodes.push(previous);
        capabilities.nodes[node.id] = {...facts, available: true, requirements: previous.requirements || {}, preservesCoordinates: previous.preservesCoordinates === true,
          ...(previous.preservesCoordinates === true ? {coordinateTransform: "identity", preservesSceneInputs: true} : {})};
        lastWorking.set(node.id, {id: node.id, kind: node.kind, method: node.kind === "shader" ? node.shader.preset : node.method,
          reason: `${reason} The previous version of this effect keeps running.`, retained: true, requestKey: require("./live-plan").selectionKey(node)});
        continue;
      }
      skip(node, reason);
      nodes.push({ id: node.id, kind: Plan.isResize(node) ? "spatial" : node.kind, enabled: false });
    }
  }
  // The prepared rows are checked once more in order; one that now breaks it
  // is bypassed like any other skipped row.
  orderRows(plan, capabilities, (node, reason) => {
    skip(node, reason);nodes[plan.video.indexOf(node)] = {id: node.id, kind: Plan.isResize(node) ? "spatial" : node.kind, enabled: false};
  });
  // A row skipped at preparation retires its helpers and the source request
  // it manages, as the edit model does for a disabled owner.
  const ownerOff = node => node.ownedBy && !plan.video.some(row => row.id === node.ownedBy.id && row.enabled);
  for (let index = 0; index < plan.video.length; index++) {
    const node = plan.video[index];
    if (node.enabled && ownerOff(node)) {node.enabled = false;nodes[index] = {id: node.id, kind: Plan.isResize(node) ? "spatial" : node.kind, enabled: false};}
  }
  if (plan.renderResolution?.managedBy && !plan.video.some(row => row.id === plan.renderResolution.managedBy && row.enabled)) delete plan.renderResolution;
  // Source allocation and completed-frame processing have separate outcomes.
  // A fallback must retain the saved request and preserve scene input contracts.
  let appliedResolution = options.live ? launch.effectPlanRenderResolution || undefined : undefined;
  let sourceDecision, processingReduction;
  const requestedResolution = plan.renderResolution || null;
  const SourceControls = require("../reshade/source-controls"),
    sourceBindings = options.live ? SourceControls.bindings(launch) : [],
    activeSources = options.live ? SourceControls.active(launch) : [],
    sourceBinding = activeSources[0] || sourceBindings[0];
  const failures = {...options.sourceResolutionFailures};
  if (options.live) for (const control of ["engine", "drawable", "virtual", "producer"])
    if (!sourceBindings.some(binding => binding.control === control)) failures[control] ||= "This launch has no live channel for this source API.";
  const sourceReceipt = sourceBinding ? SourceControls.completed(sourceBinding) : null;
  const canProcessSource = ctx.graphicsCapabilities.spatial && ctx.graphicsCapabilities.spatialMethods.includes("bilinear") &&
    nodes.length < Plan.MAX_NODES && !plan.video.some(node => {
      if(!node.enabled)return false;
      const inputs=sceneInputNames(capabilities.nodes[node.id]?.requirements);
      // This fallback inserts a full-frame reduction, so normalized projection
      // coordinates stay valid. The shared guide encoder carries the matching
      // depth/motion/jitter lease; unknown later warps retain ordering checks.
      if(ctx.graphicsCapabilities.sceneGuideTransforms===true)return false;
      return node.kind==="temporal"||inputs.some(name=>name!=="depth")||inputs.includes("depth")&&!ctx.graphicsCapabilities.depthTransforms;
    });
  if (requestedResolution || sourceBindings.length) {
    sourceDecision = SourceResolution.resolve(requestedResolution, {host: ctx.graphicsHost, inputs: ctx.graphicsInputs,
      producerDivisors: ctx.graphicsCapabilities.resolutionMultipliers, virtualWindow: ctx.graphicsCapabilities.virtualWindow,
      processing: canProcessSource, completedSource: sourceReceipt, excludedControls: failures,
      preferredControl: activeSources.find(binding => !failures[binding.control])?.control});
    if (!options.live && options.fallback && canProcessSource && sourceDecision.source) {
      // Native allocation can be rejected only after the game creates its
      // renderer. Keep its processing budget without waiting for launch-time
      // geometry: an already reduced source bypasses this guard at frame time.
      const guard = SourceResolution.resolve(requestedResolution, {processing: true});
      sourceDecision = {...sourceDecision, processing: guard.processing, processingGuard: Boolean(guard.processing)};
    }
    if (options.live && !sourceBinding && JSON.stringify(appliedResolution || null) === JSON.stringify(requestedResolution))
      sourceDecision = {...sourceDecision, strategy: "retained", processing: null, reason: "The source allocation selected at launch is retained."};
    let effective = sourceDecision.source;
    if (effective?.method && sourceDecision.support?.filterExclusiveWithTemporal === true && plan.video.some(node => node.enabled && node.kind === "temporal")) {
      if (!options.fallback || options.live) throw new Error("A temporal effect controls the source filter. Choose Original for game rendering.");
      effective = {...effective};delete effective.method;
      sourceDecision = {...sourceDecision, source: effective, reason: sourceDecision.reason + " A temporal effect retains control of the source filter."};
    }
    if (requestedResolution?.method && !effective?.method && sourceDecision.source) {
      const recoveringSource = Object.keys(options.sourceResolutionFailures || {}).length > 0;
      if (!options.fallback && !recoveringSource) throw new Error("This renderer cannot use the selected source filter.");
      warn(options.logger, "[Graphics] This renderer cannot use the selected source filter; preserving the renderer filter and remaining effects.");
    }
    if (options.live) {
      if (options.publication) {
        const selectedBinding = sourceBindings.find(binding => binding.control === sourceDecision.control);
        // Original and completed-frame fallback restore the active source. The
        // publisher coordinates independent channels before exposing the plan.
        options.publication.metadata.sourceResolutionControl = selectedBinding?.control || null;
        options.publication.metadata.sourceResolutionCandidate = selectedBinding ? SourceControls.normalize(effective, selectedBinding.support) : null;
      }
    } else if (effective) {
      if (effective.automatic) environment.RESHADE_RENDER_AUTO = "1";
      else if (effective.height !== undefined)
        environment[effective.maximum ? "RESHADE_RENDER_MAX_HEIGHT" : "RESHADE_RENDER_HEIGHT"] = String(effective.height);
      else environment[ctx.graphicsHost === "explicit" ? "RESHADE_RESOLUTION_MULTIPLIER" : "RESHADE_RENDER_MULTIPLIER"] = String(effective.multiplier);
      if (ctx.graphicsHost === "explicit") environment.RESHADE_SPATIAL_METHOD = "bilinear";
      else Object.assign(environment, SourceResolution.environment(sourceDecision.support));
      if (effective.method) environment.RESHADE_RENDER_SOURCE_METHOD = effective.method;
      appliedResolution = effective;
    }
    if (sourceDecision.processing) {
      const descriptor = sourceDecision.processing, leading = nodes.find(node => node.enabled);
      if (!(descriptor.resolutionAuto && nodes.some(node => node.enabled && node.resolutionAuto)) &&
          !(leading?.kind === "spatial" && (leading.method === "downsample" || leading.resizeDirection === "downsample") &&
          (leading.resolutionAuto && descriptor.resolutionAuto || !leading.resolutionAuto && !descriptor.resolutionAuto &&
          JSON.stringify(leading.outputSize || null) === JSON.stringify(descriptor.outputSize || null) &&
          (leading.presentationScale ?? null) === (descriptor.presentationScale ?? null)))) {
        let id = "source-resolution-fallback";
        for (let suffix = 1; nodes.some(node => node.id === id); suffix++) id = "source-resolution-fallback-" + suffix;
        processingReduction = {id, kind: "spatial", enabled: true, ...descriptor,
          settings: stageSettings({kind: "spatial", method: "downsample", settings: {spatialMultiplier: null}})};
        nodes.unshift({...processingReduction, requirements: {depth: false, motion: false}});
      }
    }
    if (requestedResolution && (sourceDecision.strategy === "processing" || sourceDecision.strategy === "original" || sourceDecision.fallbackReasons?.length))
      warn(options.logger, `[Graphics] Source resolution requested=${JSON.stringify(requestedResolution)}; strategy=${sourceDecision.strategy}; ${sourceDecision.reason}`);
  }
  const groupedNodes = await require("../reshade/plane-groups").prepare(nodes, {features: ctx.state.shaderFeatures,
    root: ctx.root, userDataDir: ctx.userDataDir, execute: options.execute, signal: options.signal});
  nodes.splice(0, nodes.length, ...groupedNodes);
  if(ctx.graphicsCapabilities.adaptiveQuality)for(const node of nodes)if(node.enabled){
    const scope=node.modelOperation?Providers.MODEL_OPERATIONS[node.modelOperation]?.gpuWorkScope:
      node.kind==="shader"?require("../reshade/shader-providers").gpuWorkScope(node.format):gpuWorkScope(node);
    if(scope)node.gpuWorkScope=scope;
  }
  const automaticMotion=plan.output?.motionClarity===undefined&&nodes.some(node => node.enabled && node.displaySubframes)?
    {motionClarity: "beam", subframes: 2, duty: .5, brightness: 1}:undefined;
  let output=plan.output||automaticMotion?{...automaticMotion,...plan.output}:undefined;
  const pendingOutput=[];
  if(output?.toneMapping!==undefined&&(output.toneMapping==="auto"||!ctx.graphicsCapabilities.outputColor)){
    if(output.toneMapping!=="auto")pendingOutput.push({id:"tone-mapping",reason:"Output tone mapping requires an updated graphics runtime. Automatic mapping remains active."});
    const {toneMapping,...supportedOutput}=output;output=Object.keys(supportedOutput).length?supportedOutput:undefined;
  }
  if(output?.motionClarity !== undefined && output.motionClarity !== "off" && !ctx.graphicsCapabilities.motionClarity)
    throw new Error("Display subframes require an updated graphics runtime.");
  if(output?.adaptiveQuality && !ctx.graphicsCapabilities.adaptiveQuality){
    if(output.adaptiveQuality.enabled)throw new Error("Adaptive quality requires an updated graphics runtime.");
    const {adaptiveQuality,...supportedOutput}=output;output=Object.keys(supportedOutput).length?supportedOutput:undefined;
  }
  if(output?.comparison && !ctx.graphicsCapabilities.comparison){
    if(output.comparison.mode!=="off")throw new Error("Image comparison requires an updated graphics runtime.");
    const {comparison,...supportedOutput}=output;output=Object.keys(supportedOutput).length?supportedOutput:undefined;
  }
  const document = { schema: 1, mode: "advanced", revision: digest(output ? {nodes,output} : nodes), nodes, ...(output ? {output} : {}) };
  // No running reader sees partial rows or a failed compilation.
  if (options.live ? !LaunchBinding.isCurrent(entry, launch, options) : options.isCurrent && options.isCurrent() !== true) return defer(STOPPED);
  if (require("../reshade/runtime-status").supported(ctx.root)) try {
    const binding = currentLaunch || LaunchBinding.read(entry, {userDataDir: ctx.userDataDir});
    if (binding?.launchId) {
      const accepted = acceptedState || (options.live ? require("../reshade/runtime-status").accepted?.(entry, options) : null);
      require("./live-plan").recordDocument(file(entry, ctx.userDataDir), document, {launchId: binding.launchId,
        acceptedRevision: accepted?.revision, root: ctx.userDataDir, publication: options.publication});
    }
  } catch (error) {warn(options.logger, `Live graphics history is unavailable: ${error.message}`);}
  if (options.publication) options.publication.write(file(entry, ctx.userDataDir), JSON.stringify(document), {root: ctx.userDataDir, activation: true});
  else Writable.atomicWrite(file(entry, ctx.userDataDir), JSON.stringify(document), { root: ctx.userDataDir });
  const appliedPlan = {...plan, ...(processingReduction ? {video: [processingReduction, ...plan.video]} : {})};
  if(output)appliedPlan.output=output;else delete appliedPlan.output;
  if (appliedResolution && !appliedResolution.automatic) appliedPlan.renderResolution = appliedResolution;
  else delete appliedPlan.renderResolution;
  const preparationStatus = {schema: 1, scope: "shared", mode: "advanced",
    ...(output||pendingOutput.length ? {output: {requested: plan.output || null, applied: output || null,...(pendingOutput.length?{pending:pendingOutput}:{})}} : {}),
    requested: projection||modelPending.length ? Plan.execution(requestedPlan).video.filter(node => node.enabled).map(describeNode) : requestedNodes,
    applied: appliedPlan.video.filter(node => node.enabled).map(describeNode), skipped: [...skipped.values()],
    ...(projection||modelPending.length||lastWorking.size ? {pending:[...new Map([...(projection?.pending||[]),...modelPending,...lastWorking.values()].map(node=>[node.id,node])).values()]} : {}),
    sourceResolution: {requested: selectedPlan.renderResolution || null, applied: appliedResolution || null,
      ...(sourceDecision ? {strategy: sourceDecision.strategy, processing: sourceDecision.processing, reason: sourceDecision.reason,
        ...(sourceDecision.processingGuard ? {processingGuard: true} : {}),
        ...(sourceDecision.fallbackReasons?.length ? {fallbackReasons: sourceDecision.fallbackReasons} : {})} : {})}};
  if (options.live && launch) {
    const launchFile = path.join(directory, "launch.json"), updated = {...launch,
      graphicsLivePreparation: {revision: document.revision, preparationStatus}};
    if (options.publication) options.publication.write(launchFile, JSON.stringify(updated), {root: ctx.userDataDir});
    else try {Writable.atomicWrite(launchFile, JSON.stringify(updated), {root: ctx.userDataDir});}
    catch (error) {warn(options.logger, "Live graphics status is unavailable.", error.message);}
    for (const row of [...projection?.pending || [], ...lastWorking.values()]) warn(options.logger, `[Graphics] ${row.id} remains pending: ${row.reason}`);
    if (launch.effectPlanLiveResources?.xess && !nodes.some(node => node.enabled && node.method === "xess"))
      releaseXess(launch.effectPlanLiveResources.xess, options.publication);
  }
  const returnedPlan=requestedPlan.enabled === false||modelPending.length ? requestedPlan : projection ? savedPlan : options.prepareEffectsEntry ? modelDefaults(savedPlan, ctx) : plan;
  const automaticModels=new Set(requestedPlan.enabled===false?[]:requestedPlan.video.filter(node=>node.enabled&&!node.settings?.modelPath&&Providers.modelOperation(node,ctx)).map(node=>node.id));
  return { plan: {...returnedPlan,video:returnedPlan.video.map(node=>{
    const desired=ownedFitOriginals.get(node.id)||node;
    return automaticModels.has(node.id)?{...desired,settings:{...desired.settings,modelPath:null}}:desired;
  })},
    appliedPlan, preparationStatus, document, environment, bindings,
    file: file(entry, ctx.userDataDir) };
}
// ACCEPTANCE SEAM (WP-2). The only reader of native plan acceptance: live
// projection retains resources from it, and main reports it to the graphics
// status owner. It leases the runtime status page for a bounded wait. The
// native acknowledgement watcher (C3) replaces this body; the two never coexist.
// A slow observer renews the existing metadata lease and reads once. It
// creates no image work and does not hold the publication queue waiting.
function primedLaunch(entry, options) {
  const Binding = require("../reshade/launch-binding"), launch = options.launchBinding || Binding.read(entry, options);
  options.signal?.throwIfAborted();
  if (launch && (!Binding.matches(launch, options.runningPids) || !Binding.isCurrent(entry, launch, options)))
    throw Object.assign(new Error("The running graphics session changed during observation."), {code: "GRAPHICS_LIVE_STALE"});
  return launch?.phase === "spawned" && require("../reshade/runtime-status").prime(launch.runtimeStatus, options) ? launch : null;
}
async function acceptance(entry, options = {}) {
  const Status = require("../reshade/runtime-status");
  if (options.timeoutMs === 0) return primedLaunch(entry, options) ? Status.accepted(entry, options) : null;
  // A caller waiting for one revision (`revision`) keeps asking while an
  // earlier revision is accepted, and gets that earlier one when its wait ends.
  const existing = Status.accepted(entry, options);
  if (existing && (!options.revision || existing.revision === options.revision)) return existing;
  return await Status.acquireAccepted(entry, options) || existing || null;
}
// The row outcomes of an accepted revision (`revision`), read like a slow
// observer from every current context that accepted it, without another
// acceptance vote.
function outcomes(entry, options = {}) {
  return primedLaunch(entry, options) ? require("../reshade/runtime-status").outcomes(entry, options) : null;
}
// Why the running game has not acknowledged a publication, when native code
// reported a reason.
function acceptanceReason(entry, options = {}) {
  return require("../reshade/runtime-status").pendingReason(entry, options);
}
function preparation(entry, options = {}) {
  return require("../reshade/runtime-status").preparation(entry, options);
}
// The plan document without rows. Native code acknowledges it as pass-through
// with this revision, the one an empty prepared plan also has.
const emptyDocument = () => ({schema: 1, mode: "advanced", revision: digest([]), nodes: []});
// Publishes the empty document: Clear effects, and a launch without processing.
function publishSimple(entry, userDataDir, {publication, running, launchBinding} = {}) {
  const document = emptyDocument(), target = file(entry, userDataDir);
  if (running && launchBinding?.effectPlanLiveResources?.xess) releaseXess(launchBinding.effectPlanLiveResources.xess, publication);
  if (publication) publication.write(target, JSON.stringify(document), {root: userDataDir, activation: true});
  else Writable.atomicWrite(target, JSON.stringify(document), { root: userDataDir });
  Writable.assertOwnDirectory(userDataDir, path.join(path.dirname(target), "plan-nodes"));
  if (publication) {publication.metadata.sourceResolutionCandidate = null;publication.metadata.sourceResolutionControl = null;}
  return target;
}
// The XeSS request watcher follows the prepared plan; a registered row starts
// it again. A rolled-back publication restores the earlier plan's demand.
function releaseXess(binding, publication) {
  const Broker = require("../runtime/gpu-compute-broker"), before = Broker.demand(binding, false);
  if (before) publication?.onRollback?.(() => Broker.demand(binding, true));
}
module.exports = { file, supported, info, templates, facts, describe, stageSettings, prepare, publishSimple, emptyDocument, acceptance, outcomes, acceptanceReason, preparation };
