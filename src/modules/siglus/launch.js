const fs = require("node:fs");
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
  const destination = path.join(directory, "project");
  fs.mkdirSync(destination, { recursive: true });
  const skip = new Set(["key.toml", "savedata", "savedata_rs", ".ds_store"]);
  const sourceNames = new Set();
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
    fs.copyFileSync(file, keyPath); fs.chmodSync(keyPath, 0o600);
  }
  if (stringEncryption !== "automatic") {
    let text = fs.existsSync(keyPath) ? fs.readFileSync(keyPath, "utf8") : "";
    if (Buffer.byteLength(text) > 65536 || fs.lstatSync(keyPath, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Private Siglus key configuration is invalid.");
    text = text.replace(/^\s*override_string_encryption\s*=.*\r?\n?/gm, "").replace(/\s*$/, "") + `\noverride_string_encryption = "${stringEncryption}"\n`;
    const temporary = keyPath + `.tmp-${crypto.randomUUID()}`;
    try { fs.writeFileSync(temporary, text, { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, keyPath); } finally { fs.rmSync(temporary, { force: true }); }
  }
  return destination;
}

function prepareLaunch(entry, context, install) {
  const info = inspectEntry(entry), original = path.resolve(entry.contentRootDir || entry.gamePath), directory = moduleRoot(entry, context), settings = context.runtimeSettings || {};
  fs.mkdirSync(directory, { recursive: true });
  const encoding = settings.encoding || "auto";
  if (!ENCODINGS.has(encoding)) throw new Error("Choose a supported text encoding.");
  const root = info.engineKind === "siglus" ? privateProject(original, directory, settings) : original;
  const saves = entry.saveDirOverride || (info.engineKind === "siglus" ? path.join(root, "savedata") : path.join(directory, "saves"));
  if (!path.isAbsolute(saves)) throw new Error("Save directory must be absolute.");
  fs.mkdirSync(saves, { recursive: true });
  if (info.engineKind === "siglus" && entry.saveDirOverride) {
    const link = path.join(root, "savedata");
    const prior = fs.lstatSync(link, { throwIfNoEntry: false });
    if (prior && !prior.isSymbolicLink()) throw new Error("Move the existing private Siglus saves before changing their directory.");
    if (prior) fs.unlinkSync(link);
    fs.symlinkSync(saves, link);
  }
  entry.defaultSaveDir = saves;
  entry.moduleData = { ...entry.moduleData, ...info };
  return { root, original, directory, saves, info,
    args: ["--run", install.libraryPath, root, ...(info.engineKind === "siglus" ? [] : [encoding])],
    env: { ...process.env, REALLIVE_SAVE_DIR: saves, AVG32_SAVE_DIR: saves, SIGLUS_CACHE_DIR: path.join(directory, "cache") } };
}
function resolveSaveLocations(entry, context) {
  const directory = moduleRoot(entry, context), info = entry.moduleData || {};
  const saves = entry.saveDirOverride || (info.engineKind === "siglus" ? path.join(directory, "project", "savedata") : path.join(directory, "saves"));
  let exists = false;
  try { exists = fs.statSync(saves).isDirectory(); } catch {}
  return { primaryDirectory: saves, directories: [{ directory: saves, exists, source: "Native interpreter private saves", confidence: "exact", label: "Saves" }] };
}
module.exports = { moduleRoot, inspectEntry, privateProject, prepareLaunch, resolveSaveLocations, ENCODINGS };
