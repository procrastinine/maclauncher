const WineSettings = require("../../shared/runtime/wine-settings");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const Writable = require("../../shared/writable-input");
const Environments = require("../../shared/runtime/wine-environment");
const Rosetta = require("../../shared/runtime/rosetta");
const { isAbortError } = require("../../shared/runtime/download-utils");
const warnGraphics = require("../../shared/graphics-warning");
const { systemVersionSync } = require("../../shared/runtime/bundled-native");
const Sources = require(".");
const Detection = require("../detect");
const DLSS = require("../dlss");
const Steps = require("./launch-steps");
const { safeText, dllOverrides } = Steps;
const Translators = require("../../shared/runtime/wine-translators");
const TranslatorFiles = require("../../shared/runtime/translator-files");

const WINDOWS_VERSIONS = new Set(Object.keys(WineSettings.WINDOWS_VERSIONS));

// Wine may return while Windows children continue in other process groups.
// Wait for the private wineserver on ordinary exit; Stop terminates that prefix
// before the tracked process and its runtime lease are released.
// A session loader first starts the prefix's Wine session (the boot program and
// the service processes) from the engine's own loader; the game then joins it.
const SUPERVISOR = `wine_wine=$1
wine_server=$2
wine_finish=$3
wine_session=$4
DYLD_LIBRARY_PATH=$5
DYLD_FALLBACK_LIBRARY_PATH=$6
DYLD_FRAMEWORK_PATH=$7
DYLD_FALLBACK_FRAMEWORK_PATH=$8
wine_insert_libraries=$9
unset DYLD_INSERT_LIBRARIES
export DYLD_LIBRARY_PATH DYLD_FALLBACK_LIBRARY_PATH DYLD_FRAMEWORK_PATH DYLD_FALLBACK_FRAMEWORK_PATH
shift 9
wine_child=
stop_wine_prefix() {
  trap '' TERM INT HUP
  if [ -n "$wine_child" ]; then kill -TERM "$wine_child" 2>/dev/null; fi
  "$wine_server" -k >/dev/null 2>&1
  "$wine_server" -w >/dev/null 2>&1
  if [ -n "$wine_child" ]; then wait "$wine_child" 2>/dev/null; fi
  exit 143
}
trap stop_wine_prefix TERM INT HUP
if [ -n "$wine_session" ]; then
  (unset DYLD_LIBRARY_PATH; exec "$wine_session" winepath.exe -w /) >/dev/null 2>&1 </dev/null &
  wine_child=$!
  wait "$wine_child"
fi
if [ -n "$wine_insert_libraries" ]; then
  DYLD_INSERT_LIBRARIES="$wine_insert_libraries" "$wine_wine" "$@" &
else
  "$wine_wine" "$@" &
fi
wine_child=$!
wait "$wine_child"
wine_status=$?
if [ "$wine_finish" = prepare ]; then "$wine_server" -k >/dev/null 2>&1; fi
"$wine_server" -w >/dev/null 2>&1
trap '' TERM INT HUP
exit "$wine_status"
`;

function supervisorArguments(command, serverPath, mode, args, environment = {}, sessionPath = "") {
  // macOS removes inherited DYLD variables when /bin/sh starts. Positional
  // values remain data and are exported by the owned script before Wine runs.
  const libraries = ["DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH", "DYLD_FALLBACK_FRAMEWORK_PATH", "DYLD_INSERT_LIBRARIES"]
    .map(key => safeText(environment[key] || "", "Runtime library paths"));
  return ["-c", SUPERVISOR, "maclauncher-wine", command, serverPath, mode, safeText(sessionPath || "", "Wine session loader"), ...libraries, ...args];
}

