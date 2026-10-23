const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const crypto = require("node:crypto");
const Writable = require("../writable-input");
const Native = require("../runtime/bundled-native");
const Publication = require("./publication");
const Graphics = require("./graphics-settings");
const Chain = require("./effect-chain");
const Packs = require("./shader-packs");
const Filters = require("./filter-library");
const Managed = require("./managed-shaders");
const Providers = require("./shader-providers");
const Live = require("./live-controls");
const ExecutionRequirements = require("../effects/execution-requirements");
const LaunchBinding = require("./launch-binding");
const warn = require("../graphics-warning");
const {info: infoGraphics} = require("../graphics-warning");
const run = promisify(execFile);
const { PRESETS, normalizeSettings, updateSettings } = require("./shader-settings");
function runtimeRoot(app) {
  // A development host can itself be a packaged Electron application. Resolve
  // resources beside the loaded source just as the other included runtimes do.
  return Publication.resolveRoot([process.resourcesPath, path.resolve(__dirname, "../../../resources")]);
}
function launchState({root, platform = process.platform, macOSVersion} = {}) {
  if (platform !== "darwin") return {available: false, reason: "ReShade requires macOS."};
  try {
    const record = JSON.parse(fs.readFileSync(path.join(root, "runtime.json"), "utf8"));
    if (record.schema !== 1 || !record.version || typeof record.minimumMacOS !== "string" ||
        !["libreshade-macos.dylib", "fx-compile"].every(file => fs.statSync(path.join(root, file)).isFile())) throw Error("Invalid runtime");
    if (!Native.versionAtLeast(macOSVersion || Native.systemVersionSync(), record.minimumMacOS))
      return {available: false, reason: `This ReShade runtime requires macOS ${record.minimumMacOS} or later.`};
    return {available: true, version: record.version, shaderFeatures: record.features?.shaders || {}};
  } catch { return {available: false, reason: "ReShade is not included in this application build."}; }
}
function getState({ app, root = runtimeRoot(app), platform = process.platform, macOSVersion, userDataDir, settings, graphicsArchitecture, graphicsInputs } = {}) {
  let filters = [], filtersError;
  try { filters = Filters.list(userDataDir); } catch (error) { filtersError = error.message; }
  const filterPresets = filters.map(item => ({ id: "filter:" + item.id, label: item.name, group: item.group || "Imported filters", traits: item.traits,
    nativeVideoAvailable: item.format === "libplacebo" && item.available === true,
    installed: true, format: item.format, available: item.available, ...(item.reason ? { reason: item.reason } : {}) }));
  const result = { available: false, filters, ...(filtersError ? { filtersError } : {}),
    presets: [...PRESETS.filter(item => item.id !== "custom").map(item => ({ ...item })), ...filterPresets, { ...PRESETS.find(item => item.id === "custom") }] };
  if (platform !== "darwin") return { ...result, reason: "ReShade requires macOS." };
  try {
    const record = JSON.parse(fs.readFileSync(path.join(root, "runtime.json"), "utf8"));
    if (record.schema !== 1 || typeof record.minimumMacOS !== "string" || !record.version) throw new Error("Invalid runtime");
    for (const file of ["libreshade-macos.dylib", "fx-compile"]) if (!fs.statSync(path.join(root, file)).isFile()) throw new Error("Missing runtime");
    const version = macOSVersion || Native.systemVersionSync();
    if (!Native.versionAtLeast(version, record.minimumMacOS))
      return { ...result, version: record.version, reason: `This ReShade runtime requires macOS ${record.minimumMacOS} or later.` };
    const shaderFeatures = record.features?.shaders || {};
    const presets = result.presets.map(preset => {
      const reason = graphicsInputs?.nativeVideo === true && preset.nativeVideoAvailable ? null :
        Providers.availability(preset.format, { features: shaderFeatures, graphicsArchitecture, macOSVersion: version });
      return reason ? { ...preset, available: false, reason } : preset;
    });
    const packOptions = { graphicsArchitecture, macOSVersion: version, nativeVideo: graphicsInputs?.nativeVideo === true, settings };
    return { ...result, presets: [...presets.filter(item => item.id !== "custom"), ...Packs.listEffects(userDataDir, shaderFeatures, packOptions),
      ...(userDataDir ? Managed.listEffects(userDataDir, shaderFeatures, packOptions) : []), presets.find(item => item.id === "custom")],
      available: true, neuralAvailable: Boolean(require("./neural").resolve(root, { platform, macOSVersion: version, graphicsArchitecture })),
      version: record.version, graphics: Graphics.capabilities(root, undefined, { platform, macOSVersion: version }), shaderFeatures, shaderParameters: shaderFeatures.parameters === true, shaderLiveSwitching: shaderFeatures.liveSwitching === true,
      ...(userDataDir ? { models: require("./models").listInstalled(userDataDir).map(item => ({ version: item.version,
        label: item.versionLabel, capabilities: Object.keys(item.inspection.capabilities).filter(key => item.inspection.capabilities[key].compatible) })),
        neuralModels: require("./neural").listModels(userDataDir).map(({ version, versionLabel, modelPath }) => ({ version, versionLabel, modelPath })),
        defaultModelVersion: settings?.runtimes?.["graphics-models"]?.defaultVersion || null } : {}) };
  } catch { return { ...result, reason: "ReShade is not included in this application build." }; }
}
function mergeEnvironment(base, effect) {
  const result = { ...base, ...effect };
  if (effect.DYLD_INSERT_LIBRARIES) {
    // A shared-processor-only launch must not inherit a prior effect or model.
    for (const key of Object.keys(base)) if ((key.startsWith("RESHADE_") || ["FSR4_ROOT", "FSR4_BUILD_DIR"].includes(key)) && !Object.hasOwn(effect, key)) delete result[key];
    result.DYLD_INSERT_LIBRARIES = [...new Set([base.DYLD_INSERT_LIBRARIES, effect.DYLD_INSERT_LIBRARIES].flatMap(value => (value || "").split(":")).filter(Boolean))].join(":");
    result.STEAM_DYLD_INSERT_LIBRARIES = [...new Set([base.STEAM_DYLD_INSERT_LIBRARIES, effect.STEAM_DYLD_INSERT_LIBRARIES, result.DYLD_INSERT_LIBRARIES].flatMap(value => (value || "").split(":")).filter(Boolean))].join(":");
  }
  return result;
}
// Explicit frame producers can need presentation while all optional effects
// are off. This resolves only the included library; it does not prepare an
// effect, create per-game state or acquire anything from the network.
function resolvePresentationLibrary({ app, root = runtimeRoot(app),
  verify = directory => require("./payload-verification").verifyLaunch(directory, {}, {presenter: true}) } = {}) {
  const state = launchState({root});
  if (!state.available) throw new Error(state.reason);
  verify(root);
  return path.join(root, "libreshade-macos.dylib");
}
async function prepareLegacy(entry, { userDataDir, app, signal, runtimeId, logger, settings: launcherSettings, useModel, useRuntime, root = runtimeRoot(app), execute = run,
  explicitHost = false, graphicsHost = null, graphicsInputs = null, graphicsArchitecture,
  forceProcessor = false,
  diagnostics = process.env.MACLAUNCHER_RESHADE_DIAGNOSTICS === "1",
  capture = process.env.MACLAUNCHER_RESHADE_CAPTURE === "1",
  gpuTiming = process.env.MACLAUNCHER_RESHADE_GPU_TIMING === "1",
  trace = process.env.RESHADE_TRACE === "1",
  verify } = {}) {
  const settings = normalizeSettings(entry.reshade);
  const graphicsSettings = Graphics.normalizeSettings(entry.graphics);
  if (!graphicsSettings.modelVersion) graphicsSettings.modelVersion = launcherSettings?.runtimes?.["graphics-models"]?.defaultVersion || null;
  const live = !explicitHost && ["window", "remote", "catalyst"].includes(graphicsHost);
  if (!forceProcessor && !settings.enabled && !Graphics.enabled(graphicsSettings)) return {};
  const started = performance.now();
  const state = launchState({root});
  // Optional live controls must not prevent an otherwise unfiltered launch.
  try { if (!state.available) throw new Error(state.reason);(verify || (directory => require("./payload-verification").verifyLaunch(directory, entry,
    {userDataDir, graphicsHost, graphicsArchitecture, activation: forceProcessor || live, shaderFeatures: state.shaderFeatures})))(root); }
  catch (error) {
    if (signal?.aborted || error.name === "AbortError" || error.code === "ABORT_ERR") throw error;
    if (!settings.enabled && !Graphics.enabled(graphicsSettings)) { warn(logger, `[Graphics] Live controls unavailable: ${error.message}`);return {}; }
    throw error;
  }
  const support = Graphics.capabilities(root, graphicsHost, { graphicsInputs, selectedMethods: ExecutionRequirements.analyze(entry).methods });
  const graphicsEnvironment = Graphics.enabled(graphicsSettings) ?
    await Graphics.prepare(graphicsSettings, { root, userDataDir, signal, useModel, graphicsHost, graphicsInputs, graphicsCapabilities: support, logger }) : {};
  if (!/^[\w-]+$/.test(entry.gameId || "")) throw new Error("ReShade requires a saved game.");
  if (live) {
    // Optional providers are bound only by their selected method. A shader-only
    // launch must not inspect or load unrelated temporal or model providers.
    const directory = path.dirname(Live.file(entry, userDataDir));
    const effects = await require("./live-effect").prepare({ ...entry, reshade: settings }, { root, userDataDir, features: state.shaderFeatures, graphicsHost, graphicsArchitecture, execute, signal, useRuntime, settings: launcherSettings,
      force: settings.preset === "custom" || Filters.isFilterId(settings.preset) });
    // A live binding grants this namespace before a shader is selected. Keep
    // the disabled-shader query pure; provision only the admitted connection.
    Writable.assertOwnDirectory(userDataDir, effects);
    // Retain the selected initial model and its capabilities. Ordered sessions
    // also receive explicit managed-store access for later live selections.
    if (!graphicsEnvironment.RESHADE_LOSSLESS_MODEL && graphicsSettings.modelVersion &&
        (graphicsSettings.spatialMethod === "ls1" || graphicsSettings.frameGeneration === "lsfg")) {
      const Models = require("./models"), model = Models.listInstalled(userDataDir).find(item => item.version === graphicsSettings.modelVersion);
      const capability = Models.CAPABILITIES.find(name => model?.inspection?.capabilities?.[name]?.compatible);
      if (capability) {
        try {
          await useModel?.(model.version);
          graphicsEnvironment.RESHADE_LOSSLESS_MODEL = (await Models.resolveModel(userDataDir, model.version, capability, { signal })).modelPath;
        } catch (error) {
          if (signal?.aborted || error.name === "AbortError" || error.code === "ABORT_ERR") throw error;
          warn(logger, `[Graphics] Optional models unavailable: ${error.message}`);
        }
      }
    }
    const boundModel = graphicsEnvironment.RESHADE_LOSSLESS_MODEL ? require("./models").listInstalled(userDataDir).find(model => model.version === graphicsSettings.modelVersion) : null;
    const controlFile = Live.write({ ...entry, graphics: graphicsSettings, reshade: settings }, userDataDir, { create: true });
    const temporalFile = support.temporal && graphicsSettings.temporalMethod !== "off"
      ? require("./temporal-controls").write({ ...entry, graphics: graphicsSettings }, userDataDir, { create: true }) : null;
    const sharedState = path.join(directory, "window-state");Writable.atomicWrite(sharedState, Buffer.alloc(4096), { root: directory });
    const launchId = crypto.randomUUID();
    if (diagnostics || gpuTiming || trace) require("./diagnostic-retention").pruneDiagnostics(directory);
    Writable.atomicWrite(path.join(directory, "launch.json"), JSON.stringify({ schema: 1, launchId, phase: "prepared", preparedAt: new Date().toISOString(),
      gameId: entry.gameId, runtimeId: runtimeId || entry.runtimeId || null, adapterVersion: state.version,
      preset: settings.enabled ? settings.preset : null, graphics: graphicsSettings, graphicsInputs, live: true,
      executionRequirements: ExecutionRequirements.analyze(entry, {activation: true, diagnostics: diagnostics && (capture || gpuTiming || trace),
        sourceSupport: require("./source-resolution").capabilities(graphicsHost, graphicsInputs, support.resolutionMultipliers, support.virtualWindow)}),
      liveTemporalMethods: graphicsSettings.temporalMethod !== "off" ? [graphicsSettings.temporalMethod] : [], liveEffectPlacement: support.effectPlacement,
      liveModelVersion: boundModel?.version || null, liveModelCapabilities: boundModel?.inspection.capabilities || {}, diagnostics, gpuTiming, trace }), { root: directory });
    return { DYLD_INSERT_LIBRARIES: path.join(root, "libreshade-macos.dylib"), ...graphicsEnvironment,
      RESHADE_CONTROL_FILE: controlFile, RESHADE_LIVE_EFFECTS: effects, RESHADE_EFFECT_KEY: Live.effectKey(settings, userDataDir),
      ...(temporalFile ? { RESHADE_TEMPORAL_CONTROL_FILE: temporalFile, RESHADE_TEMPORAL_METHOD: graphicsSettings.temporalMethod } : {}),
      RESHADE_WINDOW_STATE: sharedState, RESHADE_LAYER_SURFACE: "1", RESHADE_LOG: path.join(directory, "reshade.log"),
      ...captureEnvironment(directory, diagnostics && capture),
      ...(trace ? { RESHADE_TRACE: "1" } : {}), ...(diagnostics ? { RESHADE_DIAGNOSTICS: path.join(directory, "diagnostics-" + launchId) } : {}),
      ...(gpuTiming ? { RESHADE_GPU_TIMING: path.join(directory, "gpu-timing-" + launchId) } : {}) };
  }
  const combined = settings.enabled && settings.preset === "chain";
  const packSelection = settings.enabled && Packs.lookup(settings.preset);
  const selectedPack = Managed.isId(settings.preset) && settings.enabled ? Managed.resolveEffect(userDataDir, settings.preset, state.shaderFeatures, graphicsHost, { graphicsArchitecture, settings: launcherSettings }) : packSelection ? Packs.resolveEffect(userDataDir, settings.preset, state.shaderFeatures, graphicsHost, { graphicsArchitecture })
    : settings.enabled && Filters.isFilterId(settings.preset) ? Filters.resolve(userDataDir, settings.preset) : null;
  if (selectedPack?.runtimeIdentity) await useRuntime?.(selectedPack.runtimeIdentity);
  let effect = settings.enabled && !combined ? selectedPack?.file || (settings.preset === "custom" ? settings.effectPath : path.join(root, "effects", settings.preset + ".fx")) : null;
  if (settings.enabled && !combined && (!effect || !fs.statSync(effect, { throwIfNoEntry: false })?.isFile())) throw new Error("ReShade effect was not found. Choose an existing .fx file or a preset.");
  const directory = path.join(userDataDir, "games", entry.gameId, "effects", "reshade");
  Writable.assertOwnDirectory(userDataDir, directory);
  if (diagnostics || gpuTiming || trace) require("./diagnostic-retention").pruneDiagnostics(directory);
  const prepared = path.join(directory, "prepared.fx"), temporary = path.join(directory, "prepared-" + crypto.randomUUID() + ".fx");
  const customDirectory = effect ? path.dirname(effect) : null;
  const includePath = [path.join(root, "include"), ...(selectedPack?.includePaths || []), ...(customDirectory ? [customDirectory] : []), ...(combined ? [path.join(root, "effects")] : [])].join(":");
  const texturePath = [...(selectedPack?.texturePaths || []), ...(customDirectory ? [customDirectory, path.join(customDirectory, "Textures"), path.join(customDirectory, "../Textures")] : [])].join(":");
  const environment = { ...process.env, RESHADE_INCLUDE_PATH: includePath };
  for (const key of Object.keys(environment)) if (key.startsWith("DYLD_") || key.startsWith("RESHADE_") && key !== "RESHADE_INCLUDE_PATH") delete environment[key];
  const compiled = settings.enabled ? await fs.promises.mkdtemp(path.join(directory, "validation-")) : null;
  const provider = effect && Providers.packaged(effect);
  try {
    if (combined) {
      effect = path.join(compiled, "combined.fx");
      await fs.promises.writeFile(effect, Chain.source(settings.effects), { flag: "wx", mode: 0o600 });
    }
    if (provider) {
      Providers.requireAvailable(provider, { features: state.shaderFeatures, graphicsArchitecture });
      effect = (await provider.prepare(effect, { root, userDataDir, execute, signal })).effect;
    } else if (effect) {
      await execute(path.join(root, "fx-compile"), ["--prepare", effect, temporary], { env: environment, signal, timeout: 30000, maxBuffer: 1024 * 1024 });
      // Validate the full effect too; a successful preprocessor alone cannot
      // establish that the selected file is a supported graphics technique.
      const snapshot = path.join(compiled, "effect.prepared.fx");
      await fs.promises.link(temporary, snapshot);
      await execute(path.join(root, "fx-compile"), [snapshot, compiled],
        { env: {...environment, RESHADE_EFFECT_PLAN_ROOT: compiled}, signal, timeout: 30000, maxBuffer: 1024 * 1024 });
      if (combined) {
        const destination = path.join(directory, "combined.fx");
        await fs.promises.rename(effect, destination);
        effect = destination;
      }
      await fs.promises.rename(temporary, prepared);
      if (!combined) await fs.promises.rm(path.join(directory, "combined.fx"), { force: true });
    }
  } catch (error) {
    if (signal?.aborted || error.name === "AbortError" || error.code === "ABORT_ERR") throw error;
    const detail = String(error.stderr || error.message || "").trim().slice(0, 1500);
    throw new Error(`The shader could not be prepared. Choose another shader or disable the effect.${detail ? "\n" + detail : ""}`, { cause: error });
  } finally {
    await fs.promises.rm(temporary, { force: true });
    if (compiled) await fs.promises.rm(compiled, { recursive: true, force: true });
  }
  const sharedState = path.join(directory, "window-state");
  const controlFile = Live.write({ ...entry, graphics: graphicsSettings, reshade: settings }, userDataDir, { create: true });
  Writable.atomicWrite(sharedState, Buffer.alloc(4096), { root: directory });
  const launchId = crypto.randomUUID();
  // Preparation is distinct from a rendered frame. Keep one small receipt and
  // explicitly opt in to bounded native tracing and GPU timing independently.
  Writable.atomicWrite(path.join(directory, "launch.json"), Buffer.from(JSON.stringify({
    schema: 1, launchId, phase: "prepared", preparedAt: new Date().toISOString(),
    gameId: entry.gameId, runtimeId: runtimeId || entry.runtimeId || null,
    adapterVersion: state.version, preset: settings.enabled ? settings.preset : null,
    ...(combined ? { effects: settings.effects } : {}),
    ...(Graphics.enabled(graphicsSettings) ? { graphics: graphicsSettings } : {}),
    preparationMs: Math.round((performance.now() - started) * 100) / 100,
    diagnostics, gpuTiming, trace
  }, null, 2) + "\n"), { root: directory });
  infoGraphics(logger, `[ReShade] Prepared ${settings.enabled ? settings.preset : "graphics processing"} with adapter ${state.version}; details: ${path.join(directory, "launch.json")}`);
  return { DYLD_INSERT_LIBRARIES: path.join(root, "libreshade-macos.dylib"),
    ...graphicsEnvironment,
    ...(controlFile ? { RESHADE_CONTROL_FILE: controlFile, RESHADE_EFFECT_KEY: Live.effectKey(settings, userDataDir) } : {}),
    ...(explicitHost ? { RESHADE_EXPLICIT_HOST: "1" } : {}),
    ...(effect ? provider ? { RESHADE_EFFECT: effect, [provider.rootEnvironment]: path.dirname(effect) }
      : { RESHADE_EFFECT: effect, RESHADE_PREPARED_EFFECT: prepared, RESHADE_INCLUDE_PATH: includePath, RESHADE_TEXTURE_PATH: texturePath } : {}),
    ...(combined ? { RESHADE_TECHNIQUE: Chain.TECHNIQUE } : {}),
    RESHADE_WINDOW_STATE: sharedState, RESHADE_LAYER_SURFACE: "1", RESHADE_LOG: path.join(directory, "reshade.log"),
    ...captureEnvironment(directory, diagnostics && capture),
    ...(trace ? { RESHADE_TRACE: "1" } : {}),
    ...(diagnostics ? { RESHADE_DIAGNOSTICS: path.join(directory, "diagnostics-" + launchId) } : {}),
    ...(gpuTiming ? { RESHADE_GPU_TIMING: path.join(directory, "gpu-timing-" + launchId) } : {}) };
}
function captureEnvironment(directory, enabled) {
  if (!enabled) return {};
  return { RESHADE_CAPTURE_PREFIX: path.join(directory, "frame-capture"),
    RESHADE_CAPTURE_TRIGGER: path.join(directory, "frame-capture.request") };
}
async function prepare(entry, options = {}) {
  const Plans = require("../effects/plan"), Effects = require("../effects/runtime");
  const diagnostics = options.diagnostics ?? process.env.MACLAUNCHER_RESHADE_DIAGNOSTICS === "1";
  const capture = options.capture ?? process.env.MACLAUNCHER_RESHADE_CAPTURE === "1";
  const timing = options.gpuTiming ?? process.env.MACLAUNCHER_RESHADE_GPU_TIMING === "1";
  const demand = ExecutionRequirements.analyze(entry, {diagnostics: diagnostics && (capture || timing || options.trace === true)});
  const root = options.root || runtimeRoot(options.app);
  const planHost = ["window", "remote", "explicit", "catalyst"].includes(options.graphicsHost);
  const liveReady = require("./live-resources").supported(root, options.graphicsHost);
  if (!demand.needed.processor && !liveReady) return {};
  const finish = environment => {
    if (!environment.RESHADE_EFFECT_PLAN) return environment;
    const launchFile = path.join(path.dirname(environment.RESHADE_EFFECT_PLAN), "launch.json");
    const launch = JSON.parse(fs.readFileSync(launchFile, "utf8"));
    const SourceResolution = require("./source-resolution");
    const support = options.graphicsCapabilities || Graphics.capabilities(root, options.graphicsHost, {...options, selectedMethods: demand.methods});
    let sourceSupport = SourceResolution.capabilities(options.graphicsHost, options.graphicsInputs, support.resolutionMultipliers, support.virtualWindow);
    // Adapter identity describes the prepared process even when a future live
    // channel cannot be granted. It must not depend on optional model access.
    Object.assign(launch, {graphicsHost: options.graphicsHost,
      graphicsArchitecture: options.graphicsArchitecture || options.graphicsInputs?.architecture || process.arch,
      graphicsInputs: options.graphicsInputs || null});
    const optionalChannel = (warning, message, prepare) => {
      options.signal?.throwIfAborted();
      try { return prepare(); }
      catch (error) {
        if (options.signal?.aborted || error.name === "AbortError" || error.code === "ABORT_ERR") throw error;
        launch[warning] = error.message;
        warn(options.logger, message, error.message);
        return null;
      }
    };
    const RuntimeStatus = require("./runtime-status");
    if (RuntimeStatus.supported(root)) {
      const prepared = optionalChannel("runtimeStatusWarning", "Runtime processing status is unavailable for this launch.", () =>
        RuntimeStatus.prepare(entry, {userDataDir: options.userDataDir, launchId: launch.launchId}));
      if (prepared) {launch.runtimeStatus = prepared.binding;Object.assign(environment, prepared.environment);}
    }
    launch.executionRequirements = ExecutionRequirements.analyze(entry, {activation: liveReady,
      diagnostics: diagnostics && (capture || timing || options.trace === true), sourceSupport});
    const height = environment.RESHADE_RENDER_MAX_HEIGHT || environment.RESHADE_RENDER_HEIGHT;
    const divisor = environment.RESHADE_RENDER_MULTIPLIER || environment.RESHADE_RESOLUTION_MULTIPLIER;
    const source = environment.RESHADE_RENDER_AUTO === "1" ? {automatic: true} : height ? {height: Number(height), ...(environment.RESHADE_RENDER_MAX_HEIGHT ? {maximum: true} : {})} :
      divisor ? {multiplier: Number(divisor)} : null;
    if (source && environment.RESHADE_RENDER_SOURCE_CONTROL) {
      const excludedControls = Object.fromEntries(["engine", "drawable", "virtual"].filter(control => control !== environment.RESHADE_RENDER_SOURCE_CONTROL)
        .map(control => [control, "A different source API was selected for this launch."]));
      sourceSupport = SourceResolution.resolve(source, {host: options.graphicsHost, inputs: options.graphicsInputs,
        producerDivisors: support.resolutionMultipliers, virtualWindow: support.virtualWindow, excludedControls}).support || sourceSupport;
    }
    // Earlier cores can update an already requested virtual source. A core
    // declaring activationAPI additionally accepts a metadata-only null source;
    // native window/GPU ownership remains dormant until an actual live change.
    if (source && environment.RESHADE_RENDER_SOURCE_CONTROL === "virtual" && (source.automatic || height || Number(divisor) > 1)) {
      if (support.virtualSourceControl === true) {
        if (sourceSupport.control === "virtual") sourceSupport = {...sourceSupport, live: true};
      }
    }
    if (sourceSupport.live === true) {
      const SourceControls = require("./source-controls");
      const sourceMethod = environment.RESHADE_RENDER_SOURCE_METHOD ||
        (sourceSupport.methods?.includes(environment.RESHADE_SPATIAL_METHOD) ? environment.RESHADE_SPATIAL_METHOD : undefined);
      if (source && sourceMethod) source.method = sourceMethod;
      const prepared = optionalChannel("sourceControlWarning", "Live render source controls are unavailable for this launch.", () =>
        SourceControls.prepare(entry, {userDataDir: options.userDataDir, support: sourceSupport, launchId: launch.launchId,
          source: SourceControls.normalize(source, sourceSupport)}));
      if (prepared) { launch.sourceControl = prepared.binding;Object.assign(environment, prepared.environment); }
    }
    if (liveReady && options.graphicsInputs?.presentationHold === true) {
      const PresentationHold = require("./presentation-hold");
      if (PresentationHold.supported(root)) {
        const prepared = optionalChannel("presentationHoldWarning", "Coordinated live video changes are unavailable for this launch.", () =>
          PresentationHold.prepare(entry, {userDataDir: options.userDataDir, launchId: launch.launchId, root}));
        if (prepared) { launch.presentationHold = prepared.binding;Object.assign(environment, prepared.environment); }
      }
    }
    let authorized = {};
    if (liveReady) {
      const liveResources = optionalChannel("liveResourceWarning", "Additional live graphics models are unavailable for this launch.", () =>
        require("./live-resources").prepare({...options, root}));
      if (liveResources) {
        authorized = liveResources.environment;
        launch.effectPlanLiveResources = liveResources.resources;
        launch.effectPlanNeuralLibrary = liveResources.resources.neuralLibrary || launch.effectPlanNeuralLibrary || null;
      }
    }
    optionalChannel("liveMetadataWarning", "Live graphics metadata could not be saved for this launch.", () =>
      Writable.atomicWrite(launchFile, JSON.stringify(launch), {root: options.userDataDir}));
    return {...authorized, ...environment};
  };
  const saved = entry.effects == null ? null : Plans.normalize(entry.effects);
  const publishSimple = async environment => {
    if (environment.DYLD_INSERT_LIBRARIES && Effects.supported(root)) {
      environment.RESHADE_EFFECT_PLAN = Effects.publishSimple(entry, options.userDataDir);
      environment.RESHADE_EFFECT_PLAN_ROOT = path.join(path.dirname(environment.RESHADE_EFFECT_PLAN), "plan-nodes");
      const models = environment.RESHADE_LOSSLESS_MODEL ? [environment.RESHADE_LOSSLESS_MODEL] : [];
      environment.RESHADE_EFFECT_PLAN_MODELS = JSON.stringify(models);
      const launchFile = path.join(path.dirname(environment.RESHADE_EFFECT_PLAN), "launch.json");
      const launch = JSON.parse(await fs.promises.readFile(launchFile, "utf8"));
      Writable.atomicWrite(launchFile, JSON.stringify({ ...launch, effectPlanAPI: 1, effectPlanModels: models, effectPlanBindings: boundModel(launch, environment) }), { root: options.userDataDir });
    }
    return environment;
  };
  if (!demand.needed.processor) {
    // Saved Advanced settings supersede stale Simple selections. An empty or
    // entirely disabled plan needs only the same dormant live connection.
    const inactive = saved ? {...entry, reshade: normalizeSettings(), graphics: Graphics.normalizeSettings()} : entry;
    return finish(await publishSimple(await prepareLegacy(inactive, {...options, root, forceProcessor: true})));
  }
  let automatic = !saved && automaticPlan(entry, options);
  let advanced = saved || automatic;
  const legacyOptions = () => ({...options, root, forceProcessor: demand.needed.diagnostics || planHost && Effects.supported(root)});
  let legacyEnvironment;
  if (!advanced && !normalizeSettings(entry.reshade).enabled) {
    const graphics = Graphics.normalizeSettings(entry.graphics);
    // Keep successful renderer-native paths. If preparation fails, the shared
    // executor can retain compatible independent rows from the same request.
    if (Graphics.enabled(graphics)) {
      try { legacyEnvironment = await prepareLegacy(entry, legacyOptions()); }
      catch (error) {
        if (error.name === "AbortError" || error.code === "ABORT_ERR" || options.signal?.aborted ||
            !planHost || !Effects.supported(root)) throw error;
        automatic = automaticPlan(entry, {...options, draftPlan: true});advanced = automatic;
      }
    }
  }
  if (advanced) {
    const environment = await prepareLegacy({ ...entry, reshade: normalizeSettings(), graphics: Graphics.normalizeSettings() }, { ...options, root, forceProcessor: true });
    let prepared = await Effects.prepare({ ...entry, effects: advanced }, { ...options, ...(automatic ? { ...automaticResolutionOptions(entry, options), automaticSimple: true, fallbackPolicy: "simple" } : {}), root, force: options.force === true, launchPreparation: true, fallback: true });
    advanced = prepared.appliedPlan || prepared.plan;
    const launchFile = path.join(path.dirname(prepared.file), "launch.json");
    const launch = JSON.parse(await fs.promises.readFile(launchFile, "utf8"));
    const models = [...new Set([...prepared.document.nodes.filter(node => node.kind !== "neural").map(node => node.modelPath).filter(Boolean), environment.RESHADE_LOSSLESS_MODEL].filter(Boolean))];
    const neuralModels = [...new Set(prepared.document.nodes.filter(node => node.kind === "neural").map(node => node.modelPath))];
    const bindings = { ...boundModel(launch, environment), ...prepared.bindings };
    Writable.atomicWrite(launchFile, JSON.stringify({ ...launch, effectPlanAPI: 1, effectPlanModels: models, effectPlanBindings: bindings,
      effectPlanRenderResolution: advanced.renderResolution || null, effectPlanNeuralModels: neuralModels,
      effectPlanTemporalMethods: prepared.document.nodes.filter(node => node.enabled && node.kind === "temporal").map(node => node.method),
      effectPlanAutomatic: Boolean(automatic), graphicsPreparation: prepared.preparationStatus,
      graphicsWarnings: (prepared.preparationStatus?.skipped || []).filter(node => !automatic || node.id !== "legacy-neural-input"),
      effectPlanNeuralLibrary: prepared.environment.RESHADE_NEURAL_LIBRARY || null }), { root: options.userDataDir });
    return finish({ ...environment, ...prepared.environment, RESHADE_EFFECT_PLAN: prepared.file,
      RESHADE_EFFECT_PLAN_MODELS: JSON.stringify(models),
      RESHADE_NEURAL_MODELS: JSON.stringify(neuralModels),
      RESHADE_EFFECT_PLAN_ROOT: path.join(path.dirname(prepared.file), "plan-nodes") });
  }
  return finish(await publishSimple(legacyEnvironment || await prepareLegacy(entry, legacyOptions())));
}
function automaticPlan(entry, options = {}) {
  const Plans = require("../effects/plan");
  if (entry.effects != null && Plans.normalize(entry.effects)) return null;
  const selected = normalizeSettings(entry.reshade), graphics = Graphics.normalizeSettings(entry.graphics);
  const spatialShader = graphics.spatialShader?.enabled === true;
  const neural = graphics.neuralMethod === "mlx-dlss", combined = selected.enabled && Graphics.enabled(graphics);
  const shaderFacts = { ...(options.shaderFacts || {}) };
  let resizingShader = false;
  if (selected.enabled && (combined || selected.preset === "custom" || Filters.isFilterId(selected.preset) || Managed.isId(selected.preset) || Packs.lookup(selected.preset))) {
    let selection;
    // Unavailable selections are handled by normal per-row preparation. Their
    // absence must not prevent independent scaling or generation from working.
    try { selection = resolveShaderSelection(entry, options); } catch {}
    shaderFacts["legacy-shader"] = { requirements: Packs.lookup(selected.preset)?.effect.requires || [],
      ...(selection ? { traits: selection.traits, requirements: selection.requirements } : {}), ...shaderFacts["legacy-shader"] };
    const traits = shaderFacts["legacy-shader"].traits;
    resizingShader = Boolean(traits?.outputScale || traits?.conditionalGeometry || traits?.displayDependentGeometry || traits?.unresolvedGeometry);
  }
  if (spatialShader) {
    let selection;
    try {selection = resolveShaderSelection({...entry, reshade: graphics.spatialShader}, options);} catch {}
    shaderFacts["legacy-spatial-shader"] = {...(selection ? {traits: selection.traits, requirements: selection.requirements} : {}),
      ...shaderFacts["legacy-spatial-shader"]};
  }
  const sourceRequested = (graphics.spatialMethod !== "off" || spatialShader) && graphics.spatialMultiplier !== null;
  if (!options.draftPlan && !neural && !combined && !resizingShader && !spatialShader && !sourceRequested && !graphics.spatialMethod.startsWith("libplacebo:")) return null;
  const processing = { ...graphics };
  const support = options.graphicsCapabilities || Graphics.capabilities(options.root || runtimeRoot(options.app), options.graphicsHost,
    {...options, selectedMethods: ExecutionRequirements.analyze(entry).methods});
  // Simple follows the current presentation. Fixed heights remain explicit
  // Advanced rows; older Simple height preferences no longer impose a cap.
  if (neural) processing.neuralInputHeight = null;
  if (options.graphicsInputs?.nativeVideo === true && !Object.hasOwn(entry.graphics || {}, "neuralInputScale")) processing.neuralInputScale = 1;
  if (neural && processing.spatialMethod === "off" && !spatialShader) {
    processing.spatialMethod = ["metalfx", "bicubic", "bilinear"].find(method => support.spatial && support.spatialMethods.includes(method)) || "bilinear";
  }
  let plan = Plans.composeSimple({ ...entry, graphics: processing }, { shaderFacts });
  if (spatialShader) {
    // A hook may have an intrinsic scale (for example fixed 2×). Final fitting
    // follows its actual output and is an equal-size no-op when already fitted.
    const method = ["metalfx", "bicubic", "bilinear"].find(value => support.spatial && support.spatialMethods.includes(value));
    if (method) {
      const {spatialShader: _selection, ...settings} = processing;
      const generation = plan.video.findIndex(row => row.kind === "frame-generation");
      plan.video.splice(generation < 0 ? plan.video.length : generation, 0,
        {id: "legacy-spatial-fit", kind: "spatial", enabled: true, method,
          settings: {...settings, spatialMethod: method, spatialMultiplier: null, temporalMethod: "off", frameGeneration: "off"}});
      plan = Plans.orderSimple(plan, {shaderFacts});
    }
  }
  // An editor conversion is manual. Use a recent physical presentation extent
  // when supplied, without baking it into the live automatic sizing contract.
  const presentation = options.presentationSize || options.lastPresentationSize;
  if (options.draftPlan && neural && processing.neuralInputScale === null && presentation &&
      [presentation.width, presentation.height].every(value => Number.isFinite(value) && value > 0)) {
    const divisor = require("./source-resolution").automaticDivisor(presentation, options.presentationSourceSize);
    const node = plan.video.find(row => row.id === "legacy-neural-input");
    // The editable draft keeps an explicit ratio, including thirds. The live
    // Simple document keeps its adaptive policy instead of a fixed pixel cap.
    if (node) node.presentationScale = 1 / divisor;
  }
  // An imported resizing shader uses the shared ordered executor automatically;
  // the saved selection and editor remain Simple.
  const SourceResolution = require("./source-resolution"), source = SourceResolution.capabilities(options.graphicsHost, options.graphicsInputs,
    support.resolutionMultipliers, support.virtualWindow);
  // A scene-only engine scale is already enlarged before its UI composite.
  // Reducing that composite again would blur it. Completed-frame neural work
  // keeps the engine's sharp original and reduces only once in the plan.
  if (neural && source.control !== "engine" && processing.neuralInputScale < 1 && SourceResolution.DIVISORS.includes(1 / processing.neuralInputScale))
    plan.renderResolution = {multiplier: 1 / processing.neuralInputScale};
  else if (!neural && (graphics.spatialMethod !== "off" || resizingShader || spatialShader) && graphics.spatialMultiplier != null)
    plan.renderResolution = {multiplier: graphics.spatialMultiplier,
      ...(source.methods?.includes(graphics.spatialMethod) ? {method: graphics.spatialMethod} : {})};
  for (const row of plan.video) if (row.kind === "spatial") row.settings.spatialMultiplier = null;
  return plan;
}
// This applies only while preparing a synthesized Simple chain. Its Advanced
// draft remains an explicit 2× reduction, and saved Advanced plans stay manual.
function automaticResolutionOptions(entry, options = {}) {
  if (entry.effects != null) return {};
  const settings = Graphics.normalizeSettings(entry.graphics);
  if (settings.neuralMethod !== "mlx-dlss" || settings.neuralInputScale !== null ||
      options.graphicsInputs?.nativeVideo === true && !Object.hasOwn(entry.graphics || {}, "neuralInputScale")) return {automaticSimple: true};
  return { automaticSimple: true, automaticResolutionNode: "legacy-neural-input", automaticSourceResolution: true };
}
function resolveShaderSelection(entry, {userDataDir, root = runtimeRoot(), graphicsHost, graphicsArchitecture, nativeVideo = false, macOSVersion, platform, settings: launcherSettings} = {}) {
  const selected = normalizeSettings(entry.reshade);
  if (!selected.enabled || selected.preset === "chain") return null;
  const settings = {userDataDir, graphicsArchitecture, nativeVideo, macOSVersion, settings: launcherSettings};
  const features = Managed.isId(selected.preset) || Packs.lookup(selected.preset) ? launchState({root, macOSVersion, platform}).shaderFeatures : undefined;
  const result = Managed.isId(selected.preset) ? Managed.resolveEffect(userDataDir, selected.preset, features, graphicsHost, settings) :
    Filters.isFilterId(selected.preset) ? Filters.resolve(userDataDir, selected.preset) :
    Packs.lookup(selected.preset) ? Packs.resolveEffect(userDataDir, selected.preset, features, graphicsHost, settings) :
      {file: selected.preset === "custom" ? selected.effectPath : path.join(root, "effects", selected.preset + ".fx")};
  if (!result.file) return null;
  const file = fs.realpathSync(result.file), stat = fs.statSync(file), format = result.format || Filters.formatForPath(file);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("Choose a supported shader file of at most 8 MiB.");
  const Traits = require("./shader-traits");
  return {...result, file, format, requirements: result.requirements || Packs.lookup(selected.preset)?.effect.requires || [],
    traits: format === "libplacebo" ? Traits.analyzeFile(file, format).traits : Traits.inspect("", format)};
}
async function updateAutomaticEffects(entry, options = {}) {
  const launch = LaunchBinding.read(entry, options);
  if (!launch) return options.runningPids !== undefined;
  options.publication?.guard(() => LaunchBinding.isCurrent(entry, launch, options));
  if (entry.effects == null && launch.effectPlanAPI === 1 && launch.live === true &&
      !Graphics.enabled(Graphics.normalizeSettings(entry.graphics)) && !automaticPlan(entry, {...options, draftPlan: false})) {
    // The ordinary shader channel was bound by this launch. Returning to it
    // must not keep an ordered overlay merely because heavier work ran before.
    // Managed spatial/generation paths still need their ordered model access.
    const root = options.root || runtimeRoot(options.app), settings = normalizeSettings(entry.reshade),
      isCurrent = () => LaunchBinding.isCurrent(entry, launch, options);
    if (settings.enabled) {
      const state = launchState({...options, root});
      if (!state.available) throw new Error(state.reason);
      try {await require("./live-effect").prepare({...entry, reshade: settings}, {...options, root,
        features: state.shaderFeatures, execute: options.execute || run, isCurrent});}
      catch (error) {if (error.code !== "GRAPHICS_LIVE_STALE") throw error;options.publication?.defer();return true;}
    }
    if (!isCurrent()) {options.publication?.defer();return true;}
    require("../effects/runtime").publishSimple(entry, options.userDataDir, {publication: options.publication});
    return true;
  }
  const automatic = automaticPlan(entry, {...options, ...(launch.effectPlanLiveResources?.schema === 1 ? {draftPlan: true} : {})});
  if (!launch.effectPlanAutomatic && !automatic) return false;
  const plan = automatic || require("../effects/plan").fromLegacy(entry);
  await require("../effects/runtime").prepare({...entry, effects: plan}, {...options, ...(automatic ? { ...automaticResolutionOptions(entry, options), automaticSimple: true } : {}), live: true, deferRenderResolution: true});
  return true;
}
function boundModel(launch, environment) {
  return launch.liveModelVersion && environment.RESHADE_LOSSLESS_MODEL ? { [launch.liveModelVersion]: { path: environment.RESHADE_LOSSLESS_MODEL,
    capabilities: Object.keys(launch.liveModelCapabilities || {}).filter(name => launch.liveModelCapabilities[name]?.compatible === true) } } : {};
}
async function describeParameters(entry, { userDataDir, app, root = runtimeRoot(app), graphicsHost, graphicsArchitecture, graphicsInputs, signal, execute = run, parameterLimit = 128, settings: launcherSettings } = {}) {
  const settings = normalizeSettings(entry.reshade);
  const state = getState({ app, root, userDataDir, graphicsArchitecture });
  if (!state.available) throw new Error(state.reason);
  Native.verifyPayload(root, Publication.forRoot(root));
  const nativeVideo = graphicsInputs?.nativeVideo === true;
  const selected = Managed.isId(settings.preset) ? Managed.resolveEffect(userDataDir, settings.preset, state.shaderFeatures, graphicsHost, { graphicsArchitecture, nativeVideo, settings: launcherSettings }) : Packs.lookup(settings.preset) ? Packs.resolveEffect(userDataDir, settings.preset, state.shaderFeatures, graphicsHost, { graphicsArchitecture })
    : Filters.isFilterId(settings.preset) ? Filters.resolve(userDataDir, settings.preset) : null;
  const directory = path.dirname(Live.file(entry, userDataDir));
  Writable.assertOwnDirectory(userDataDir, directory);
  const temporary = await fs.promises.mkdtemp(path.join(directory, "parameters-"));
  try {
    let effect = selected?.file || (settings.preset === "custom" ? settings.effectPath : path.join(root, "effects", settings.preset + ".fx"));
    if (settings.preset === "chain") { effect = path.join(temporary, "chain.fx");await fs.promises.writeFile(effect, Chain.source(settings.effects)); }
    if (!effect || !fs.statSync(effect, { throwIfNoEntry: false })?.isFile()) throw new Error("Choose an included filter or an existing .fx file.");
    const provider = Providers.packaged(effect);
    if (provider) {
      Providers.requireAvailable(provider, { features: state.shaderFeatures, graphicsArchitecture });
      return { key: Live.effectKey(settings, userDataDir), ...(await provider.inspect(effect, { root, execute, signal, nativeVideo })) };
    }
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("DYLD_") || key.startsWith("RESHADE_")) delete env[key];
    env.RESHADE_INCLUDE_PATH = [path.join(root, "include"), path.join(root, "effects"), ...(selected?.includePaths || []), path.dirname(effect)].join(path.delimiter);
    await execute(path.join(root, "fx-compile"), [effect, temporary], { env, signal, timeout: 30000, maxBuffer: 1024 * 1024 });
    const uniforms = JSON.parse(await fs.promises.readFile(path.join(temporary, "uniforms.json"), "utf8"));
    const requirements = require("./requirements").read(temporary, settings.preset === "chain" ? Chain.TECHNIQUE : undefined);
    if (!Array.isArray(uniforms) || uniforms.length > 4096) throw new Error("Invalid shader parameter metadata.");
    return { key: Live.effectKey(settings, userDataDir), ...(requirements ? { requirements } : {}), parameters: uniforms.slice(0, parameterLimit).map(parameter => {
      const stage = /^V__MLStage(\d+)__/.exec(parameter.name);
      return stage ? { ...parameter, label: `Effect ${Number(stage[1]) + 1} · ${parameter.label}` } : parameter;
    }) };
  } finally { await fs.promises.rm(temporary, { recursive: true, force: true }); }
}
async function updateLive(entry, options = {}) {
  const { userDataDir, app, graphicsHost, graphicsArchitecture, graphicsInputs, runningPids, root = runtimeRoot(app), execute = run, force = false } = options;
  if (graphicsInputs?.shaderBindingsNextLaunch === true) return;
  const launch = LaunchBinding.read(entry, {userDataDir, runningPids});
  if (runningPids !== undefined && !launch) return false;
  const isCurrent = () => LaunchBinding.isCurrent(entry, launch, options);
  options.publication?.guard(isCurrent);
  sourceCandidate(entry, launch, options);
  const publish = () => { if (!isCurrent()) return false;Live.write(entry, userDataDir, {publication: options.publication}); };
  const directory = path.dirname(Live.file(entry, userDataDir));
  for (const name of ["effect-plan.json", "live-selection.json", "controls.bin", "temporal-controls.bin"])
    options.publication?.observe(path.join(directory, name), {root: userDataDir});
  if (await updateAutomaticEffects(entry, {...options, root, execute, force, isCurrent})) return publish();
  if (!fs.existsSync(path.join(directory, "live-effects"))) return publish();
  const state = getState({ app, root, userDataDir });
  try { await require("./live-effect").prepare(entry, {...options, root, userDataDir, features: state.shaderFeatures, graphicsHost, graphicsArchitecture, execute, force, isCurrent}); }
  catch (error) { if (error.code === "GRAPHICS_LIVE_STALE") return false;throw error; }
  return publish();
}
async function validateLiveGraphics(entry, options = {}) {
  const { userDataDir, app, graphicsHost, runningPids, root = runtimeRoot(app) } = options;
  const launch = LaunchBinding.read(entry, {userDataDir, runningPids});
  if (!launch) return runningPids === undefined ? undefined : false;
  options.publication?.guard(() => LaunchBinding.isCurrent(entry, launch, options));
  const graphics = Graphics.normalizeSettings(entry.graphics);
  const managed = launch.effectPlanLiveResources?.schema === 1;
  const automatic = launch.effectPlanAPI === 1 && (managed || launch.effectPlanAutomatic || automaticPlan(entry, {...options, root}));
  if (automatic) {
    const plan = require("../effects/plan").fromLegacy(entry), required = [];
    if (graphics.spatialMethod === "ls1") required.push(graphics.ls1Mode === "quality" ? "ls1Quality" : "ls1Performance");
    if (graphics.frameGeneration === "lsfg") required.push("lsfg" + (graphics.lsfgFp16 ? "Fp16" : "Fp32") + (graphics.lsfgMode === "quality" ? "Quality" : "Performance"));
    const bound = Object.entries(launch.effectPlanBindings || {}).filter(([version, binding]) =>
      (!graphics.modelVersion || graphics.modelVersion === version) && launch.effectPlanModels?.includes(binding.path) &&
      required.every(capability => binding.capabilities?.includes(capability)));
    // Omitted model versions retain the process's actual selected model, rather
    // than switching to whichever library default may have changed since launch.
    let selected = bound.find(([version]) => version === launch.liveModelVersion) || (bound.length === 1 ? bound[0] : null);
    if (required.length && !selected && managed) {
      const installed = require("./models").listInstalled(userDataDir).filter(model =>
        (!graphics.modelVersion || graphics.modelVersion === model.version) &&
        required.every(capability => model.inspection.capabilities[capability]?.compatible) &&
        LaunchBinding.allowsModel(launch, model.modelPath, "lossless"));
      const preferred = options.settings?.runtimes?.["graphics-models"]?.defaultVersion;
      const model = installed.find(model => model.version === preferred) || installed[0];
      if (model) selected = [model.version, model];
    }
    let neuralLibrary;
    for (const node of plan.video) {
      if (!node.enabled) continue;
      if (["ls1", "lsfg"].includes(node.method) && selected) node.settings.modelVersion = selected[0];
      if (node.kind === "neural") {
        const Neural = require("./neural"), provider = Neural.resolve(root, options);
        neuralLibrary = provider?.library || null;
        if (provider && node.settings.modelPath && LaunchBinding.allowsNeural(launch, node.settings.modelPath, neuralLibrary))
          node.settings.modelPath = Neural.model(node.settings.modelPath);
      }
    }
    if (required.length && !selected || !LaunchBinding.supportsPlan(launch, plan, neuralLibrary)) {
      const Effects = require("../effects/runtime"), LivePlan = require("../effects/live-plan");
      const projected = LivePlan.project(plan, LivePlan.readDocument(Effects.file(entry, userDataDir), options.publication),
        node => required.length && !selected && ["ls1", "lsfg"].includes(node.method) ?
          "No compatible installed Lossless Scaling models are selected." : LaunchBinding.nodeUnavailableReason(launch, node, neuralLibrary));
      // The ordinary ordered preparation validates and publishes the complete
      // projected chain next. Never validate the unavailable aggregate legacy
      // settings or issue its requested source allocation ahead of that chain.
      return projected ? undefined : false;
    }
    await Graphics.prepare({...graphics, effectPlacement: "before", ...(selected ? {modelVersion: selected[0]} : {})}, {
      ...options, root, graphicsHost, graphicsInputs: launch.graphicsInputs,
      resolveModel: (directory, version, capability, selectedOptions) => LaunchBinding.resolveModel(launch, directory, version, capability, selectedOptions)
    });
    sourceCandidate(entry, launch, options);
    return;
  }
  if (!launch.live) return;
  if (runningPids !== undefined && (graphics.effectPlacement === "after" && !launch.liveEffectPlacement ||
      graphics.temporalMethod !== "off" && !launch.liveTemporalMethods?.includes(graphics.temporalMethod) ||
      (graphics.spatialMethod === "ls1" || graphics.frameGeneration === "lsfg") && (!launch.liveModelVersion ||
        graphics.modelVersion && graphics.modelVersion !== launch.liveModelVersion))) return false;
  if (graphics.effectPlacement === "after" && !launch.liveEffectPlacement)
    throw new Error("Restart the game with a runtime that supports effects after spatial scaling.");
  if (graphics.temporalMethod !== "off" && !launch.liveTemporalMethods?.includes(graphics.temporalMethod))
    throw new Error("Restart the game with a runtime that provides this temporal upscaler and compatible game inputs.");
  if ((graphics.spatialMethod === "ls1" || graphics.frameGeneration === "lsfg") && !launch.liveModelVersion)
    throw new Error("Restart the game with compatible Lossless Scaling models selected before enabling LS1 or LSFG.");
  await Graphics.prepare({ ...graphics, modelVersion: launch.liveModelVersion }, { root, graphicsHost, graphicsInputs: launch.graphicsInputs, resolveModel: async (_directory, _version, capability) => {
    if (!launch.liveModelCapabilities?.[capability]?.compatible)
      throw new Error("The models loaded for this game do not support that mode. Choose compatible models and restart the game.");
    return {};
  } });
  sourceCandidate(entry, launch, options);
}
function sourceCandidate(entry, launch, options) {
  if (!options.publication || !launch?.sourceControl) return;
  const graphics = Graphics.normalizeSettings(entry.graphics), support = launch.sourceControl.support;
  const requested = (graphics.spatialMethod !== "off" || graphics.spatialShader?.enabled === true) && graphics.spatialMultiplier !== null && graphics.neuralMethod === "off" && graphics.temporalMethod === "off"
    ? {multiplier: graphics.spatialMultiplier, ...(support.methods?.includes(graphics.spatialMethod) ? {method: graphics.spatialMethod} : {})} : null;
  options.publication.metadata.sourceResolutionCandidate = require("./source-controls").normalize(requested, support);
}
module.exports = { PRESETS, normalizeSettings, updateSettings, runtimeRoot, launchState, getState, prepare, mergeEnvironment, resolvePresentationLibrary, describeParameters, updateLive, validateLiveGraphics, automaticPlan, automaticResolutionOptions, updateAutomaticEffects, resolveShaderSelection,
  createPublication: require("./live-publication").createPublication,
  bindLaunchProcess: LaunchBinding.bind,
  executionRequirements: ExecutionRequirements.analyze };
