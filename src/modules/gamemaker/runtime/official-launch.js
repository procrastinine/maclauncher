const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const Native = require("../../shared/runtime/local-native");
const Exports = require("../export");
const { inspectStudio, hashFile } = require("../inspect");
const { runTool } = require("../tools");

function hashRunnerTree(appPath) {
  const root = path.resolve(appPath);
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error("Official runner app must be a real directory.");
  const digest = crypto.createHash("sha256");
  let entries = 0, bytes = 0;
  function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const full = path.join(directory, name), stat = fs.lstatSync(full);
      if (++entries > 10000) throw new Error("Official runner bundle exceeds the file limit.");
      const relative = path.relative(root, full);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(full);
        const resolved = path.resolve(path.dirname(full), target);
        if (!resolved.startsWith(root + path.sep)) throw new Error("Official runner symlink escapes its bundle.");
        digest.update(JSON.stringify([relative, "link", target]));
      } else if (stat.isDirectory()) { digest.update(JSON.stringify([relative, "directory"])); walk(full); }
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > 128 * 1024 ** 2) throw new Error("Official runner bundle exceeds the size limit.");
        digest.update(JSON.stringify([relative, "file", stat.mode & 0o777, hashFile(full)]));
      } else throw new Error("Official runner contains a special filesystem object.");
    }
  }
  walk(root);
  return digest.digest("hex");
}

function privateSaveLocations(entry, context, { homeDir = os.homedir() } = {}) {
  const gameRoot = Exports.resolveOutputRoot(entry, context);
  const identifier = `com.maclauncher.gamemaker.${crypto.createHash("sha256").update(path.resolve(context.userDataDir) + "\0" + entry.gameId).digest("hex").slice(0, 24)}`;
  const saveDir = path.join(gameRoot, "official-saves");
  const support = path.join(homeDir, "Library", "Application Support");
  if (!path.isAbsolute(homeDir)) throw new Error("An absolute macOS home directory is required.");
  const alias = path.join(support, identifier);
  return { gameRoot, identifier, saveDir, support, alias };
}
function ensurePrivateSaves(locations) {
  for (const dir of [locations.saveDir, path.dirname(locations.support), locations.support]) {
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error("Official GameMaker save path contains an unexpected symlink.");
    fs.mkdirSync(dir, { recursive: true });
  }
  let existing;
  try { existing = fs.lstatSync(locations.alias); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing) {
    if (!existing.isSymbolicLink() || path.resolve(path.dirname(locations.alias), fs.readlinkSync(locations.alias)) !== locations.saveDir) {
      throw new Error("The private official GameMaker save alias already belongs to another path. Its contents were preserved.");
    }
  } else fs.symlinkSync(locations.saveDir, locations.alias, "dir");
}

