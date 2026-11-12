const WineSettings = require("../../shared/runtime/wine-settings");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const Writable = require("../../shared/writable-input");
const Environments = require("../../shared/runtime/wine-environment");
const Rosetta = require("../../shared/runtime/rosetta");
const { isAbortError } = require("../../shared/runtime/download-utils");
const warnGraphics = require("../../shared/graphics-warning");
const manager = require("./manager");
const DLSS = require("../dlss");
const Steps = require("../sources/launch-steps");
const Translators = require("../../shared/runtime/wine-translators");
const TranslatorFiles = require("../../shared/runtime/translator-files");
const { wineLayout } = require("../../shared/runtime/wine-layout");
const { findWindowsExecutable, readWindowsExecutable, inside } = require("../detect");

const PROTECTED_ENVIRONMENT = new Set(["HOME", "PATH", "TMPDIR", "WINEPREFIX", "WINEARCH", "WINELOADER", "WINESERVER", "WINEDLLPATH",
  "CX_ROOT", "CX_HOME", "CX_BOTTLE", "CX_BOTTLE_PATH", "CX_MANAGED_BOTTLE_PATH", "CX_INITIALIZED", "CX_ENV", "CX_WINELOADER", "MACLAUNCHER_DXMT_BASE_LIBRARY"]);
