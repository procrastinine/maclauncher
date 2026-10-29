const fs = require("node:fs");
const path = require("node:path");
const GameData = require("../shared/game-data");
const Writable = require("../shared/writable-input");
const { throwIfAborted } = require("../shared/runtime/download-utils");
const { resolveProgram, sourceFiles, isGuestModule } = require("../anyps5/prepare");

function gameDirectory(entry, context) {
  if (!/^[\w-]+$/.test(entry?.gameId || "") || !path.isAbsolute(context?.userDataDir || ""))
    throw new Error("Prosper requires a PS5 game in the library.");
  return GameData.resolveGameRuntimeDir(context.userDataDir, entry.gameId, "prosper");
}
function resolveSaveLocations(entry, context) {
  const root = entry.saveDirOverride || path.join(gameDirectory(entry, context), "saves");
  return { primaryDirectory: root, directories: [{ directory: root, role: "primary", source: "Prosper save data", confidence: "declared" }] };
}
function outside(source, output) {
  let parent = output;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const prospective = path.join(fs.realpathSync(parent), path.relative(parent, output));
  const relative = path.relative(source, prospective);
  if (!relative || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
    throw new Error("Prosper game data must stay outside the original game folder.");
}
async function prepareGame(entry, context) {
  const program = resolveProgram(entry), root = gameDirectory(entry, context), dump = path.join(root, "app0");
  outside(program.sourceRoot, root);
  Writable.assertOwnDirectory(context.userDataDir, root);
  for (const name of ["app0", "home", "tmp", "captures", "cache"]) Writable.assertOwnDirectory(root, path.join(root, name));
  const saves = resolveSaveLocations(entry, context).primaryDirectory;
  if (!path.isAbsolute(saves) || /[\0\r\n]/.test(saves)) throw new Error("Prosper saves require an absolute local directory.");
  outside(program.sourceRoot, saves); fs.mkdirSync(saves, { recursive: true });
  const downloads = path.join(saves, "download0");
  Writable.assertOwnDirectory(saves, downloads);
  const assets = await sourceFiles(program.assetRoot, context);
  const modules = program.programRoot === program.assetRoot ? assets : await sourceFiles(program.programRoot, context);
  const files = new Map(assets.filter(file => !file.name.endsWith(".guest.prx")).map(file => [file.name, file]));
  for (const file of modules.filter(isGuestModule)) files.set(file.name, file);
  const executable = program.format === "self" ? "eboot.bin" : "eboot.elf";
  const programStat = fs.statSync(program.executablePath);
  files.set(executable, { name: executable, full: program.executablePath, stamp: `${program.bytes}:${programStat.mtimeMs}:${programStat.ctimeMs}` });
  let previous = {};
  try { const receipt = JSON.parse(fs.readFileSync(path.join(root, "input.json"), "utf8")); if (receipt.schemaVersion === 1 && receipt.source === program.sourceRoot) previous = receipt.files; } catch {}
  const current = {}; let completed = 0;
  for (const file of files.values()) {
    throwIfAborted(context.signal);
    const destination = path.join(dump, file.name), stamp = previous?.[file.name];
    Writable.assertOwnDirectory(root, path.dirname(destination));
    let existing; try { existing = fs.lstatSync(destination); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Prosper's staged files must not be aliases.");
    if (stamp !== file.stamp || !existing) Writable.atomicCopy(file.full, destination, { root });
    current[file.name] = file.stamp;
    if (++completed % 128 === 0) { context.onProgress?.({ phase: "prepare", completed, label: "Preparing PS5 files…" }); await new Promise(resolve => setImmediate(resolve)); }
  }
  for (const name of Object.keys(previous || {})) if (!Object.hasOwn(current, name)) {
    const relative = path.relative(dump, path.resolve(dump, name));
    if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("Prosper's staged input record has an invalid path.");
    fs.rmSync(path.join(dump, name), { force: true });
  }
  Writable.atomicWrite(path.join(root, "input.json"), JSON.stringify({ schemaVersion: 1, source: program.sourceRoot, files: current }) + "\n", { root });
  return { root, dump, executable: "/app0/" + executable, saves, environment: {
    PROSPER_GUEST_FS: "1", PROSPER_SAVE0: path.join(saves, "savedata0"), PROSPER_SAVEDATA_DIR: path.join(saves, "memory"),
    PROSPER_TEMP0: path.join(root, "tmp"), PROSPER_DOWNLOAD0: downloads,
    PROSPER_CAPTURE_DIR: path.join(root, "captures"), HOME: path.join(root, "home"), CFFIXED_USER_HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "home", ".config"), XDG_DATA_HOME: path.join(root, "home", ".local", "share"),
    XDG_CACHE_HOME: path.join(root, "cache"), TMPDIR: path.join(root, "tmp") + path.sep
  } };
}
module.exports = { gameDirectory, resolveSaveLocations, prepareGame };
