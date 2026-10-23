const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Plan = require("./plan"), Graphics = require("../reshade/graphics-settings");
const Live = require("../reshade/live-controls"), Writable = require("../writable-input");
const SourceResolution = require("../reshade/source-resolution");
const LaunchBinding = require("../reshade/launch-binding");
const warn = require("../graphics-warning");
const {info: infoGraphics} = require("../graphics-warning");
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const preserving = new Set(["grayscale", "vibrance", "sharpen", "cas"]);
function file(entry, userDataDir) { return path.join(path.dirname(Live.file(entry, userDataDir)), "effect-plan.json"); }
function supported(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, "runtime.json"), "utf8")).features?.graphics?.effectPlanAPI === 1; }
  catch { return false; }
}
function context(options = {}, entry) {
  const ReShade = require("../reshade"), root = options.root || ReShade.runtimeRoot(options.app);
  const demand = entry && ReShade.executionRequirements(entry);
  // Editor discovery includes all installed choices. Preparation needs only
  // the selected rows and must not inventory unrelated providers or models.
  const state = demand ? ReShade.launchState({ ...options, root }) : ReShade.getState({ ...options, root });
  if (demand) {
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
        state.defaultModelVersion = options.settings?.runtimes?.["graphics-models"]?.defaultVersion || null;
      }
    }
  }
  return { ...options, root, state, neuralProvider: !demand || demand.needed.neural ? require("../reshade/neural").resolve(root, options) : null,
    graphicsCapabilities: Graphics.capabilities(root, options.graphicsHost, { graphicsInputs: options.graphicsInputs,
      graphicsArchitecture: options.graphicsArchitecture, macOSVersion: options.macOSVersion,
      ...(demand ? { selectedMethods: demand.methods } : {}) }) };
}
function catalog(entry, options) {
  const rows = Plan.catalog({ ...options, reshadeState: options.state, graphicsSettings: entry.graphics });
  if (!supported(options.root)) return rows.map(row => ({ ...row, available: false, availableWithoutModel: false, reason: "Ordered effects are unavailable in this application build." }));
  if (!["window", "remote", "explicit", "catalyst"].includes(options.graphicsHost))
    return rows.map(row => ({ ...row, available: false, availableWithoutModel: false, reason: "Shared frame presentation is unavailable for this runtime." }));
  const graphics = JSON.parse(fs.readFileSync(path.join(options.root, "runtime.json"), "utf8")).features?.graphics || {};
  return rows.map(row => {
    if (Array.isArray(graphics.effectPlanKinds) && !graphics.effectPlanKinds.includes(row.kind))
      return { ...row, available: false, availableWithoutModel: false, reason: row.reason || "The included processor cannot place this method in an ordered chain. Use Simple controls for this method." };
    const scope = graphics.effectPlanTemporal, input = options.graphicsInputs;
    if (row.kind === "temporal" && scope && (!["source", "output", "commandBuffer"].every(key => typeof scope[key] === "string") ||
        scope.source !== input?.temporalSource || scope.output !== input?.temporalOutput || scope.commandBuffer !== input?.commandBuffer ||
        Array.isArray(scope.hosts) && !scope.hosts.includes(options.graphicsHost)))
      return { ...row, available: false, reason: row.reason || "This rendering path cannot supply matching scene inputs and output for an ordered temporal effect. Simple temporal controls remain available." };
    return row;
  });
}
function info(entry, options = {}) {
  const ctx = context(options), advanced = Plan.normalize(entry.effects);
  let live = false, launch;
  if (options.running) launch = LaunchBinding.read(entry, options);
  const ReShade = require("../reshade"), draftOptions = {...ctx, draftPlan: true};
  if (!advanced && launch?.sourceControl && ReShade.automaticResolutionOptions(entry, ctx).automaticResolutionNode) {
    const receipt = require("../reshade/source-controls").completed(launch.sourceControl);
    if (receipt?.verified && receipt.outputSize) {
      draftOptions.presentationSize = receipt.outputSize;
      draftOptions.presentationSourceSize = receipt.dimensions;
    }
  }
  const automatic = !advanced && ReShade.automaticPlan(entry, draftOptions);
  if (options.running) live = launch?.effectPlanAPI === 1;
  let selectedShaderTraits;
  if (!advanced && entry.reshade?.enabled && entry.reshade.preset === "custom") {
    try { selectedShaderTraits = require("../reshade").resolveShaderSelection(entry, ctx)?.traits; } catch {}
  }
  return { mode: advanced ? "advanced" : "simple", live, plan: modelDefaults(advanced || automatic || Plan.fromLegacy(entry), ctx, launch), catalog: catalog(advanced ? {} : entry, ctx),
    templates: reconstructionTemplates(entry, ctx),
    ...(selectedShaderTraits ? { selectedShaderTraits } : {}),
    shaderBindingsNextLaunch: ctx.graphicsInputs?.shaderBindingsNextLaunch === true,
    sourceResolution: sourceResolution(ctx, launch) };
}
function reconstructionTemplates(entry, ctx) {
  const ReShade = require("../reshade"), Neural = require("../reshade/neural"), graphics = Graphics.normalizeSettings(entry.graphics);
  const installed = ctx.state.neuralModels || [], selected = ctx.settings?.runtimes?.["graphics-neural-models"]?.defaultVersion;
  const modelPath = graphics.neuralModelPath || installed.find(model => model.version === selected)?.modelPath || installed[0]?.modelPath || null;
  let selection, reason;
  if (entry.reshade?.enabled) try { selection = ReShade.resolveShaderSelection(entry, ctx); } catch (error) { reason = error.message; }
  const shaderFacts = {"legacy-shader": {traits: selection?.traits, requirements: selection?.requirements || []}};
  const plan = modelDefaults(Plan.reconstructionPreset({...entry, graphics: {...graphics, neuralModelPath: modelPath}}, {shaderFacts}), ctx);
  try {
    if (reason) throw new Error(reason);
    Plan.validateOrdering(plan, facts(plan, node => catalog({graphics: node.settings || graphics}, ctx)));
    if (!modelPath) throw new Error("Choose a compatible neural rendering model before applying this preset.");
    Neural.model(modelPath);
  } catch (error) { reason = error.message; }
  return [{id: "reconstruction-4x", name: "Reconstruction + frame generation · 4×", plan, available: !reason, ...(reason ? {reason} : {})}];
}
function sourceResolution(ctx, launch) {
  const support = SourceResolution.capabilities(ctx.graphicsHost, ctx.graphicsInputs, ctx.graphicsCapabilities.resolutionMultipliers, ctx.graphicsCapabilities.virtualWindow);
  const { heights, multipliers, methods, methodLabels } = support;
  // The editor needs the current launch contract as well as the adapter's
  // declaration. In particular, a launched virtual source can already switch
  // live even when this core cannot activate one from an initially-off launch.
  const live = ctx.running ? launch?.sourceControl?.support?.live === true : support.live === true;
  return { heights, multipliers, ...(live ? {live: true} : {}), ...(methods ? {methods} : {}), ...(methodLabels ? {methodLabels} : {}) };
}
function modelDefaults(plan, ctx, launch) {
  return { ...plan, video: plan.video.map(node => {
    if (!node.enabled || node.kind === "shader" || node.settings.modelVersion || !["ls1", "lsfg"].includes(node.method)) return node;
    if (launch) {
      const version = LaunchBinding.modelForNode(launch, node);
      if (version) return {...node, settings: {...node.settings, modelVersion: version}};
      if (launch.effectPlanLiveResources?.schema !== 1) return node;
    }
    const row = Plan.catalog({ ...ctx, reshadeState: ctx.state, graphicsSettings: node.settings })
      .find(row => row.id === node.kind + ":" + node.method);
    const version = row?.template.settings.modelVersion;
    return version ? { ...node, settings: { ...node.settings, modelVersion: version } } : node;
  }) };
}
function facts(plan, rows) {
  const nodes = {};
  for (const node of plan.video) {
    const id = node.kind === "shader" ? /^(shader|filter):/.test(node.shader.preset) ? node.shader.preset : "shader:" + node.shader.preset : node.kind + ":" + node.method;
    const row = (typeof rows === "function" ? rows(node) : rows).find(item => item.id === id);
    const requirements = row?.requirements || [];
    nodes[node.id] = { available: row?.available === true, label: row?.label || node.method || "Shader", reason: row?.reason || "Choose an available effect.",
      requirements: { depth: requirements.includes("depth"), motion: requirements.includes("motion") || requirements.includes("temporal-inputs") },
      preservesCoordinates: node.kind === "shader" && (preserving.has(node.shader.preset) ||
        node.shader.preset === "chain" && node.shader.effects?.every(id => preserving.has(id))) };
  }
  return { nodes };
}
async function describe(entry, nodeId, draft, options = {}) {
  const plan = draft === undefined ? Plan.normalize(entry.effects) || Plan.fromLegacy(entry) : Plan.validate(draft);
  const node = plan.video.find(row => row.id === nodeId);
  if (!node || node.kind !== "shader") throw new Error("Choose a shader row to edit its parameters.");
  // Describing a draft must never publish a plan or activate Advanced.
  return require("../reshade").describeParameters({ ...entry, reshade: node.shader }, { ...options, parameterLimit: Plan.MAX_PARAMETERS });
}
function stageSettings(node) {
  return Graphics.updateStageSettings(node.settings, { spatialMultiplier: node.settings.spatialMultiplier,
    spatialMethod: node.kind === "spatial" ? node.method : "off",
    temporalMethod: node.kind === "temporal" ? node.method : "off", frameGeneration: node.kind === "frame-generation" ? node.method : "off",
    effectPlacement: "before" });
}
async function prepare(entry, options = {}) {
  const savedPlan = Plan.validate(entry.effects);
  const currentLaunch = options.live ? LaunchBinding.read(entry, options) : null;
  options.publication?.observe(file(entry, options.userDataDir), {root: options.userDataDir});
  if (options.live || options.isCurrent) options.publication?.guard(() => options.live ? LaunchBinding.isCurrent(entry, currentLaunch, options) : options.isCurrent() === true);
  function defer() {
    const nodes = Object.fromEntries(savedPlan.video.map(node => [node.id, {preservesCoordinates: node.kind === "shader" &&
      (preserving.has(node.shader.preset) || node.shader.preset === "chain" && node.shader.effects?.every(id => preserving.has(id)))}]));
    Plan.validateOrdering(savedPlan, {nodes});
    options.publication?.defer();
    infoGraphics(options.logger, "Graphics settings remain pending; current rendering is retained.");
    return {plan: savedPlan, deferred: true};
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
      if (original?.mode !== "simple" || original.nodes.length || controls.length !== 19116 || controls.toString("ascii", 0, 8) !== "MLFXCTL2" ||
          (controls.readUInt32LE(16) & (1 | 8)) || controls.readUInt32LE(152) !== 0 || !LaunchBinding.isCurrent(entry, currentLaunch, options)) return null;
      return {schema: 1, mode: "advanced", nodes: [], revision: digest([])};
    } catch {return null;}
  };
  const project = async (candidate, library, unavailable) => {
    options.signal?.throwIfAborted();
    if (currentLaunch?.effectPlanAPI !== 1) return null;
    const unavailableReason = unavailable || (node => LaunchBinding.nodeUnavailableReason(currentLaunch, node, library));
    if (!candidate.video.some(node => node.enabled && !unavailableReason(node))) return null;
    const empty = untouchedActivation();
    if (empty) return require("./live-plan").project(candidate, empty, unavailableReason);
    // A published candidate may still have been rejected by the native owner.
    // Retain resources only from its explicitly acknowledged immutable graph.
    const Status = require("../reshade/runtime-status");
    acceptedState ??= Status.accepted(entry, options) || await Status.acquireAccepted(entry, {...options, launchBinding: currentLaunch,
      timeoutMs: candidate.video.some(node => node.enabled && node.kind === "neural") ? 5000 : 2500}) || false;
    if (!acceptedState || acceptedState.launchId !== currentLaunch.launchId || acceptedState.launchPid !== currentLaunch.pid) return null;
    if (!previousDocument) previousDocument = require("./live-plan").readAcceptedDocument(file(entry, options.userDataDir),
      {launchId: currentLaunch.launchId, revision: acceptedState.revision, publication: options.publication});
    return require("./live-plan").project(candidate, previousDocument, unavailableReason);
  };
  const acceptProjection = next => {
    if (projection) {
      for (const [id, row] of projection.retained) next.retained.set(id, row);
      next.pending = [...new Map([...next.pending, ...projection.pending].map(row => [row.id, row])).values()];
    }
    projection = next;
  };
  if (options.live && options.runningPids !== undefined && !LaunchBinding.supportsPlan(currentLaunch, savedPlan)) {
    projection = await project(savedPlan);
    if (!projection) return defer();
  }
  const processingInput = projection ? {...entry, effects: projection.plan} : entry;
  const processingEntry = await options.prepareEffectsEntry?.(processingInput) || processingInput;
  let selectedPlan = Plan.validate(processingEntry.effects);
  let ctx = context(options, { ...processingEntry, effects: selectedPlan });
  let plan = modelDefaults(selectedPlan, ctx, currentLaunch);
  const describeNode = node => ({id: node.id, kind: node.kind, method: node.kind === "shader" ? node.shader.preset : node.method});
  const requestedNodes = selectedPlan.video.filter(node => node.enabled).map(describeNode), skipped = new Map();
  const simpleFallback = options.fallback === true && options.fallbackPolicy === "simple";
  const skip = (node, reason) => {
    const message = simpleFallback ? `${capabilities.nodes[node.id].label}: ${reason}` : reason;
    node.enabled = false;skipped.set(node.id, {...describeNode(node), reason: message});
    warn(options.logger, `[Graphics] Skipping ${node.id}: ${reason}`);
  };
  if (currentLaunch && !LaunchBinding.supportsPlan(currentLaunch, plan, ctx.neuralProvider?.library || null)) {
    const next = await project(plan, ctx.neuralProvider?.library || null);
    if (!next) return defer();
    acceptProjection(next);selectedPlan = next.plan;
    ctx = context(options, {...processingEntry, effects: selectedPlan});
    plan = modelDefaults(selectedPlan, ctx, currentLaunch);
  }
  if (!ctx.state.available) throw new Error(ctx.state.reason);
  if (!supported(ctx.root)) throw new Error("Ordered effects are unavailable in this application build.");
  if (options.verify) options.verify(ctx.root);
  else require("../reshade/payload-verification").verifyLaunch(ctx.root, {}, {presenter: true});
  let rows = catalog(entry, ctx), capabilities = facts(plan, node => node.kind === "shader" ? rows :
    catalog({ graphics: node.settings }, ctx));
  if (options.live && plan.video.some(node => node.enabled && !projection?.retained.has(node.id) && capabilities.nodes[node.id].available === false)) {
    const next = await project(plan, ctx.neuralProvider?.library || null, node => projection?.retained.has(node.id) ? null :
      capabilities.nodes[node.id].available === false ? capabilities.nodes[node.id].reason :
        LaunchBinding.nodeUnavailableReason(currentLaunch, node, ctx.neuralProvider?.library || null));
    if (!next) return defer();
    acceptProjection(next);selectedPlan = next.plan;
    ctx = context(options, {...processingEntry, effects: selectedPlan});plan = modelDefaults(selectedPlan, ctx, currentLaunch);
    rows = catalog(entry, ctx);capabilities = facts(plan, node => node.kind === "shader" ? rows : catalog({graphics: node.settings}, ctx));
  }
  if (projection) {
    const requestedFacts = {...capabilities, nodes: {...capabilities.nodes}};
    for (const node of savedPlan.video) requestedFacts.nodes[node.id] = {...requestedFacts.nodes[node.id], available: true};
    Plan.validateOrdering(savedPlan, requestedFacts);
    for (const [id, node] of projection.retained) capabilities.nodes[id] = {...capabilities.nodes[id], available: true,
      requirements: node.requirements || {}, preservesCoordinates: node.preservesCoordinates === true};
  }
  if (options.fallback === true && !options.live) {
    // Availability can change after a game was configured. Keep independent
    // stages usable on launch; explicit editor changes remain transactional.
    for (let index = 0; index < plan.video.length; index++) {
      const node = plan.video[index];
      if (!node.enabled) continue;
      try {
        if (options.automaticSimple) {
          if (capabilities.nodes[node.id].available === false) throw new Error(capabilities.nodes[node.id].reason);
        } else Plan.validateOrdering({ ...plan, video: plan.video.slice(0, index + 1) }, capabilities);
      }
      catch (error) { skip(node, error.message); }
    }
  }
  if (!options.automaticSimple) Plan.validateOrdering(plan, capabilities);
  const nodes = [], shaderFacts = {}, environment = {}, bindings = {}, directory = path.dirname(file(entry, ctx.userDataDir));
  Writable.assertOwnDirectory(ctx.userDataDir, directory);
  Writable.assertOwnDirectory(ctx.userDataDir, path.join(directory, "plan-nodes"));
  let launch;
  if (options.live) {
    launch = currentLaunch;
    if (launch?.effectPlanAPI !== 1) throw new Error("Restart the game to use ordered effects.");
    ctx.resolveModel = (directory, version, capability, selectedOptions) => LaunchBinding.resolveModel(launch, directory, version, capability, selectedOptions);
    ctx.isCurrent = () => LaunchBinding.isCurrent(entry, launch, options);
  }
  for (const node of plan.video) {
    options.signal?.throwIfAborted();
    if (!node.enabled) { nodes.push({ id: node.id, kind: node.kind, enabled: false }); continue; }
    if (projection?.retained.has(node.id)) {nodes.push(projection.retained.get(node.id));continue;}
    const requirements = capabilities.nodes[node.id].requirements;
    try {
    if (!options.verify) require("../reshade/payload-verification").verifyLaunch(ctx.root,
      {effects: {schema: 1, mode: "advanced", video: [node]}}, {...ctx, shaderFeatures: ctx.state.shaderFeatures});
    if (node.kind === "shader") {
      const ownedDirectory = path.join(directory, "plan-nodes", node.id);
      const effects = await require("../reshade/live-effect").prepare({ ...entry, reshade: node.shader },
        { ...ctx, features: ctx.state.shaderFeatures, force: options.force === true || options.launchPreparation === true &&
            (node.shader.preset === "custom" || require("../reshade/filter-library").isFilterId(node.shader.preset)),
          directory: ownedDirectory, execute: options.execute || require("node:util").promisify(require("node:child_process").execFile) });
      const selectionFile = path.join(ownedDirectory, "live-selection.json");
      const selection = JSON.parse(options.publication ? options.publication.read(selectionFile, "utf8") : await fs.promises.readFile(selectionFile, "utf8"));
      if (!/^[a-f0-9]{64}$/.test(selection.revision || "") || !/^[a-f0-9]{64}$/.test(selection.key || "")) throw new Error("The shader selection is invalid.");
      if (selection.requirements) {
        if (typeof selection.requirements.depth !== "boolean" || typeof selection.requirements.motion !== "boolean") throw new Error("Invalid shader input requirements.");
        requirements.depth ||= selection.requirements.depth;requirements.motion ||= selection.requirements.motion;
        const depth = ctx.state.shaderFeatures?.depth;
        if (requirements.depth && ctx.graphicsInputs?.depth !== true && !(ctx.graphicsHost === "window" && (depth === true || depth?.hosts?.includes("window"))))
          throw new Error("This shader requires scene depth from the current graphics path.");
        if (requirements.motion && ctx.graphicsInputs?.motionVectors !== true) throw new Error("This shader requires game motion vectors.");
      }
      if (!options.automaticSimple) Plan.validateOrdering({ ...plan, video: plan.video.slice(0, plan.video.indexOf(node) + 1) }, capabilities);
      const format = selection.format || "fx", filename = format === "slangp" ? "effect.slangp" : format === "libplacebo" ? "effect.hook" : "effect.prepared.fx";
      const preparedFile = path.join(effects, selection.revision, filename);
      const traits = format === "libplacebo" ? require("../reshade/shader-traits").inspect(await fs.promises.readFile(preparedFile, "utf8"), format) : null;
      shaderFacts[node.id] = { traits, requirements };
      nodes.push({ id: node.id, kind: node.kind, enabled: true, format, file: path.join(effects, selection.revision, filename),
        key: selection.key, revision: selection.revision, ...(node.shader.preset === "chain" ? { technique: "MacLauncherChain" } : {}),
        parameters: node.shader.parameters || {}, requirements, preservesCoordinates: capabilities.nodes[node.id].preservesCoordinates === true,
        ...(traits?.conditionalGeometry || traits?.displayDependentGeometry || traits?.unresolvedGeometry ? {outputExtent: "presentation"}
          : traits?.outputScale ? {outputScale: traits.outputScale} : {}) });
    } else if (node.kind === "neural") {
      const Neural = require("../reshade/neural"), identity = Neural.modelIdentity?.(ctx.userDataDir, node.settings.modelPath);
      if (options.live && !identity && !launch.effectPlanNeuralModels?.includes(node.settings.modelPath))
        throw new Error("Import the selected neural model in Runtimes before switching during play.");
      if (identity) await ctx.useRuntime?.(identity);
      if (options.live && identity) await require("../reshade/neural/models").resolveModel(ctx.userDataDir, identity.version, {signal: options.signal});
      const prepared = Neural.prepare(node.settings, ctx);
      if (options.live && !LaunchBinding.allowsNeural(launch, prepared.settings.modelPath, prepared.environment.RESHADE_NEURAL_LIBRARY))
        throw new Error("Restart the game to use this neural rendering provider or model.");
      Object.assign(environment, prepared.environment);
      nodes.push({ id: node.id, kind: node.kind, enabled: true, method: node.method, settings: prepared.settings,
        modelPath: prepared.settings.modelPath, requirements });
    } else {
      const settings = stageSettings(node);
      // A stage controls its own output, not the producer allocation. Pass the
      // scaler implementation through its normal capability/model validation.
      const prepared = await Graphics.prepare({ ...settings, spatialMultiplier: null }, ctx);
      if (options.live && prepared.RESHADE_LOSSLESS_MODEL && !LaunchBinding.allowsModel(launch, prepared.RESHADE_LOSSLESS_MODEL, "lossless"))
        throw new Error("Restart the game to use a different Lossless Scaling model.");
      if (prepared.RESHADE_LOSSLESS_MODEL) bindings[settings.modelVersion] = { path: prepared.RESHADE_LOSSLESS_MODEL,
        capabilities: ctx.state.models?.find(model => model.version === settings.modelVersion)?.capabilities || [] };
      // Implementations and the selected model are launch inputs. Each node
      // also retains its own model binding; row order never selects a model.
      for (const [key, value] of Object.entries(prepared)) if (["RESHADE_FSR2_LIBRARY", "RESHADE_FSR3_LIBRARY", "RESHADE_FSR4_LIBRARY", "RESHADE_FSR_SHADER_DIRECTORY", "FSR4_ROOT", "FSR4_BUILD_DIR"].includes(key)) environment[key] = value;
      nodes.push({ id: node.id, kind: node.kind, enabled: true, method: node.method, settings, requirements,
        ...(node.outputSize && node.id !== options.automaticResolutionNode ? { outputSize: node.outputSize } : {}),
        ...(node.presentationScale !== undefined ? { presentationScale: node.presentationScale } : {}),
        ...(node.kind === "spatial" && node.method === "downsample" && node.id === options.automaticResolutionNode ? { resolutionAuto: true } : {}),
        ...(prepared.RESHADE_LOSSLESS_MODEL ? { modelPath: prepared.RESHADE_LOSSLESS_MODEL } : {}) });
    }
    } catch (error) {
      if (error.code === "GRAPHICS_LIVE_STALE" || options.isCurrent && options.isCurrent() !== true) return defer();
      if (!options.fallback || options.live || options.signal?.aborted || error.name === "AbortError" || error.code === "ABORT_ERR") throw error;
      skip(node, error.message);
      nodes.push({ id: node.id, kind: node.kind, enabled: false });
    }
  }
  if (options.automaticSimple) {
    // The original compiler's requirements take precedence over discovery
    // metadata. Custom depth/motion shaders are placed before geometry only
    // after their actual input contract has been validated.
    plan.video = Plan.orderSimple(plan, {shaderFacts}).video;
    const prepared = new Map(nodes.map(node => [node.id, node]));
    if (!plan.video.some(node => node.enabled && node.kind === "neural") ||
        !plan.video.some(node => node.enabled && node.kind === "spatial" && node.method !== "downsample")) {
      const reduction = plan.video.find(node => node.id === "legacy-neural-input");
      if (reduction && requestedNodes.some(node => node.id === reduction.id)) skipped.set(reduction.id, {...describeNode(reduction),
        reason: "Automatic input reduction was removed because neural rendering or final spatial scaling is unavailable."});
      plan.video = plan.video.filter(node => node.id !== "legacy-neural-input");
      // Automatic source requests depend on the selected reconstruction chain.
      // Advanced processing and source requests retain their manual semantics.
      if (selectedPlan.video.some(node => node.id === "legacy-neural-input")) delete plan.renderResolution;
    }
    nodes.length = 0;
    for (let index = 0; index < plan.video.length; index++) {
      const node = plan.video[index];
      if (node.enabled && options.fallback && !options.live) {
        try { Plan.validateOrdering({...plan, video: plan.video.slice(0, index + 1)}, capabilities); }
        catch (error) { skip(node, error.message); }
      }
      nodes.push(node.enabled ? prepared.get(node.id) : {id: node.id, kind: node.kind, enabled: false});
    }
    if (plan.renderResolution && !plan.video.some(node => {
      if (!node.enabled) return false;
      if (node.kind === "temporal" || node.kind === "neural" || node.kind === "spatial" && node.method !== "downsample") return true;
      const traits = shaderFacts[node.id]?.traits;
      return node.kind === "shader" && Boolean(traits?.neural || traits?.outputScale || traits?.conditionalGeometry ||
        traits?.displayDependentGeometry || traits?.unresolvedGeometry);
    })) delete plan.renderResolution;
  }
  Plan.validateOrdering(plan, capabilities);
  // Source allocation and completed-frame processing have separate outcomes.
  // A fallback must retain the saved request and preserve scene input contracts.
  let appliedResolution = options.live ? launch.effectPlanRenderResolution || undefined : undefined;
  let sourceDecision, processingReduction;
  const automaticSource = options.automaticSimple && options.automaticSourceResolution === true &&
    nodes.some(node => node.enabled && node.resolutionAuto) && nodes.some(node => node.enabled && node.kind === "neural") &&
    nodes.some(node => node.enabled && node.kind === "spatial" && node.method !== "downsample");
  const requestedResolution = automaticSource ? {automatic: true} : plan.renderResolution || null,
    sourceBinding = options.live ? launch.sourceControl : null;
  const failures = {...options.sourceResolutionFailures};
  if (options.live) for (const control of ["engine", "drawable", "virtual", "producer"])
    if (control !== sourceBinding?.control) failures[control] ||= "This launch has no live channel for this source API.";
  const sourceReceipt = sourceBinding ? require("../reshade/source-controls").completed(sourceBinding) : null;
  const canProcessSource = ctx.graphicsCapabilities.spatial && ctx.graphicsCapabilities.spatialMethods.includes("bilinear") &&
    nodes.length < Plan.MAX_NODES && !plan.video.some(node => node.enabled &&
      (node.kind === "temporal" || capabilities.nodes[node.id]?.requirements?.depth || capabilities.nodes[node.id]?.requirements?.motion));
  if (requestedResolution || sourceBinding) {
    sourceDecision = SourceResolution.resolve(requestedResolution, {host: ctx.graphicsHost, inputs: ctx.graphicsInputs,
      producerDivisors: ctx.graphicsCapabilities.resolutionMultipliers, virtualWindow: ctx.graphicsCapabilities.virtualWindow,
      processing: canProcessSource, completedSource: sourceReceipt, excludedControls: failures});
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
    if (effective?.method && plan.video.some(node => node.enabled && node.kind === "temporal")) {
      if (!options.fallback || options.live) throw new Error("A temporal effect controls the source filter. Choose Original for game rendering.");
      effective = {...effective};delete effective.method;
      sourceDecision = {...sourceDecision, source: effective, reason: sourceDecision.reason + " A temporal effect retains control of the source filter."};
    }
    if (requestedResolution?.method && !effective?.method && sourceDecision.source) {
      if (!options.fallback) throw new Error("This renderer cannot use the selected source filter.");
      warn(options.logger, "[Graphics] This renderer cannot use the selected source filter; preserving the renderer filter and remaining effects.");
    }
    if (options.live) {
      // A failed source retry retains its accepted allocation. Processing sizes
      // follow the presentation and never reduce an already smaller source twice.
      if (sourceBinding && options.publication && !options.sourceResolutionFailures?.[sourceBinding.control])
        options.publication.metadata.sourceResolutionCandidate = require("../reshade/source-controls").normalize(effective, sourceBinding.support);
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
          !(leading?.kind === "spatial" && leading.method === "downsample" &&
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
  let generationPlacement;
  if (options.automaticSimple && nodes.some(node => node.enabled && node.kind === "frame-generation")) {
    // A compiled Simple hint leaves saved Advanced rows literal. The native
    // owner chooses from the actual admitted source and presentation extents,
    // not a launch-time window-size snapshot. Qualification is independent of
    // API availability; private candidate measurements do not change defaults.
    let graphics;
    try {graphics = JSON.parse(fs.readFileSync(path.join(ctx.root, "runtime.json"), "utf8")).features?.graphics;} catch {}
    generationPlacement = require("./simple-generation.mjs").applyHint(nodes, {
      api: graphics?.simpleGenerationPlacementAPI,
      qualified: graphics?.simpleGenerationPlacementQualified === true,
      policy: options.simpleGenerationPlacement
    });
    if (generationPlacement && options.publication) options.publication.metadata.simpleGenerationPlacement = generationPlacement;
  }
  const document = { schema: 1, mode: "advanced", revision: digest(nodes), nodes };
  // No running reader sees partial rows or a failed compilation.
  if (options.live ? !LaunchBinding.isCurrent(entry, launch, options) : options.isCurrent && options.isCurrent() !== true) return defer();
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
  if (appliedResolution && !appliedResolution.automatic) appliedPlan.renderResolution = appliedResolution;
  else delete appliedPlan.renderResolution;
  const preparationStatus = {schema: 1, scope: "shared", mode: options.automaticSimple ? "simple" : "advanced",
    requested: projection ? savedPlan.video.filter(node => node.enabled).map(describeNode) : requestedNodes,
    applied: appliedPlan.video.filter(node => node.enabled).map(describeNode), skipped: [...skipped.values()],
    ...(projection ? {pending: projection.pending} : {}),
    sourceResolution: {requested: automaticSource ? requestedResolution : selectedPlan.renderResolution || null, applied: appliedResolution || null,
      ...(sourceDecision ? {strategy: sourceDecision.strategy, processing: sourceDecision.processing, reason: sourceDecision.reason,
        ...(sourceDecision.processingGuard ? {processingGuard: true} : {}),
        ...(sourceDecision.fallbackReasons?.length ? {fallbackReasons: sourceDecision.fallbackReasons} : {})} : {})}};
  if (options.live && launch) {
    const launchFile = path.join(directory, "launch.json"), updated = {...launch,
      graphicsLivePreparation: {revision: document.revision, preparationStatus}};
    if (options.publication) options.publication.write(launchFile, JSON.stringify(updated), {root: ctx.userDataDir});
    else try {Writable.atomicWrite(launchFile, JSON.stringify(updated), {root: ctx.userDataDir});}
    catch (error) {warn(options.logger, "Live graphics status is unavailable.", error.message);}
    for (const row of projection?.pending || []) warn(options.logger, `[Graphics] ${row.id} remains pending: ${row.reason}`);
  }
  return { plan: projection ? savedPlan : options.prepareEffectsEntry ? modelDefaults(savedPlan, ctx) : plan,
    appliedPlan, preparationStatus, document, environment, bindings,
    ...(generationPlacement ? {generationPlacement} : {}), file: file(entry, ctx.userDataDir) };
}
function publishSimple(entry, userDataDir, {publication} = {}) {
  const document = { schema: 1, mode: "simple", revision: digest(["simple"]), nodes: [] }, target = file(entry, userDataDir);
  if (publication) publication.write(target, JSON.stringify(document), {root: userDataDir, activation: true});
  else Writable.atomicWrite(target, JSON.stringify(document), { root: userDataDir });
  Writable.assertOwnDirectory(userDataDir, path.join(path.dirname(target), "plan-nodes"));
  if (publication) publication.metadata.sourceResolutionCandidate = null;
  return target;
}
module.exports = { file, supported, info, facts, describe, stageSettings, prepare, publishSimple };
