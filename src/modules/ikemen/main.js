const fs = require("node:fs");
const { cloneOrCopySync } = require("../shared/copy-file");
const { syncOverlay } = require("../shared/game-overlay");
const path = require("node:path");
const manifest = require("./manifest.json");
const { detectGame, validMotif } = require("./detect");
const { inspectGame } = require("./inspect");
const manager = require("./runtime/manager");
const { manager: sffManager } = require("./tools/sff-manager");
const Sprites = require("./tools/sprites");
const GameData = require("../shared/game-data");
const Native = require("../shared/runtime/local-native");
const { prepareLegacyTriggers } = require("./legacy-triggers");
const READ_ONLY_ASSET = /\.(?:snd|sff|air|fnt|def|const|zss|lua|mp3|ogg|wav|flac|png|bmp|jpg|jpeg|webp|pcx|ttf|otf|mp4|webm|glb|gltf|mesh|obj|fbx|dae|dds|ktx)$/i;

function existsDirectory(directory) {
  try { return fs.statSync(directory).isDirectory(); } catch { return false; }
}

function gameDirectory(entry, context) {
  if (!entry.gameId || !context.userDataDir || !/^[A-Za-z0-9_-]+$/.test(entry.gameId)) throw new Error("Ikemen GO requires a persisted game id and launcher data directory.");
  return GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, manifest.id);
}
const { distributionRoot, originalSaveDirectory } = require("./original-paths");
function resolveSaveLocations(entry, context = {}) {
  const selection = manager.resolveSelection(entry, context.settings, context.userDataDir, { verification: "status" });
  const original = selection.ready && originalSaveDirectory(entry, selection.install);
  return { primaryDirectory: original || (context.userDataDir && entry.gameId ? path.join(gameDirectory(entry, context), "saves") : entry.defaultSaveDir || null) };
}
// Materialize directories but link immutable assets; keep configuration and
// unknown sidecars private because engine scripts may update them. Mutable
// save/config/log data lives beside the overlay, and imported game directories
// are never patched. Runtime Lua scripts come from the selected engine;
// Windows-game scripts are not silently injected into a different engine version.
const ASSET_DIRECTORIES = ["data", "external", "font", "sound", "video", "chars", "stages"];
function assetLayers(runtimeRoot, root) {
  return ASSET_DIRECTORIES.flatMap(name => [{ source: path.join(runtimeRoot, name), into: name, optional: true },
    ...name === "external" ? [] : [{ source: path.join(root, name), into: name, optional: true }]]);
}
const overlayRules = { link: name => READ_ONLY_ASSET.test(name), skip: name => name.startsWith(".") };

