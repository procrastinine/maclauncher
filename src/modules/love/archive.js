const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Zip = require("../shared/runtime/zip");
const GameData = require("../shared/game-data");
const Writable = require("../shared/writable-input");

const MAX_ENTRIES = 50000;
const MAX_BYTES = 4 * 1024 ** 3;
const normalize = name => String(name || "").replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");

// A game's own nested libraries may have main.lua too. Only independent,
// outermost roots compete; a root main.lua always retains stock LÖVE behavior.
function selectRoot(entries) {
  const mains = (entries || []).map(entry => ({ entry, name: normalize(entry.name) }))
    .filter(item => /(?:^|\/)main\.lua$/i.test(item.name));
  const direct = mains.find(item => item.name.toLowerCase() === "main.lua");
  if (direct) return { mainEntry: direct.entry, root: "", ambiguous: false };
  // Stock LÖVE can run callbacks supplied by root conf.lua. A nested example
  // must not replace that already valid source layout.
  const rootConf = mains.length && (entries || []).find(entry => normalize(entry.name).toLowerCase() === "conf.lua");
  if (rootConf) return { mainEntry: rootConf, root: "", ambiguous: false };
  const roots = [...new Set(mains.map(item => path.posix.dirname(item.name)))];
  const outer = roots.filter(root => !roots.some(other => root !== other && root.startsWith(other + "/")));
  if (outer.length !== 1) return { mainEntry: null, root: null, ambiguous: outer.length > 1 };
  return { mainEntry: mains.find(item => path.posix.dirname(item.name) === outer[0]).entry,
    root: outer[0], ambiguous: false };
}

function readArchive(file) {
  const fd = fs.openSync(file, "r");
  try {
    const info = Zip.findZipEocd(fd);
    if (!info || info.zipBase < 0 || info.cdSize > 16 * 1024 ** 2 || info.entries > MAX_ENTRIES) return null;
    const entries = Zip.readCentralDirectory(fd, info, { metadata: true });
    if (entries.length !== info.entries) throw new Error("The LÖVE archive directory is incomplete.");
    return { entries, ...selectRoot(entries) };
  } finally { fs.closeSync(fd); }
}

function identity(file) {
  const stat = fs.statSync(file, { bigint: true });
  if (!stat.isFile()) throw new Error("LÖVE archive not found.");
  return [file, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
}

function selectedEntries(archive) {
  const prefix = archive.root ? archive.root + "/" : "", names = new Set();
  let bytes = 0;
  const selected = [];
  for (const entry of archive.entries) {
    const name = normalize(entry.name);
    if (!name.startsWith(prefix)) continue;
    const relative = name.slice(prefix.length), directory = name.endsWith("/");
    const parts = (directory ? relative.slice(0, -1) : relative).split("/");
    if (!relative || parts.some(part => !part || part === "." || part === ".." || /[\0:]/.test(part)) ||
        path.posix.isAbsolute(name) || entry.flags & 1 ||
        ![0, 0o100000, ...(directory ? [0o040000] : [])].includes(entry.externalAttributes >>> 16 & 0o170000))
      throw new Error("The LÖVE archive contains an unsafe game resource.");
    const key = parts.join("/").toLowerCase();
    if (names.has(key)) throw new Error("The LÖVE archive contains conflicting game resources.");
    names.add(key);
    if (!directory) {
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 ||
          (bytes += entry.uncompressedSize) > MAX_BYTES)
        throw new Error("The LÖVE archive exceeds its expanded size limit.");
      selected.push({ entry, relative });
    }
  }
  return selected;
}

// Root archives stay at their original location. A nested archive is projected
// once into owned game data; neither the source nor the game's cwd is rewritten.
async function prepare(file, entry, context) {
  context.signal?.throwIfAborted();
  if (entry.moduleData?.archiveRoot === "" && !entry.moduleData?.archiveAmbiguous) return file;
  const source = fs.realpathSync(file), before = identity(source), archive = readArchive(source);
  if (archive?.ambiguous) throw new Error("The LÖVE archive contains multiple games. Import a separate game archive or folder.");
  if (!archive?.root) return file;
  if (archive.root.split("/").some(part => !part || part === "." || part === ".." || /[\0:]/.test(part)) || path.posix.isAbsolute(archive.root))
    throw new Error("The LÖVE archive has an unsafe game folder.");
  const files = selectedEntries(archive);
  if (!path.isAbsolute(context.userDataDir || "") || !/^[\w-]+$/.test(entry.gameId || ""))
    throw new Error("LÖVE archive preparation needs a game data directory.");
  const key = crypto.createHash("sha256").update(JSON.stringify([1, before, archive.root])).digest("hex");
  const parent = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "love"), "archives");
  const destination = path.join(parent, key), target = path.join(destination, path.basename(file));
  Writable.assertOwnDirectory(context.userDataDir, destination, { create: false });
  const ready = () => {
    try {
      const marker = path.join(destination, "prepared.json"), stat = fs.lstatSync(marker);
      return stat.isFile() && stat.size < 1024 && JSON.parse(fs.readFileSync(marker, "utf8")).key === key &&
        fs.lstatSync(target).isDirectory() && !fs.lstatSync(target).isSymbolicLink() &&
        fs.lstatSync(path.join(target, normalize(archive.mainEntry.name).slice(archive.root.length + 1))).isFile();
    } catch { return false; }
  };
  const preparedTarget = () => {
    entry.moduleData = { ...entry.moduleData, archiveRoot: archive.root };
    return target;
  };
  if (ready()) return preparedTarget();
  if (fs.existsSync(destination)) throw new Error("The prepared LÖVE game is incomplete. Remove the game preparation before retrying.");
  Writable.assertOwnDirectory(context.userDataDir, parent);
  const temporary = fs.mkdtempSync(path.join(parent, ".prepare-")), game = path.join(temporary, path.basename(file));
  try {
    fs.mkdirSync(game);
    for (const { entry: resource, relative } of files) {
      context.signal?.throwIfAborted();
      const output = path.join(game, relative);
      Writable.assertOwnDirectory(temporary, path.dirname(output));
      await Zip.extractZipEntry(source, resource, output, { maxOutputBytes: MAX_BYTES, signal: context.signal });
    }
    context.signal?.throwIfAborted();
    if (JSON.stringify(before) !== JSON.stringify(identity(source))) throw new Error("The LÖVE archive changed during preparation. Retry Play.");
    fs.writeFileSync(path.join(temporary, "prepared.json"), JSON.stringify({ key }), { flag: "wx", mode: 0o600 });
    try { fs.renameSync(temporary, destination); }
    catch (error) { if (!ready()) throw error; }
    return preparedTarget();
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

module.exports = { selectRoot, prepare, readArchive, selectedEntries };
