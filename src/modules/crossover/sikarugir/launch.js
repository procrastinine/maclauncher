const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const GameData = require("../../shared/game-data");
const Writable = require("../../shared/writable-input");
const Rosetta = require("../../shared/runtime/rosetta");
const { isAbortError } = require("../../shared/runtime/download-utils");
const warnGraphics = require("../../shared/graphics-warning");
const { systemVersionSync } = require("../../shared/runtime/bundled-native");
const WindowsFiles = require("../runtime/launch");
const Detection = require("../detect");
const DLSS = require("../dlss");

const PROTECTED_ENVIRONMENT = new Set(["HOME", "PATH", "TMPDIR", "WINEPREFIX", "WINEARCH", "WINELOADER", "WINESERVER",
  "WINEDLLPATH", "WINEDLLOVERRIDES", "WINEMSYNC", "WINEESYNC", "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH", "DYLD_FALLBACK_FRAMEWORK_PATH", "DYLD_INSERT_LIBRARIES", "VK_DRIVER_FILES", "VK_ICD_FILENAMES",
  "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "SikarugirAppWine11", "MACLAUNCHER_DXMT_BASE_LIBRARY"]);
const WINDOWS_VERSIONS = new Set(["win11", "win10", "win7", "winxp"]);

// Wine may return while Windows children continue in other process groups.
// Wait for the private wineserver on ordinary exit; Stop terminates that prefix
// before the tracked process and its runtime lease are released.
const SUPERVISOR = `sikarugir_wine=$1
sikarugir_server=$2
sikarugir_finish=$3
DYLD_LIBRARY_PATH=$4
DYLD_FALLBACK_LIBRARY_PATH=$5
DYLD_FRAMEWORK_PATH=$6
DYLD_FALLBACK_FRAMEWORK_PATH=$7
sikarugir_insert_libraries=$8
unset DYLD_INSERT_LIBRARIES
export DYLD_LIBRARY_PATH DYLD_FALLBACK_LIBRARY_PATH DYLD_FRAMEWORK_PATH DYLD_FALLBACK_FRAMEWORK_PATH
shift 8
sikarugir_child=
stop_sikarugir_prefix() {
  trap '' TERM INT HUP
  if [ -n "$sikarugir_child" ]; then kill -TERM "$sikarugir_child" 2>/dev/null; fi
  "$sikarugir_server" -k >/dev/null 2>&1
  "$sikarugir_server" -w >/dev/null 2>&1
  if [ -n "$sikarugir_child" ]; then wait "$sikarugir_child" 2>/dev/null; fi
  exit 143
}
trap stop_sikarugir_prefix TERM INT HUP
if [ -n "$sikarugir_insert_libraries" ]; then
  DYLD_INSERT_LIBRARIES="$sikarugir_insert_libraries" "$sikarugir_wine" "$@" &
else
  "$sikarugir_wine" "$@" &
fi
sikarugir_child=$!
wait "$sikarugir_child"
sikarugir_status=$?
if [ "$sikarugir_finish" = prepare ]; then "$sikarugir_server" -k >/dev/null 2>&1; fi
"$sikarugir_server" -w >/dev/null 2>&1
trap '' TERM INT HUP
exit "$sikarugir_status"
`;

function supervisorArguments(command, serverPath, mode, args, environment = {}) {
  // macOS removes inherited DYLD variables when /bin/sh starts. Positional
  // values remain data and are exported by the owned script before Wine runs.
  const libraries = ["DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH", "DYLD_FALLBACK_FRAMEWORK_PATH", "DYLD_INSERT_LIBRARIES"]
    .map(key => safeText(environment[key] || "", "Runtime library paths"));
  return ["-c", SUPERVISOR, "maclauncher-sikarugir", command, serverPath, mode, ...libraries, ...args];
}

function runtimeDirectory(entry, context) {
  if (!path.isAbsolute(context.userDataDir || "") || !/^[\w-]+$/.test(entry.gameId || "")) {
    throw new Error("Sikarugir requires a saved game and launcher data directory.");
  }
  return GameData.resolveGameRuntimeDir(context.userDataDir, entry.gameId, "sikarugir");
}
function safeText(value, label) {
  const text = String(value ?? "");
  if (/[\0\r\n]/.test(text)) throw new Error(`${label} must not contain newlines or NUL bytes.`);
  return text;
}
function parseEnvironment(values) {
  const environment = {};
  for (const line of Array.isArray(values) ? values : []) {
    const match = String(line).match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || PROTECTED_ENVIRONMENT.has(match[1]) || /^(?:CX_|GST_)/.test(match[1])) {
      throw new Error("Environment entries must use NAME=value. Wine paths, graphics libraries and synchronization are managed automatically.");
    }
    environment[match[1]] = safeText(match[2], "Environment values");
  }
  return environment;
}
function dllOverrides(settings, graphicsOverrides = []) {
  const values = [...(Array.isArray(graphicsOverrides) ? graphicsOverrides : []),
    ...(Array.isArray(settings.dllOverrides) ? settings.dllOverrides : [])]
    .map(value => safeText(value, "DLL overrides").trim()).filter(Boolean);
  if (settings.bepInExWinhttp && !values.some(value => /^winhttp\s*=/i.test(value))) values.push("winhttp=n,b");
  for (const value of values) {
    if (!/^[\w.*,-]+=(?:n(?:ative)?|b(?:uiltin)?|[nb],\s*[nb]|[nb]\s*,\s*[nb]|)$/i.test(value)) {
      throw new Error("DLL overrides must use Wine library=order syntax, such as winhttp=n,b.");
    }
  }
  return values.join(";");
}
function buildEnvironment(settings, installation, directory, prefixPath, graphics = {}, { baseEnvironment = process.env } = {}) {
  const environment = { ...baseEnvironment };
  for (const key of Object.keys(environment)) {
    if (/^(?:WINE|CX_|DYLD_|GST_|SikarugirAppWine)/.test(key) || [...DLSS.ENVIRONMENT, "MACLAUNCHER_DXMT_BASE_LIBRARY", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "VITE_DEV_SERVER_URL", "VK_DRIVER_FILES", "VK_ICD_FILENAMES"].includes(key)) delete environment[key];
  }
  const capabilities = { ...installation.capabilities, ...graphics.capabilities };
  const synchronization = settings.synchronization || "auto";
  if (!["auto", "msync", "esync", "off"].includes(synchronization)) throw new Error("Unsupported Wine synchronization mode.");
  if (["msync", "esync"].includes(synchronization) && capabilities[synchronization] !== true) {
    throw new Error(`The selected Sikarugir version does not support ${synchronization === "msync" ? "MSync" : "ESync"}. Select Automatic or Off in Runtime Settings.`);
  }
  Object.assign(environment, graphics.env || {}, parseEnvironment(settings.environment));
  // The producer's Wine 11 loader requires this initialization marker before
  // loading Windows libraries, including wineboot in a fresh prefix.
  if (/^11(?:[._]|$)/.test(installation.engineVersion || "")) environment.SikarugirAppWine11 = "1";
  if (synchronization !== "auto" || capabilities.msync === true) {
    environment.WINEMSYNC = synchronization === "msync" || synchronization === "auto" && capabilities.msync === true ? "1" : "0";
    environment.WINEESYNC = synchronization === "esync" ? "1" : "0";
  }
  if (settings.locale) {
    const locale = safeText(settings.locale, "Locale");
    if (!/^[A-Za-z0-9_.@-]+$/.test(locale)) throw new Error("Locale must use a locale identifier, such as ja_JP.UTF-8.");
    environment.LANG = locale; environment.LC_ALL = locale;
  }
  environment.WINEDEBUG = settings.wineDebug ? safeText(settings.wineDebug, "Wine debug channels") : "-all";
  const dll = dllOverrides(settings, graphics.dllOverrides);
  if (dll) environment.WINEDLLOVERRIDES = dll;
  else delete environment.WINEDLLOVERRIDES;
  const wine = graphics.executablePath || installation.executablePath;
  const server = graphics.serverPath || installation.serverPath;
  Object.assign(environment, { HOME: path.join(directory, "home"), TMPDIR: path.join(directory, "tmp"), WINEPREFIX: prefixPath,
    WINEARCH: "win64", WINELOADER: wine, WINESERVER: server,
    PATH: [path.dirname(wine), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter) });
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
function prefixRuntime(installation, directory) {
  const engine = installation.wineRoot || installation.engineRoot || path.dirname(path.dirname(installation.executablePath));
  const support = installation.templateRoot || installation.supportRoot || path.join(installation.installDir, "support");
  const frameworks = path.join(support, "Frameworks");
  const gstreamer = path.join(frameworks, "GStreamer.framework", "Versions", "1.0");
  const gstLib = path.join(gstreamer, "lib");
  const libraries = [path.join(engine, "lib", "wine", "x86_64-unix"), frameworks,
    ...(fs.existsSync(gstLib) ? [gstLib] : [])].join(path.delimiter);
  const env = { DYLD_LIBRARY_PATH: libraries, DYLD_FALLBACK_LIBRARY_PATH: libraries,
    DYLD_FRAMEWORK_PATH: frameworks, GST_REGISTRY_1_0: path.join(directory, "gstreamer-prefix-registry.bin") };
  if (fs.existsSync(gstLib)) {
    env.GST_PLUGIN_SYSTEM_PATH_1_0 = path.join(gstLib, "gstreamer-1.0");
    env.GST_PLUGIN_PATH_1_0 = "";
    const scanner = path.join(gstreamer, "libexec", "gstreamer-1.0", "gst-plugin-scanner");
    if (fs.existsSync(scanner)) env.GST_PLUGIN_SCANNER_1_0 = scanner;
  }
  return { executablePath: installation.executablePath, serverPath: installation.serverPath, env };
}
async function ensurePrefix(installation, prefixPath, directory, settings, graphics, context, { run = runSupervised } = {}) {
  Writable.assertOwnDirectory(directory, prefixPath, { create: false });
  const windowsVersion = settings.windowsVersion || "win10";
  if (!WINDOWS_VERSIONS.has(windowsVersion)) throw new Error("Unsupported Wine Windows version.");
  const markerPath = path.join(prefixPath, "maclauncher-prefix.json");
  let marker; try { if (regularFile(markerPath)) marker = JSON.parse(fs.readFileSync(markerPath, "utf8")); } catch {}
  const completed = regularFile(path.join(prefixPath, "system.reg")) && regularFile(path.join(prefixPath, "user.reg"));
  if (completed && marker?.windowsVersion === windowsVersion && marker?.schemaVersion === 1) return;
  // Initialize the engine's Windows system files before selecting game DLLs.
  // Renderer-prioritized loaders can replace libraries used by wineboot itself.
  const runtime = prefixRuntime(installation, directory);
  const wine = runtime.executablePath, server = runtime.serverPath;
  const { environment } = buildEnvironment({ ...settings, environment: [], dllOverrides: [], bepInExWinhttp: false },
    installation, directory, prefixPath, runtime);
  const options = { cwd: directory, env: environment, signal: context.signal, timeout: 180000, maxBuffer: 1024 * 1024,
    onProcessSpawn: async (child, options) => {
      await context.onToolProcessSpawn?.(child, options);
      await context.onProcessSpawn?.(child);
    } };
  context.onProgress?.({ phase: "prepare", label: "Creating Windows environment…" });
  if (!completed) await fs.promises.rm(prefixPath, { recursive: true, force: true });
  let stage = completed ? "winecfg" : "wineboot";
  try {
    context.signal?.throwIfAborted();
    if (!completed) await run(wine, server, ["wineboot.exe", "--init"], options);
    if (!regularFile(path.join(prefixPath, "system.reg")) || !regularFile(path.join(prefixPath, "user.reg"))) {
      throw new Error("Wine did not finish creating the game's Windows environment.");
    }
    // winecfg's version option changes the prefix registry without opening its GUI.
    stage = "winecfg";
    await run(wine, server, ["winecfg.exe", "-v", windowsVersion], options);
    context.signal?.throwIfAborted();
    Writable.atomicWrite(markerPath, JSON.stringify({ schemaVersion: 1, windowsVersion }) + "\n", { root: directory });
  } catch (error) {
    try { context.logger?.warn?.(`[sikarugir] Windows environment preparation failed ${JSON.stringify({ stage, ...preparationFailureDetails(error) })}`); } catch {}
    if (!completed) await fs.promises.rm(prefixPath, { recursive: true, force: true });
    if (context.signal?.aborted || error.name === "AbortError") throw error;
    throw new Error("Sikarugir could not create the game's Windows environment. Check the selected runtime version and graphics settings.", { cause: error });
  }
}

function executableEvidence(entry, settings = {}) {
  if (Detection.isNativeImport(entry)) return null;
  const evidence = Detection.cachedWindowsExecutable(entry);
  if (!evidence?.windowsExecutablePath || !path.isAbsolute(evidence.sourceRoot || "")) return null;
  const executable = settings.executable
    ? path.resolve(evidence.sourceRoot, safeText(settings.executable, "Windows executable")) : evidence.windowsExecutablePath;
  let root, real;
  try { root = fs.realpathSync(evidence.sourceRoot); real = fs.realpathSync(executable); } catch { return null; }
  if (!Detection.inside(root, real)) return null;
  const match = Detection.readWindowsExecutable(real);
  return match ? { ...match, sourceRoot: root } : null;
}
function mapGameDrive(directory, prefixPath, gameRoot, executablePath) {
  Writable.assertOwnDirectory(directory, prefixPath, { create: false });
  Writable.assertOwnDirectory(directory, gameRoot, { create: false });
  const root = fs.realpathSync(gameRoot), executable = fs.realpathSync(executablePath);
  if (!Detection.inside(root, executable)) throw new Error("The selected Windows executable escapes the game's private files.");
  const relative = path.relative(root, executable);
  if (!relative || relative.split(path.sep).some(name => /[\\:\0\r\n]/.test(name))) {
    throw new Error("The Windows executable path contains unsupported filename characters.");
  }
  const dosdevices = path.join(prefixPath, "dosdevices");
  Writable.assertOwnDirectory(directory, dosdevices);
  const mapping = path.join(dosdevices, "g:");
  let stat; try { stat = fs.lstatSync(mapping); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (stat) {
    let target; try { if (stat.isSymbolicLink()) target = fs.realpathSync(mapping); } catch {}
    if (target !== root) throw new Error("The game's G: drive mapping conflicts with an existing file or folder.");
  } else {
    // Relative links preserve the per-game mapping when the library moves.
    // This drive exposes only the private copy, never the imported source.
    fs.symlinkSync(path.relative(dosdevices, gameRoot), mapping, "dir");
  }
  return "G:\\" + relative.split(path.sep).join("\\");
}
async function prepareLaunch(entry, context, dependencies = {}) {
  const manager = dependencies.manager || require("./runtime/manager");
  const prepareGraphicsView = dependencies.prepareGraphicsView || require("./graphics").prepareGraphicsView;
  const rosetta = dependencies.rosetta || Rosetta;
  let settings = DLSS.withTemporalSelection(context.runtimeSettings || {}, entry.effects);
  const match = executableEvidence(entry, settings);
  if (!match) throw new Error("Windows executable must be a PE executable inside the game folder.");
  if (!["x86", "x86_64"].includes(match.executableArchitecture)) throw new Error("Sikarugir supports x86 and x64 Windows executables. Select a compatible Windows build.");
  const selected = await manager.resolveSelection(entry, context.settings, context.userDataDir, settings);
  if (!selected.ready || !selected.install) throw new Error(selected.reason || "The selected Sikarugir version is not installed.");
  const Temporal = require("../temporal");
  const host = dependencies.host || { platform: process.platform, arch: process.arch, macOSVersion: systemVersionSync() };
  let cameraBridge = Temporal.resolvePlan(entry, context, { install: selected.install, settings, host,
    runtimeId: "sikarugir", verify: true, root: dependencies.graphicsRoot, automatic: settings.dlss !== true });
  if (cameraBridge) settings = { ...settings, dlss: true };
  if (cameraBridge?.dependency) await context.useRuntime?.(cameraBridge.dependency);
  await context.flushRuntimeUses?.();
  if (selected.install.needsRosetta && !rosetta.isAvailable()) await rosetta.ensure(context);
  context.signal?.throwIfAborted();
  const directory = runtimeDirectory(entry, context);
  const GameView = require("../temporal/game-view");GameView.clearWatch(context);
  GameView.reconcile(entry, context, directory, "sikarugir");
  Writable.assertOwnDirectory(context.userDataDir, directory);
  for (const name of ["home", "tmp", "prefixes", "runtime-view"]) Writable.assertOwnDirectory(directory, path.join(directory, name));
  const baselineRoot = await WindowsFiles.stageGameFiles(match.sourceRoot, directory, context);
  const baselineExecutable = path.join(baselineRoot, path.relative(match.sourceRoot, match.windowsExecutablePath));
  if (!Detection.readWindowsExecutable(baselineExecutable)) throw new Error("The selected Windows executable is unavailable in the game's private files.");
  const legacyLibraries = cameraBridge?.libraries ||
    (entry.runtimeData?.sikarugir?.graphicsInputs?.cameraProjection || ["xess","streamline+xess"].includes(entry.runtimeData?.sikarugir?.graphicsInputs?.source) ? Temporal.libraries(match, match.windowsExecutablePath).map(sourcePath => ({sourcePath, relativePath: path.relative(match.sourceRoot, sourcePath)})) : []);
  const baseline = await GameView.baseline(entry, context, directory, baselineRoot, baselineExecutable, "sikarugir", legacyLibraries);
  let gameRoot = baseline.gameRoot, executablePath = baseline.executablePath, cameraView;
  if (cameraBridge) {
    try {
      cameraView = await GameView.camera(directory, baselineRoot, baselineExecutable, cameraBridge, baseline.recovery, context.signal);
      if (!Temporal.prepareGame(cameraBridge, cameraView.gameRoot, context.signal)) cameraBridge = null;
      else {GameView.prepared(cameraView, cameraBridge);GameView.remember(entry, context, "sikarugir", cameraView, baseline.recovery);gameRoot = cameraView.gameRoot;executablePath = cameraView.executablePath;}
    }
    catch (error) {
      GameView.discard(cameraView);
      if (context.signal?.aborted || isAbortError(error)) throw error;
      cameraBridge = null;
      warnGraphics(context.logger, "Sikarugir camera integration could not be prepared. Using the selected graphics backend.", error?.message || String(error));
    }
  }
  if (!cameraBridge) {GameView.discard(cameraView);cameraView = null;}
  context.graphicsInputs = require("../graphics-inputs").inputs(selected.install, cameraBridge?.inputs, { fallback: "x86_64" });
  const identity = crypto.createHash("sha256").update(JSON.stringify([selected.version,
    selected.install.sha256 || selected.install.digest || null])).digest("hex").slice(0, 20);
  const windowsVersion = settings.windowsVersion || "win10";
  if (!WINDOWS_VERSIONS.has(windowsVersion)) throw new Error("Unsupported Wine Windows version.");
  const prefixPath = path.join(directory, "prefixes", `${identity}-${windowsVersion}`);
  // Version the loader layout independently of the persistent prefix/saves.
  const variant = crypto.createHash("sha256").update(JSON.stringify([2, settings.graphicsBackend || "auto", settings.vulkanBackend || "auto",
    settings.cncDdraw === true, match.executableArchitecture, ...(settings.dlss === true ? ["dlss"] : []),
    ...(cameraBridge ? [cameraBridge.dxmt.identity, cameraBridge.baseRoot] : [])])).digest("hex").slice(0, 12);
  const viewRoot = path.join(directory, "runtime-view", `${identity}-${variant}`);
  const graphics = await prepareGraphicsView({ install: selected.install, settings, prefixPath, viewRoot, host,
    cameraBridge, signal: context.signal, logger: context.logger, onProgress: context.onProgress, executableArchitecture: match.executableArchitecture });
  await ensurePrefix(selected.install, prefixPath, directory, settings, graphics, context, { run: dependencies.run });
  WindowsFiles.detachProfileAliases(prefixPath);
  await graphics.applyPrefix?.();
  context.signal?.throwIfAborted();
  const windowsExecutablePath = mapGameDrive(directory, prefixPath, gameRoot, executablePath);
  let { environment } = buildEnvironment(settings, selected.install, directory, prefixPath, graphics, dependencies);
  // Apply launcher-owned optional effects only to the game, after stock Wine
  // finishes prefix initialization. User-supplied loader paths remain blocked.
  if (context.applyGameEnvironment) environment = await context.applyGameEnvironment(environment);
  const args = [windowsExecutablePath, ...(Array.isArray(settings.arguments) ? settings.arguments : []).map(value => safeText(value, "Game arguments")),
    ...(context.gameArguments || [])];
  GameView.remember(entry, context, "sikarugir", cameraBridge ? cameraView : baseline, baseline.recovery);
  GameView.watch(entry, context, directory, "sikarugir", cameraBridge ? cameraView : baseline);
  entry.runtimeData = { ...entry.runtimeData, sikarugir: { ...entry.runtimeData?.sikarugir, installedVersion: selected.version,
    sourceRoot: match.sourceRoot, gameRoot, baselineGameRoot: baselineRoot, prefixPath, viewRoot, graphicsBackend: graphics.graphicsBackend,
    vulkanBackend: graphics.vulkanBackend, dlss: graphics.dlss?.enabled === true, componentVersions: graphics.componentVersions,
    graphicsInputs: context.graphicsInputs } };
  context.onEntryChange?.(entry);
  return { ...selected, directory, gameRoot, prefixPath, viewRoot, executablePath, windowsExecutablePath, graphics, environment, args,
    winePath: graphics.executablePath || selected.install.executablePath, serverPath: graphics.serverPath || selected.install.serverPath };
}

module.exports = { SUPERVISOR, supervisorArguments, PROTECTED_ENVIRONMENT, runtimeDirectory, safeText, parseEnvironment, dllOverrides,
  buildEnvironment, runSupervised, prefixRuntime, ensurePrefix, executableEvidence, mapGameDrive, prepareLaunch };