const MANAGED_ENVIRONMENT = [...DLSS.ENVIRONMENT, "MACLAUNCHER_DXMT_BASE_LIBRARY", "CX_GRAPHICS_BACKEND", "WINEDXVK", "WINED3DMETAL", "WINEMSYNC", "WINEESYNC", "WINEDLLOVERRIDES", "WINEDEBUG"];
// CrossOver's Windows processes and wineserver create separate process groups.
// Keep an owned wrapper alive until its private bottle has stopped, so the
// launcher's ordinary Stop operation releases both processes and runtime leases.
const SUPERVISOR = `crossover_wine=$1
crossover_server=$2
shift 2
crossover_child=
stop_crossover_bottle() {
  trap '' TERM INT HUP
  if [ -n "$crossover_child" ]; then kill -TERM "$crossover_child" 2>/dev/null; fi
  "$crossover_server" -k >/dev/null 2>&1
  "$crossover_server" -w >/dev/null 2>&1
  if [ -n "$crossover_child" ]; then wait "$crossover_child" 2>/dev/null; fi
  exit 143
}
trap stop_crossover_bottle TERM INT HUP
"$crossover_wine" "$@" &
crossover_child=$!
wait "$crossover_child"
crossover_status=$?
"$crossover_server" -k >/dev/null 2>&1
"$crossover_server" -w >/dev/null 2>&1
trap '' TERM INT HUP
exit "$crossover_status"
`;
function runSupervised(command, serverPath, args, options) {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const child = spawn("/bin/sh", ["-c", SUPERVISOR, "maclauncher-crossover", command, serverPath, ...args],
      { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const output = { stdout: [], stderr: [] };
    let error, bytes = 0, timeout;
    const stop = reason => {
      if (error) return;
      error = reason;
      // Signalling the supervisor lets it stop Wine's separate process groups
      // before the preparation promise rejects or an incomplete bottle is removed.
      child.kill("SIGTERM");
    };
    const abort = () => stop(Object.assign(new Error("CrossOver preparation was cancelled.", { cause: options.signal.reason }),
      { name: "AbortError", code: "ABORT_ERR" }));
    for (const channel of ["stdout", "stderr"]) child[channel].on("data", chunk => {
      bytes += chunk.length;
      if (bytes <= (options.maxBuffer || 1024 * 1024)) output[channel].push(chunk);
      else stop(new Error("CrossOver preparation produced too much output."));
    });
    if (options.timeout) timeout = setTimeout(() => stop(Object.assign(new Error("CrossOver preparation timed out."),
      { code: "ETIMEDOUT" })), options.timeout);
    options.signal?.addEventListener("abort", abort, { once: true });
    // Cover a cancellation occurring between spawn and event registration.
    if (options.signal?.aborted) abort();
    child.once("error", failure => { error = failure; });
    child.once("close", (code, signal) => {
      clearTimeout(timeout); options.signal?.removeEventListener("abort", abort);
      const result = { stdout: Buffer.concat(output.stdout).toString(), stderr: Buffer.concat(output.stderr).toString() };
      if (error || code !== 0) reject(Object.assign(error || new Error("CrossOver preparation failed."), result, { exitCode: code, signal }));
      else resolve(result);
    });
  });
}
const source = () => require("../sources").get("crossover");
const runtimeDirectory = (entry, context) => Steps.runtimeDirectory(entry, context, source());
const { safeText } = Steps;
function wineEnvironmentString(environment) {
  // CrossOver parses --env with Perl shellwords; no shell executes this text.
  return Object.entries(environment).map(([key, value]) => "'" + `${key}=${value}`.replace(/'/g, "'\"'\"'") + "'").join(" ");
}
function bottleTemplate(settings) {
  const template = settings.bottleTemplate || "win10_64";
  if (!["win11_64", "win10_64", "win7_64", "winxp_64"].includes(template)) throw new Error("Unsupported CrossOver Windows bottle type.");
  return template;
}
// `translatorEnvironment` holds the values of the chosen translators'
// environments (shared/runtime/translator-environment-launch.js). They replace
// the values that Runtime Settings set; locked names never reach them.
function buildEnvironment(settings, installation, directory, bottlePath, { baseEnvironment = process.env, host = {}, executableArchitecture, cameraBridge, translatorPlan, vulkanDLSS, existingEnvironment, translatorEnvironment = {} } = {}) {
  const environment = { ...baseEnvironment };
  for (const name of [...PROTECTED_ENVIRONMENT].filter(name => name.startsWith("WINE") || name.startsWith("CX_"))) delete environment[name];
  for (const name of MANAGED_ENVIRONMENT) delete environment[name];
  const overrides = {};
  const backend = settings.graphicsBackend || "auto";
  const managedRenderer = translatorPlan?.components["d3d-renderer"].used && !translatorPlan.components["d3d-renderer"].used.included;
  if (!managedRenderer && !["auto", "d3dmetal", "dxmt", "dxvk", "wined3d"].includes(backend)) throw new Error("Unsupported CrossOver graphics backend.");
  const backendReason = translatorPlan?.components["d3d-renderer"].used ? null : require("./backend-support").reason(installation, backend, host);
  if (backendReason) throw new Error(backendReason);
  const windows = TranslatorFiles.cpuFolder(require("../../shared/runtime/binary-compatibility").requiredMachine(executableArchitecture)) || wineLayout(installation).primaryWindows;
  const vendorLibraries = engine => windows ? DLSS.hasLibraries(path.join(installation.crossoverRoot,
    ...(engine === 'dxmt' ? ['lib', 'dxmt'] : ['lib64', 'apple_gptk', 'wine']), windows)) : false;
  const resolvedGraphics = translatorPlan?.apiMode || translatorPlan?.components['d3d-renderer'].used;
  const dlss = DLSS.checkSelection(settings, { ...host, executableArchitecture, backend, translatorPlan, vulkan: vulkanDLSS?.enabled === true,
    dxmt: settings.dlss === true && (Boolean(cameraBridge?.dxmt) || (resolvedGraphics ? DLSS.hasPlanLibraries(translatorPlan, 'dxmt') : vendorLibraries('dxmt'))),
    d3dmetal: settings.dlss === true && (resolvedGraphics ? DLSS.hasPlanLibraries(translatorPlan, 'd3dmetal') : vendorLibraries('d3dmetal')) });
  Object.assign(overrides, DLSS.environment(dlss));
  if (backend !== "auto") {
    overrides.CX_GRAPHICS_BACKEND = backend;
    // CrossOver versions before its unified graphics selector use these flags.
    if (Number.parseInt(installation.upstreamVersion, 10) < 25) {
      overrides.WINED3DMETAL = backend === "d3dmetal" ? "1" : "0";
      overrides.WINEDXVK = backend === "dxvk" ? "1" : "0";
    }
  }
  const sync = settings.synchronization || "auto";
  if (!["auto", "msync", "esync", "off"].includes(sync)) throw new Error("Unsupported CrossOver synchronization mode.");
  if (sync !== "auto") {
    overrides.WINEMSYNC = sync === "msync" ? "1" : "0";
    if (Number.parseInt(installation.upstreamVersion, 10) < 25) overrides.WINEESYNC = sync === "esync" ? "1" : "0";
  }
  Object.assign(overrides, Steps.localeEnvironment(settings));
  if (settings.wineDebug) overrides.WINEDEBUG = safeText(settings.wineDebug, "Wine debug channels");
  Object.assign(overrides, WineSettings.environment(settings, { needsRosetta: installation.needsRosetta, engines: translatorPlan ? Translators.engines(translatorPlan) : {} }), translatorEnvironment);
  const dll = Steps.dllOverrides(settings);
  if (dll) overrides.WINEDLLOVERRIDES = dll;
  Object.assign(overrides, require("./shader-cache").environment(directory,
    { ...environment, ...existingEnvironment?.environment, ...overrides }));
  Object.assign(environment, overrides, { CX_ROOT: installation.crossoverRoot,
    CX_BOTTLE: bottlePath,
    CX_BOTTLE_PATH: path.dirname(bottlePath), WINEPREFIX: bottlePath });
  if (existingEnvironment) for (const key of ["CX_HOME", "CX_BOTTLE_PATH", "WINEPREFIX"]) delete environment[key];
  if (existingEnvironment?.running) for (const key of ["WINEMSYNC", "WINEESYNC"]) { delete environment[key]; delete overrides[key]; }
  return { environment, overrides, dll };
}

