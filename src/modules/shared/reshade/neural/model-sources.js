const fs = require("node:fs"), path = require("node:path");
const Zip = require("../../runtime/zip"), Models = require("./models");
const LIMITS = {entries: 16384, directory: 16 << 20, packages: 16, notice: 1 << 20, notices: 8 << 20,
  archive: 2 * Models.MAX_WEIGHTS + (32 << 20)};
const noticeName = name => /^(?:LICENSE|NOTICE|COPYING)(?:[._-][A-Za-z0-9._-]+)?$/i.test(name);
const safeName = name => typeof name === "string" && name.length <= 4096 && !/[\\\x00-\x1f]/.test(name) &&
  !name.startsWith("/") && !/^[A-Za-z]:/.test(name) && name.split("/").every(part => part && part !== "." && part !== "..");
function regular(file, maximum) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum) throw new Error("The model source contains an invalid or oversized file.");
  return stat;
}
function children(directory, maximum) {
  const rows = [], opened = fs.opendirSync(directory);
  try { let row;while ((row = opened.readSync())) { if (rows.length >= maximum) throw new Error("The model source contains too many entries.");rows.push(row); } }
  finally { opened.closeSync(); }return rows;
}
function localNotices(directory, maximum) {
  const notices = children(directory, maximum).filter(row => row.isFile() && noticeName(row.name)).map(row => {
    const source = path.join(directory, row.name), stat = regular(source, LIMITS.notice);return {name: row.name, source, bytes: stat.size};
  });
  if (notices.reduce((sum, row) => sum + row.bytes, 0) > LIMITS.notices) throw new Error("The model source notices exceed the size limit.");
  return notices;
}
function appSource(file) {
  const canonical = fs.realpathSync(file), resources = path.join(canonical, "Contents/Resources"), folder = path.join(resources, "models");
  if (!fs.lstatSync(canonical).isDirectory() || fs.realpathSync(folder) !== folder) throw new Error("Choose an application containing compatible model packages.");
  const packages = [];let candidates = 0;
  for (const row of children(folder, 256).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!row.isDirectory() || !/\.dlssmodel$/i.test(row.name)) continue;
    if (++candidates > LIMITS.packages) throw new Error("The model source contains too many packages.");
    try { packages.push(Models.inspectPackage(path.join(folder, row.name))); } catch {}
    if (packages.length > LIMITS.packages) throw new Error("The model source contains too many packages.");
  }
  if (!packages.length) throw new Error("This application contains no compatible neural model package.");
  if (packages.reduce((sum, row) => sum + row.weightsStat.size, 0) > Models.MAX_WEIGHTS) throw new Error("The model source exceeds the combined weights size limit.");
  const notices = localNotices(resources, 512);
  return {kind: "application", file: canonical, packages, notices};
}
function archiveSource(file) {
  const stat = regular(file, LIMITS.archive), fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);let entries;
  try {
    const info = Zip.findZipEocd(fd);
    if (!info || info.zipBase < 0 || info.cdSize > LIMITS.directory || info.entries > LIMITS.entries ||
        info.zipBase + info.cdOffset + info.cdSize > stat.size) throw new Error("The model ZIP is invalid or too large.");
    entries = Zip.readCentralDirectory(fd, info, {metadata: true});
    if (entries.length !== info.entries) throw new Error("The model ZIP is incomplete.");
  } finally { fs.closeSync(fd); }
  const byName = new Map(), duplicates = new Set();
  for (const entry of entries) {
    if (!safeName(entry.name)) continue;
    const key = entry.name.toLowerCase();if (byName.has(key)) duplicates.add(key);else byName.set(key, entry);
  }
  function selected(name, maximum) {
    const row = byName.get(name.toLowerCase()), type = row?.externalAttributes >>> 16 & 0o170000;
    if (!row || duplicates.has(name.toLowerCase()) || row.flags & 1 || ![0, 8].includes(row.compressionMethod) ||
        ![0, 0o100000].includes(type) || row.uncompressedSize < 1 || row.uncompressedSize > maximum)
      throw new Error("The model ZIP contains an unsafe or oversized model file.");
    return row;
  }
  const packages = [], resources = new Set();let expanded = 0, candidates = 0;
  for (const entry of entries) {
    if (!safeName(entry.name) || entry.name.startsWith("__MACOSX/")) continue;
    const standalone = /^(?:[^/]+\/)?[^/]+\.dlssmodel\/manifest\.json$/i.test(entry.name),
      bundled = /^(?:[^/]+\/)?[^/]+\.app\/Contents\/Resources\/models\/[^/]+\.dlssmodel\/manifest\.json$/i.test(entry.name);
    if (!standalone && !bundled) continue;
    if (++candidates > LIMITS.packages) throw new Error("The model ZIP contains too many packages.");
    try {
      const manifestEntry = selected(entry.name, Models.MAX_MANIFEST), bytes = Zip.readZipEntry(file, manifestEntry, {maxOutputBytes: Models.MAX_MANIFEST});
      if (!bytes) throw new Error("The model manifest could not be read.");
      const value = Models.inspectManifest(bytes), prefix = entry.name.slice(0, -"manifest.json".length), weightsEntry = selected(prefix + value.weights.file, Models.MAX_WEIGHTS);
      packages.push({prefix, bytes, value, manifestEntry, weightsEntry});expanded += manifestEntry.uncompressedSize + weightsEntry.uncompressedSize;
      if (bundled) resources.add(prefix.slice(0, prefix.indexOf("/models/") + 1));
      else resources.add(prefix.slice(0, prefix.lastIndexOf("/", prefix.length - 2) + 1));
    } catch (error) {
      // Unsupported packages are not model sources; an explicitly selected
      // compatible package still receives full checksum checks during import.
      continue;
    }
  }
  if (!packages.length) throw new Error("This ZIP contains no compatible neural model package.");
  if (packages.length > LIMITS.packages || expanded > Models.MAX_WEIGHTS + (LIMITS.packages * Models.MAX_MANIFEST))
    throw new Error("The model ZIP exceeds the expanded model size limit.");
  const notices = [];
  for (const entry of entries) {
    const parent = entry.name.slice(0, entry.name.lastIndexOf("/") + 1);
    if (!safeName(entry.name) || !noticeName(path.posix.basename(entry.name)) || !(parent === "" || resources.has(parent))) continue;
    notices.push(selected(entry.name, LIMITS.notice));
  }
  if (notices.reduce((sum, entry) => sum + entry.uncompressedSize, 0) > LIMITS.notices) throw new Error("The model ZIP notices exceed the size limit.");
  return {kind: "archive", file, stat, packages, notices};
}
function inspect(file) {
  if (typeof file !== "string" || !path.isAbsolute(file) || /[\x00-\x1f]/.test(file)) throw new Error("Choose a local neural model source.");
  if (/\.dlssmodel$/i.test(file)) return {kind: "package", file, packages: [Models.inspectPackage(file)], notices: []};
  if (/\.app$/i.test(file)) return appSource(file);
  if (/\.zip$/i.test(file)) return archiveSource(file);
  throw new Error("Choose a .dlssmodel package, model application or model ZIP.");
}
function recognizes(file) { try { inspect(file);return true; } catch { return false; } }
async function materialize(source, destination, {signal, onProgress} = {}) {
  if (source.kind !== "archive") return source;
  const packages = [], notices = [];
  for (const [index, row] of source.packages.entries()) {
    signal?.throwIfAborted();
    const modelPath = path.join(destination, index + ".dlssmodel");fs.mkdirSync(modelPath);
    await Zip.extractZipEntry(source.file, row.manifestEntry, path.join(modelPath, "manifest.json"), {maxOutputBytes: Models.MAX_MANIFEST, signal});
    let reported = 0;
    await Zip.extractZipEntry(source.file, row.weightsEntry, path.join(modelPath, row.value.weights.file), {maxOutputBytes: Models.MAX_WEIGHTS, signal,
      onProgress: completed => {
        const now = Date.now();if (completed !== row.weightsEntry.uncompressedSize && now - reported < 100) return;
        reported = now;onProgress?.({phase: "extract", completed, total: row.weightsEntry.uncompressedSize, label: "Reading neural model…"});
      }});
    packages.push({...Models.inspectPackage(modelPath), sourcePackage: row.prefix.replace(/\/$/, "")});
  }
  for (const [index, row] of source.notices.entries()) {
    signal?.throwIfAborted();const file = path.join(destination, "notice-" + index);
    await Zip.extractZipEntry(source.file, row, file, {maxOutputBytes: LIMITS.notice, signal});
    notices.push({name: path.posix.basename(row.name), source: file});
  }
  const after = fs.lstatSync(source.file);
  if (["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(key => source.stat[key] !== after[key])) throw new Error("The model ZIP changed during import.");
  return {...source, packages, notices};
}
module.exports = {LIMITS, inspect, recognizes, materialize};
