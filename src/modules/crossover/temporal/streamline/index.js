const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Writable = require("../../../shared/writable-input");
const PE = require("./pe-exports");
const ORIGINAL = "maclauncher_streamline_original.dll", RECORD = ".maclauncher-streamline.json";
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sameExports = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => item.name === b[index].name && item.ordinal === b[index].ordinal);
function provider(root) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(root, "provider.json"), "utf8")), library = path.join(root, "sl.interposer.dll");
    if (record.schema !== 1 || record.library !== "sl.interposer.dll" || !/^[a-f0-9]{64}$/.test(record.sha256) || hash(library) !== record.sha256 || !sameExports(PE.inspect(library), record.exports)) return null;
    return { ...record, library };
  } catch { return null; }
}
function inspect(sourcePath, providerRoot) {
  const payload = provider(providerRoot);
  if (!payload) return { available: false, reason: "The Streamline camera adapter is unavailable." };
  const exports = PE.inspect(sourcePath);
  if (!sameExports(exports, payload.exports)) return { available: false, reason: "This Streamline interface is not supported by the camera adapter." };
  return { available: true, sourcePath, sourceSha256: hash(sourcePath), provider: payload,
    cameraProjection: true, source: "streamline", methods: ["fsr2", "fsr3"] };
}
function paths(gameRoot, relativePath) {
  if (!path.isAbsolute(gameRoot || "") || typeof relativePath !== "string" || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).some(part => !part || part === "." || part === "..") || path.basename(relativePath).toLowerCase() !== "sl.interposer.dll") throw Error("Choose a Streamline library inside the private game directory.");
  const target = path.join(gameRoot, relativePath), directory = path.dirname(target);
  Writable.assertOwnDirectory(gameRoot, directory, { create: false });
  return { target, directory, original: path.join(directory, ORIGINAL), record: path.join(directory, RECORD) };
}
function readRecord(file) { try { const stat = fs.lstatSync(file);return stat.isFile() && !stat.isSymbolicLink() && stat.size < 16384 ? JSON.parse(fs.readFileSync(file, "utf8")) : null; } catch { return null; } }
function ownedBackup(files, record) {
  try { const stat = fs.lstatSync(files.original);return record?.schema === 1 && stat.isFile() && !stat.isSymbolicLink() && hash(files.original) === record.sourceSha256; } catch { return false; }
}
function recorded(options) {
  const files = paths(options.gameRoot, options.relativePath), record = readRecord(files.record);
  if (record?.schema !== 1 || !/^[a-f0-9]{64}$/.test(record.sourceSha256 || "") || !/^[a-f0-9]{64}$/.test(record.proxySha256 || "")) return null;
  const stat = fs.lstatSync(files.target);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  return {...files, ...record, currentSha256: hash(files.target)};
}
function ownership(options, expected) {
  const value = recorded(options);
  if (!value || expected && (value.sourceSha256 !== expected.sourceSha256 || value.proxySha256 !== expected.proxySha256) || !ownedBackup(value, value)) return null;
  return value;
}
function prepare({ sourcePath, gameRoot, relativePath, providerRoot, signal }) {
  signal?.throwIfAborted();
  const selection = inspect(sourcePath, providerRoot);
  if (!selection.available) return selection;
  let files;
  try { files = paths(gameRoot, relativePath); } catch (error) { return { available: false, reason: error.message }; }
  const record = readRecord(files.record);let current = fs.existsSync(files.target) ? hash(files.target) : null;
  if (record) {
    if (!ownedBackup(files, record)) return { available: false, reason: "The private Streamline backup changed." };
    if (current === record.proxySha256 && record.sourceSha256 === selection.sourceSha256 && record.proxySha256 === selection.provider.sha256)
      return { ...selection, target: files.target, prepared: true };
    if (current === record.proxySha256) {
      // Restore the owned original before replacing an older adapter. A failed
      // update leaves a normal game library rather than a half-updated proxy.
      restore({ gameRoot, relativePath });
      if (record.sourceSha256 !== selection.sourceSha256) Writable.atomicCopy(sourcePath, files.target, { root: gameRoot, preserveTimes: false });
      current = selection.sourceSha256;
    } else {
      // File staging can replace the proxy with an updated original. Only retire
      // our own completed backup; never replace another mod or a changed game DLL.
      if (current !== selection.sourceSha256) return { available: false, reason: "The private Streamline library changed." };
      fs.unlinkSync(files.original);fs.unlinkSync(files.record);
    }
  } else if (fs.existsSync(files.original) || fs.existsSync(files.record)) return { available: false, reason: "A Streamline backup already exists in this game directory." };
  if (current !== selection.sourceSha256) return { available: false, reason: "The private Streamline library differs from the selected game source." };
  // Both swaps replace only leaf entries under the checked owned directory.
  // Source files and any source-pointing leaf symlink remain untouched.
  const temporary = path.join(files.directory, ".streamline-" + crypto.randomUUID());
  let copied = false;
  try {
    fs.copyFileSync(sourcePath, files.original, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL);copied = true;
    fs.copyFileSync(selection.provider.library, temporary, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL);
    signal?.throwIfAborted();
    Writable.atomicWrite(files.record, JSON.stringify({ schema: 1, sourceSha256: selection.sourceSha256, proxySha256: selection.provider.sha256 }) + "\n", { root: gameRoot });
    fs.renameSync(temporary, files.target);
    return { ...selection, target: files.target, prepared: true };
  } catch (error) {
    if (copied) { fs.rmSync(files.original, { force: true });fs.rmSync(files.record, { force: true }); }
    throw error;
  } finally { fs.rmSync(temporary, { force: true }); }
}
function restore({ gameRoot, relativePath }) {
  const files = paths(gameRoot, relativePath), record = readRecord(files.record);
  if (!record) return false;
  const current = hash(files.target);
  if (current !== record.proxySha256 && current !== record.sourceSha256)
    throw Object.assign(Error("The private Streamline library changed."), { code: "STREAMLINE_LIBRARY_CHANGED" });
  if (!ownedBackup(files, record)) throw Error("The private Streamline backup changed.");
  if (current === record.proxySha256) Writable.atomicCopy(files.original, files.target, { root: gameRoot, preserveTimes: false });
  fs.unlinkSync(files.original);fs.unlinkSync(files.record);return true;
}
module.exports = { ORIGINAL, RECORD, provider, inspect, prepare, restore, recorded, ownership, sameExports };
