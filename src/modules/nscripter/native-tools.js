const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const GameData = require("../shared/game-data");

const SCRIPT_NAMES = ["0.txt", "00.txt", "0.utf", "0.utf.txt", "00.utf", "00.utf.txt", "nscr_sec.dat", "nscript.___", "nscript.dat", "pscript.dat"];
const MAX_SCRIPT_BYTES = 32 * 1024 * 1024;
const MAX_KEY_EXE_BYTES = 64 * 1024 * 1024;
const SAVE_FILE = /^(?:envdata|gloval\.sav|global\.sav|kidoku\.dat|nscr[fl]log\.dat|save\d+\.(?:dat|sav))$/i;
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function moduleRoot(entry, context) {
  if (!path.isAbsolute(context?.userDataDir || "") || !/^[A-Za-z0-9_-]{1,128}$/.test(entry?.gameId || "")) {
    throw new Error("NScripter requires a persisted game id and an absolute launcher data directory.");
  }
  return GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "nscripter");
}
function scriptInfo(root) {
  for (const name of SCRIPT_NAMES) {
    const file = path.join(root, name);
    try { if (fs.statSync(file).isFile()) return { file, name, declaredUtf8: /\.utf(?:\.txt)?$/.test(name) || name === "pscript.dat" }; } catch {}
  }
  return null;
}
function resolveKeyExecutable(root, entry = {}) {
  if (scriptInfo(root)?.name !== "nscript.___") return null;
  function executable(file) {
    if (typeof file !== "string" || !path.isAbsolute(file) || path.extname(file).toLowerCase() !== ".exe") return false;
    try { const stat = fs.statSync(file); return stat.isFile() && stat.size >= 2 && stat.size <= MAX_KEY_EXE_BYTES; } catch { return false; }
  }
  for (const file of [entry.importPath, entry.moduleData?.packagedPath, entry.gamePath]) if (executable(file)) return file;
  const candidates = fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isFile() && /\.exe$/i.test(item.name))
    .map(item => path.join(root, item.name)).filter(executable);
  const named = candidates.filter(file => /^(?:nscr|onscripter)\.exe$/i.test(path.basename(file)));
  if (named.length === 1) return named[0];
  if (candidates.length === 1) return candidates[0];
  throw new Error("This encrypted NScripter script needs its original Windows executable. Add that .exe to select its key table.");
}
function readKeyTable(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_KEY_EXE_BYTES) throw new Error("NScripter key executable exceeds the 64 MB limit.");
  const bytes = fs.readFileSync(file);
  if (bytes.length < 258 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error("NScripter key data must come from an original Windows executable.");
  // Upstream ScriptParser::createKeyTable uses the first consecutive run of
  // every byte value once. Track last positions to find that same permutation
  // in O(n), rather than comparing a 256-byte ring for every input byte.
  const last = new Int32Array(256).fill(-1);
  let start = 0;
  for (let index = 0; index < bytes.length; index++) {
    const value = bytes[index];
    start = Math.max(start, last[value] + 1); last[value] = index;
    if (index - start + 1 !== 256) continue;
    const table = new Uint8Array(256);
    for (let offset = 0; offset < 256; offset++) table[bytes[start + offset]] = offset;
    return { table, originalPath: file, originalSha256: sha256(bytes), tableOffset: start };
  }
  throw new Error("The original executable has no supported NScripter key table.");
}
function readScript(root, entry = {}) {
  const source = scriptInfo(root);
  if (!source) {
    throw new Error("A supported NScripter source script was not found.");
  }
  const size = fs.statSync(source.file).size;
  if (size > MAX_SCRIPT_BYTES) throw new Error("NScripter script exceeds the 32 MB export limit.");
  const original = fs.readFileSync(source.file), bytes = Buffer.from(original);
  const mode = source.name === "nscript.___" ? "exe-key-table" : source.name === "nscr_sec.dat" ? "nscr-sec" : /^(?:nscript|pscript)\.dat$/.test(source.name) ? "xor-84" : "plain";
  let keyExecutable = null;
  if (mode === "xor-84") for (let i = 0; i < bytes.length; i++) bytes[i] ^= 0x84;
  if (mode === "nscr-sec") {
    const magic = [0x79, 0x57, 0x0d, 0x80, 0x04];
    for (let i = 0; i < bytes.length; i++) bytes[i] ^= magic[i % magic.length];
  }
  if (mode === "exe-key-table") {
    const key = readKeyTable(resolveKeyExecutable(root, entry));
    for (let index = 0; index < bytes.length; index++) bytes[index] = key.table[bytes[index]] ^ 0x84;
    keyExecutable = { originalPath: key.originalPath, originalSha256: key.originalSha256, tableOffset: key.tableOffset };
  }
  return { ...source, mode, originalSha256: sha256(original), bytes, keyExecutable };
}
function resolveTextMode(root, settings = {}) {
  const selected = settings.textMode || "auto";
  if (!["auto", "english", "japanese"].includes(selected)) throw new Error("Choose a supported ONScripter-EN text mode.");
  // Match upstream's declared UTF filenames. Legacy scripts retain the
  // Japanese/Shift-JIS mode; their own backtick/english commands still apply.
  return selected === "auto" ? scriptInfo(root)?.declaredUtf8 ? "english" : "japanese" : selected;
}
function prepareNativeSaves(entry, context, gameRoot) {
  const defaultSaveDir = path.join(moduleRoot(entry, context), "saves");
  const override = entry.saveDirOverride;
  if (override !== null && override !== undefined && override !== "" && (typeof override !== "string" || !path.isAbsolute(override))) {
    throw new Error("NScripter save directory override must be an absolute directory path.");
  }
  const saveDir = override || defaultSaveDir;
  fs.mkdirSync(saveDir, { recursive: true });
  if (!fs.statSync(saveDir).isDirectory()) throw new Error("NScripter save location is not a directory.");
  // Reuse existing Windows/native saves without modifying their originals.
  // Only known small save files are imported; script/archive assets stay put.
  if (!override && gameRoot) {
    let total = 0, count = 0;
    for (const name of fs.readdirSync(gameRoot)) {
      if (!SAVE_FILE.test(name) || fs.existsSync(path.join(saveDir, name))) continue;
      const file = path.join(gameRoot, name), stat = fs.lstatSync(file);
      if (!stat.isFile()) continue;
      if (++count > 64 || stat.size > 16 * 1024 * 1024 || (total += stat.size) > 64 * 1024 * 1024) throw new Error("Original NScripter saves exceed the import size limit.");
      fs.copyFileSync(file, path.join(saveDir, name), fs.constants.COPYFILE_EXCL);
    }
  }
  entry.defaultSaveDir = defaultSaveDir;
  return { saveDir, defaultSaveDir };
}
function prepareConfig(gameRoot, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const from = path.join(gameRoot, "ons.cfg"), to = path.join(directory, "ons.cfg");
  if (!fs.existsSync(from)) return;
  const stat = fs.lstatSync(from);
  if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("NScripter configuration is not a supported regular file.");
  fs.copyFileSync(from, to);
}
function exportScript(entry, context, root, payload = {}) {
  const source = readScript(root, entry), selected = payload.encoding || (source.declaredUtf8 ? "utf8" : "sjis");
  const encoding = { utf8: "utf-8", sjis: "shift_jis", gbk: "gbk" }[selected];
  if (!encoding) throw new Error("Choose UTF-8, Shift-JIS or GBK for script export.");
  const text = new TextDecoder(encoding, { fatal: true }).decode(source.bytes).replace(/\r\n?/g, "\n");
  const parent = path.join(moduleRoot(entry, context), "source"); fs.mkdirSync(parent, { recursive: true });
  const destination = path.join(parent, "script"), work = fs.mkdtempSync(path.join(parent, ".export-"));
  try {
    fs.writeFileSync(path.join(work, "0.txt"), text);
    const record = { originalPath: source.file, originalSha256: source.originalSha256, originalEncoding: selected,
      format: source.mode, decoder: "maclauncher-nscript-v2", keyExecutable: source.keyExecutable, upstreamEngineVersion: "2025-06-08",
      sourceRevision: "0a725088e01919e0c206533c793a84f69f06b833", outputSha256: sha256(Buffer.from(text)) };
    fs.writeFileSync(path.join(work, "source.json"), JSON.stringify(record, null, 2));
    if (fs.existsSync(destination)) fs.renameSync(destination, destination + ".previous-" + crypto.randomUUID());
    fs.renameSync(work, destination);
    return { directory: destination, scriptPath: path.join(destination, "0.txt"), ...record };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

module.exports = { SCRIPT_NAMES, MAX_SCRIPT_BYTES, MAX_KEY_EXE_BYTES, moduleRoot, scriptInfo, readScript, readKeyTable, resolveKeyExecutable, resolveTextMode,
  prepareNativeSaves, prepareConfig, exportScript };
