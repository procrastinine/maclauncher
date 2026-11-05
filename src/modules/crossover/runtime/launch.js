const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const GameData = require("../../shared/game-data");
const Writable = require("../../shared/writable-input");
const Environments = require("../../shared/runtime/wine-environment");
const Rosetta = require("../../shared/runtime/rosetta");
const { isAbortError } = require("../../shared/runtime/download-utils");
const warnGraphics = require("../../shared/graphics-warning");
const manager = require("./manager");
const DLSS = require("../dlss");
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
function runtimeDirectory(entry, context) {
  if (!path.isAbsolute(context.userDataDir || "") || !/^[\w-]+$/.test(entry.gameId || "")) {
    throw new Error("CrossOver requires a saved game and launcher data directory.");
  }
  return GameData.resolveGameRuntimeDir(context.userDataDir, entry.gameId, "crossover");
}
const safeText = (value, label) => {
  const text = String(value || "");
  if (/[\0\r\n]/.test(text)) throw new Error(`${label} must not contain newlines or NUL bytes.`);
  return text;
};
function parseEnvironment(values) {
  const environment = {};
  for (const line of Array.isArray(values) ? values : []) {
    const match = String(line).match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || PROTECTED_ENVIRONMENT.has(match[1])) throw new Error("Environment entries must use NAME=value and cannot replace CrossOver's application or bottle paths.");
    environment[match[1]] = safeText(match[2], "Environment values");
  }
  return environment;
}
function wineEnvironmentString(environment) {
  // CrossOver parses --env with Perl shellwords; no shell executes this text.
  return Object.entries(environment).map(([key, value]) => "'" + `${key}=${value}`.replace(/'/g, "'\"'\"'") + "'").join(" ");
}
function dllOverrides(settings) {
  const values = (Array.isArray(settings.dllOverrides) ? settings.dllOverrides : []).map(value => safeText(value, "DLL overrides").trim()).filter(Boolean);
  const explicitWinhttp = values.some(value => value.split("=", 1)[0].split(",")
    .some(name => /^(?:\*|winhttp(?:\.dll)?)$/i.test(name.trim())));
  if (settings.bepInExWinhttp && !explicitWinhttp) values.push("winhttp=n,b");
  for (const value of values) {
    if (!/^[\w.*,-]+=(?:n(?:ative)?|b(?:uiltin)?|[nb],\s*[nb]|[nb]\s*,\s*[nb]|)$/i.test(value)) {
      throw new Error("DLL overrides must use Wine library=order syntax, such as winhttp=n,b.");
    }
  }
  return values.join(";");
}
function bottleTemplate(settings) {
  const template = settings.bottleTemplate || "win10_64";
  if (!["win11_64", "win10_64", "win7_64", "winxp_64"].includes(template)) throw new Error("Unsupported CrossOver Windows bottle type.");
  return template;
}
function buildEnvironment(settings, installation, directory, bottlePath, { baseEnvironment = process.env, host = {}, executableArchitecture, cameraBridge } = {}) {
  const environment = { ...baseEnvironment };
  for (const name of [...PROTECTED_ENVIRONMENT].filter(name => name.startsWith("WINE") || name.startsWith("CX_"))) delete environment[name];
  for (const name of MANAGED_ENVIRONMENT) delete environment[name];
  const overrides = {};
  const backend = settings.graphicsBackend || "auto";
  if (!["auto", "d3dmetal", "dxmt", "dxvk", "wined3d"].includes(backend)) throw new Error("Unsupported CrossOver graphics backend.");
  const backendReason = require("./backend-support").reason(installation, backend, host);
  if (backendReason) throw new Error(backendReason);
  const dlss = DLSS.checkSelection(settings, { ...host, executableArchitecture, backend,
    dxmt: settings.dlss === true && (Boolean(cameraBridge) || DLSS.hasLibraries(path.join(installation.crossoverRoot, "lib", "dxmt", "x86_64-windows"))),
    d3dmetal: settings.dlss === true && DLSS.hasLibraries(path.join(installation.crossoverRoot, "lib64", "apple_gptk", "wine", "x86_64-windows")) });
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
  if (settings.locale) {
    const locale = safeText(settings.locale, "Locale");
    if (!/^[A-Za-z0-9_.@-]+$/.test(locale)) throw new Error("Locale must use a locale identifier, such as ja_JP.UTF-8.");
    overrides.LANG = locale; overrides.LC_ALL = locale; overrides.LC_MESSAGES = locale;
  }
  if (settings.wineDebug) overrides.WINEDEBUG = safeText(settings.wineDebug, "Wine debug channels");
  Object.assign(overrides, parseEnvironment(settings.environment));
  const dll = dllOverrides(settings);
  if (dll) overrides.WINEDLLOVERRIDES = dll;
  Object.assign(environment, overrides, { CX_ROOT: installation.crossoverRoot,
    CX_BOTTLE: bottlePath,
    CX_BOTTLE_PATH: path.dirname(bottlePath), WINEPREFIX: bottlePath });
  return { environment, overrides, dll };
}