// Some screenpacks retain DEF references to files moved into a subdirectory.
// Automatic preparation adds only absent paths in the owned stage, and only when
// exactly one matching asset exists. It never rewrites a DEF or source asset.
function repairAssetPaths(wrapper) {
  const files = [], assets = new Map(), repairs = [];
  function visit(directory, depth = 0) {
    if (depth > 32 || files.length > 20000) throw new Error("Ikemen resource repair exceeds supported directory bounds.");
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file, depth + 1);
      else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(file);
        if (/\.(snd|sff|air|fnt)$/i.test(entry.name)) {
          const key = entry.name.toLowerCase(); assets.set(key, [...(assets.get(key) || []), file]);
        }
      }
    }
  }
  for (const name of ["data", "font", "sound", "chars", "stages"]) if (existsDirectory(path.join(wrapper, name))) visit(path.join(wrapper, name));
  for (const file of files.filter(file => /\.def$/i.test(file))) {
    if (fs.statSync(file).size > 1024 * 1024) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = /^[\w.]+\s*=\s*([^;]+?\.(?:snd|sff|air|fnt))\s*(?:;.*)?$/i.exec(line.trim());
      if (!match) continue;
      const reference = match[1].replace(/\\/g, "/");
      if (path.isAbsolute(reference) || reference.split("/").includes("..")) continue;
      const target = path.resolve(path.dirname(file), reference);
      if (!target.startsWith(wrapper + path.sep) || fs.existsSync(target) || fs.existsSync(path.join(wrapper, reference))) continue;
      const candidates = assets.get(path.basename(reference).toLowerCase()) || [];
      if (candidates.length !== 1) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(candidates[0], target);
      repairs.push({ reference: path.relative(wrapper, target), asset: path.relative(wrapper, candidates[0]) });
    }
  }
  return repairs;
}
function prepareLaunch(entry, context, install) {
  const root = entry.contentRootDir || entry.gamePath;
  const motifRelative = validMotif(root, entry.moduleData?.motifRelative);
  if (!motifRelative) throw new Error("MUGEN/Ikemen motif definition was not found or is invalid.");
  const compatibility = inspectGame(root, motifRelative);
  if (compatibility.unsupported.length) throw new Error("This content declares a newer MUGEN/Ikemen version than the pinned Ikemen GO 1.0.0 runtime supports.");
  const runtimeRoot = distributionRoot(install);
  if (!fs.existsSync(path.join(runtimeRoot, "external", "script", "main.lua"))) {
    throw new Error("Ikemen GO needs its complete distribution, including external/script/main.lua beside the app.");
  }
  const originalSaveRoot = originalSaveDirectory(entry, install);
  if (entry.saveDirOverride && !path.isAbsolute(entry.saveDirOverride)) throw new Error("Ikemen GO save location must be absolute.");
  // The selected runtime is already part of this original distribution. Its
  // app-bundle cwd reset lands here too, and no fallback resources are missing.
  // A separate save override still uses the existing adaptation below.
  if (originalSaveRoot) {
    entry.defaultSaveDir = originalSaveRoot;
    return { directory: root, wrapper: root, saveRoot: originalSaveRoot, motifRelative,
      executablePath: install.executablePath, originalPaths: true };
  }
  const directory = gameDirectory(entry, context);
  const wrapper = path.join(directory, "game");
  const stagedVersion = path.join(directory, "staged-runtime.json");
  let prior;
  try {
    prior = JSON.parse(fs.readFileSync(stagedVersion, "utf8"));
    if (prior?.layoutVersion !== 6) throw new Error("Invalid Ikemen GO runtime preparation metadata.");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const repairMissingAssetPaths = true;
  fs.mkdirSync(directory, { recursive: true });
  // Edited, added and removed game and engine files reach the overlay on each launch.
  const { changed } = syncOverlay({ destination: wrapper, recordPath: path.join(directory, "game-files.json"), layers: assetLayers(runtimeRoot, root), ...overlayRules });
  // Upstream's Mac runner intentionally resets cwd to its app's parent.
  // Stage the unchanged app alongside this game's assets so that behavior
  // resolves this game's motif and keeps writes in its owned save root.
  const macos = path.dirname(install.executablePath);
  const sourceApp = path.resolve(macos, "..", "..");
  const relative = sourceApp.toLowerCase().endsWith(".app") ? path.relative(runtimeRoot, install.executablePath) : path.basename(install.executablePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Ikemen executable escaped its distribution.");
  const runtimeChanged = prior?.version !== install.version || prior?.binarySha256 !== install.binarySha256 || prior?.executableRelative !== relative || !fs.existsSync(path.join(wrapper, relative));
  if (runtimeChanged) {
    const previousApp = typeof prior?.executableRelative === "string" ? prior.executableRelative.split(/[\\/]/)[0] : null;
    if (previousApp && !ASSET_DIRECTORIES.includes(previousApp) && previousApp !== "save") fs.rmSync(path.join(wrapper, previousApp), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (sourceApp.toLowerCase().endsWith(".app")) cloneOrCopySync(sourceApp, path.join(wrapper, path.basename(sourceApp)));
    else cloneOrCopySync(install.executablePath, path.join(wrapper, relative));
  }
  let assetRepairs = Array.isArray(prior?.assetRepairs) ? prior.assetRepairs : [];
  if (changed || runtimeChanged || prior?.layoutVersion !== 6) {
    // Earlier aliases go first, so a file that now exists is never shadowed.
    for (const repair of assetRepairs) {
      const file = path.join(wrapper, String(repair.reference));
      try { if (file.startsWith(wrapper + path.sep) && fs.readlinkSync(file) === path.join(wrapper, String(repair.asset))) fs.rmSync(file); } catch {}
    }
    assetRepairs = repairMissingAssetPaths ? repairAssetPaths(wrapper) : [];
  }
  const record = JSON.stringify({ layoutVersion: 6, version: install.version, binarySha256: install.binarySha256, gameRoot: root, executableRelative: relative, repairMissingAssetPaths, assetRepairs });
  if (record !== JSON.stringify(prior)) fs.writeFileSync(stagedVersion, record);
  const executablePath = path.join(wrapper, relative);
  if (Native.hashFile(executablePath) !== install.binarySha256) throw new Error("Staged Ikemen executable changed. Remove the staged runtime before retrying.");
  const triggerChanges = prepareLegacyTriggers(wrapper, install);
  if (triggerChanges.length) fs.writeFileSync(path.join(directory, "legacy-triggers.json"), JSON.stringify({ runtimeVersion: install.version, upstreamRevision: install.upstreamRevision, changes: triggerChanges }));
  const saveRoot = entry.saveDirOverride || path.join(directory, "saves");
  if (!path.isAbsolute(saveRoot)) throw new Error("Ikemen GO save location must be absolute.");
  fs.mkdirSync(saveRoot, { recursive: true });
  const config = path.join(saveRoot, "config.ini"), initialConfig = path.join(root, "save", "config.ini");
  if (!fs.existsSync(config) && fs.existsSync(initialConfig) && fs.statSync(initialConfig).isFile()) cloneOrCopySync(initialConfig, config);
  const saveLink = path.join(wrapper, "save");
  try {
    if (!fs.lstatSync(saveLink).isSymbolicLink() || fs.readlinkSync(saveLink) !== saveRoot) fs.rmSync(saveLink, { recursive: true, force: true });
  } catch {}
  if (!fs.existsSync(saveLink)) fs.symlinkSync(saveRoot, saveLink, "dir");
  entry.defaultSaveDir = saveRoot;
  return { directory, wrapper, saveRoot, motifRelative, executablePath };
}

module.exports = { id: manifest.id, manifest, detectGame, runtimeManagers: [manager, sffManager],
  normalizeRuntimeId: () => "ikemen",
  ensureRuntime: (entry, context) => {
    const root = entry.contentRootDir || entry.gamePath, motif = validMotif(root, entry.moduleData?.motifRelative);
    if (!motif) throw new Error("MUGEN/Ikemen motif definition is missing or invalid.");
    if (inspectGame(root, motif).unsupported.length) throw new Error("This game requires a newer MUGEN/Ikemen runtime.");
    const selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
    return selection.ready ? null : { managerId: "ikemen", version: selection.version, ...(selection.discoveryRequired ? { discoveryRequired: true } : {}), installOptions: {} };
  },
  resolveSaveLocations,
  onImport: (entry, context) => { entry.defaultSaveDir = resolveSaveLocations(entry, context).primaryDirectory; },
  onRuntimeChange: (entry, context) => { entry.defaultSaveDir = resolveSaveLocations(entry, context).primaryDirectory; },
  launchRuntime: async (runtimeId, entry, context) => {
    if (runtimeId !== "ikemen") return null;
    const selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
    if (!selection.ready) throw new Error(selection.reason);
    const launch = prepareLaunch(entry, context, selection.install);
    const args = ["-r", launch.motifRelative];
    const extra = context.runtimeSettings?.appArgs || [];
    if (!Array.isArray(extra) || extra.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Invalid Ikemen GO application arguments.");
    context.onEntryChange?.(entry);
    return context.spawnDetachedChecked(launch.executablePath, [...args, ...extra, ...(context.gameArguments || [])],
      { cwd: launch.wrapper }, selection.install.needsRosetta);
  },
  cleanupGameData: (entry, context) => { fs.rmSync(gameDirectory(entry, context), { recursive: true, force: true }); return true; },
  actions: {
    runtimeStatus: (entry, _payload, context) => manager.resolveSelection(entry, context.settings, context.userDataDir),
    installRuntime: async (entry, payload, context) => {
      const installed = await manager.installRuntime({ userDataDir: context.userDataDir,
        version: payload?.version || manager.resolveSelection(entry, context.settings, context.userDataDir).version,
        downloads: context.downloads, logger: context.logger });
      if (payload?.version) entry.runtimeData = { ...entry.runtimeData, ikemen: { ...entry.runtimeData?.ikemen, version: installed.version } };
      context.onRuntimeStateChange?.();
      return installed;
    },
    inspectGame: entry => inspectGame(entry.contentRootDir || entry.gamePath, entry.moduleData.motifRelative),
    exportSprites: Sprites.exportSprites
  },
  __test: { prepareLaunch, assetLayers, overlayRules, distributionRoot, repairAssetPaths }
};
