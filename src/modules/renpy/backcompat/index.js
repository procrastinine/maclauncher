// Backcompat: MacLauncher v0.5.1 Ren'Py projects/<SDK-or-patched-version>
// Play mirrors and schema-1 shared writable-input records. Runs only through
// the persisted, at-most-once-per-game original-game-mirrors migration.
// Delete when supported profiles no longer contain those released layouts.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const GameData = require("../../shared/game-data");
const WritableBackcompat = require("../../shared/backcompat/writable-input");
const RuntimeSdk = require("../runtime/sdk");
const Native = require("../../shared/runtime/bundled-native");
const Scripts = require("../script-config");
const existsDir = directory => { try { return fs.statSync(directory).isDirectory(); } catch { return false; } };

function provedSteamArtifacts(root) {
  const scriptName = "game/00_maclauncher_steam.rpy", receiptName = ".maclauncher-renpy-steam.json";
  try {
    const receipt = JSON.parse(Native.readRegular(path.join(root, receiptName), 8192).bytes);
    const script = Native.readRegular(path.join(root, scriptName), 32 * 1024).bytes.toString("utf8");
    if (receipt.schemaVersion !== 1 || !script.startsWith("# MacLauncher owned per-game Steam path mapping v1\n") ||
        crypto.createHash("sha256").update(script).digest("hex") !== receipt.sha256) return [];
    const generated = [receiptName, scriptName];
    const appId = script.match(/^    config\.steam_appid = ([1-9][0-9]*)$/m)?.[1];
    const appIdName = ".maclauncher-renpy-steam/steam_appid.txt";
    try { if (appId && Native.readRegular(path.join(root, appIdName), 32).bytes.toString("utf8") === appId + "\n") generated.push(appIdName); } catch {}
    // A compiled helper is disposable only when its retained inert Python AST
    // matches the exact proved script body, not just its reserved filename.
    try {
      const compiled = Native.readRegular(path.join(root, scriptName + "c"), Scripts.LIMITS.sourceBytes).bytes;
      const body = script.split("init -1500 python in _maclauncher_steam:\n")[1]?.split("\n").map(line => line.startsWith("    ") ? line.slice(4) : line).join("\n").trim();
      const sources = Scripts.readRpycConfiguration(compiled, scriptName + "c", { includePythonSources: true });
      if (body && sources.length === 1 && !sources[0].unsafeContext && sources[0].python?.trim() === body) generated.push(scriptName + "c");
    } catch {}
    return generated;
  } catch { return []; }
}

function remapPath(value, mirror, source) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return value;
  const relative = path.relative(mirror, value);
  return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
    ? path.join(source, relative) : value;
}

function restoredRecordPatch(entry, mirror, source) {
  const patch = {};
  // Default/save-location arrays are remapped cumulatively by the runner.
  for (const key of ["contentRootDir", "indexDir", "indexHtml", "saveDirOverride"]) {
    const value = remapPath(entry[key], mirror, source);
    if (value !== entry[key]) patch[key] = value;
  }
  return patch;
}

// One-time migration describes obsolete Play views; Play never calls this.
function legacyGameMirrors(entry, { userDataDir } = {}) {
  const mirrors = WritableBackcompat.legacyGameMirrors(entry, { userDataDir });
  if (!entry?.gameId || !path.isAbsolute(userDataDir || "")) return mirrors;
  const moduleRoot = GameData.resolveGameModuleDir(userDataDir, entry.gameId, "renpy");
  const projects = path.join(moduleRoot, "projects");
  let projectStat;
  try { projectStat = fs.lstatSync(projects); } catch (error) { if (error.code === "ENOENT") return mirrors;throw error; }
  if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) throw new Error("Legacy Ren'Py projects must be a real directory.");
  const record = file => {
    try { fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null;throw error; }
    return JSON.parse(Native.readRegular(file, 2 * 1024 ** 2).bytes);
  };
  const builds = record(path.join(moduleRoot, "builds", "builds.json"));
  if (builds && !Array.isArray(builds.builds)) throw new Error("Ren'Py package build records are unreadable.");
  // The same historical workspace is still used by explicit package builds.
  // Recover released Play data from build workspaces too, without retiring
  // that current workspace. Actual builds/ outputs are never described.
  const buildWorkspaces = new Set((builds?.builds || []).map(build => RuntimeSdk.resolveWrapperDir(userDataDir, entry.gameId, build.sdkVersion)));
  for (const child of fs.readdirSync(projects, { withFileTypes: true })) {
    const mirrorRoot = path.join(projects, child.name);
    const metadata = child.isDirectory() ? record(path.join(mirrorRoot, ".maclauncher-renpy-wrapper.json")) : null;
    let sourceRoot = path.isAbsolute(metadata?.source || "") ? metadata.source : WritableBackcompat.sourceRoot(entry);
    const view = entry.moduleData?.writableInput;
    if (path.isAbsolute(view?.root || "") && path.isAbsolute(view?.sourceRoot || "") && path.isAbsolute(sourceRoot || "")) {
      const relative = path.relative(view.root, sourceRoot);
      if (relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
        sourceRoot = path.join(view.sourceRoot, relative);
    }
    if (!path.isAbsolute(sourceRoot || "")) throw new Error("The original Ren'Py project is unavailable.");
    // Old game-only wrappers always inserted game/ beneath the project. Their
    // source directory was already named game, so map from its parent.
    if (path.basename(sourceRoot).toLowerCase() === "game" && !existsDir(path.join(sourceRoot, "game")))
      sourceRoot = path.dirname(sourceRoot);
    const retainMirror = buildWorkspaces.has(mirrorRoot);
    const generated = retainMirror ? [] : [".maclauncher-renpy-wrapper.json"];
    if (child.isDirectory()) generated.push(...provedSteamArtifacts(mirrorRoot));
    const entryPatch = restoredRecordPatch(entry, mirrorRoot, sourceRoot);
    mirrors.push({ mirrorRoot, sourceRoot, generated, ...(retainMirror ? { retainMirror: true } : {}),
      ...(Object.keys(entryPatch).length ? { entryPatch } : {}) });
  }
  return mirrors;
}

function migrateLegacyGameData(entry, { ownerSuccessfulDescriptors = [], ownerFailedDescriptors = [] } = {}) {
  if (!Array.isArray(entry.moduleData?.saveDirectories)) return null;
  const directories = entry.moduleData.saveDirectories;
  const remap = directory => {
    if (ownerFailedDescriptors.some(row => remapPath(directory, row.mirrorRoot, row.sourceRoot) !== directory)) return directory;
    return ownerSuccessfulDescriptors.reduce((value, row) => remapPath(value, row.mirrorRoot, row.sourceRoot), directory);
  };
  const saveDirectories = directories.map(row => row && remap(row.directory) !== row.directory
    ? { ...row, directory: remap(row.directory) } : row);
  if (saveDirectories.every((row, index) => row === directories[index])) return null;
  return { complete: true, entryPatch: { moduleData: { saveDirectories } } };
}

module.exports = { legacyGameMirrors, migrateLegacyGameData };