async function ensureBottle(installation, ownedEnvironment, directory, settings, context, { run } = {}) {
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
  const { environment } = buildEnvironment({ ...settings, dlss: false }, installation, directory, bottlePath);
  fs.mkdirSync(path.join(directory, "crossover-home"), { recursive: true });
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

function detachProfileAliases(bottlePath) {
  // Keep known Windows profile folders private instead of CrossOver's default
  // aliases into macOS Documents, Desktop and other shared save locations.
  const users = path.join(bottlePath, "drive_c", "users");
  if (!fs.existsSync(users)) return;
  Writable.assertOwnDirectory(bottlePath, users, { create: false });
  for (const user of fs.readdirSync(users, { withFileTypes: true })) {
    if (!user.isDirectory()) continue;
    const profile = path.join(users, user.name);
    for (const item of fs.readdirSync(profile, { withFileTypes: true })) {
      if (!item.isSymbolicLink()) continue;
      const link = path.join(profile, item.name);
      let target; try { target = fs.realpathSync(link); } catch { target = null; }
      if (target && inside(bottlePath, target)) continue;
      fs.unlinkSync(link);
      fs.mkdirSync(link, { mode: 0o700 });
    }
  }
}

async function prepareLaunch(entry, context, { run, graphicsRoot, host } = {}) {
  let settings = DLSS.withTemporalSelection(context.runtimeSettings || {}, entry.effects);
  const selected = manager.resolveSelection(entry, context.settings, context.userDataDir, settings);
  if (!selected.ready) throw new Error(selected.reason);
  const Temporal = require("../temporal");
  const scenePlan = Temporal.resolveScenePlan(entry, context, { install: selected.install, settings, verify: true, root: graphicsRoot });
  let sceneClosure = scenePlan?.packageReady ? scenePlan.sceneClosure : null;
  // A Vulkan scene source does not request a different Direct3D renderer.
  if (scenePlan) settings = { ...settings, dlss: context.runtimeSettings?.dlss === true };
  let cameraBridge = Temporal.resolvePlan(entry, context,
    { install: selected.install, settings, runtimeId: "crossover", root: graphicsRoot, host, verify: true, automatic: settings.dlss !== true });
  if (cameraBridge) settings = { ...settings, dlss: true };
  if (cameraBridge?.dependency) await context.useRuntime?.(cameraBridge.dependency);
  for (const dependency of scenePlan?.dependencies || []) await context.useRuntime?.(dependency);
  const match = findWindowsExecutable(entry);
  if (!match) throw new Error("No Windows executable was found in this game folder.");
  const executable = settings.executable ? path.resolve(match.sourceRoot, safeText(settings.executable, "Windows executable")) : match.windowsExecutablePath;
  const selectedExecutable = inside(match.sourceRoot, executable) ? readWindowsExecutable(executable) : null;
  if (!selectedExecutable) throw new Error("Windows executable must be a PE executable inside the game folder.");
  if (selectedExecutable.executableArchitecture === "arm64") throw new Error("This Windows ARM64 executable is not supported by the CrossOver backend. Use an x86 or x64 Windows build.");
  const directory = runtimeDirectory(entry, context);
  const GameView = require("../temporal/game-view");GameView.clearWatch(context);
  const template = bottleTemplate(settings);
  // The game and Windows environment own saves; changing the CrossOver
  // installation does not create another bottle.
  // Validate all launch settings before creating a bottle.
  const bottlePath = path.join(directory, "bottles", template);
  let environment, overrides, dll;
  try {
    ({environment, overrides, dll} = buildEnvironment(settings, selected.install, directory, bottlePath,
      {executableArchitecture: selectedExecutable.executableArchitecture, cameraBridge, host}));
  } catch (error) {
    if (context.signal?.aborted || isAbortError(error) || settings.dlss !== true) throw error;
    // Only accept a fallback if the ordinary vendor settings validate too.
    // A bad executable, renderer, environment or DLL rule remains an error.
    ({environment, overrides, dll} = buildEnvironment({...settings, dlss: false}, selected.install, directory, bottlePath,
      {executableArchitecture: selectedExecutable.executableArchitecture, host}));
    cameraBridge = null;
    context.graphicsBridgeFailure = {provider: "crossover-camera", reason: String(error.message || error)};
    warnGraphics(context.logger, "CrossOver temporal integration is unavailable. Using the selected vendor graphics backend.", context.graphicsBridgeFailure.reason);
  }
  const argumentsList = (Array.isArray(settings.arguments) ? settings.arguments : []).map(value => safeText(value, "Game arguments"));
  if (selected.install.needsRosetta && !Rosetta.isAvailable()) await Rosetta.ensure(context);
  Writable.assertOwnDirectory(context.userDataDir, directory);
  // Wine accepts the original Unix executable and working directory. Ordinary
  // Play needs no game copy, alias projection or old-view reconciliation.
  const originalRoot = match.sourceRoot, recovery = { overrides: {}, omitted: new Set(), libraries: [] };
  let gameRoot = originalRoot, executablePath = executable, cameraView;
  const GraphicsLoader = require("./graphics-loader");
  let loader, loaderFailure;
  const restoreScene = cause => {
    if (!cameraView || !scenePlan) return;
    Temporal.restoreLibraries(scenePlan.libraries, cameraView.gameRoot, cause, context.logger);
    GameView.prepared(cameraView, { libraries: cameraBridge?.libraries || [] });
  };
  const prepareLoader = async () => {
    try { return await GraphicsLoader.prepare(selected.install, directory, { signal: context.signal, cameraBridge, sceneClosure }); }
    catch (error) {
      if (context.signal?.aborted || isAbortError(error)) throw error;
      if (sceneClosure) {
        sceneClosure = null;
        restoreScene(error);
        context.graphicsBridgeFailure = { provider: "crossover-vulkan", reason: String(error.message || error) };
        warnGraphics(context.logger, "CrossOver Vulkan scene support could not be prepared. Using the selected vendor renderer.", context.graphicsBridgeFailure.reason);
        try { return await GraphicsLoader.prepare(selected.install, directory, { signal: context.signal, cameraBridge }); }
        catch (failure) { if (context.signal?.aborted || isAbortError(failure)) throw failure;error = failure; }
      }
      loaderFailure = error;return null;
    }
  };
  const requestedCameraBridge = Boolean(cameraBridge);
  if (cameraBridge || sceneClosure) {
    // Verify the optional native closure before replacing a private game DLL.
    // A loader failure must leave the ordinary vendor game path available.
    loader = await prepareLoader();
    if (!loader) { cameraBridge = null;sceneClosure = null; }
    else try {
      const plans = [...(cameraBridge ? [{ kind: "camera", plan: cameraBridge }] : []), ...(sceneClosure ? [{ kind: "scene", plan: scenePlan }] : [])];
      cameraView = await GameView.camera(directory, originalRoot, executable, { libraries: plans.flatMap(item => item.plan.libraries) }, recovery, context.signal);
      const preparedLibraries = [];
      for (const item of plans) {
        let ready = false;
        try { ready = Temporal.prepareGame(item.plan, cameraView.gameRoot, context.signal); }
        catch (error) {
          if (context.signal?.aborted || isAbortError(error) || error.code === "STREAMLINE_RESTORE_FAILED") throw error;
          warnGraphics(context.logger, "CrossOver temporal integration could not be prepared. Using its original game API.", error.message);
        }
        if (ready) preparedLibraries.push(...item.plan.libraries);
        else { if (item.kind === "camera") cameraBridge = null;else sceneClosure = null;loader = null; }
      }
      if (preparedLibraries.length) {GameView.prepared(cameraView, { libraries: preparedLibraries });GameView.remember(entry, context, "crossover", cameraView, recovery);gameRoot = cameraView.gameRoot;executablePath = cameraView.executablePath;}
      else {GameView.discard(cameraView);cameraView = null;}
    } catch (error) {
      GameView.discard(cameraView);
      if (context.signal?.aborted || isAbortError(error) || error.code === "STREAMLINE_RESTORE_FAILED") throw error;
      warnGraphics(context.logger, "CrossOver camera integration could not be prepared. Using the selected vendor graphics backend.", error?.message || String(error));
      cameraBridge = null;sceneClosure = null;cameraView = null;
    }
    if (requestedCameraBridge && !cameraBridge) {
      loader = null;
      // Disable only the optional temporal adaptation, retaining renderer,
      // synchronization, Steam, user environment and DLL override choices.
      ({environment, overrides, dll} = buildEnvironment({...settings, dlss: false}, selected.install, directory, bottlePath,
        {executableArchitecture: selectedExecutable.executableArchitecture, host}));
    }
  }
  context.graphicsInputs = require("../graphics-inputs").inputs(selected.install, cameraBridge?.inputs);
  Writable.assertOwnDirectory(directory, path.dirname(bottlePath));
  await ensureBottle(selected.install, Environments.privateEnvironment(context.userDataDir, directory, path.relative(directory, bottlePath)), directory, settings, context, { run });
  detachProfileAliases(bottlePath);
  // The vendor wrapper restores these trusted game-only values after its
  // protected shell/Perl launch; bottle setup stays on the stock runtime.
  const originalEnvironment = {...environment}, originalOverrides = {...overrides};
  if (context.applyGameEnvironment) {
    environment = await context.applyGameEnvironment(environment);
    overrides = await context.applyGameEnvironment(overrides);
  }
  if (overrides.DYLD_INSERT_LIBRARIES || cameraBridge || sceneClosure) {
    if (!loader && !loaderFailure) loader = await prepareLoader();
    if (loader) {
      const values = () => ({ overrides: GraphicsLoader.environment(loader, overrides, { cameraBridge, sceneClosure, installation: selected.install }),
        environment: GraphicsLoader.environment(loader, environment, { cameraBridge, sceneClosure, installation: selected.install }) });
      let prepared;
      try { prepared = values(); }
      catch (error) {
        if (context.signal?.aborted || isAbortError(error) || !sceneClosure) throw error;
        sceneClosure = null;
        restoreScene(error);
        context.graphicsBridgeFailure = { provider: "crossover-vulkan", reason: String(error.message || error) };
        warnGraphics(context.logger, "CrossOver Vulkan scene support changed before launch. Using the selected vendor renderer.", context.graphicsBridgeFailure.reason);
        loader = await prepareLoader();if (loader) prepared = values();
      }
      if (prepared) {
        Object.assign(overrides, prepared.overrides);Object.assign(environment, prepared.environment);
        if (cameraBridge || sceneClosure) dll = overrides.WINEDLLOVERRIDES;
        const cameraEnvironment = Temporal.environment(cameraBridge, path.resolve(path.dirname(loader), "../lib/wine"));
        Object.assign(overrides, cameraEnvironment);Object.assign(environment, cameraEnvironment);
      }
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
  const workingDirectory = path.dirname(executable);
  const args = ["--bottle", bottlePath, "--wait-children", "--workdir", workingDirectory];
  if (Object.keys(overrides).length) args.push("--env", wineEnvironmentString(overrides));
  if (dll) args.push("--dll", dll);
  if (settings.wineDebug) args.push("--debugmsg", safeText(settings.wineDebug, "Wine debug channels"));
  if (settings.wineDebug) args.push("--cx-log", path.join(directory, "wine.log"));
  args.push("--", executablePath, ...argumentsList, ...(context.gameArguments || []));
  if (cameraView) {
    GameView.remember(entry, context, "crossover", cameraView, recovery);
    GameView.watch(entry, context, directory, "crossover", cameraView);
  }
  entry.runtimeData = { ...entry.runtimeData, crossover: { ...entry.runtimeData?.crossover,
    windowsExecutablePath: match.windowsExecutablePath, executableArchitecture: match.executableArchitecture,
    sourceRoot: match.sourceRoot, gameRoot, bottlePath, applicationPath: selected.install.appPath,
    graphicsInputs: context.graphicsInputs } };
  context.onEntryChange?.(entry);
  return { ...selected, directory, gameRoot, workingDirectory, bottlePath, executablePath, environment, args };
}

module.exports = { runtimeDirectory, buildEnvironment, parseEnvironment, wineEnvironmentString, dllOverrides,
  ensureBottle, detachProfileAliases, prepareLaunch, runSupervised, SUPERVISOR };