// `translatorEnvironment` holds the values of the chosen translators'
// environments (shared/runtime/translator-environment-launch.js). They replace
// the values that Runtime Settings set; locked names never reach them.
function buildEnvironment(settings, installation, directory, prefixPath, graphics = {}, { source, baseEnvironment = process.env, translatorPlan, existingEnvironment, translatorEnvironment = {} } = {}) {
  const environment = { ...baseEnvironment };
  for (const key of Object.keys(environment)) {
    if (/^(?:WINE|CX_|DYLD_|GST_|SikarugirAppWine)/.test(key) || [...DLSS.ENVIRONMENT, "MACLAUNCHER_DXMT_BASE_LIBRARY", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "VITE_DEV_SERVER_URL", "VK_DRIVER_FILES", "VK_ICD_FILENAMES"].includes(key)) delete environment[key];
  }
  const capabilities = { ...installation.capabilities, ...graphics.capabilities };
  const synchronization = settings.synchronization || "auto";
  if (!["auto", "msync", "esync", "off"].includes(synchronization)) throw new Error("Unsupported Wine synchronization mode.");
  if (!existingEnvironment && ["msync", "esync"].includes(synchronization) && capabilities[synchronization] !== true) {
    throw new Error(`The selected ${source.label} version does not support ${synchronization === "msync" ? "MSync" : "ESync"}. Select Automatic or Off in Runtime Settings.`);
  }
  Object.assign(environment, existingEnvironment?.environment || {}, graphics.env || {}, WineSettings.environment(settings, { needsRosetta: installation.needsRosetta, engines: translatorPlan ? Translators.engines(translatorPlan) : {} }));
  Object.assign(environment, source.launchEnvironment(installation));
  if ((!existingEnvironment || settings.synchronization != null) && (synchronization !== "auto" || capabilities.msync === true)) {
    environment.WINEMSYNC = synchronization === "msync" || synchronization === "auto" && capabilities.msync === true ? "1" : "0";
    environment.WINEESYNC = synchronization === "esync" ? "1" : "0";
  }
  Object.assign(environment, Steps.localeEnvironment(settings));
  environment.WINEDEBUG = settings.wineDebug ? safeText(settings.wineDebug, "Wine debug channels") : existingEnvironment?.environment.WINEDEBUG || "-all";
  Object.assign(environment, translatorEnvironment);
  const dll = dllOverrides(settings, graphics.dllOverrides);
  if (dll) environment.WINEDLLOVERRIDES = dll;
  else delete environment.WINEDLLOVERRIDES;
  const wine = graphics.executablePath || installation.executablePath;
  const server = graphics.serverPath || installation.serverPath;
  Object.assign(environment, require("../runtime/shader-cache").environment(directory, environment));
  Object.assign(environment, { HOME: path.join(directory, "home"), TMPDIR: path.join(directory, "tmp"), WINEPREFIX: prefixPath,
    WINEARCH: "win64", WINELOADER: wine, WINESERVER: server,
    PATH: [path.dirname(wine), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter) });
  if (existingEnvironment) {
    for (const key of ["HOME", "TMPDIR"]) { if (baseEnvironment[key] != null) environment[key] = baseEnvironment[key]; else delete environment[key]; }
    delete environment.WINEARCH;
    Object.assign(environment, source.launchEnvironment(installation, { existingEnvironment: true }));
  }
  return { environment, dll };
}

function runSupervised(command, serverPath, args, options = {}) {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const child = spawn("/bin/sh", supervisorArguments(command, serverPath, "prepare", args, options.env),
      { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const output = { stdout: [], stderr: [] };
    let error, bytes = 0, timeout, registration = Promise.resolve();
    const stop = reason => { if (!error) { error = reason; child.kill("SIGTERM"); } };
    const abort = () => stop(Object.assign(new Error("Wine preparation was cancelled.", { cause: options.signal.reason }), { name: "AbortError", code: "ABORT_ERR" }));
    for (const channel of ["stdout", "stderr"]) child[channel].on("data", chunk => {
      bytes += chunk.length;
      if (bytes <= (options.maxBuffer || 1024 * 1024)) output[channel].push(chunk);
      else stop(new Error("Wine preparation produced too much output."));
    });
    if (options.timeout) timeout = setTimeout(() => stop(Object.assign(new Error("Wine preparation timed out."), { code: "ETIMEDOUT" })), options.timeout);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.once("error", failure => { error = failure; });
    child.once("close", async (code, signal) => {
      clearTimeout(timeout); options.signal?.removeEventListener("abort", abort);
      await registration;
      const result = { stdout: Buffer.concat(output.stdout).toString(), stderr: Buffer.concat(output.stderr).toString() };
      if (error || code !== 0) reject(Object.assign(error || new Error("Wine preparation failed."), result, { exitCode: code, signal }));
      else resolve(result);
    });
    try {
      registration = Promise.resolve(options.onProcessSpawn?.(child, { stopOnLauncherExit: true })).catch(stop);
    } catch (failure) { stop(failure); }
  });
}

