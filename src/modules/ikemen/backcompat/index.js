// MacLauncher 0.5.1 private game/save layouts. Runs once through persisted data
// migration after original-path restoration, never on import or Play. Remove
// after support for upgrading those released layouts is explicitly retired.
const fs = require("node:fs");
const path = require("node:path");
const GameData = require("../../shared/game-data");
const Writable = require("../../shared/backcompat/writable-input");
const manager = require("../runtime/manager");
const { originalSaveDirectory } = require("../original-paths");
const { selectRuntimeVersion } = require("../../shared/runtime/version-choices");
const crypto = require("node:crypto");

function gameDirectory(entry, { userDataDir }) {
  return GameData.resolveGameModuleDir(userDataDir, entry.gameId, "ikemen");
}
function directOriginalRoot(entry, { userDataDir, settings }) {
  if (!selectRuntimeVersion({ manual: entry.runtimeData?.ikemen?.version }).version) return null;
  const original = Writable.sourceEntry(entry), sourceRoot = original.contentRootDir || original.gamePath;
  const profile = path.resolve(userDataDir);
  if (!path.isAbsolute(sourceRoot || "") || path.resolve(sourceRoot) === profile || path.resolve(sourceRoot).startsWith(profile + path.sep)) return null;
  const selection = manager.resolveSelection(original, settings, userDataDir, { verification: "status" });
  return selection.ready && originalSaveDirectory(original, selection.install) ? sourceRoot : null;
}
function legacyGameMirrors(entry, { userDataDir, settings }) {
  if (!path.isAbsolute(userDataDir || "") || !entry.gameId || !/^[A-Za-z0-9_-]+$/.test(entry.gameId)) return [];
  const override = path.isAbsolute(entry.saveDirOverride || "") ? path.resolve(entry.saveDirOverride) : null;
  const inactive = ({ mirrorRoot }) => !override || !(override === mirrorRoot || override.startsWith(mirrorRoot + path.sep) || mirrorRoot.startsWith(override + path.sep));
  const mirrors = (entry.moduleData?.writableInput?.schemaVersion === 1 ? Writable.legacyGameMirrors(entry, { userDataDir }) : []).filter(inactive);
  // The one-time hook has no global runtime settings. Only an explicit game
  // choice proves that the separate-runtime adaptation is no longer live.
  const sourceRoot = directOriginalRoot(entry, { userDataDir, settings });
  if (!sourceRoot) return mirrors;
  const directory = gameDirectory(entry, { userDataDir });
  return [...mirrors, { mirrorRoot: path.join(directory, "game"), sourceRoot },
    { mirrorRoot: path.join(directory, "saves"), sourceRoot: path.join(sourceRoot, "save"), createSourceWithin: sourceRoot }].filter(inactive);
}

// Convert only the released receipt format. Existing engine files, resource
// copies, aliases and player state are not rewritten or minimized here.
function migrateLegacyGameData(entry, { userDataDir, settings }) {
  try {
    if (!path.isAbsolute(userDataDir || "") || !/^[A-Za-z0-9_-]+$/.test(entry.gameId || "")) throw Error("The Ikemen GO game data from an earlier MacLauncher version could not be located, so it was left unchanged. Copy any needed files from this folder before removing the game.");
    // Successful retirement already restored the direct distribution. Its old
    // preparation receipt is not used by current Play and needs no conversion.
    const direct = directOriginalRoot(entry, { userDataDir, settings });
    if (direct) return {complete:true};
    const directory = gameDirectory(entry, { userDataDir }), file = path.join(directory, "staged-runtime.json");
    let stat;try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return {complete:true};throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw Error("The Ikemen GO preparation record from an earlier MacLauncher version is not an ordinary file, so the game's data was left unchanged. Copy any needed files from this folder before removing the game.");
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (record?.layoutVersion === 6) return {complete:true};
    if (![4,5].includes(record?.layoutVersion)) throw Error("The Ikemen GO preparation record from an earlier MacLauncher version has an unknown format, so the game's data was left unchanged. Copy any needed files from this folder before removing the game.");
    const relative = value => typeof value === "string" && value.length > 0 && value.length <= 4096 && !path.isAbsolute(value) &&
      !/[\0\r\n:]/.test(value) && value.split(/[\\/]/).every(part => part && part !== "." && part !== "..");
    const original = Writable.sourceEntry(entry), root = original.contentRootDir || original.gamePath;
    if (typeof record.version !== "string" || !record.version || record.version.length > 256 || /[\0\r\n]/.test(record.version) ||
        !/^[a-f0-9]{64}$/.test(record.binarySha256 || "") || !path.isAbsolute(record.gameRoot || "") || !path.isAbsolute(root || "") ||
        path.resolve(record.gameRoot) !== path.resolve(root) || !relative(record.executableRelative)) throw Error("The Ikemen GO preparation record from an earlier MacLauncher version does not match this game, so the game's data was left unchanged. Copy any needed files from this folder before removing the game.");
    const repairs = record.assetRepairs || [];
    if (!Array.isArray(repairs) || repairs.length > 4096 || repairs.some(row => !relative(row?.reference) || !relative(row?.asset)))
      throw Error("The Ikemen GO preparation record from an earlier MacLauncher version lists invalid resource aliases, so the game's data was left unchanged. Copy any needed files from this folder before removing the game.");
    const executable = path.join(directory, "game", record.executableRelative);
    let parent = path.parse(path.resolve(userDataDir)).root;
    for (const part of path.dirname(executable).split(path.sep).filter(Boolean)) {
      parent = path.join(parent, part);const info = fs.lstatSync(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) throw Error("The path to the Ikemen GO engine that an earlier MacLauncher version prepared contains a symbolic link, so the game's data was left unchanged. Copy any needed files from this folder before removing the game.");
    }
    const before = fs.lstatSync(executable);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 512 * 1024 * 1024) throw Error("The Ikemen GO engine that an earlier MacLauncher version prepared is not an ordinary file, so the game's data was left unchanged. Copy any needed files from this folder before removing the game.");
    const digest = crypto.createHash("sha256").update(fs.readFileSync(executable)).digest("hex"), after = fs.lstatSync(executable);
    if (digest !== record.binarySha256 || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw Error("The Ikemen GO engine that an earlier MacLauncher version prepared has changed since then, so the game's data was left unchanged. Copy any needed files from this folder before removing the game.");
    const temporary = path.join(directory, ".staged-runtime-" + crypto.randomUUID() + ".tmp");
    try {
      const current = fs.lstatSync(file);
      if (current.ino !== stat.ino || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs)
        throw Error("The Ikemen GO preparation record changed while it was being updated, so the game's data was left unchanged. Copy any needed files from this folder before removing the game.");
      fs.writeFileSync(temporary, JSON.stringify({...record, layoutVersion:6, assetRepairs:repairs}), {flag:"wx",mode:0o600});
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, {force:true}); }
    return {complete:true, converted:true};
  } catch (error) { return {complete:false,reason:error.message}; }
}

module.exports = { legacyGameMirrors, migrateLegacyGameData };
