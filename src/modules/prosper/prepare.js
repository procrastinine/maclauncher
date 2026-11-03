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
function defaultSaveDirectory(entry, environment = process.env) {
  const data = environment.XDG_DATA_HOME || (environment.HOME && path.join(environment.HOME, ".local", "share"));
  if (!/^[\w-]+$/.test(entry?.gameId || "") || !path.isAbsolute(data || ""))
    throw new Error("Prosper saves require a saved game and an absolute user data directory.");
  return path.join(data, "prosper", "games", entry.gameId);
}
function declaredTitleId(entry) {
  if (/^PPSA\d{5}$/.test(entry.moduleData?.titleId || "")) return entry.moduleData.titleId;
  const root = entry.contentRootDir || entry.gamePath;
  if (!path.isAbsolute(root || "")) return null;
  const file = path.join(root, ...(entry.moduleData?.inputLayout === "anyps5-prepared" ? ["app0"] : []), "sce_sys", "param.json");
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || !stat.size || stat.size > 128 * 1024) return null;
    const bytes = require("../anyps5/detect").readBytes(file, 0, stat.size);
    const titleId = JSON.parse(bytes.toString("utf8")).titleId;
    return /^PPSA\d{5}$/.test(titleId || "") ? titleId : null;
  } catch { return null; }
}
function resolveSaveIdentity(entry, _context = {}, environment = process.env) {
  const active = entry.runtimeId === "prosper";
  const override = (active && entry.saveDirOverride) || entry.runtimeData?.prosper?.saveDirOverride || null;
  const titleId = declaredTitleId(entry) || "_unknown-title";
  const cwd = entry.contentRootDir || entry.gamePath || process.cwd();
  const roots = saveRoots({ ...entry, saveDirOverride: override }, environment).map(root => path.join(path.resolve(cwd, root), titleId));
  return { namespace: "prosper-save-data", identity: JSON.stringify(roots), scope: "game", explicit: Boolean(override), hostSubstitution: false,
    createPatch({ entry: current }) {
      if (override) return null;
      const data = environment.XDG_DATA_HOME || (environment.HOME && path.join(environment.HOME, ".local", "share"));
      if (!path.isAbsolute(data || "")) return null;
      const saveDirOverride = defaultSaveDirectory(current, environment);
      return { runtimeData: { ...current.runtimeData, prosper: { ...current.runtimeData?.prosper, saveDirOverride } },
        ...(current.runtimeId === "prosper" ? { saveDirOverride } : {}) };
    } };
}
function saveRoots(entry, environment = process.env) {
  if (entry.saveDirOverride) {
    if (!path.isAbsolute(entry.saveDirOverride) || /[\0\r\n]/.test(entry.saveDirOverride))
      throw new Error("Prosper saves require an absolute local directory.");
    return [path.join(entry.saveDirOverride, "savedata0"), path.join(entry.saveDirOverride, "memory")];
  }
  const data = environment.XDG_DATA_HOME || (environment.HOME && path.join(environment.HOME, ".local", "share"));
  return [environment.PROSPER_SAVE0 || (data ? path.join(data, "prosper", "savedata0") : "/tmp/prosper-savedata0"),
    environment.PROSPER_SAVEDATA_DIR || (data ? path.join(data, "prosper", "savedata-mem") : "/tmp/prosper-savedata-mem")];
}
function resolveSaveLocations(entry, _context, environment = process.env) {
  const roots = saveRoots(entry, environment);
  return { primaryDirectory: roots[0], directories: roots.map((directory, index) => ({ directory,
    role: index ? "alternate" : "primary", source: index ? "Prosper save-data memory" : "Prosper save data", confidence: "declared" })) };
}
function acceptsOriginalExecutable(executable) {
  const name = path.basename(executable || "").toLowerCase();
  return name === "eboot.bin" || name.endsWith(".elf");
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
  throwIfAborted(context.signal);
  const program = resolveProgram(entry), root = gameDirectory(entry, context);
  const environment = { PROSPER_GUEST_FS: "1" };
  const configPath = context.runtimeSettings?.configPath || entry.runtimeSettings?.prosper?.configPath;
  if (configPath) {
    if (!path.isAbsolute(configPath) || /[\0\r\n]/.test(configPath)) throw new Error("Prosper configuration must be an absolute local file path.");
    environment.PROSPER_APP_CONFIG = configPath;
  }
  if (entry.saveDirOverride) {
    const [saves, memory] = saveRoots(entry);
    environment.PROSPER_SAVE0 = saves; environment.PROSPER_SAVEDATA_DIR = memory;
  }
  if (program.programRoot === program.assetRoot && acceptsOriginalExecutable(program.executablePath)) return { root, dump: program.assetRoot, cwd: program.sourceRoot,
    executable: "/app0/" + path.relative(program.assetRoot, fs.realpathSync(program.executablePath)).split(path.sep).join("/"), environment };
  // Split AnyPS5 inputs need their programs merged with assets. A SELF with
  // another filename needs the upstream-required eboot.bin alias as well.
  const dump = path.join(root, "app0");
  outside(program.sourceRoot, root);
  Writable.assertOwnDirectory(context.userDataDir, root);
  Writable.assertOwnDirectory(root, dump);
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
  return { root, dump, cwd: program.sourceRoot, executable: "/app0/" + executable, environment };
}
module.exports = { gameDirectory, defaultSaveDirectory, declaredTitleId, resolveSaveIdentity, resolveSaveLocations, acceptsOriginalExecutable, prepareGame };
