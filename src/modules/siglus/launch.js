const fs = require("node:fs");
const { cloneOrCopySync } = require("../shared/copy-file");
const path = require("node:path");
const crypto = require("node:crypto");
const GameData = require("../shared/game-data");
const Detect = require("./detect");

const ENCODINGS = new Set(["auto", "sjis", "gbk", "big5", "utf8", "western", "korean"]);
function moduleRoot(entry, context) {
  if (!/^[A-Za-z0-9_-]+$/.test(entry.gameId || "")) throw new Error("Import the game into the library first.");
  return GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "siglus");
}
function inspectEntry(entry) {
  const info = Detect.inspectGame(entry.contentRootDir || entry.gamePath, { inputPath: entry.moduleData?.originalRunnerPath });
  if (!info) throw new Error("RealLive / Siglus script data was not found.");
  if (!info.interpreterSupported) throw new Error(`${info.engineLabel} script version ${info.compilerVersion || info.headerSize} needs a compatible native interpreter.`);
  return info;
}
function privateProject(root, directory, { stringEncryption = "automatic" } = {}) {
  root = path.resolve(root);
  if (!["automatic", "xor", "none", "mdl"].includes(stringEncryption)) throw new Error("Choose a supported string decoding mode.");
  const destination = path.join(directory, "configured-project", stringEncryption);
  fs.mkdirSync(destination, { recursive: true });
  const skip = new Set(["key.toml", "savedata", "savedata_rs", ".ds_store"]);
  const sourceNames = new Set(["savedata"]);
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    if (skip.has(item.name.toLowerCase())) continue;
    const source = path.join(root, item.name), target = path.join(destination, item.name);
    if (!fs.realpathSync(source).startsWith(fs.realpathSync(root) + path.sep)) throw new Error("A Siglus resource points outside the original game.");
    sourceNames.add(item.name);
    let existing; try { existing = fs.lstatSync(target); } catch {}
    if (existing && (!existing.isSymbolicLink() || fs.readlinkSync(target) !== source)) throw new Error("A private Siglus asset link has changed.");
    if (!existing) fs.symlinkSync(source, target);
  }
  for (const item of fs.readdirSync(destination, { withFileTypes: true })) {
    if (item.isSymbolicLink() && !sourceNames.has(item.name)) fs.unlinkSync(path.join(destination, item.name));
  }
  const keyPath = path.join(destination, "key.toml"), original = fs.readdirSync(root).find(name => name.toLowerCase() === "key.toml");
  if (!fs.existsSync(keyPath) && original) {
    const file = path.join(root, original);
    if (fs.statSync(file).size > 65536 || fs.lstatSync(file).isSymbolicLink()) throw new Error("The original Siglus key configuration cannot be imported safely.");
    cloneOrCopySync(file, keyPath); fs.chmodSync(keyPath, 0o600);
  }
  if (stringEncryption !== "automatic") {
    let text = fs.existsSync(keyPath) ? fs.readFileSync(keyPath, "utf8") : "";
    const previous = text;
    if (Buffer.byteLength(text) > 65536 || fs.lstatSync(keyPath, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Private Siglus key configuration is invalid.");
    text = text.replace(/^\s*override_string_encryption\s*=.*\r?\n?/gm, "").replace(/\s*$/, "") + `\noverride_string_encryption = "${stringEncryption}"\n`;
    if (text !== previous) {
      const temporary = keyPath + `.tmp-${crypto.randomUUID()}`;
      try { fs.writeFileSync(temporary, text, { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, keyPath); } finally { fs.rmSync(temporary, { force: true }); }
    }
  }
  return destination;
}

function saveDirectory(entry, info = entry.moduleData || {}) {
  const original = path.resolve(entry.contentRootDir || entry.gamePath);
  if (entry.saveDirOverride) return entry.saveDirOverride;
  if (info.engineKind === "reallive") return process.env.REALLIVE_SAVE_DIR || path.join(original, "savedata_rs");
  if (info.engineKind === "avg32") return process.env.AVG32_SAVE_DIR || original;
  return path.join(original, "savedata");
}
function prepareLaunch(entry, context, install) {
  const info = inspectEntry(entry), original = path.resolve(entry.contentRootDir || entry.gamePath), directory = moduleRoot(entry, context), settings = context.runtimeSettings || {};
  fs.mkdirSync(directory, { recursive: true });
  const encoding = settings.encoding || "auto";
  if (!ENCODINGS.has(encoding)) throw new Error("Choose a supported text encoding.");
  const stringEncryption = settings.stringEncryption || "automatic";
  if (!["automatic", "xor", "none", "mdl"].includes(stringEncryption)) throw new Error("Choose a supported string decoding mode.");
  // Siglus exposes key/save overrides through the project layout only. The
  // ordinary automatic launch needs neither an adapter tree nor private saves.
  const adapted = info.engineKind === "siglus" && (stringEncryption !== "automatic" || entry.saveDirOverride);
  const root = adapted ? privateProject(original, directory, settings) : original;
  const saves = saveDirectory(entry, info);
  if (!path.isAbsolute(saves)) throw new Error("Save directory must be absolute.");
  if (adapted) {
    fs.mkdirSync(saves, { recursive: true });
    const link = path.join(root, "savedata");
    const prior = fs.lstatSync(link, { throwIfNoEntry: false });
    if (prior && !prior.isSymbolicLink()) throw new Error("Move the existing private Siglus saves before changing their directory.");
    const matches = prior && fs.readlinkSync(link) === saves;
    if (prior && !matches) fs.unlinkSync(link);
    if (!matches) fs.symlinkSync(saves, link);
  }
  entry.defaultSaveDir = saves;
  entry.moduleData = { ...entry.moduleData, ...info };
  const env = { ...process.env, SIGLUS_CACHE_DIR: path.join(directory, "cache") };
  if (entry.saveDirOverride && info.engineKind === "reallive") env.REALLIVE_SAVE_DIR = saves;
  if (entry.saveDirOverride && info.engineKind === "avg32") env.AVG32_SAVE_DIR = saves;
  return { root, original, directory: original, saves, info,
    args: ["--run", install.libraryPath, root, ...(info.engineKind === "siglus" ? [] : [encoding])],
    env };
}
function resolveSaveLocations(entry, context) {
  const saves = saveDirectory(entry);
  let exists = false;
  try { exists = fs.statSync(saves).isDirectory(); } catch {}
  return { primaryDirectory: saves, directories: [{ directory: saves, exists, source: "Native interpreter saves", confidence: "exact", label: "Saves" }] };
}
module.exports = { moduleRoot, inspectEntry, privateProject, prepareLaunch, resolveSaveLocations, saveDirectory, ENCODINGS };
