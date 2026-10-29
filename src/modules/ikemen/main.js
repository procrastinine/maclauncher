const fs = require("node:fs");
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

function gameDirectory(entry, context) {
  if (!entry.gameId || !context.userDataDir || !/^[A-Za-z0-9_-]+$/.test(entry.gameId)) throw new Error("Ikemen GO requires a persisted game id and launcher data directory.");
  return GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, manifest.id);
}
function existsDirectory(directory) {
  try { return fs.statSync(directory).isDirectory(); } catch { return false; }
}
function distributionRoot(install) {
  if (install.source === "download") return install.installDir;
  const macos = path.dirname(install.executablePath);
  const app = path.resolve(macos, "..", "..");
  return app.toLowerCase().endsWith(".app") ? path.dirname(app) : macos;
}

// Materialize directories but link immutable assets. Mutable save/config/log data
// lives beside the overlay, and imported game directories are never patched.
function mergeAssets(source, destination, depth = 0) {
  if (depth > 32) throw new Error("Ikemen asset directory is too deeply nested.");
  if (!existsDirectory(source)) return;
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      if (fs.existsSync(to) && !fs.lstatSync(to).isDirectory()) fs.rmSync(to);
      mergeAssets(from, to, depth + 1);
    } else if (entry.isFile()) {
      fs.rmSync(to, { recursive: true, force: true });
      // Alias known read-only resources; keep configuration and unknown sidecars
      // private because engine scripts may update them.
      if (READ_ONLY_ASSET.test(entry.name)) fs.symlinkSync(from, to);
      else fs.copyFileSync(from, to);
    }
    // Directory symlinks are ignored to prevent import cycles/outside traversal.
  }
}

function minimizeLegacyResources(source, destination, depth = 0) {
  if (depth > 32) throw new Error("Ikemen resource directory is too deeply nested.");
  if (!existsDirectory(source) || !existsDirectory(destination)) return;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory() && fs.existsSync(to) && fs.lstatSync(to).isDirectory()) minimizeLegacyResources(from, to, depth + 1);
    else if (entry.isFile() && READ_ONLY_ASSET.test(entry.name) && fs.existsSync(to) && fs.lstatSync(to).isFile() && Native.hashFile(from) === Native.hashFile(to)) {
      fs.rmSync(to); fs.symlinkSync(from, to);
    }
  }
}

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
  const directory = gameDirectory(entry, context);
  const root = entry.contentRootDir || entry.gamePath;
  const motifRelative = validMotif(root, entry.moduleData?.motifRelative);
  if (!motifRelative) throw new Error("MUGEN/Ikemen motif definition was not found or is invalid.");
  const compatibility = inspectGame(root, motifRelative);
  if (compatibility.unsupported.length) throw new Error("This content declares a newer MUGEN/Ikemen version than the pinned Ikemen GO 1.0.0 runtime supports.");
  const runtimeRoot = distributionRoot(install);
  if (!fs.existsSync(path.join(runtimeRoot, "external", "script", "main.lua"))) {
    throw new Error("Ikemen GO needs its complete distribution, including external/script/main.lua beside the app.");
  }
  const wrapper = path.join(directory, "game");
  const stagedVersion = path.join(directory, "staged-runtime.json");
  let prior;
  try { prior = JSON.parse(fs.readFileSync(stagedVersion, "utf8")); } catch {}
  const repairMissingAssetPaths = true;
  if (prior?.layoutVersion === 4 && prior.version === install.version && prior.binarySha256 === install.binarySha256 && prior.gameRoot === root && existsDirectory(wrapper)) {
    for (const name of ["data", "font", "sound", "video", "chars", "stages"]) {
      minimizeLegacyResources(path.join(root, name), path.join(wrapper, name));
      minimizeLegacyResources(path.join(runtimeRoot, name), path.join(wrapper, name));
    }
    prior.layoutVersion = 5; fs.writeFileSync(stagedVersion, JSON.stringify(prior));
  }
  if (!prior || prior.layoutVersion !== 5 || prior.version !== install.version || prior.binarySha256 !== install.binarySha256 || prior.gameRoot !== root) {
    fs.mkdirSync(directory, { recursive: true });
    const temporary = fs.mkdtempSync(path.join(directory, ".stage-"));
    try {
      for (const name of ["data", "external", "font", "sound", "video", "chars", "stages"]) {
        mergeAssets(path.join(runtimeRoot, name), path.join(temporary, name));
        // Runtime Lua scripts come from the selected engine; Windows-game scripts
        // are not silently injected into a different engine version.
        if (name !== "external") mergeAssets(path.join(root, name), path.join(temporary, name));
      }
      // Upstream's Mac runner intentionally resets cwd to its app's parent.
      // Stage the unchanged app alongside this game's assets so that behavior
      // resolves this game's motif and keeps writes in its owned save root.
      const macos = path.dirname(install.executablePath);
      const sourceApp = path.resolve(macos, "..", "..");
      const relative = sourceApp.toLowerCase().endsWith(".app") ? path.relative(runtimeRoot, install.executablePath) : path.basename(install.executablePath);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Ikemen executable escaped its distribution.");
      if (sourceApp.toLowerCase().endsWith(".app")) fs.cpSync(sourceApp, path.join(temporary, path.basename(sourceApp)), { recursive: true, verbatimSymlinks: true });
      else fs.copyFileSync(install.executablePath, path.join(temporary, relative));
      fs.rmSync(wrapper, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      fs.renameSync(temporary, wrapper);
      const assetRepairs = repairMissingAssetPaths ? repairAssetPaths(wrapper) : [];
      fs.writeFileSync(stagedVersion, JSON.stringify({ layoutVersion: 5, version: install.version, binarySha256: install.binarySha256, gameRoot: root, executableRelative: relative, repairMissingAssetPaths, assetRepairs }));
    } finally { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }
  const staged = JSON.parse(fs.readFileSync(stagedVersion, "utf8"));
  const executablePath = path.join(wrapper, staged.executableRelative);
  if (Native.hashFile(executablePath) !== install.binarySha256) throw new Error("Staged Ikemen executable changed. Remove the staged runtime before retrying.");
  const triggerChanges = prepareLegacyTriggers(wrapper, install);
  if (triggerChanges.length) fs.writeFileSync(path.join(directory, "legacy-triggers.json"), JSON.stringify({ runtimeVersion: install.version, upstreamRevision: install.upstreamRevision, changes: triggerChanges }));
  const saveRoot = entry.saveDirOverride || path.join(directory, "saves");
  if (!path.isAbsolute(saveRoot)) throw new Error("Ikemen GO save location must be absolute.");
  fs.mkdirSync(saveRoot, { recursive: true });
  const config = path.join(saveRoot, "config.ini"), initialConfig = path.join(root, "save", "config.ini");
  if (!fs.existsSync(config) && fs.existsSync(initialConfig) && fs.statSync(initialConfig).isFile()) fs.copyFileSync(initialConfig, config);
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
  onImport: (entry, context) => { entry.defaultSaveDir = path.join(gameDirectory(entry, context), "saves"); },
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
  __test: { prepareLaunch, mergeAssets, distributionRoot, repairAssetPaths, minimizeLegacyResources }
};