async function stageRunner(entry, context, install, { runProcess = runTool, homeDir } = {}) {
  const locations = privateSaveLocations(entry, context, { ...(homeDir ? { homeDir } : {}) });
  const sourceTree = hashRunnerTree(install.runnerAppPath);
  if (sourceTree !== install.runnerTreeSha256) throw new Error("Official source runner changed after registration.");
  const runtimeKey = require("../../shared/runtime/custom-runtime").storageKey(install.version, { prefix: "", length: 20 });
  const destination = path.join(locations.gameRoot, `official-runner-${runtimeKey}`);
  const recordPath = path.join(destination, "staged.json");
  const appPath = path.join(destination, "Runner.app");
  let record;
  if (fs.existsSync(destination)) {
    if (fs.lstatSync(destination).isSymbolicLink()) throw new Error("Official staging path is a symlink.");
    record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    if (record.sourceTreeSha256 !== sourceTree || record.version !== install.version || record.identifier !== locations.identifier ||
      record.saveDir !== locations.saveDir || hashRunnerTree(appPath) !== record.stagedTreeSha256) {
      throw new Error("The staged official runner changed. Remove this game's staged runner folder before trying again.");
    }
  } else {
    const temporary = fs.mkdtempSync(path.join(locations.gameRoot, ".official-stage-"));
    try {
      const app = path.join(temporary, "Runner.app");
      await runProcess("/usr/bin/ditto", [install.runnerAppPath, app], { timeout: 60000 });
      await runProcess("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleIdentifier ${locations.identifier}`, path.join(app, "Contents", "Info.plist")], { timeout: 15000 });
      // Bundle ID controls the native runner's Application Support save root.
      // Re-sign only the owned copy after changing its plist. Preserve JIT rights.
      await runProcess("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--options", "0", "--preserve-metadata=entitlements", app], { timeout: 60000 });
      if (hashRunnerTree(install.runnerAppPath) !== sourceTree) throw new Error("Official source runner changed during staging.");
      record = { version: install.version, upstreamRevision: install.upstreamRevision, identifier: locations.identifier,
        sourceTreeSha256: sourceTree, sourceBinarySha256: install.binarySha256,
        stagedTreeSha256: hashRunnerTree(app), stagedBinarySha256: hashFile(path.join(app, "Contents", "MacOS", "Mac_Runner")),
        saveDir: locations.saveDir, saveAlias: locations.alias, stagedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(temporary, "staged.json"), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
      fs.renameSync(temporary, destination);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  ensurePrivateSaves(locations);
  return { ...record, appPath, executablePath: path.join(appPath, "Contents", "MacOS", "Mac_Runner") };
}

function preflight(dataPath, runnerVersion) {
  const inspection = inspectStudio(dataPath);
  if (inspection.executionKind !== "studio-vm") throw new Error("Official VM execution requires bytecode; YYC/native or code-free data cannot be swapped into this runner.");
  if (inspection.inventory?.EXTN !== 0) throw new Error("Official cross-game execution is unavailable for declared native extensions; their Mac dependencies and ABI have not been verified.");
  if (runnerVersion) {
    const result = require("./official-compatibility").compatibility(inspection, runnerVersion);
    if (!result.compatible) throw new Error(result.reason);
  }
  return inspection;
}
function validateNativeDependencies(inspection, dataPath, install, options = {}) {
  if (inspection.steamRequired !== true && inspection.steamEnabled !== true && inspection.steamFunctions !== true) return;
  if (options.context) return require("./steam-api").resolveDependency(inspection, dataPath, install,
    { runnerVersion: options.runnerVersion || install?.version, resourcesRoot: options.resourcesRoot });
  const locations = [path.join(path.dirname(dataPath), "libsteam_api.dylib"),
    install?.runnerAppPath && path.join(install.runnerAppPath, "Contents", "MacOS", "libsteam_api.dylib")].filter(Boolean);
  const found = locations.some(file => {
    try { return Native.readMachOArchitectures(file, { allowLibrary: true }).length > 0; } catch { return false; }
  });
  if (!found) throw Object.assign(new Error("This Steam export needs the Mac Steamworks library and Steam client. Choose Butterscotch to run its VM data."), {
    code: "GAMEMAKER_STEAM_DEPENDENCY_REQUIRED", fallbackRuntimeId: "butterscotch", steamAppId: inspection.steamAppId,
    missingDependency: "libsteam_api.dylib"
  });
}
async function launchOfficial(entry, context, selection, dependencies = {}) {
  const dataPath = Exports.resolveDataPath(entry);
  const runtimeVersion = selection?.install?.runtimeVersion || selection?.version;
  const inspection = preflight(dataPath, runtimeVersion);
  if (!selection?.install?.launchReady) throw new Error(selection?.reason || "Select an installed official native runner build.");
  const steamDependency = validateNativeDependencies(inspection, dataPath, selection.install,
    { context, runnerVersion: runtimeVersion, resourcesRoot: dependencies.resourcesRoot });
  let environment, graphicsHelper;
  const setting = context.runtimeSettings?.softwareOpenGLFallback;
  const mode = setting === false || setting === "disabled" ? "disabled" : setting === true || setting === "enabled" ? "enabled" : "auto";
  if (mode !== "disabled") {
    const graphics = require("./opengl-fallback");
    const selectedHelper = graphics.selection(entry, context);
    const reviewed = graphics.supportsRunner(selectedHelper.install, runtimeVersion, selection.install.binarySha256);
    if (reviewed || mode === "enabled") {
      const fallback = graphics.resolveFallback({ userDataDir: context.userDataDir, runnerVersion: runtimeVersion,
        runnerSha256: selection.install.binarySha256, helperVersion: selectedHelper.version, entry, settings: context.settings });
      if (!fallback.ready && (reviewed || mode === "enabled")) throw new Error(fallback.reason || "No compatible graphics helper is available for this runner.");
      if (fallback.ready && fallback.environment) {
        graphicsHelper = fallback;
        context.recordRuntimeUse?.({ managerId: graphics.manager.id, version: selectedHelper.version, sourcePath: fallback.installDir });
        environment = { ...process.env, ...fallback.environment };
      }
    }
  }
  const staged = await stageRunner(entry, context, selection.install, dependencies);
  const steam = await require("./steam-api").prepareDependency(steamDependency, entry, context, environment);
  if (steam?.environment) environment = steam.environment;
  entry.defaultSaveDir = staged.saveDir;
  entry.moduleData = { ...(entry.moduleData || {}), lastRuntimeVersion: selection.version,
    lastRuntimeRevision: selection.install.upstreamRevision, lastRuntimeBackend: "official-studio-vm",
    lastRuntimeSha256: selection.install.binarySha256, lastStagedRuntimeSha256: staged.stagedBinarySha256,
    officialGameVersionMatch: "unverified", officialGameFormat: inspection.detectedVersion,
    lastGraphicsHelperVersion: graphicsHelper?.version || null,
    lastGraphicsHelperSha256: graphicsHelper?.binarySha256 || null,
    lastGraphicsHelperSourceSha256: graphicsHelper?.sourceSha256 || null,
    ...(steam ? { lastSteamApiMode: steam.mode, lastSteamApiVersion: steam.version, lastSteamApiSha256: steam.sha256,
      lastSteamApiSourceRevision: steam.sourceRevision, lastSteamApiSavePath: steam.savePath || null } : {}) };
  context.onEntryChange?.({ defaultSaveDir: staged.saveDir, moduleData: entry.moduleData });
  const launcher = environment ? { ...context, spawnDetachedChecked: (exe, args, options, rosetta) => context.spawnDetachedChecked(exe, args, { ...options, env: environment }, rosetta) } : context;
  return Native.launchLocalRuntime({ runtimePath: staged.appPath, runtimeVersion: selection.version,
    upstreamRevision: selection.install.upstreamRevision, expectedSha256: staged.stagedBinarySha256,
    preferredExecutable: "Mac_Runner", args: ["-game", dataPath, ...(context.gameArguments || [])], cwd: path.dirname(dataPath), context: launcher, focusOnLaunch: true });
}

function cleanupGameData(entry, context, dependencies = {}) {
  const locations = privateSaveLocations(entry, context, dependencies);
  let stat;
  try { stat = fs.lstatSync(locations.alias); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (stat.isSymbolicLink() && path.resolve(path.dirname(locations.alias), fs.readlinkSync(locations.alias)) === locations.saveDir) fs.unlinkSync(locations.alias);
}

module.exports = { hashRunnerTree, privateSaveLocations, ensurePrivateSaves, stageRunner, preflight, validateNativeDependencies, launchOfficial, cleanupGameData };
