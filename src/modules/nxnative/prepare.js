const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");
const GameData = require("../shared/game-data");
const Writable = require("../shared/writable-input");
const Bundled = require("../shared/runtime/bundled-native");
const Native = require("../shared/runtime/local-native");
const IsolatedPython = require("../shared/runtime/isolated-python");
const Source = require("./source");
const { createProgressHandler } = require("./progress");
const { runToolCommand } = require("../shared/runtime/tool-command");
const { confirmToolInstall } = require("../shared/runtime/tool-install");
const { createAbortError, throwIfAborted } = require("../shared/runtime/download-utils");
const { getUiServices } = require("../shared/ui-services");
const { inspectBinary, extracted, inside } = require("./detect");
const manager = require("./runtime/manager");

function gameDirectory(entry, context) {
  if (!/^[A-Za-z0-9_-]+$/.test(entry?.gameId || "") || !path.isAbsolute(context?.userDataDir || "")) throw new Error("nxnative requires a game in the library.");
  return GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "nxnative");
}
function saveDirectory(entry, context) {
  const result = entry.saveDirOverride || path.join(gameDirectory(entry, context), "saves");
  if (!path.isAbsolute(result) || /[\0\r\n]/.test(result)) throw new Error("Switch saves require an absolute local folder.");
  return result;
}
function readJson(file, maximum = 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new Error("The nxnative metadata file is invalid.");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function resolveInput(entry) {
  const sourceRoot = fs.realpathSync(entry.contentRootDir || entry.gamePath), input = entry.moduleData?.inputPath;
  if (!path.isAbsolute(input || "") || !inside(sourceRoot, fs.realpathSync(input))) throw new Error("The Switch input must stay inside the imported game folder.");
  const details = fs.statSync(input).isDirectory() ? extracted(input) || (entry.moduleData.format === "collection" ? entry.moduleData : null) : inspectBinary(input);
  if (!details) throw new Error("The Switch input is missing or invalid.");
  return { sourceRoot, inputPath: input, ...details };
}
function runtimePaths(install, { verify = true } = {}) {
  if (!install?.declaration || !path.isAbsolute(install.payloadRoot || "")) throw new Error("The selected nxnative runtime has no verified package.");
  if (verify) Bundled.verifyPayload(install.root, install.declaration);
  const root = install.payloadRoot, config = readJson(path.join(root, "runtime.json"));
  if (config.schemaVersion !== 1 || !["nxnative", "nxnative-tools"].includes(config.id) || config.architecture !== "arm64" || config.executableRelative !== "bin/nxnative" || config.runtimeFiles?.host !== "bin/nxnative-host")
    throw new Error("The nxnative runtime configuration is unsupported.");
  const cli = path.join(root, "bin/nxnative"), host = path.join(root, config.runtimeFiles.host);
  if (fs.realpathSync(cli) !== fs.realpathSync(install.executablePath) || !Native.readMachOArchitectures(host).includes("arm64")) throw new Error("The nxnative runtime does not contain the selected Apple Silicon host.");
  if (config.python?.delivery === "launcher" && (config.runtimeFiles.pythonPackages !== "python-packages" ||
      !inside(fs.realpathSync(root), fs.realpathSync(path.join(root, config.runtimeFiles.pythonPackages)))))
    throw new Error("The nxnative Python package directory is invalid.");
  return { root, cli, host, config, packageIdentity: install.declaration.manifestSha256 ||
    crypto.createHash("sha256").update(JSON.stringify(install.declaration)).digest("hex") };
}
async function runtimeForSelection(selection, context) {
  const runtime = runtimePaths(selection.install);
  if (!runtime.config.sourceRequirement) return runtime;
  if (runtime.config.sourceRequirement.repository !== "https://github.com/seedds/nxnative.git" ||
      runtime.config.sourceRequirement.adapter !== "maclauncher-nxnative-1")
    throw new Error("The nxnative native tools require an unsupported source adapter.");
  return { ...runtime, source: await Source.resolveSource(selection.sourceInstall, context, sourceIdentity) };
}
function recordSelectionUse(entry, context, selection, runtime) {
  context.recordRuntimeUse?.({ managerId: manager.id, version: selection.version, sectionId: "default",
    sourcePath: selection.sourceInstall?.root || selection.install.installDir });
  if (selection.sourceInstall) context.recordRuntimeUse?.({ managerId: selection.toolsManagerId || "nxnative-tools",
    version: selection.toolsVersion || runtime.config.version, sectionId: "default", sourcePath: selection.install.installDir });
  const info = { version: selection.version, source: runtime.source ? { kind: runtime.source.kind,
    revision: runtime.source.revision, committedAt: runtime.source.committedAt } : {
    kind: "package", revision: runtime.config.sourceRevision || null, committedAt: runtime.config.sourceCommittedAt || null },
    nativeTools: { version: selection.toolsVersion || runtime.config.version,
      revision: runtime.config.sourceRequirement?.nativeSourceRevision || runtime.config.nativeSourceRevision || runtime.config.sourceRevision || null,
      committedAt: runtime.config.sourceRequirement?.nativeSourceCommittedAt || runtime.config.nativeSourceCommittedAt || null } };
  entry.runtimeData = { ...entry.runtimeData, nxnative: { ...entry.runtimeData?.nxnative, selection: info } };
  context.onEntryChange?.({ runtimeData: entry.runtimeData });
}
async function pythonEnvironment(runtime, context) {
  if (runtime.config?.python?.delivery !== "launcher") return null;
  return IsolatedPython.ensureEnvironment({ userDataDir: context.userDataDir, id: "nxnative", version: runtime.config.version,
    packagesRoot: path.join(runtime.root, runtime.config.runtimeFiles.pythonPackages), payloadIdentity: runtime.packageIdentity,
    requirement: runtime.config.python, signal: context.signal });
}
async function resolveRuntime(entry, context, { runtimeManager = manager } = {}) {
  let selected = runtimeManager.resolveSelection(entry, context.settings, context.userDataDir);
  if (!selected.ready) {
    await confirmToolInstall(context, { manager: runtimeManager, version: selected.version || "latest", requiresDownload: true, detail: "Required to inspect or prepare Nintendo Switch programs." });
    await runtimeManager.installRuntime({ ...context, version: selected.version || "latest" });
    context.onRuntimeStateChange?.();
    selected = runtimeManager.resolveSelection(entry, context.settings, context.userDataDir);
  }
  if (!selected.ready) throw new Error(selected.reason);
  const runtime = await runtimeForSelection(selected, context);
  recordSelectionUse(entry, context, selected, runtime);
  return { ...selected, runtime };
}
async function runCli(runtime, args, directory, context, dependencies = {}, preparationEnvironment = {}) {
  const python = await pythonEnvironment(runtime, context);
  const environment = { ...(python?.env || process.env), ...preparationEnvironment, ...(python ? { NXNATIVE_PYTHON: python.pythonPath } : {}),
    ...(runtime.source ? { NXNATIVE_SOURCE_ROOT: runtime.source.root, NXNATIVE_SOURCE_REVISION: runtime.source.revision,
      NXNATIVE_SOURCE_COMMITTED_AT: runtime.source.committedAt || "" } : {}) };
  fs.mkdirSync(directory, { recursive: true });
  const logPath = path.join(directory, "nxnative.log");
  fs.writeFileSync(logPath, "");
  let failure;
  const progress = createProgressHandler(context.onProgress);
  try {
    await (dependencies.runCommand || runToolCommand)(runtime.cli, args, { cwd: directory, logPath, signal: context.signal, timeout: 60 * 60 * 1000,
      ...(python || runtime.source || Object.keys(preparationEnvironment).length ? { env: environment } : {}),
      onSpawn: child => {
        const decoder = new StringDecoder("utf8");let pending = "";
        child.stdout?.on("data", chunk => {
          pending += decoder.write(chunk);
          const lines = pending.split(/\r?\n/);pending = lines.pop() || "";
          if (pending.length > 65536) pending = "";
          for (const line of lines) {
            let event;try { event = JSON.parse(line); } catch { continue; }
            progress(event);
          }
        });
        return context.onToolProcessSpawn?.(child);
      } });
  } catch (error) { failure = error; }
  throwIfAborted(context.signal);
  const events = fs.readFileSync(logPath, "utf8").split(/\r?\n/).flatMap(line => {
    try { const value = JSON.parse(line); return value && typeof value === "object" && !Array.isArray(value) ? [value] : []; } catch { return []; }
  });
  if (failure) {
    const event = events.findLast(item => item.ev === "error");
    if (failure.exitCode === 78 && event?.code === "keys-required") throw Object.assign(new Error(event.message || "This package requires a prod.keys file."), { code: "NXNATIVE_KEYS_REQUIRED", logPath });
    if (event?.message) throw Object.assign(new Error(event.message + " See " + logPath + "."), { code: "NXNATIVE_PREPARATION_FAILED", logPath });
    const message = events.findLast(item => item.ev === "say" && typeof item.msg === "string" && item.msg.startsWith("[RED] "))?.msg.slice(6);
    if (message) throw Object.assign(new Error(message + " See " + logPath + "."), { code: "NXNATIVE_PREPARATION_FAILED", logPath });
    throw failure;
  }
  return { events, logPath };
}
function validKeys(file) {
  try { const stat = fs.statSync(file); return path.isAbsolute(file) && stat.isFile() && stat.size > 0 && stat.size <= 8 * 1024 * 1024; } catch { return false; }
}
function keysFileStatus({ filePath } = {}) {
  if (!filePath) return { status: "missing", reason: "Choose prod.keys for encrypted Switch game data." };
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return { status: "invalid", reason: "Choose a local prod.keys file." };
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { status: "invalid", reason: "The selection is a folder, not a keys file." };
    if (!stat.size) return { status: "invalid", reason: "The keys file is empty." };
    if (stat.size > 8 * 1024 * 1024) return { status: "invalid", reason: "The keys file is too large to read." };
    const content = fs.readFileSync(filePath, "utf8");
    if (!content.split(/\r?\n/).some(line => /^\s*[a-z0-9_]+\s*=\s*(?:[a-f0-9]{2})+\s*(?:[#;].*)?$/i.test(line)))
      return { status: "invalid", reason: "No key = hexadecimal value entries were found." };
    return { status: "registered", name: path.basename(filePath), reason: "Keys file registered. Required game keys are checked during preparation." };
  } catch (error) {
    return { status: error.code === "ENOENT" ? "missing" : "invalid", reason: error.code === "ENOENT" ? "The registered file is missing. Replace it or remove the registration." : "The keys file cannot be read. Choose a readable local file." };
  }
}
async function pickKeysFile(payload, context) {
  if (payload?.filePaths !== undefined && (!Array.isArray(payload.filePaths) || payload.filePaths.some(file => typeof file !== "string"))) throw new Error("Key selection requires a list of file paths.");
  const result = payload?.filePaths !== undefined ? { canceled: payload.filePaths.length === 0, filePaths: payload.filePaths }
    : await getUiServices(context).dialog.showOpenDialog({ title: "Choose prod.keys", message: "Encrypted Switch game data requires prod.keys. The file stays in its current location." + (payload?.preparing ? " Preparation continues after selection." : ""), properties: ["openFile"], filters: [{ name: "Switch keys", extensions: ["keys"] }] });
  if (result.canceled || !result.filePaths?.length) return { filePath: null };
  if (result.filePaths.length !== 1) throw new Error("Choose one prod.keys file.");
  const status = keysFileStatus({ filePath: result.filePaths[0] });
  if (status.status !== "registered") throw new Error(status.reason);
  return { filePath: result.filePaths[0] };
}
function rememberKeys(entry, context, filePath) {
  entry.runtimeSettings = { ...entry.runtimeSettings, nxnative: { ...entry.runtimeSettings?.nxnative, keysPath: filePath } };
  context.onEntryChange?.({ runtimeSettings: entry.runtimeSettings });
}
async function chooseKeys(entry, payload, context) {
  if (!entry.moduleData?.keysRequired) throw new Error("Keys are requested only for an encrypted Switch input.");
  context.onProgress?.({ phase: "prepare", label: "prod.keys required", message: "Choose prod.keys to continue preparing encrypted Switch game data." });
  const selected = await pickKeysFile({ ...payload, preparing: true }, context);
  if (!selected.filePath) throw createAbortError("Key selection canceled.");
  rememberKeys(entry, context, selected.filePath);
  return { selected: true };
}
function selectedKeys(entry, context) {
  return entry.runtimeSettings?.nxnative?.keysPath || context.runtimeSettings?.keysPath || entry.runtimeData?.nxnative?.keysPath || context.moduleSettings?.keysPath;
}
async function sourceIdentity(input, context) {
  const hash = crypto.createHash("sha256"), real = fs.realpathSync(input), visited = new Set();
  let count = 0;
  async function walk(file, relative, depth) {
    throwIfAborted(context.signal);
    if (depth > 64 || ++count > 500000) throw new Error("The Switch input exceeds the folder inspection limit.");
    const actual = fs.realpathSync(file), stat = await fs.promises.stat(file);
    if (!inside(real, actual) || visited.has(actual)) throw new Error("Switch input aliases must stay inside the imported folder without cycles.");
    hash.update(JSON.stringify([relative, stat.size, stat.mtimeMs, stat.ctimeMs]));
    if (stat.isDirectory()) {
      visited.add(actual);
      for (const name of (await fs.promises.readdir(file)).sort()) if (![".DS_Store", ".git"].includes(name)) await walk(path.join(file, name), path.join(relative, name), depth + 1);
      visited.delete(actual);
    } else if (!stat.isFile()) throw new Error("Switch inputs must be ordinary files or folders.");
    if (count % 256 === 0) await new Promise(resolve => setImmediate(resolve));
  }
  await walk(input, "", 0);
  return hash.digest("hex");
}
function assertOutsideSource(source, output) {
  let parent = output;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  if (inside(fs.realpathSync(source), path.join(fs.realpathSync(parent), path.relative(parent, output)))) throw new Error("Prepared Switch files and saves must be stored outside the original game folder.");
}
function canonicalTarget(file) {
  let parent = path.resolve(file), missing = [];
  while (!fs.existsSync(parent)) { missing.unshift(path.basename(parent));parent = path.dirname(parent); }
  return path.join(fs.realpathSync(parent), ...missing);
}
const PATH_ENVIRONMENT = new Set(["NXNATIVE_PROFILE", "DM_ROOT", "DM_ROMFS", "DM_SAVE", "DM_TEMP", "DM_MSL_DIR", "DM_FONT_DIR", "DM_NVN_SHMAP", "DM_AOC_DIR", "DM_PSO_ARCHIVE"]);
function validateLaunch(file, prepared, runtime, input, entry, context) {
  const launch = readJson(file), actualPrepared = fs.realpathSync(prepared);
  if (launch.schemaVersion !== 1 || !path.isAbsolute(launch.command || "") || fs.realpathSync(launch.command) !== fs.realpathSync(runtime.host) ||
      !Array.isArray(launch.args) || launch.args.length !== 1 || launch.args.some(value => typeof value !== "string" || value.length > 16384 || value.includes("\0")) ||
      !path.isAbsolute(launch.args[0]) || !inside(actualPrepared, fs.realpathSync(launch.args[0])) ||
      !path.isAbsolute(launch.cwd || "") || !inside(actualPrepared, fs.realpathSync(launch.cwd)) || !launch.env || typeof launch.env !== "object" || Array.isArray(launch.env))
    throw new Error("The prepared Switch launch does not match the managed runtime and private game files.");
  const environment = {}, suppliedEnvironment = { ...launch.env };
  // mac_run prebuilds here before the launcher redirects the save mount.
  // The host otherwise derives its archive beside the new save directory.
  if ((!Object.hasOwn(suppliedEnvironment, "DM_PSO_ARCHIVE") || suppliedEnvironment.DM_PSO_ARCHIVE === "") && typeof suppliedEnvironment.DM_ROOT === "string")
    suppliedEnvironment.DM_PSO_ARCHIVE = path.join(suppliedEnvironment.DM_ROOT, "run", "pso_archive");
  for (const [key, value] of Object.entries(suppliedEnvironment)) {
    if (typeof value !== "string" || value.includes("\0") || value.length > 16384 || key !== "NXNATIVE_PROFILE" && !/^DM_[A-Z0-9_]+$/.test(key)) throw new Error("The prepared Switch environment is invalid.");
    if (PATH_ENVIRONMENT.has(key) && !(key === "DM_PSO_ARCHIVE" && value === "off")) {
      const roots = key === "DM_PSO_ARCHIVE" ? [actualPrepared] : [runtime.root, actualPrepared, input.sourceRoot];
      if (!path.isAbsolute(value) || !roots.some(root => inside(fs.realpathSync(root), canonicalTarget(value)))) throw new Error("The prepared Switch environment escapes its game and runtime folders.");
    }
    environment[key] = value;
  }
  const save = saveDirectory(entry, context), temporary = path.join(gameDirectory(entry, context), "temp");
  assertOutsideSource(input.sourceRoot, save);fs.mkdirSync(save, { recursive: true });Writable.assertOwnDirectory(context.userDataDir, temporary);
  entry.defaultSaveDir = save;
  return { command: runtime.host, args: launch.args, cwd: launch.cwd,
    env: { ...environment, DM_SAVE: save, DM_TEMP: temporary, DM_WINDOW: "1", DM_AUDIO: "1" }, prepared };
}
async function prepareGame(entry, context, selection, dependencies = {}) {
  const input = resolveInput(entry);
  if (input.inspectionOnly) throw new Error("A Switch NSP, NSZ, XCI or XCZ application container is required for Play.");
  const runtime = selection.runtime || await runtimeForSelection(selection, context), root = gameDirectory(entry, context);
  assertOutsideSource(input.sourceRoot, root);Writable.assertOwnDirectory(context.userDataDir, root);
  const inputKey = crypto.createHash("sha256").update(JSON.stringify([input.inputPath, await sourceIdentity(input.inputPath, context)])).digest("hex");
  const identity = crypto.createHash("sha256").update(JSON.stringify([inputKey, selection.version, ...(runtime.source ? [runtime.source.revision] : []),
    selection.install.manifestSha256 || selection.install.declaration.manifestSha256])).digest("hex");
  let prepared = path.join(root, "prepared", inputKey);
  const workspacePath = path.join(root, "workspace.json");
  try {
    const workspace = readJson(workspacePath);
    if ((workspace.inputKey === inputKey || workspace.inputKey === identity) && typeof workspace.preparedRelative === "string") {
      const candidate = path.resolve(root, workspace.preparedRelative);
      if (inside(path.join(root, "prepared"), candidate)) {
        Writable.assertOwnDirectory(root, candidate, { create: false });
        prepared = candidate;
      }
    }
  } catch (error) { if (error.code !== "ENOENT") context.logger?.debug?.("[nxnative] preparing current workspace: " + error.message); }
  Writable.atomicWrite(workspacePath, JSON.stringify({ schemaVersion: 1, inputKey, preparedRelative: path.relative(root, prepared) }) + "\n", { root });
  const receiptPath = path.join(prepared, "prepared.json");
  try {
    const receipt = readJson(receiptPath);
    if (receipt.identity === identity) return { ...validateLaunch(path.join(prepared, "launch.json"), prepared, runtime, input, entry, context), cached: true };
  } catch (error) { if (error.code !== "ENOENT") context.logger?.debug?.("[nxnative] preparing current input: " + error.message); }
  Writable.assertOwnDirectory(root, prepared);
  const compilerRequirement = runtime.config.requirements?.metalCompiler;
  const compiler = compilerRequirement
    ? await (dependencies.ensureMetal || require("../shared/runtime/apple-metal-toolchain").ensure)(context, compilerRequirement) : null;
  const args = ["prepare", "--input", input.inputPath, "--output", prepared, "--progress", "json"];
  const execute = async () => {
    const keys = selectedKeys(entry, context);
    return runCli(runtime, validKeys(keys) ? [...args, "--keys", keys] : args, path.join(root, "preparation"), context, dependencies, compiler?.environment || {});
  };
  context.onProgress?.({ phase: "prepare", label: "Preparing Switch game…" });
  let result;
  try { result = await execute(); }
  catch (error) {
    if (error.code !== "NXNATIVE_KEYS_REQUIRED") throw error;
    entry.moduleData = { ...entry.moduleData, keysRequired: true };context.onEntryChange?.({ moduleData: entry.moduleData });
    const configured = selectedKeys(entry, context), adjacent = path.join(input.sourceRoot, "prod.keys");
    if (!validKeys(configured) && validKeys(adjacent)) rememberKeys(entry, context, adjacent);
    else if (!validKeys(configured)) await chooseKeys(entry, dependencies.keysPayload, context);
    result = await execute();
  }
  const event = result.events.findLast(item => item.ev === "prepared");
  const launchFile = path.join(prepared, "launch.json");
  if (!event?.launchFile || path.resolve(event.launchFile) !== launchFile) throw new Error("nxnative did not prepare its private game launch.");
  const launch = validateLaunch(launchFile, prepared, runtime, input, entry, context);
  Writable.atomicWrite(receiptPath, JSON.stringify({ schemaVersion: 1, identity, runtimeVersion: selection.version,
    ...(runtime.source ? { sourceRevision: runtime.source.revision, sourceCommittedAt: runtime.source.committedAt,
      nativeToolsVersion: selection.toolsVersion || runtime.config.version } : {}) }) + "\n", { root });
  return { ...launch, cached: false };
}
module.exports = { gameDirectory, saveDirectory, resolveInput, runtimePaths, runtimeForSelection, recordSelectionUse, pythonEnvironment, resolveRuntime, runCli, keysFileStatus, pickKeysFile, chooseKeys, sourceIdentity, validateLaunch, prepareGame, readJson };