function regularFile(file) { try { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; } }
function preparationFailureDetails(error) {
  const bounded = (value, maximum) => String(value ?? "").replace(/\0/g, "").slice(-maximum);
  return { message: bounded(error?.message || error, 1024), code: bounded(error?.code, 128),
    exitCode: Number.isInteger(error?.exitCode) ? error.exitCode : null, signal: bounded(error?.signal, 64),
    stderr: bounded(error?.stderr, 8192), stdout: bounded(error?.stdout, 2048),
    cause: bounded(error?.cause?.message, 1024) };
}
// The source's native library roots, for Wine and its GStreamer plugins.
function prefixRuntime(installation, directory, source) {
  const native = source.nativeLibraries(installation), engine = installation.wineRoot || installation.engineRoot || path.dirname(path.dirname(installation.executablePath));
  const gstreamer = native.gstreamer;
  const env = { DYLD_FALLBACK_LIBRARY_PATH: [path.join(engine, "lib", "wine", "x86_64-unix"), ...native.libraries,
    ...(gstreamer && !native.libraries.includes(gstreamer.lib) ? [gstreamer.lib] : [])].join(path.delimiter),
    ...(native.frameworks.length ? { DYLD_FALLBACK_FRAMEWORK_PATH: native.frameworks.join(path.delimiter) } : {}),
    GST_REGISTRY_1_0: path.join(directory, "gstreamer-prefix-registry.bin") };
  if (gstreamer) {
    env.GST_PLUGIN_SYSTEM_PATH_1_0 = gstreamer.plugins;
    env.GST_PLUGIN_PATH_1_0 = "";
    if (gstreamer.scanner && fs.existsSync(gstreamer.scanner)) env.GST_PLUGIN_SCANNER_1_0 = gstreamer.scanner;
  }
  return { executablePath: installation.executablePath, serverPath: installation.serverPath, env };
}
async function ensurePrefix(installation, ownedEnvironment, directory, settings, graphics, context, { source, run = runSupervised,
  runtimeIdentity = JSON.stringify([installation.version, installation.archiveSha256, installation.binarySha256]) } = {}) {
  const prefixPath = Environments.assertPrivateEnvironment(ownedEnvironment, directory);
  Writable.assertOwnDirectory(directory, prefixPath, { create: false });
  const windowsVersion = settings.windowsVersion || "win10";
  if (!WINDOWS_VERSIONS.has(windowsVersion)) throw new Error("Unsupported Wine Windows version.");
  const markerPath = path.join(prefixPath, "maclauncher-prefix.json");
  let marker; try { if (regularFile(markerPath)) marker = JSON.parse(fs.readFileSync(markerPath, "utf8")); } catch {}
  const completed = regularFile(path.join(prefixPath, "system.reg")) && regularFile(path.join(prefixPath, "user.reg"));
  const hasRuntimeIdentity = typeof marker?.runtimeIdentity === "string" && marker.runtimeIdentity.length > 0;
  const runtimeChanged = hasRuntimeIdentity && marker.runtimeIdentity !== runtimeIdentity;
  if (completed && !runtimeChanged && marker?.windowsVersion === windowsVersion && marker?.schemaVersion === 1) {
    // An unrecorded engine is unknown, not changed. Adopt its identity without
    // setup; a later recorded identity change still upgrades before registry work.
    if (!hasRuntimeIdentity) {
      context.signal?.throwIfAborted();
      Writable.atomicWrite(markerPath, JSON.stringify({ ...marker, runtimeIdentity }) + "\n", { root: directory });
    }
    return;
  }
  // Initialize the engine's Windows system files before selecting game DLLs.
  // Renderer-prioritized loaders can replace libraries used by wineboot itself.
  const runtime = prefixRuntime(installation, directory, source);
  const wine = runtime.executablePath, server = runtime.serverPath;
  const { environment } = buildEnvironment({ ...settings, wineDebug: "-all", dllOverrides: [], bepInExWinhttp: false },
    installation, directory, prefixPath, runtime, { source });
  const options = { cwd: directory, env: environment, signal: context.signal, timeout: 180000, maxBuffer: 1024 * 1024,
    onProcessSpawn: async (child, options) => {
      await context.onToolProcessSpawn?.(child, options);
      await context.onProcessSpawn?.(child);
    } };
  context.onProgress?.({ phase: "prepare", label: completed ? "Updating Windows environment…" : "Creating Windows environment…" });
  if (!completed) await fs.promises.rm(prefixPath, { recursive: true, force: true });
  let stage = completed && !runtimeChanged ? "winecfg" : "wineboot";
  try {
    context.signal?.throwIfAborted();
    // A new engine upgrades existing Windows files before any short registry
    // command can trigger that upgrade implicitly. Existing prefixes stay intact.
    if (!completed || runtimeChanged) await run(wine, server, ["wineboot.exe", completed ? "--update" : "--init"], options);
    if (!regularFile(path.join(prefixPath, "system.reg")) || !regularFile(path.join(prefixPath, "user.reg"))) {
      throw new Error("Wine did not finish creating the game's Windows environment.");
    }
    // winecfg's version option changes the prefix registry without opening its GUI.
    stage = "winecfg";
    await run(wine, server, ["winecfg.exe", "-v", windowsVersion], options);
    context.signal?.throwIfAborted();
    Writable.atomicWrite(markerPath, JSON.stringify({ schemaVersion: 1, windowsVersion, runtimeIdentity }) + "\n", { root: directory });
  } catch (error) {
    try { context.logger?.warn?.(`[${source.id}] Windows environment preparation failed ${JSON.stringify({ stage, ...preparationFailureDetails(error) })}`); } catch {}
    if (!completed) await fs.promises.rm(prefixPath, { recursive: true, force: true });
    if (context.signal?.aborted || error.name === "AbortError") throw error;
    throw new Error(`${source.label} could not create the game's Windows environment. Check the selected runtime version and graphics settings.`, { cause: error });
  }
}