async function ensureBottle(installation, ownedEnvironment, directory, settings, context, { run, translatorEnvironment } = {}) {
  const bottlePath = Environments.assertPrivateEnvironment(ownedEnvironment, directory);
  const template = bottleTemplate(settings);
  Writable.assertOwnDirectory(directory, bottlePath, { create: false });
  const configPath = path.join(bottlePath, "cxbottle.conf");
  if (fs.existsSync(configPath) && fs.existsSync(path.join(bottlePath, "system.reg"))) return;
  if (installation.needsRosetta) await Rosetta.ensure(context);
  context.signal?.throwIfAborted();
  if (!fs.existsSync(path.join(installation.crossoverRoot, "share", "crossover", "bottle_templates", template))) {
    throw new Error("The selected CrossOver application does not include this Windows bottle type. Select another type in Runtime Settings.");
  }
  context.onProgress?.({ phase: "prepare", label: "Creating Windows environment…" });
  const { environment } = buildEnvironment({ ...settings, dlss: false }, installation, directory, bottlePath, { translatorEnvironment });
  // A failed first preparation contains no game saves and cannot be reused.
  // Remove only this owned incomplete bottle, preserving completed environments.
  await fs.promises.rm(bottlePath, { recursive: true, force: true });
  let result;
  try {
    const args = ["--bottle", bottlePath, "--create", "--template", template];
    const options = { cwd: directory, env: environment, signal: context.signal, timeout: 180000, maxBuffer: 1024 * 1024 };
    result = await (run ? run(installation.bottleToolPath, args, options)
      : runSupervised(installation.bottleToolPath, installation.serverPath, args, options));
    if (!fs.existsSync(configPath) || !fs.existsSync(path.join(bottlePath, "system.reg"))) {
      throw new Error("CrossOver did not finish creating the game's Windows environment.", { cause: result });
    }
  } catch (error) {
    await fs.promises.rm(bottlePath, { recursive: true, force: true });
    if (context.signal?.aborted || error.name === "AbortError") throw error;
    throw new Error("CrossOver could not create the game's Windows environment. Open the selected CrossOver application to check its license and startup requirements.", { cause: error });
  }
}

