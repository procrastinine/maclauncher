const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { TextDecoder } = require("node:util");
const { inspectGame } = require("./inspect");
const GameData = require("../shared/game-data");
const { assertOwnDirectory, atomicWrite } = require("../shared/writable-input");
const { throwIfAborted } = require("../shared/runtime/download-utils");
const { getUiServices } = require("../shared/ui-services");

// BIN: two uint32 fields (entry count/name-table length), 12-byte entries
// (name offset/data offset/size), NUL-terminated names, then unchanged assets.
// This reader performs no image conversion, bytecode execution or repacking.
const LIMITS = Object.freeze({ archives: 64, entries: 100000, indexBytes: 8 * 1024 ** 2,
  fileBytes: 1024 ** 3, totalBytes: 8 * 1024 ** 3, depth: 32, nameBytes: 1024 });
const RESOURCE_FOLDER = /^(?:graph(?:_[a-z0-9]+)*|bgm|voice(?:_[a-z0-9]+)*|se(?:_[a-z0-9]+)*|sysse|sound|movie)$/i;
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
const key = name => name.normalize("NFC").toLowerCase();
const inside = (root, file) => { const relative = path.relative(root, file); return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative); };

function safeName(value) {
  const name = value.replace(/\\/g, "/"), parts = name.split("/");
  if (!name || Buffer.byteLength(name) > LIMITS.nameBytes || parts.length > LIMITS.depth ||
      /^[a-z]:/i.test(name) || /[\x00-\x1f\x7f:]/.test(name) || parts.some(part => !part || part === "." || part === "..")) {
    throw new Error("FVP assets contain an unsafe file name.");
  }
  return name;
}
function readExact(fd, offset, length) {
  const bytes = Buffer.alloc(length); let done = 0;
  while (done < length) {
    const count = fs.readSync(fd, bytes, done, length - done, offset + done);
    if (!count) throw new Error("FVP asset data is truncated.");
    done += count;
  }
  return bytes;
}
function openSource(file, sources) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("FVP assets must be regular files.");
    const source = { path: file, fd, size: stat.size, identity: identity(stat) };
    sources.push(source); return source;
  } catch (error) { fs.closeSync(fd); throw error; }
}
function parseArchive(source, encoding) {
  if (source.size < 22) throw new Error("This FVP BIN archive is unsupported.");
  const header = readExact(source.fd, 0, 8), count = header.readUInt32LE(0), namesBytes = header.readUInt32LE(4);
  const indexBytes = 8 + count * 12 + namesBytes;
  if (!count || count > LIMITS.entries || !namesBytes || indexBytes > LIMITS.indexBytes || indexBytes > source.size) {
    throw new Error("FVP archive metadata exceeds supported limits.");
  }
  const index = readExact(source.fd, 8, indexBytes - 8), names = index.subarray(count * 12);
  if (names[names.length - 1] !== 0) throw new Error("FVP archive file names are truncated.");
  const decoder = new TextDecoder({ sjis: "shift_jis", gbk: "gbk", utf8: "utf-8" }[encoding] || "shift_jis", { fatal: true });
  const entries = [], seen = new Set();
  for (let i = 0; i < count; i++) {
    const offset = i * 12, nameOffset = index.readUInt32LE(offset), dataOffset = index.readUInt32LE(offset + 4), size = index.readUInt32LE(offset + 8);
    if (nameOffset >= names.length || nameOffset !== 0 && names[nameOffset - 1] !== 0 || names[nameOffset] === 0 || dataOffset < indexBytes || dataOffset > source.size - size) {
      throw new Error("FVP archive entries are invalid.");
    }
    if (size > LIMITS.fileBytes) throw new Error("An FVP asset exceeds the 1 GB file limit.");
    const end = names.indexOf(0, nameOffset); let name;
    try { name = safeName(decoder.decode(names.subarray(nameOffset, end))); }
    catch (error) { if (error.message.includes("unsafe")) throw error; throw new Error("FVP archive file names do not match the selected text encoding."); }
    if (seen.has(key(name))) throw new Error("FVP archive file names are ambiguous.");
    seen.add(key(name)); entries.push({ name, size, offset: dataOffset, source });
  }
  return entries;
}
function collectAssets(entry, context = {}) {
  throwIfAborted(context.signal);
  const root = fs.realpathSync(entry.contentRootDir || entry.gamePath);
  const encoding = context.runtimeSettings?.textEncoding || entry.moduleData?.textEncoding || "sjis";
  const game = inspectGame(root, { inputPath: entry.moduleData?.scriptPath, textEncoding: encoding });
  if (!game) throw new Error("FVP game data was not found.");
  const sources = [], files = new Map(), folders = new Map(); let scanned = 0;
  const close = () => { for (const source of sources) if (source.fd !== null) { fs.closeSync(source.fd); source.fd = null; } };
  function add(item, override = false) {
    const nameKey = key(item.name);
    if (files.has(nameKey) && (!override || files.get(nameKey).loosePath)) throw new Error("FVP asset file names are ambiguous.");
    files.set(nameKey, item);
    if (files.size > LIMITS.entries) throw new Error("FVP assets exceed the 100,000 file limit.");
  }
  function visit(directory, prefix, depth) {
    if (depth > LIMITS.depth) throw new Error("FVP asset folders exceed supported limits.");
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !inside(root, fs.realpathSync(directory))) throw new Error("FVP asset folders must not contain aliases.");
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      throwIfAborted(context.signal);
      if (++scanned > LIMITS.entries) throw new Error("FVP assets exceed the 100,000 file limit.");
      if (item.name === ".DS_Store") continue;
      const file = path.join(directory, item.name), name = safeName(prefix + "/" + item.name);
      if (item.isSymbolicLink()) throw new Error("FVP asset folders must not contain aliases.");
      if (item.isDirectory()) visit(file, name, depth + 1);
      else if (item.isFile()) {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("FVP assets must be regular files.");
        if (stat.size > LIMITS.fileBytes) throw new Error("An FVP asset exceeds the 1 GB file limit.");
        add({ name, size: stat.size, offset: 0, loosePath: file, sourceIdentity: identity(stat) }, true);
      } else throw new Error("FVP assets must be regular files.");
    }
  }
  try {
    if (game.archives.length > LIMITS.archives) throw new Error("FVP archives exceed supported limits.");
    const archiveNames = new Set(game.archives.map(archive => key(archive.name)));
    for (const item of fs.readdirSync(root, { withFileTypes: true })) {
      if (item.isFile() && /\.bin$/i.test(item.name) && RESOURCE_FOLDER.test(item.name.slice(0, -4)) && !archiveNames.has(key(item.name))) {
        throw new Error("An FVP asset archive is unsupported or damaged.");
      }
    }
    for (const archive of game.archives) {
      throwIfAborted(context.signal);
      const prefix = safeName(path.basename(archive.name, path.extname(archive.name)));
      if (folders.has(key(prefix))) throw new Error("FVP asset folder names are ambiguous.");
      folders.set(key(prefix), prefix);
      const source = openSource(archive.path, sources);
      if (source.identity !== archive.identity) throw new Error("An FVP archive changed during inspection. Try again.");
      for (const item of parseArchive(source, encoding)) add({ ...item, name: safeName(prefix + "/" + item.name) });
    }
    const looseFolders = new Set();
    for (const item of fs.readdirSync(root, { withFileTypes: true })) {
      if (item.isSymbolicLink() && (RESOURCE_FOLDER.test(item.name) || folders.has(key(item.name)))) throw new Error("FVP asset folders must not contain aliases.");
      if (!item.isDirectory() || !RESOURCE_FOLDER.test(item.name) && !folders.has(key(item.name))) continue;
      if (looseFolders.has(key(item.name))) throw new Error("FVP asset folder names are ambiguous.");
      looseFolders.add(key(item.name));
      // Loose files override archived assets, matching the player's VFS.
      visit(path.join(root, item.name), folders.get(key(item.name)) || safeName(item.name), 1);
    }
    if (!files.size) throw new Error("No supported FVP assets were found.");
    const entries = [...files.values()].sort((a, b) => a.name.localeCompare(b.name)), names = new Set(files.keys());
    let bytes = 0;
    for (const item of entries) {
      bytes += item.size;
      if (bytes > LIMITS.totalBytes) throw new Error("FVP assets exceed the 8 GB export limit.");
      const parts = item.name.split("/");
      while (parts.length > 1) { parts.pop(); if (names.has(key(parts.join("/")))) throw new Error("FVP asset files conflict with folders."); }
    }
    return { entries, bytes, archives: game.archives.map(archive => ({ name: archive.name, bytes: archive.bytes, count: archive.count })), sources, close };
  } catch (error) { close(); throw error; }
}
function exportRoot(entry, context, { create = true } = {}) {
  if (!path.isAbsolute(context.userDataDir || "") || !/^[\w-]+$/.test(entry.gameId || "")) throw new Error("FVP exports need an owned game data directory.");
  const directory = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "fvp"), "exports");
  assertOwnDirectory(context.userDataDir, directory, { create: false });
  let existing = directory;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const destination = path.join(fs.realpathSync(existing), path.relative(existing, directory));
  const original = fs.realpathSync(entry.contentRootDir || entry.gamePath);
  if (inside(original, destination)) throw new Error("FVP exports must be outside the original game folder.");
  if (create) assertOwnDirectory(context.userDataDir, directory);
  return directory;
}
function remember(entry, context, value) {
  entry.moduleData = { ...entry.moduleData, ...value }; context.onEntryChange?.({ moduleData: entry.moduleData });
}
function checkSources(source) {
  for (const item of source.sources) {
    if (identity(fs.fstatSync(item.fd)) !== item.identity || identity(fs.lstatSync(item.path)) !== item.identity) {
      throw new Error("An FVP archive changed during export. Try again.");
    }
  }
  for (const item of source.entries) {
    if (item.loosePath && identity(fs.lstatSync(item.loosePath)) !== item.sourceIdentity) throw new Error("An FVP asset changed during export. Try again.");
  }
}
function listAssets(entry, _payload, context) {
  const source = collectAssets(entry, context);
  try {
    checkSources(source); throwIfAborted(context.signal);
    const outputPath = path.join(exportRoot(entry, context), "asset-list.json");
    const result = { fileCount: source.entries.length, bytes: source.bytes, archives: source.archives };
    atomicWrite(outputPath, JSON.stringify({ ...result, files: source.entries.map(item => ({ name: item.name, size: item.size,
      source: item.loosePath ? "loose" : path.basename(item.source.path) })) }, null, 2) + "\n", { root: context.userDataDir });
    remember(entry, context, { assetListPath: outputPath }); return { ...result, outputPath };
  } finally { source.close(); }
}
function extractAssets(entry, _payload, context) {
  throwIfAborted(context.signal);
  const directory = exportRoot(entry, context), outputDir = path.join(directory, "assets");
  assertOwnDirectory(directory, outputDir, { create: false });
  const temporary = fs.mkdtempSync(path.join(directory, ".extract-")), backup = path.join(directory, ".previous-" + crypto.randomUUID());
  let source;
  try {
    source = collectAssets(entry, context); const files = [], buffer = Buffer.alloc(1024 ** 2);
    for (const item of source.entries) {
      throwIfAborted(context.signal);
      const output = path.join(temporary, ...item.name.split("/"));
      assertOwnDirectory(temporary, path.dirname(output));
      let loose;
      if (item.loosePath) {
        loose = openSource(item.loosePath, []);
        if (loose.identity !== item.sourceIdentity) { fs.closeSync(loose.fd); throw new Error("An FVP asset changed during export. Try again."); }
      }
      const input = loose || item.source, hash = crypto.createHash("sha256"); let fd;
      try {
        fd = fs.openSync(output, "wx", 0o600);
        for (let offset = 0; offset < item.size;) {
          throwIfAborted(context.signal);
          const length = Math.min(buffer.length, item.size - offset), count = fs.readSync(input.fd, buffer, 0, length, item.offset + offset);
          if (!count) throw new Error("FVP asset data is truncated.");
          let written = 0;
          while (written < count) written += fs.writeSync(fd, buffer, written, count - written);
          hash.update(buffer.subarray(0, count)); offset += count;
        }
        if (loose && (identity(fs.fstatSync(loose.fd)) !== loose.identity || identity(fs.lstatSync(loose.path)) !== loose.identity)) {
          throw new Error("An FVP asset changed during export. Try again.");
        }
        files.push({ name: item.name, size: item.size, sha256: hash.digest("hex"), source: loose ? "loose" : path.basename(item.source.path) });
      } finally { if (fd !== undefined) fs.closeSync(fd); if (loose) fs.closeSync(loose.fd); }
    }
    checkSources(source); throwIfAborted(context.signal);
    const result = { outputDir, fileCount: files.length, bytes: source.bytes, archives: source.archives, files };
    fs.writeFileSync(path.join(temporary, "export.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const previous = fs.existsSync(outputDir);
    if (previous) fs.renameSync(outputDir, backup);
    try { fs.renameSync(temporary, outputDir); } catch (error) { if (previous) fs.renameSync(backup, outputDir); throw error; }
    fs.rmSync(backup, { recursive: true, force: true });
    remember(entry, context, { assetExportDir: outputDir }); return result;
  } finally { source?.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
}
function revealAssets(entry, _payload, context) {
  const directory = exportRoot(entry, context, { create: false }), outputDir = path.join(directory, "assets");
  assertOwnDirectory(directory, outputDir, { create: false });
  if (!fs.existsSync(path.join(outputDir, "export.json"))) throw new Error("Extract FVP assets before opening the export folder.");
  getUiServices(context).shell.showItemInFolder(outputDir); return { outputDir };
}
function removeAssets(entry, _payload, context) {
  const directory = exportRoot(entry, context, { create: false }), outputDir = path.join(directory, "assets");
  assertOwnDirectory(directory, outputDir, { create: false }); fs.rmSync(outputDir, { recursive: true, force: true });
  remember(entry, context, { assetExportDir: null }); return { removed: true };
}
module.exports = { listAssets, extractAssets, revealAssets, removeAssets, __test: { LIMITS, collectAssets, safeName, parseArchive } };