function executableEvidence(entry, settings = {}) {
  const evidence = Detection.findWindowsExecutable(entry);
  if (!evidence?.windowsExecutablePath || !path.isAbsolute(evidence.sourceRoot || "")) return null;
  const executable = settings.executable
    ? path.resolve(evidence.sourceRoot, safeText(settings.executable, "Windows executable")) : evidence.windowsExecutablePath;
  let root, real;
  try { root = fs.realpathSync(evidence.sourceRoot); real = fs.realpathSync(executable); } catch { return null; }
  if (!Detection.inside(root, real)) return null;
  const match = Detection.readWindowsExecutable(real);
  return match ? { ...match, sourceRoot: root } : null;
}
async function prepareLaunch(entry, context, dependencies = {}) {
  const source = dependencies.source;
  const manager = dependencies.manager || source.manager();
  const prepareGraphicsView = dependencies.prepareGraphicsView || require("./wine-graphics").prepareGraphicsView;
  const rosetta = dependencies.rosetta || Rosetta;
  const requestedSettings = context.runtimeSettings || {};
  let { existingEnvironment, settings } = await Steps.existingEnvironment(context, source);
  const match = executableEvidence(entry, settings);
  if (!match) throw new Error("Windows executable must be a PE executable inside the game folder.");
  if (!["x86", "x86_64"].includes(match.executableArchitecture)) throw new Error(`${source.label} supports x86 and x64 Windows executables. Select a compatible Windows build.`);
  const selected = existingEnvironment ? { ready: true, version: existingEnvironment.path, install: existingEnvironment.install } :
    await manager.resolveSelection(entry, context.settings, context.userDataDir, settings);
  if (!selected.ready || !selected.install) throw new Error(selected.reason || `The selected ${source.label} version is not installed.`);
  if (context.resolveRuntimeSettings) {
    settings = await context.resolveRuntimeSettings({ settings, install: selected.install,
      executablePath: match.windowsExecutablePath, executableArchitecture: match.executableArchitecture });
    context.runtimeSettings = settings;
  }
  const capabilities = require("../../shared/runtime/host-capabilities").getHostCapabilities();
  const host = dependencies.host || capabilities;
  const plans = await require("./launch-graphics").resolve(entry, context, { source, install: selected.install, settings, host,
    executableArchitecture: match.executableArchitecture, root: dependencies.graphicsRoot, resolveTranslators: dependencies.resolveTranslators });
  const { translatorPlan, translatorEnvironment, translatorView, vulkanDLSS, ngxScene, scenePlan } = plans;
  const { vulkanCamera } = plans;let { cameraBridge } = plans;settings = plans.settings;
  await context.flushRuntimeUses?.();
  if (selected.install.needsRosetta && !rosetta.isAvailable()) await rosetta.ensure(context);
  context.signal?.throwIfAborted();
  const directory = Steps.runtimeDirectory(entry, context, source);
  const GameView = require("../temporal/game-view");GameView.clearWatch(context);
  Writable.assertOwnDirectory(context.userDataDir, directory);
  if (!existingEnvironment) for (const name of ["home", "tmp", "prefixes", "runtime-view"]) Writable.assertOwnDirectory(directory, path.join(directory, name));
  const originalRoot = match.sourceRoot;
  const folder = await Steps.launchFolder(entry, context, { source, directory, originalRoot,
    executable: match.windowsExecutablePath, executableArchitecture: match.executableArchitecture, cameraBridge, scenePlan });
  let { view: cameraView, gameRoot, executablePath } = folder;cameraBridge = folder.cameraBridge;
  const GraphicsInputs = require("../graphics-inputs");
  context.graphicsInputs = GraphicsInputs.inputs(selected.install, GraphicsInputs.merge(cameraBridge?.inputs, vulkanCamera?.inputs, plans.sceneInputs), { fallback: "x86_64" });
  const nativeInputs = [selected.install.executablePath, selected.install.serverPath,
    ...(translatorPlan.layout.unixRoot ? ["ntdll.so", "wine"].map(name => path.join(translatorPlan.layout.unixRoot, name)).filter(file => fs.existsSync(file)) : [])]
    .map(file => ({ path: file, sha256: require("../../shared/runtime/verified-identity").fileDigest(file).sha256 }));
  const identity = crypto.createHash("sha256").update(JSON.stringify(nativeInputs)).digest("hex").slice(0, 20);
  const windowsVersion = settings.windowsVersion || "win10";
  if (!WINDOWS_VERSIONS.has(windowsVersion)) throw new Error("Unsupported Wine Windows version.");
  const environmentVersion = require('./settings').prefixVersions(require('../manifest.json')).includes(windowsVersion) ? windowsVersion : 'win10';
  const prefixPath = existingEnvironment?.prefixPath || path.join(directory, "prefixes", environmentVersion);
  // Version the loader layout independently of the persistent prefix/saves.
  const variant = crypto.createHash("sha256").update(JSON.stringify([require("./wine-graphics").VIEW_LAYOUT, settings.graphicsBackend || "auto", settings.vulkanBackend || "auto",
    settings.cncDdraw === true, match.executableArchitecture, ...(settings.dlss === true ? ["dlss"] : []),
    ...(cameraBridge ? [cameraBridge.dxmt.identity, cameraBridge.baseRoot] : [])])).digest("hex").slice(0, 12);
  const views = path.join(context.userDataDir, `graphics/${source.id}-views`);
  Writable.assertOwnDirectory(context.userDataDir, views);
  const viewRoot = path.join(views, `${identity}-${variant}-${translatorView.identity}`);
  Writable.assertOwnDirectory(views, viewRoot);
  const graphics = await prepareGraphicsView({ source, install: selected.install, settings, prefixPath, viewRoot, host,
    environment: existingEnvironment, cameraBridge, vulkanDLSS, translatorPlan, translatorView, signal: context.signal, logger: context.logger, onProgress: context.onProgress, executableArchitecture: match.executableArchitecture });
  Writable.atomicWrite(path.join(viewRoot, "prepared.json"), JSON.stringify({ inputs: [...nativeInputs, { path: path.join(translatorView.root, "prepared.json"), sha256: require("../../shared/runtime/verified-identity").fileDigest(path.join(translatorView.root, "prepared.json")).sha256 }] }) + "\n", { root: viewRoot });
  if (!existingEnvironment) {
    await ensurePrefix(selected.install, Environments.privateEnvironment(context.userDataDir, directory, path.relative(directory, prefixPath)), directory, { ...settings, windowsVersion: environmentVersion }, graphics, context,
      { source, run: dependencies.run, runtimeIdentity: JSON.stringify([selected.version, identity]) });
    Steps.detachProfileAliases(prefixPath);
  }
  await TranslatorFiles.applyNativeLibraries(translatorView, prefixPath, { signal: context.signal });
  await graphics.applyPrefix?.();
  context.signal?.throwIfAborted();
  let { environment } = buildEnvironment(settings, selected.install, directory, prefixPath, graphics, { ...dependencies, source, translatorPlan, existingEnvironment, translatorEnvironment });
  Object.assign(environment,require("../temporal/vulkan-dlss").environment(vulkanDLSS.enabled,environment));
  // Apply launcher-owned optional effects only to the game, after stock Wine
  // finishes prefix initialization. User-supplied loader paths remain blocked.
  if (context.applyGameEnvironment) environment = await context.applyGameEnvironment(environment);
  const ngxDestinationRequested = settings.dlss === true || DLSS.needsSceneInputs(entry.effects);
  Object.assign(environment, require("../temporal/ngx/connection").environment(ngxScene, { macDriverPath: ngxDestinationRequested ? require("../temporal/ngx/connection").windowModule(selected.install) : "", sceneDestinationRequested: ngxDestinationRequested }));
  if (existingEnvironment?.running) {
    for (const key of ["WINEMSYNC", "WINEESYNC"]) {
      if (existingEnvironment.environment[key] != null) environment[key] = existingEnvironment.environment[key];
      else delete environment[key];
    }
  }
  const steam = await Steps.steamBridge(entry, context, { install: selected.install, prefixPath, architecture: match.executableArchitecture, environment, executablePath });
  const { bridge: steamBridge, launch: bridgeLaunch } = steam;({ environment, executablePath } = steam);
  Object.assign(environment, await Steps.adapterDescription(environment, { translatorPlan, host, signal: context.signal }));
  const registryEnvironment = existingEnvironment;
  const runRegistryTool = args => {
    // The registry tool runs from the engine's own loader, outside the game
    // bundle, like the session that it starts.
    const env = { ...environment, WINEDEBUG: "-all" };
    delete env.DYLD_LIBRARY_PATH;
    const options = { cwd: directory, env, signal: context.signal, timeout: 30000 };
    return dependencies.run ? dependencies.run(selected.install.executablePath, selected.install.serverPath, args, options) : registryEnvironment
      ? require("../../shared/runtime/wine-processes").runTool(selected.install.executablePath, args, options)
      : runSupervised(selected.install.executablePath, selected.install.serverPath, args, options);
  };
  await require('../temporal/ngx-trust').apply(vulkanDLSS.trust, {
    assertWritable: () => registryEnvironment ? Environments.assertWritableRegistry(registryEnvironment)
      : Environments.assertPrivateEnvironment(Environments.privateEnvironment(context.userDataDir, directory, path.relative(directory, prefixPath)), directory),
    run: runRegistryTool,
  });
  await WineSettings.applyRegistry({ ...context.runtimeSettings, ...settings }, { executable: path.basename(executablePath), ngxCore: vulkanDLSS.enabled === true,
    // A stopped private prefix is read directly, so unchanged values start no Wine.
    readCurrentRegistry: !registryEnvironment ? async () =>
      (await require("../../shared/runtime/wine-processes").runningState(prefixPath)).running ? null : Environments.registryValues(prefixPath) : undefined,
    assertWritable: registryEnvironment ? () => Environments.assertWritableRegistry(registryEnvironment) : undefined }, runRegistryTool);
  const { workingDirectory, windowsExecutablePath, windowsWorkingDirectory } = Steps.gamePaths(entry, prefixPath,
    { originalRoot, gameRoot, executable: match.windowsExecutablePath, executablePath, directory });
  Steps.runtimeDataPath(prefixPath, selected.install);
  Object.assign(environment, Steps.shaderCache(directory, prefixPath));
  let applicationArguments = [...(Array.isArray(settings.arguments) ? settings.arguments : []).map(value => safeText(value, "Game arguments")), ...(context.gameArguments || [])];
  if (context.resolveRuntimeArguments) applicationArguments = await context.resolveRuntimeArguments({ arguments: applicationArguments,
    install: selected.install, executablePath: match.windowsExecutablePath, executableArchitecture: match.executableArchitecture,
    graphicsBackend: graphics.graphicsBackend });
  const args = WineSettings.desktopArguments(settings, ["start.exe", "/d", windowsWorkingDirectory, "/exec", ...(steamBridge ? [steamBridge.helper] : []), windowsExecutablePath, ...(bridgeLaunch?.arguments || []), ...applicationArguments]);
  Steps.keepLaunchFolder(entry, context, { runtimeId: source.id, directory, view: cameraView });
  Steps.recordRuntime(entry, context, { runtimeId: source.id, match, gameRoot, existingEnvironment, steamBridge, translatorPlan, requestedSettings,
    install: selected.install, values: { installedVersion: selected.version, prefixPath, viewRoot, graphicsBackend: graphics.graphicsBackend,
      vulkanBackend: graphics.vulkanBackend, dlss: graphics.dlss?.enabled === true, componentVersions: graphics.componentVersions } });
  return { ...selected, directory, gameRoot, workingDirectory, prefixPath, viewRoot, executablePath, windowsExecutablePath, windowsWorkingDirectory, graphics, environment, args, translatorPlan,
    existingEnvironment, winePath: graphics.executablePath || selected.install.executablePath, serverPath: graphics.serverPath || selected.install.serverPath,
    sessionPath: graphics.executablePath && graphics.executablePath !== selected.install.executablePath ? selected.install.executablePath : "" };
}

// The launch functions of one Wine source.
function forSource(sourceOrId) {
  const source = typeof sourceOrId === "string" ? Sources.get(sourceOrId) : sourceOrId;
  if (!source || source.invocation !== "wine") throw new Error("Choose a Wine source that runs its own Wine loader.");
  return { source, SUPERVISOR, supervisorArguments, safeText, dllOverrides, runSupervised, executableEvidence,
    runtimeDirectory: (entry, context) => Steps.runtimeDirectory(entry, context, source),
    buildEnvironment: (settings, installation, directory, prefixPath, graphics, options = {}) => buildEnvironment(settings, installation, directory, prefixPath, graphics, { ...options, source }),
    prefixRuntime: (installation, directory) => prefixRuntime(installation, directory, source),
    ensurePrefix: (installation, ownedEnvironment, directory, settings, graphics, context, options = {}) => ensurePrefix(installation, ownedEnvironment, directory, settings, graphics, context, { ...options, source }),
    prepareLaunch: (entry, context, dependencies = {}) => prepareLaunch(entry, context, { ...dependencies, source }) };
}

module.exports = { SUPERVISOR, supervisorArguments, safeText, dllOverrides, runSupervised, executableEvidence, forSource };
