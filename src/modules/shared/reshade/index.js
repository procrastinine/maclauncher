const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const crypto = require("node:crypto");
const Writable = require("../writable-input");
const Native = require("../runtime/bundled-native");
const Publication = require("./publication");
const RuntimeRecord = require("./runtime-record");
const Graphics = require("./graphics-settings");
const Chain = require("./effect-chain");
const Packs = require("./shader-packs");
const Filters = require("./filter-library");
const Managed = require("./managed-shaders");
const Providers = require("./shader-providers");
const Live = require("./live-controls");
const ExecutionRequirements = require("../effects/execution-requirements");
const LaunchBinding = require("./launch-binding");
const warn = require("../graphics-warning"), Items = require("../item-results");
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
    const record = RuntimeRecord.read(root);
    if (record.schema !== 1 || !record.version || typeof record.minimumMacOS !== "string" ||
        !["libreshade-macos.dylib", "fx-compile"].every(file => fs.statSync(path.join(root, file)).isFile())) throw Error("Invalid runtime");
    if (!Native.versionAtLeast(macOSVersion || Native.systemVersionSync(), record.minimumMacOS))
      return {available: false, reason: `This ReShade runtime requires macOS ${record.minimumMacOS} or later.`};
    return {available: true, version: record.version, shaderFeatures: record.features?.shaders || {}};
  } catch { return {available: false, reason: "ReShade is not included in this application build."}; }
}
function getState({ app, root = runtimeRoot(app), platform = process.platform, macOSVersion, userDataDir, settings, graphicsArchitecture, graphicsInputs } = {}) {
  const present = state => require("./shader-library").present(state, { userDataDir, root });
  let filters = [], filtersError;
  try { filters = Filters.list(userDataDir); } catch (error) { filtersError = error.message; }
  const filterPresets = filters.map(item => ({ id: "filter:" + item.id, label: item.name, group: item.group || "Imported filters", traits: item.traits, outputContract:item.outputContract,sourceRevision:item.sourceRevision,
    nativeVideoAvailable: item.format === "libplacebo" && item.available === true && item.traits?.sharedOnly !== true && !Object.keys(item.traits?.sceneBindings||{}).length,
    installed: true, format: item.format, available: item.available, ...(item.reason ? { reason: item.reason } : {}) }));
  const result = { available: false, filters, ...(filtersError ? { filtersError } : {}),
    presets: [...PRESETS.filter(item => item.id !== "custom").map(item => ({ ...item })), ...filterPresets, { ...PRESETS.find(item => item.id === "custom") }] };
  if (platform !== "darwin") return present({ ...result, reason: "ReShade requires macOS." });
  try {
    const record = RuntimeRecord.read(root);
    if (record.schema !== 1 || typeof record.minimumMacOS !== "string" || !record.version) throw new Error("Invalid runtime");
    for (const file of ["libreshade-macos.dylib", "fx-compile"]) if (!fs.statSync(path.join(root, file)).isFile()) throw new Error("Missing runtime");
    const version = macOSVersion || Native.systemVersionSync();
    if (!Native.versionAtLeast(version, record.minimumMacOS))
      return present({ ...result, version: record.version, reason: `This ReShade runtime requires macOS ${record.minimumMacOS} or later.` });
    const shaderFeatures = record.features?.shaders || {};
    const presets = result.presets.map(preset => {
      const reason = preset.traits?.libplaceboImageFilter && shaderFeatures.providers?.libplacebo?.imageFiltersAPI !== 1
        ? "The installed libplacebo provider does not include this image filter." :
        graphicsInputs?.nativeVideo === true && preset.nativeVideoAvailable ? null :
        preset.traits?.requiresDerivedPlanes && shaderFeatures.providers?.libplacebo?.derivedPlanes !== true
          ? "The installed shader processor does not provide derived luma and chroma planes." :
          Providers.availability(preset.format, { features: shaderFeatures, graphicsArchitecture, macOSVersion: version })||Providers.traitsAvailability(preset.format,preset.traits,{features:shaderFeatures});
      return reason ? { ...preset, available: false, reason } : preset;
    });
    const packOptions = { graphicsArchitecture, macOSVersion: version, nativeVideo: graphicsInputs?.nativeVideo === true, settings };
    // Each inventory is read on its own: one that cannot be read is empty with
    // a notice, and the rest of the catalog stays usable.
    const failures = [], section = (id, read, fallback) => Items.section(read, fallback, failures, id);
    const SECTIONS = {"graphics-models": "Installed Lossless Scaling models", "graphics-neural-models": "Installed neural models", "shader-packs": "Included shader packs",
      [Managed.ID]: "Installed shader collections", "neural-provider": "The neural provider", "graphics-capabilities": "Graphics capabilities"};
    const models = userDataDir ? section("graphics-models", () => require("./models").listInstalled(userDataDir).map(item => ({ version: item.version,
      label: item.versionLabel, capabilities: Object.keys(item.inspection.capabilities).filter(key => item.inspection.capabilities[key].compatible) })), []) : [];
    const neuralModels = userDataDir ? section("graphics-neural-models", () => require("./neural").listModels(userDataDir).map(({ version, versionLabel, modelPath, method, operation, intrinsicScale, compatibleMethods, pairedDenoiser,curatedDefault }) =>
      ({ version, versionLabel, modelPath, ...(method ? {method} : {}), ...(operation ? {operation} : {}), ...(intrinsicScale ? {intrinsicScale} : {}), ...(compatibleMethods ? {compatibleMethods} : {}), ...(pairedDenoiser === true ? {pairedDenoiser:true} : {}),...(curatedDefault?{curatedDefault:true}:{}) })), []) : [];
    const packs = section("shader-packs", () => Packs.listEffects(userDataDir, shaderFeatures, packOptions), []);
    const managed = userDataDir ? section(Managed.ID, () => Managed.listEffects(userDataDir, shaderFeatures, packOptions), []) : [];
    const neuralAvailable = section("neural-provider", () => Boolean(require("./neural").resolve(root, { platform, macOSVersion: version, graphicsArchitecture })), false);
    const graphics = section("graphics-capabilities", () => Graphics.capabilities(root, undefined, { platform, macOSVersion: version }), {});
    return present({ ...result, presets: [...presets.filter(item => item.id !== "custom"), ...packs, ...managed, presets.find(item => item.id === "custom")],
      available: true, neuralAvailable, version: record.version, graphics, shaderFeatures, shaderParameters: shaderFeatures.parameters === true, shaderLiveSwitching: shaderFeatures.liveSwitching === true,
      ...(failures.length ? {notices: failures.map(({id, reason}) => ({message: `${SECTIONS[id]} could not be read. ${reason}`}))} : {}),
      ...(userDataDir ? { models, neuralModels,
        defaultModelVersion: require("../runtime/custom-runtime").defaultVersion(settings, "graphics-models") || null,
        defaultNeuralModelVersion: require("../runtime/custom-runtime").defaultVersion(settings, "graphics-neural-models") || null,
        defaultNeuralModelVersions:settings?.runtimes?.['graphics-neural-models']?.defaultVersions||{} } : {}) });
  } catch { return present({ ...result, reason: "ReShade is not included in this application build." }); }
}
// The settings getState reads (model, neural-model and shader-collection
// defaults). A state built for the same values stays valid.
function stateSettings(settings) {
  const runtimes = settings?.runtimes || {};
  return ["graphics-models", "graphics-neural-models", Managed.ID].map(id => runtimes[id] || null);
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
  if (!graphicsSettings.modelVersion) graphicsSettings.modelVersion = require("../runtime/custom-runtime").defaultVersion(launcherSettings, "graphics-models") || null;
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
      effect = (await provider.prepare(effect, { root, userDataDir, execute, signal, resourceRoots: [...(selectedPack?.includePaths || []), ...(selectedPack?.texturePaths || [])] })).effect;
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
  const Effects = require("../effects/runtime");
  // Every launch runs from `entry.effects`. A record whose one-time upgrade
  // could not be written is upgraded again here; an unreadable plan is bypassed.
  // A salvaged plan runs its valid rows, and the parts it left out are warnings.
  const StoredPlan = require("../effects/stored-plan"), stored = StoredPlan.read(entry, options);
  if (stored.upgraded) entry = stored.upgraded;
  if (stored.source !== "invalid") entry = {...entry, effects: stored.plan};
  const dropped = StoredPlan.notices(stored).map((notice, index) => ({id: stored.dropped[index].id, reason: notice.message}));
  for (const row of dropped) warn(options.logger, "[Graphics] " + row.reason);
  const diagnostics = options.diagnostics ?? process.env.MACLAUNCHER_RESHADE_DIAGNOSTICS === "1";
  const capture = options.capture ?? process.env.MACLAUNCHER_RESHADE_CAPTURE === "1";
  const timing = options.gpuTiming ?? process.env.MACLAUNCHER_RESHADE_GPU_TIMING === "1";
  const demand = ExecutionRequirements.analyze(entry, {diagnostics: diagnostics && (capture || timing || options.trace === true)});
  const root = options.root || runtimeRoot(options.app);
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
    // The saved plan revision this launch prepared, for its graphics status.
    if (stored.source !== "invalid" && stored.revision) launch.effectPlanRevision = stored.revision;
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
        RuntimeStatus.prepare(entry, {userDataDir: options.userDataDir, launchId: launch.launchId,
          processingRequested: demand.needed.processor}));
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
    // Reserve independent metadata-only channels once. A native source API and
    // the shared virtual fallback must never compete for one command/status file.
    if (launch.sourceControl) launch.sourceControls = {[launch.sourceControl.control]: launch.sourceControl};
    if (sourceSupport.control !== "virtual" && support.virtualWindow?.channelAPI === 1) {
      const virtualSupport = SourceResolution.candidates(options.graphicsHost, options.graphicsInputs,
        support.resolutionMultipliers, support.virtualWindow).find(row => row.control === "virtual" && row.activationAPI === 1);
      if (virtualSupport) {
        const prepared = optionalChannel("virtualSourceControlWarning", "Virtual render source controls are unavailable for this launch.", () =>
          require("./source-controls").prepare(entry, {userDataDir: options.userDataDir, support: virtualSupport,
            launchId: launch.launchId, channel: "virtual"}));
        if (prepared) {
          launch.sourceControls = {...launch.sourceControls, virtual: prepared.binding};Object.assign(environment, prepared.environment);
        }
      }
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
        require("./live-resources").prepare({...options, root, entry, launchId:launch.launchId}));
      if (liveResources) {
        authorized = liveResources.environment;
        launch.effectPlanLiveResources = liveResources.resources;
        launch.effectPlanNeuralLibrary = liveResources.resources.neuralLibrary || launch.effectPlanNeuralLibrary || null;
      }
    }
    optionalChannel("payloadBindingWarning", "The running graphics payload could not be retained.", () =>
      LaunchBinding.preparePayload(entry, launch, root, {userDataDir: options.userDataDir}));
    optionalChannel("liveMetadataWarning", "Live graphics metadata could not be saved for this launch.", () =>
      Writable.atomicWrite(launchFile, JSON.stringify(launch), {root: options.userDataDir}));
    return {...authorized, ...environment};
  };
  const publishSimple = async environment => {
    if (environment.DYLD_INSERT_LIBRARIES && Effects.supported(root)) {
      environment.RESHADE_EFFECT_PLAN = Effects.publishSimple(entry, options.userDataDir);
      environment.RESHADE_EFFECT_PLAN_ROOT = path.join(path.dirname(environment.RESHADE_EFFECT_PLAN), "plan-nodes");
      const models = environment.RESHADE_LOSSLESS_MODEL ? [environment.RESHADE_LOSSLESS_MODEL] : [];
      environment.RESHADE_EFFECT_PLAN_MODELS = JSON.stringify(models);
      const launchFile = path.join(path.dirname(environment.RESHADE_EFFECT_PLAN), "launch.json");
      const launch = JSON.parse(await fs.promises.readFile(launchFile, "utf8"));
      Writable.atomicWrite(launchFile, JSON.stringify({ ...launch, effectPlanAPI: 1, effectPlanModels: models, effectPlanBindings: boundModel(launch, environment),
        ...(dropped.length ? {graphicsWarnings: dropped} : {}) }), { root: options.userDataDir });
    }
    return environment;
  };
  // The dormant connection carries no shader or stage settings of its own.
  const dormant = {...entry, reshade: normalizeSettings(), graphics: Graphics.normalizeSettings()};
  if (stored.source === "invalid") warn(options.logger, "[Graphics] The saved graphics settings are bypassed for this launch.", stored.error.message);
  if (!demand.needed.processor || stored.source === "invalid") {
    // An empty or entirely disabled plan needs only the same dormant live
    // connection, and an invalid one is bypassed.
    return finish(await publishSimple(await prepareLegacy(dormant, {...options, root, forceProcessor: true})));
  }
  const environment = await prepareLegacy(dormant, { ...options, root, forceProcessor: true });
  const prepared = await Effects.prepare(entry, { ...options, root, force: options.force === true, launchPreparation: true, fallback: true });
  const applied = prepared.appliedPlan || prepared.plan;
  const launchFile = path.join(path.dirname(prepared.file), "launch.json");
  const launch = JSON.parse(await fs.promises.readFile(launchFile, "utf8"));
  const models = [...new Set([...prepared.document.nodes.filter(node => !require("../effects/providers").modelOperation(node)).map(node => node.modelPath).filter(Boolean), environment.RESHADE_LOSSLESS_MODEL].filter(Boolean))];
  const neuralModels = [...new Set(prepared.document.nodes.filter(node => require("../effects/providers").modelOperation(node)).map(node => node.modelPath).filter(Boolean))];
  const bindings = { ...boundModel(launch, environment), ...prepared.bindings };
  Writable.atomicWrite(launchFile, JSON.stringify({ ...launch, effectPlanAPI: 1, effectPlanModels: models, effectPlanBindings: bindings,
    effectPlanRenderResolution: prepared.preparationStatus?.sourceResolution ? prepared.preparationStatus.sourceResolution.applied || null : applied.renderResolution || null, effectPlanNeuralModels: neuralModels,
    effectPlanTemporalMethods: prepared.document.nodes.filter(node => node.enabled && node.kind === "temporal").map(node => node.method),
    graphicsPreparation: dropped.length ? {...prepared.preparationStatus, skipped: [...dropped, ...prepared.preparationStatus?.skipped || []]} : prepared.preparationStatus,
    graphicsWarnings: [...dropped, ...prepared.preparationStatus?.skipped || []],
    effectPlanNeuralLibrary: prepared.environment.RESHADE_NEURAL_LIBRARY || null }), { root: options.userDataDir });
  return finish({ ...environment, ...prepared.environment, RESHADE_EFFECT_PLAN: prepared.file,
    RESHADE_EFFECT_PLAN_MODELS: JSON.stringify(models),
    RESHADE_NEURAL_MODELS: JSON.stringify(neuralModels),
    RESHADE_EFFECT_PLAN_ROOT: path.join(path.dirname(prepared.file), "plan-nodes") });
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
  const original = fs.realpathSync(result.file), cube = /\.cube$/i.test(original);
  const file = cube ? require("./cube-lut").prepare(original, userDataDir) : original;
  const stat = fs.statSync(file), format = result.format || Filters.formatForPath(file);
  if (!stat.isFile() || stat.size > (cube ? 16 : 8) * 1024 * 1024) throw new Error("Choose a supported shader file within its source limit.");
  const Traits = require("./shader-traits"),analysis=Traits.analyzeFile(file,format);
  return {...result, file, format, ...(cube ? {sourcePath: original} : {}), requirements: result.requirements || Packs.lookup(selected.preset)?.effect.requires || [],
    traits:analysis.traits,sourceRevision:analysis.sourceRevision};
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
      return { key: Live.effectKey(settings, userDataDir), ...(await provider.inspect(effect, { root, execute, signal, nativeVideo, userDataDir, resourceRoots:[...(selected?.includePaths||[]),...(selected?.texturePaths||[])] })) };
    }
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("DYLD_") || key.startsWith("RESHADE_")) delete env[key];
    env.RESHADE_INCLUDE_PATH = [path.join(root, "include"), path.join(root, "effects"), ...(selected?.includePaths || []), path.dirname(effect)].join(path.delimiter);
    await execute(path.join(root, "fx-compile"), [effect, temporary], { env, signal, timeout: 30000, maxBuffer: 1024 * 1024 });
    const uniforms = JSON.parse(await fs.promises.readFile(path.join(temporary, "uniforms.json"), "utf8"));
    const requirements = require("./requirements").read(temporary, settings.preset === "chain" ? Chain.TECHNIQUE : undefined);
    if (!Array.isArray(uniforms) || uniforms.length > 4096) throw new Error("Invalid shader parameter metadata.");
    const traits=require("./shader-traits").analyzeFile(effect,"fx").traits;
    return { key: Live.effectKey(settings, userDataDir), traits, outputContract:require("./shader-traits").outputContract(traits), ...(requirements ? { requirements } : {}), parameters: uniforms.slice(0, parameterLimit).map(parameter => {
      const stage = /^V__MLStage(\d+)__/.exec(parameter.name);
      return stage ? { ...parameter, label: `Effect ${Number(stage[1]) + 1} · ${parameter.label}` } : parameter;
    }) };
  } finally { await fs.promises.rm(temporary, { recursive: true, force: true }); }
}
module.exports = { PRESETS, normalizeSettings, updateSettings, runtimeRoot, launchState, getState, stateSettings, prepare, mergeEnvironment, resolvePresentationLibrary, describeParameters, resolveShaderSelection,
  createPublication: require("./live-publication").createPublication,
  bindLaunchProcess: LaunchBinding.bind,
  executionRequirements: ExecutionRequirements.analyze };
