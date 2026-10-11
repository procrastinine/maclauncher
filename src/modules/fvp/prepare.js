const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const GameData = require("../shared/game-data");
const Writable = require("../shared/writable-input");
const Inspect = require("./inspect");
const inside = (root, file) => { const relative = path.relative(root, file); return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative); };
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
function directoryFor(entry, context) {
  if (!/^[A-Za-z0-9_-]+$/.test(entry.gameId || "") || !path.isAbsolute(context.userDataDir || "")) throw new Error("FVP requires a saved game entry and launcher data directory.");
  return GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "fvp");
}
function saveDirectory(entry, context) {
  const directory = entry.saveDirOverride || path.join(directoryFor(entry, context), "saves");
  if (!path.isAbsolute(directory) || /[\0\r\n]/.test(directory)) throw new Error("FVP save location must be an absolute local directory.");
  return path.resolve(directory);
}
function gameData(entry, context = {}, { refresh = false } = {}) {
  context.signal?.throwIfAborted();
  const root = entry.contentRootDir || entry.gamePath;
  if (!path.isAbsolute(root || "") || !fs.statSync(root).isDirectory()) throw new Error("FVP game data directory is missing.");
  const previous = entry.moduleData;
  const encoding = context.runtimeSettings?.textEncoding || "sjis";
  if (!["sjis", "gbk", "utf8"].includes(encoding)) throw new Error("Choose a supported FVP text encoding.");
  let reusable = !refresh && previous?.format === "FAVORITE / FVP" && previous.textEncoding === encoding && previous.sourceRootIdentity === identity(fs.statSync(root));
  if (reusable) {
    for (const [file, expected] of [[previous.scriptPath, previous.scriptIdentity], ...(previous.archives || []).map(archive => [archive.path, archive.identity])]) {
      if (!path.isAbsolute(file || "") || path.dirname(file) !== root) { reusable = false; break; }
      try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || identity(stat) !== expected) reusable = false; }
      catch (error) { if (error.code !== "ENOENT") throw error; reusable = false; }
    }
  }
  const data = reusable ? previous : Inspect.inspectGame(root, { inputPath: previous?.selectedScriptPath, textEncoding: encoding });
  if (!data) throw new Error("The FVP HCB script is missing, ambiguous or invalid.");
  entry.moduleData = { ...previous, ...data, sourceRootIdentity: identity(fs.statSync(root)) };
  return { root: path.resolve(root), data: entry.moduleData };
}
function assertOutsideOriginal(root, destination) {
  const original = fs.realpathSync(root);
  let existing = destination, suffix = [];
  while (!fs.existsSync(existing)) { suffix.unshift(path.basename(existing)); existing = path.dirname(existing); }
  if (inside(original, path.join(fs.realpathSync(existing), ...suffix))) throw new Error("FVP writable data must be outside the original game directory.");
}
function readReceipt(file) {
  try {
    const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) return null;
    const result = JSON.parse(fs.readFileSync(file, "utf8")); return result.schema === 1 ? result : null;
  } catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return null; throw error; }
}
function prepareLaunch(entry, context) {
  const { root, data } = gameData(entry, context), directory = directoryFor(entry, context), saveRoot = saveDirectory(entry, context);
  const gameDirectory = GameData.resolveGameDir(context.userDataDir, entry.gameId), playRoot = path.join(directory, "play"), receiptFile = path.join(directory, "preparation.json");
  assertOutsideOriginal(root, directory); assertOutsideOriginal(root, saveRoot);
  Writable.assertOwnDirectory(context.userDataDir, directory);
  // Explicit custom save folders are allowed, but never aliases back into source data.
  const saveStat = (() => { try { return fs.lstatSync(saveRoot); } catch (error) { if (error.code === "ENOENT") return null; throw error; } })();
  if (saveStat && (!saveStat.isDirectory() || saveStat.isSymbolicLink())) throw new Error("FVP save location must be a real directory.");
  fs.mkdirSync(saveRoot, { recursive: true, mode: 0o700 });
  const previous = readReceipt(receiptFile), scriptKind = /\.bch$/i.test(data.scriptName) ? "bch" : "hcb";
  const key = JSON.stringify([root, data.scriptPath, scriptKind, saveRoot]);
  let ready = previous?.key === key && fs.existsSync(playRoot) && fs.lstatSync(playRoot).isDirectory() && !fs.lstatSync(playRoot).isSymbolicLink();
  if (ready) {
    for (const folder of previous.directories || []) {
      context.signal?.throwIfAborted();
      if (!inside(root, folder.path)) { ready = false; break; }
      try { if (identity(fs.statSync(folder.path)) !== folder.identity) ready = false; }
      catch (error) { if (error.code !== "ENOENT") throw error; ready = false; }
    }
    const saveLink = path.join(playRoot, "save");
    try { if (!fs.lstatSync(saveLink).isSymbolicLink() || fs.readlinkSync(saveLink) !== saveRoot) ready = false; }
    catch (error) { if (error.code !== "ENOENT") throw error; ready = false; }
  }
  if (!ready) {
    const staging = fs.mkdtempSync(path.join(directory, ".play-")), directories = [], links = [];
    let count = 0;
    const visit = (source, destination, depth = 0) => {
      context.signal?.throwIfAborted();
      if (depth > 24) throw new Error("FVP asset folders exceed the preparation depth limit.");
      directories.push({ path: source, identity: identity(fs.statSync(source)) });
      const names = new Set();
      for (const item of fs.readdirSync(source, { withFileTypes: true })) {
        context.signal?.throwIfAborted();
        if (++count > 100000) throw new Error("FVP game files exceed the preparation limit.");
        if (item.name.toLowerCase() === ".ds_store" || depth === 0 && item.name.toLowerCase() === "save") continue;
        const from = path.join(source, item.name), script = depth === 0 && /\.(?:hcb|bch)$/i.test(item.name);
        if (script && from !== data.scriptPath) continue;
        const name = script ? `game.${scriptKind}` : depth === 0 && /\.bin$/i.test(item.name) ? item.name.toLowerCase() : item.name;
        const folded = name.normalize("NFC").toLowerCase();
        if (names.has(folded)) throw new Error("FVP game files contain ambiguous names."); names.add(folded);
        const to = path.join(destination, name);
        if (item.isSymbolicLink()) throw new Error("FVP game assets must not contain file aliases.");
        if (item.isDirectory()) { fs.mkdirSync(to, { mode: 0o700 }); visit(from, to, depth + 1); }
        else if (item.isFile()) { fs.symlinkSync(from, to, "file"); links.push(path.relative(staging, to)); }
        else throw new Error("FVP game assets must be regular files and folders.");
      }
    };
    const backup = path.join(directory, `.previous-${crypto.randomUUID()}`);
    let replaced = false;
    try {
      visit(root, staging);
      fs.symlinkSync(saveRoot, path.join(staging, "save"), "dir");
      context.signal?.throwIfAborted();
      if (fs.existsSync(playRoot)) { if (!fs.lstatSync(playRoot).isDirectory() || fs.lstatSync(playRoot).isSymbolicLink()) throw new Error("FVP private launch folder is invalid."); fs.renameSync(playRoot, backup); replaced = true; }
      try {
        fs.renameSync(staging, playRoot);
        Writable.atomicWrite(receiptFile, JSON.stringify({ schema: 1, key, root, playRoot, saveRoot, directories, links }) + "\n", { root: gameDirectory });
      } catch (error) {
        fs.rmSync(playRoot, { recursive: true, force: true });
        if (replaced) fs.renameSync(backup, playRoot);
        throw error;
      }
    } finally { fs.rmSync(staging, { recursive: true, force: true }); fs.rmSync(backup, { recursive: true, force: true }); }
  }
  const settings = context.runtimeSettings || {}, textEncoding = settings.textEncoding || "sjis";
  if (!["sjis", "gbk", "utf8"].includes(textEncoding)) throw new Error("Choose a supported FVP text encoding.");
  const env = { ...process.env, FVP_BASE_PATH: playRoot, FVP_HCB_ROOT: playRoot, RFVP_DUMP_DIR: path.join(directory, "frames") };
  for (const name of ["FVP_TEST", "FVP_TESTCASE", "RFVP_DUMP_FRAMES", "DEBUG"]) delete env[name];
  entry.defaultSaveDir = saveRoot;
  entry.moduleData = { ...entry.moduleData, preparationDirectory: playRoot, activeTextEncoding: textEncoding };
  return { directory, root, playRoot, saveRoot, textEncoding, textHiDpi: settings.textHiDpi !== false, env };
}
module.exports = { directoryFor, saveDirectory, gameData, prepareLaunch };