async function prepareLaunch(entry, context, { run, graphicsRoot, host } = {}) {
  const started = performance.now();
  const timing = phase => context.logger?.debug?.('[runtime] CrossOver preparation', { phase, elapsedMs: Math.round(performance.now() - started) });
  timing('start');
  let { existingEnvironment, settings } = await Steps.existingEnvironment(context, source());
  const selected = manager.resolveSelection(entry, context.settings, context.userDataDir, settings);
  if (!selected.ready) throw new Error(selected.reason);
  const match = findWindowsExecutable(entry);
  if (!match) throw new Error("No Windows executable was found in this game folder.");
  const executable = settings.executable ? path.resolve(match.sourceRoot, safeText(settings.executable, "Windows executable")) : match.windowsExecutablePath;
  const selectedExecutable = inside(match.sourceRoot, executable) ? readWindowsExecutable(executable) : null;
  if (!selectedExecutable) throw new Error("Windows executable must be a PE executable inside the game folder.");
  const plans = await require("../sources/launch-graphics").resolve(entry, context, { source: source(),
    install: selected.install, settings, host, executableArchitecture: selectedExecutable.executableArchitecture, root: graphicsRoot, translatorFiles: "selected", timing });
  const { translatorPlan, translatorEnvironment, translatorView, vulkanDLSS, ngxScene, scenePlan } = plans;
  let { cameraBridge, vulkanCamera } = plans;settings = plans.settings;
  const Temporal = require("../temporal");
  if (selectedExecutable.executableArchitecture === "arm64" && !translatorPlan.layout.windows.includes("aarch64-windows")) throw new Error("This Windows ARM64 executable is not supported by the CrossOver backend. Use an x86 or x64 Windows build.");
  const directory = runtimeDirectory(entry, context);
  const GameView = require("../temporal/game-view");GameView.clearWatch(context);
  const template = bottleTemplate(settings);
  // The game and Windows environment own saves; changing the CrossOver
  // installation does not create another bottle.
  // Validate all launch settings before creating a bottle.
  const bottlePath = existingEnvironment?.prefixPath || path.join(directory, "bottles", template);
  let environment, overrides, dll;
  try {
    ({environment, overrides, dll} = buildEnvironment(settings, selected.install, directory, bottlePath,
      {executableArchitecture: selectedExecutable.executableArchitecture, cameraBridge, translatorPlan, vulkanDLSS, existingEnvironment, host, translatorEnvironment}));
  } catch (error) {
    if (context.signal?.aborted || isAbortError(error) || settings.dlss !== true) throw error;
    // Only accept a fallback if the ordinary vendor settings validate too.
    // A bad executable, renderer, environment or DLL rule remains an error.
    ({environment, overrides, dll} = buildEnvironment({...settings, dlss: false}, selected.install, directory, bottlePath,
      {executableArchitecture: selectedExecutable.executableArchitecture, translatorPlan, existingEnvironment, host, translatorEnvironment}));
    cameraBridge = null;
    context.graphicsBridgeFailure = {provider: "crossover-camera", reason: String(error.message || error)};
    warnGraphics(context.logger, "CrossOver temporal integration is unavailable. Using the selected vendor graphics backend.", context.graphicsBridgeFailure.reason);
  }
  const argumentsList = (Array.isArray(settings.arguments) ? settings.arguments : []).map(value => safeText(value, "Game arguments"));
  if (selected.install.needsRosetta && !Rosetta.isAvailable()) await Rosetta.ensure(context);
  Writable.assertOwnDirectory(context.userDataDir, directory);
  // Wine accepts the original Unix executable and working directory. Ordinary
  // Play needs no game copy, alias projection or old-view reconciliation.
  const originalRoot = match.sourceRoot;
  let gameRoot = originalRoot, executablePath = executable, cameraView;
  const GraphicsLoader = require("./graphics-loader");
  let winemac = await require('./winemac').select(selected.install, context);
  let loader, loaderFailure;
  const prepareLoader = async () => {
    try { return await GraphicsLoader.prepare(selected.install, directory, { signal: context.signal, cameraBridge, winemac, translatorView, userDataDir: context.userDataDir }); }
    catch (error) {
      if (context.signal?.aborted || isAbortError(error)) throw error;
      if (winemac) { winemac = null; return prepareLoader(); }
      if (translatorView && Object.keys(translatorView.links).length) throw error;
      loaderFailure = error;return null;
    }
  };
  const requestedCameraBridge = Boolean(cameraBridge);
  // Verify the camera bridge's native closure before replacing a private game
  // DLL. A loader failure must leave the ordinary vendor game path available.
  if (cameraBridge) { loader = await prepareLoader();if (!loader) cameraBridge = null; }
  ({ view: cameraView, gameRoot, executablePath, cameraBridge, vulkanCamera } = await Steps.launchFolder(entry, context, { source: source(), directory, originalRoot,
    executable, executableArchitecture: selectedExecutable.executableArchitecture, cameraBridge, vulkanCamera, scenePlan }));
  if (requestedCameraBridge && !cameraBridge) {
    loader = null;
    // Disable only the optional temporal adaptation, retaining renderer,
    // synchronization, Steam, user environment and DLL override choices.
    ({environment, overrides, dll} = buildEnvironment({...settings, dlss: false}, selected.install, directory, bottlePath,
      {executableArchitecture: selectedExecutable.executableArchitecture, host, existingEnvironment, translatorEnvironment}));
  }
  const GraphicsInputs = require("../graphics-inputs");
  context.graphicsInputs = GraphicsInputs.inputs(selected.install, GraphicsInputs.merge(cameraBridge?.inputs, vulkanCamera?.inputs, plans.sceneInputs));
  if (!existingEnvironment) {
    Writable.assertOwnDirectory(directory, path.dirname(bottlePath));
    await ensureBottle(selected.install, Environments.privateEnvironment(context.userDataDir, directory, path.relative(directory, bottlePath)), directory, settings, context, { run, translatorEnvironment });
    Steps.detachProfileAliases(bottlePath);
  }
  const runRegistryTool = args => {
    const options = { cwd: directory, env: environment, signal: context.signal, timeout: 30000 };
    const commandArgs = ["--bottle", bottlePath, "--no-update", "--", ...args];
    return run ? run(selected.install.executablePath, commandArgs, options) : existingEnvironment
      ? require("../../shared/runtime/wine-processes").runTool(selected.install.executablePath, commandArgs, options)
      : runSupervised(selected.install.executablePath, selected.install.serverPath, commandArgs, options);
  };
  await require('../temporal/ngx-trust').apply(vulkanDLSS.trust, {
    assertWritable: () => existingEnvironment ? Environments.assertWritableRegistry(existingEnvironment)
      : Environments.assertPrivateEnvironment(Environments.privateEnvironment(context.userDataDir, directory, path.relative(directory, bottlePath)), directory),
    run: runRegistryTool,
  });
  await WineSettings.applyRegistry({ ...context.runtimeSettings, ...settings, windowsVersion: "" }, { ngxCore: vulkanDLSS.enabled === true,
    readCurrentRegistry: !existingEnvironment ? async () =>
      (await require('../../shared/runtime/wine-processes').runningState(bottlePath)).running ? null : Environments.registryValues(bottlePath) : undefined,
    assertWritable: existingEnvironment ? () => Environments.assertWritableRegistry(existingEnvironment) : undefined }, runRegistryTool);
  timing('bottle-settings');
  // The vendor wrapper restores these trusted game-only values after its
  // protected shell/Perl launch; bottle setup stays on the stock runtime.
  const originalEnvironment = {...environment}, originalOverrides = {...overrides};
  if (context.applyGameEnvironment) {
    environment = await context.applyGameEnvironment(environment);
    overrides = await context.applyGameEnvironment(overrides);
  }
  await TranslatorFiles.applyNativeLibraries(translatorView || { native: [] }, bottlePath, { signal: context.signal });
  if (translatorView) {
    Object.assign(overrides, translatorView.env); Object.assign(environment, translatorView.env);
    if ((overrides.CX_GRAPHICS_BACKEND || environment.CX_GRAPHICS_BACKEND) !== 'wined3d') { delete overrides.CX_LIBVULKAN; delete environment.CX_LIBVULKAN; }
    if (translatorView.dllOverrides.length) { dll = [dll, ...translatorView.dllOverrides].filter(Boolean).join(';'); overrides.WINEDLLOVERRIDES = dll; environment.WINEDLLOVERRIDES = dll; }
  }
  if (overrides.DYLD_INSERT_LIBRARIES || cameraBridge || winemac || translatorView && Object.keys(translatorView.links).length) {
    if (!loader && !loaderFailure) loader = await prepareLoader();
    if (loader) {
      Object.assign(overrides, GraphicsLoader.environment(loader, overrides, { cameraBridge, translatorView, installation: selected.install }));
      Object.assign(environment, GraphicsLoader.environment(loader, environment, { cameraBridge, translatorView, installation: selected.install }));
      if (cameraBridge) dll = overrides.WINEDLLOVERRIDES;
      const cameraEnvironment = Temporal.environment(cameraBridge, path.resolve(path.dirname(loader), "../lib/wine"));
      Object.assign(overrides, cameraEnvironment);Object.assign(environment, cameraEnvironment);
    }
  }
  if (loaderFailure) {
    const graphics = await context.getGameEffectsEnvironment?.() || {};
    overrides = GraphicsLoader.withoutGraphics(overrides, originalOverrides, graphics);
    environment = GraphicsLoader.withoutGraphics(environment, originalEnvironment, graphics);
    // Core spawn performs the same final merge again. Preserve its ordinary
    // Steam/game preparation while removing only this unavailable processor.
    if (context.applyGameEnvironment) {
      const apply = context.applyGameEnvironment.bind(context);
      context.applyGameEnvironment = async (base, options) => GraphicsLoader.withoutGraphics(
        await apply(base, options), base || process.env, await context.getGameEffectsEnvironment?.() || graphics);
    }
    context.graphicsBridgeFailure = {provider: "crossover-loader", reason: String(loaderFailure.message || loaderFailure)};
    warnGraphics(context.logger, "CrossOver graphics loader could not be prepared. Using the vendor renderer without shared graphics processing.", context.graphicsBridgeFailure.reason);
  }
  const steam = await Steps.steamBridge(entry, context, { install: selected.install, prefixPath: bottlePath,
    architecture: selectedExecutable.executableArchitecture, environment, executablePath });
  const { bridge: steamBridge, launch: bridgeLaunch } = steam;({ environment, executablePath } = steam);
  if (steamBridge) { Object.assign(overrides, steamBridge.extra); dll = environment.WINEDLLOVERRIDES; }
  const vulkanEnvironment=require("../temporal/vulkan-dlss").environment(vulkanDLSS.enabled,environment);
  Object.assign(environment,vulkanEnvironment);Object.assign(overrides,vulkanEnvironment);
  const adapterDescription = await Steps.adapterDescription(environment, { translatorPlan, host, signal: context.signal, existingEnvironment });
  Object.assign(environment, adapterDescription); Object.assign(overrides, adapterDescription);
  const { workingDirectory, windowsExecutablePath, windowsWorkingDirectory } = Steps.gamePaths(entry, bottlePath, { originalRoot, gameRoot, executable, executablePath, directory });
  Steps.runtimeDataPath(bottlePath, selected.install);
  const shaderCache = Steps.shaderCache(directory, bottlePath);
  Object.assign(environment, shaderCache); Object.assign(overrides, shaderCache);
  const args = ["--bottle", bottlePath, "--wait-children", "--workdir", windowsWorkingDirectory];
  if (!WineSettings.inherit(settings.windowsVersion)) {
    if (!Object.hasOwn(WineSettings.WINDOWS_VERSIONS, settings.windowsVersion)) throw new Error("Unsupported Wine Windows version.");
    args.push("--winver", settings.windowsVersion);
  }
  args.push(...WineSettings.desktopArguments(settings, [], { crossover: true }));
  if (existingEnvironment) args.push("--no-update");
  if (existingEnvironment?.running) {
    for (const key of ["WINEMSYNC", "WINEESYNC"]) { delete overrides[key]; delete environment[key]; }
  }
  // The NGX scene destination binds through the CrossOver graphics
  // integration package, which CrossOver's own Mac driver cannot replace.
  // Without that package the transport stays off and the game starts.
  if (ngxScene && !winemac) {
    context.ngxSceneConnection = null;
    context.graphicsBridgeFailure ||= { provider: "crossover-ngx-scene", reason: `No CrossOver graphics integration package for CrossOver ${selected.install.upstreamVersion || ""} (build ${selected.install.buildVersion || "unknown"}) is installed, so DLSS scene frames are not forwarded.` };
    warnGraphics(context.logger, "CrossOver NGX scene forwarding is unavailable. The game starts without it.", context.graphicsBridgeFailure.reason);
  }
  Object.assign(overrides, require("../temporal/ngx/connection").environment(winemac ? ngxScene : null, { macDriverPath: winemac?.path || "", sceneDestinationRequested: settings.dlss === true || DLSS.needsSceneInputs(entry.effects) }));
  if (Object.keys(overrides).length) args.push("--env", wineEnvironmentString(overrides));
  if (dll) args.push("--dll", dll);
  if (settings.wineDebug) args.push("--debugmsg", safeText(settings.wineDebug, "Wine debug channels"));
  if (settings.wineDebug) args.push("--cx-log", path.join(directory, "wine.log"));
  args.push("--", ...(steamBridge ? [steamBridge.helper] : []), windowsExecutablePath, ...(bridgeLaunch?.arguments || []), ...argumentsList, ...(context.gameArguments || []));
  Steps.keepLaunchFolder(entry, context, { runtimeId: "crossover", directory, view: cameraView });
  Steps.recordRuntime(entry, context, { runtimeId: "crossover", match, gameRoot, existingEnvironment, steamBridge, translatorPlan,
    requestedSettings: context.runtimeSettings, install: selected.install, values: { windowsExecutablePath: match.windowsExecutablePath,
      executableArchitecture: match.executableArchitecture, bottlePath, applicationPath: selected.install.appPath } });
  timing('ready');
  return { ...selected, directory, gameRoot, workingDirectory, bottlePath, executablePath, windowsExecutablePath, windowsWorkingDirectory, environment, args, translatorPlan, existingEnvironment };
}

module.exports = { runtimeDirectory, buildEnvironment, wineEnvironmentString, ensureBottle, prepareLaunch, runSupervised, SUPERVISOR };
