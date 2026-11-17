const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), zlib = require("node:zlib");
const { inspectApk, withApk, LIMITS } = require("./apk");
const Manifest = require("./binary-manifest");
const Zip = require("../shared/runtime/zip");
const ARCHIVES = /\.(?:xapk|apkm|apks)$/i;
const MAX_APKS = 64;

// Android installers retain the manifest split identity in the installed path.
// Native clients also use this path to distinguish asset packs from config APKs.
function installedName(split) {
  return split == null ? "base.apk" : "split_" + encodeURIComponent(split) + ".apk";
}

function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Android packages must be regular files.");
  return stat;
}

function folderFiles(directory) {
  const files = [], entries = fs.opendirSync(directory);
  try {
    let item, count = 0;
    while ((item = entries.readSync())) {
      if (++count > 4096) throw new Error("The Android package folder contains too many files.");
      if (!/\.apk$/i.test(item.name)) continue;
      if (!item.isFile() || item.isSymbolicLink()) throw new Error("Android packages must be regular files.");
      files.push(path.join(directory, item.name));
      if (files.length > MAX_APKS) throw new Error("An Android package set can contain at most 64 APKs.");
    }
  } finally { entries.closeSync(); }
  if (!files.length) throw new Error("The folder contains no Android APK files.");
  return files.sort();
}

function directFiles(input) {
  const stat = fs.lstatSync(input);
  if (stat.isSymbolicLink()) throw new Error("Linked Android package inputs are unsupported.");
  if (stat.isDirectory()) return folderFiles(input);
  regular(input);
  if (!/\.apk$/i.test(input)) return null;
  const metadata = inspectApk(input);
  const required = metadata.split || metadata.requiresSplitInstallation || metadata.requiredSplits.length;
  let siblings;
  try { siblings = folderFiles(path.dirname(input)); }
  catch (error) { if (required) throw error; return [input]; }
  const matching = [];
  for (const file of siblings) {
    try {
      const m = inspectApk(file);
      if (m.packageName === metadata.packageName && m.versionCode === metadata.versionCode &&
          m.versionCodeMajor === metadata.versionCodeMajor &&
          (metadata.split || m.split || path.resolve(file) === path.resolve(input))) matching.push({ file, metadata: m });
    }
    catch { /* Unrelated invalid files do not become part of a selected APK. */ }
  }
  return required || matching.some(item => item.metadata.split) ? matching.map(item => item.file) : [input];
}

function plan(records, { verified = false, profile = {}, requireLauncher = true, inspection = false } = {}) {
  if (!Array.isArray(records) || !records.length || records.length > MAX_APKS)
    throw new Error("An Android package set requires 1–64 APKs.");
  const bases = records.filter(item => item.metadata.split === null);
  if (bases.length !== 1) throw new Error("Select one Android base APK and its matching splits.");
  const nativeAbi = inspection ? null : require("./native-abi").supported(profile).find(abi => records.filter(item => item.metadata.split === null || item.metadata.isFeatureSplit).every(item => !item.metadata.architectures.length || item.metadata.architectures.includes(abi)) && (!records.some(item => item.metadata.architectures.length) || records.some(item => item.metadata.architectures.includes(abi))));
  if (!inspection && !nativeAbi) throw new Error("The Android package set does not include compatible ARM native libraries.");
  const base = bases[0], splits = new Map(), identities = new Set(); let sourceBytes = 0;
  const certificates = item => {
    if (!Array.isArray(item.signers) || !item.signers.length || item.signers.some(s => !/^[a-f0-9]{64}$/.test(s)))
      throw new Error("Android package signatures could not be verified.");
    return [...new Set(item.signers)].sort().join(",");
  };
  for (const item of records) {
    const m = item.metadata, b = base.metadata;
    for (const key of ["versionCode", "versionCodeMajor"])
      if (!(inspection && m[key] === null) && (!Number.isInteger(m[key]) || m[key] < 0 || m[key] > 0xffffffff))
        throw new Error("The Android package version is invalid.");
    if (m.packageName !== b.packageName || m.versionCode !== b.versionCode || m.versionCodeMajor !== b.versionCodeMajor)
      throw new Error("Android base and split APKs must have the same package and version.");
    if (verified && certificates(item) !== certificates(base)) throw new Error("Android base and split APKs have different signing certificates.");
    const stat = regular(item.file), identity = stat.dev + ":" + stat.ino;
    sourceBytes += stat.size;
    if (sourceBytes > LIMITS.extractedBytes) throw new Error("The Android package set exceeds the supported size.");
    if (!inspection && m.isFeatureSplit && m.architectures.length && !m.architectures.includes(nativeAbi))
      throw new Error("An Android feature split does not include " + nativeAbi + " native libraries.");
    if (identities.has(identity)) throw new Error("The Android package set contains the same file more than once.");
    identities.add(identity);
    if (m.split !== null) {
      if (typeof m.split !== "string" || !m.split || splits.has(m.split)) throw new Error("The Android package set contains duplicate split names.");
      splits.set(m.split, item);
    }
  }
  const selected = inspection ? records : records.filter(item => !item.metadata.architectures.length || item.metadata.architectures.includes(nativeAbi));
  if (!inspection && (!selected.includes(base) || records.some(item => item.metadata.architectures.length) &&
      !selected.some(item => item.metadata.architectures.includes(nativeAbi))))
    throw new Error("The Android package set does not include " + nativeAbi + " native libraries.");
  if (base.metadata.requiresSplitInstallation && selected.length === 1) throw new Error("The Android package requires additional split APKs.");
  const retained = new Set(selected), active = new Set(), done = new Set(), ordered = [base];
  function visit(item) {
    if (done.has(item)) return;
    if (active.has(item)) throw new Error("The Android package has cyclic split dependencies.");
    active.add(item);
    for (const name of [...item.metadata.requiredSplits, ...(item.metadata.configForSplit ? [item.metadata.configForSplit] : [])]) {
      const dependency = name === "base" ? base : splits.get(name);
      if (!dependency || !retained.has(dependency)) throw new Error("A required Android split APK is missing: " + name);
      if (dependency !== base || item === base) visit(dependency);
    }
    active.delete(item); done.add(item); if (item !== base) ordered.push(item);
  }
  for (const item of [base, ...selected.filter(item => item !== base).sort((a, b) => a.metadata.split.localeCompare(b.metadata.split))]) visit(item);
  const inspected = ordered.length === 1 ? base.metadata : { ...Manifest.parseBinaryManifestSet(ordered.map(item =>
    withApk(item.file, archive => archive.read("AndroidManifest.xml", Manifest.LIMITS.bytes)))), libraries: base.metadata.libraries };
  const metadata = { ...inspected, nativeAbi, splitApks: ordered.map(item => item.metadata.split),
    architectures: [...new Set(ordered.flatMap(item => item.metadata.architectures))].sort(),
    requiredGlEsVersion: Math.max(0, ...ordered.map(item => item.metadata.requiredGlEsVersion || 0)),
    dex: ordered.flatMap(item => item.metadata.dex), limitations: [] };
  if (requireLauncher && !metadata.launchers.length) metadata.limitations.push("The APK has no enabled launcher activity.");
  if (!metadata.dex.length && metadata.hasCode !== false)
    metadata.limitations.push("The Android package is missing its application bytecode.");
  return { base, selected: ordered, excluded: records.filter(item => !retained.has(item)), metadata };
}

function inspectFiles(files, { profile = {}, requireLauncher = true, inspection = false } = {}) { return plan(files.map(file => ({ file, metadata: inspectApk(file, { requireLauncher, ...(inspection ? {} : { nativeArchitectures: require("./native-abi").supported(profile) }) }) })), { profile, requireLauncher, inspection }); }

// Archives usually store their APKs uncompressed. Such an APK's bytes are read
// in place, after the same local-header, range and checksum checks the
// archive reader makes before its own copy; any other entry, or a check that
// does not hold, is left to that copy and its errors.
const COPY_CHUNK = 4 * 1024 * 1024, EOCD_WINDOW = 22 + 0xffff;
function readRange(fd, offset, length) {
  const buffer = Buffer.alloc(length);
  if (fs.readSync(fd, buffer, 0, length, offset) !== length) throw new Error("The APK entry is truncated.");
  return buffer;
}
function storedRange(fd, info, entry, stat) {
  if (entry.compressionMethod !== 0 || entry.compressedSize !== entry.uncompressedSize ||
      entry.uncompressedSize > LIMITS.extractedBytes || (entry.flags & 1)) return null;
  const at = entry.absoluteLocalHeaderOffset;
  if (!Number.isSafeInteger(at) || at < 0 || at > info.cdOffset - 30) return null;
  const header = readRange(fd, at, 30);
  if (header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(6) !== entry.flags || header.readUInt16LE(8) !== 0) return null;
  const nameLength = header.readUInt16LE(26), offset = at + 30 + nameLength + header.readUInt16LE(28);
  if (at + 30 + nameLength > info.cdOffset || readRange(fd, at + 30, nameLength).toString("utf8") !== entry.name) return null;
  if (offset > info.cdOffset - entry.compressedSize) return null;
  if (!(entry.flags & 8) && entry.crc32 !== header.readUInt32LE(14)) return null;
  const key = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, offset, entry.compressedSize, entry.crc32].join(":");
  return { offset, size: entry.compressedSize, crc32: entry.crc32, key };
}
// Stored APKs whose checksum this process has verified, by the archive's
// identity, so that one import's detection and resource read verify each APK
// once. Any change to the archive changes its identity.
const verified = new Set(), VERIFIED_LIMIT = 256;
function remember(range) {
  verified.add(range.key);
  if (verified.size > VERIFIED_LIMIT) verified.delete(verified.values().next().value);
}
function clearVerified() { verified.clear(); }
// Streams a stored APK's bytes, to `target` when given, and reports whether
// their checksum matches the archive's.
async function streamStored(fd, range, target, signal) {
  const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(COPY_CHUNK, range.size)));
  let crc = 0;
  for (let position = 0; position < range.size;) {
    signal?.throwIfAborted();
    const length = Math.min(buffer.length, range.size - position);
    const read = await new Promise((resolve, reject) => fs.read(fd, buffer, 0, length, range.offset + position,
      (error, bytesRead) => error ? reject(error) : resolve(bytesRead)));
    if (read !== length) throw new Error("The APK entry is truncated.");
    crc = zlib.crc32(buffer.subarray(0, length), crc);
    if (target) await target.write(buffer, 0, length, position);
    position += length;
  }
  if (crc !== range.crc32) return false;
  remember(range);
  return true;
}
// The names in a resource table's global string pool, which include the path
// of every file-based resource, or null when the table cannot be read.
function tableStrings(bytes) {
  if (bytes.length < 12 || bytes.readUInt16LE(0) !== 0x0002) return null;
  const at = bytes.readUInt16LE(2);
  if (at < 12 || at + 28 > bytes.length || bytes.readUInt16LE(at) !== 0x0001) return null;
  const headerSize = bytes.readUInt16LE(at + 2), end = at + bytes.readUInt32LE(at + 4), count = bytes.readUInt32LE(at + 8);
  const utf8 = (bytes.readUInt32LE(at + 16) & 0x100) !== 0, strings = at + bytes.readUInt32LE(at + 20);
  if (headerSize < 28 || end > bytes.length || at + headerSize + count * 4 > end || strings > end) return null;
  const names = new Set();
  for (let index = 0; index < count; index++) {
    let p = strings + bytes.readUInt32LE(at + headerSize + index * 4), length;
    if (utf8) {
      if (p + 2 > end) return null;
      p += bytes[p] & 0x80 ? 2 : 1;
      if (p + 2 > end) return null;
      length = bytes[p] & 0x80 ? (bytes[p] & 0x7f) << 8 | bytes[p + 1] : bytes[p];
      p += bytes[p] & 0x80 ? 2 : 1;
      if (p + length > end) return null;
      names.add(bytes.toString("utf8", p, p + length));
    } else {
      if (p + 4 > end) return null;
      length = bytes.readUInt16LE(p) & 0x8000 ? (bytes.readUInt16LE(p) & 0x7fff) << 16 | bytes.readUInt16LE(p + 2) : bytes.readUInt16LE(p);
      p += bytes.readUInt16LE(p) & 0x8000 ? 4 : 2;
      if (p + length * 2 > end) return null;
      names.add(bytes.toString("utf16le", p, p + length * 2));
    }
  }
  return names;
}
// What `method` writes of a stored APK: "plain" all of it. "sparse" writes a
// file of the APK's size holding, at their own offsets, its directory, the
// end of the file where the directory record is searched for, and its
// manifest: all that package inspection reads. "resources" adds the resource
// table and every entry named in it: all that the resource reader reads.
async function writeStored(fd, range, output, signal, method) {
  const sparse = method !== "plain";
  const target = await fs.promises.open(output, sparse ? "wx+" : "wx", 0o600);
  let complete = false;
  try {
    if (!(sparse && verified.has(range.key)) && !await streamStored(fd, range, sparse ? null : target, signal)) return false;
    if (sparse) {
      const size = range.size, tailStart = size - Math.min(size, EOCD_WINDOW), tail = readRange(fd, range.offset + tailStart, size - tailStart);
      let cdOffset = null;
      for (let i = tail.length - 22; i >= 0 && cdOffset === null; i--) {
        if (tail.readUInt32LE(i) !== 0x06054b50 || i + 22 + tail.readUInt16LE(i + 20) !== tail.length) continue;
        if (tail.readUInt32LE(i + 12) <= LIMITS.directoryBytes && tail.readUInt32LE(i + 16) + tail.readUInt32LE(i + 12) <= size) cdOffset = tail.readUInt32LE(i + 16);
        else return false;
      }
      if (cdOffset === null) return false;
      const start = Math.min(cdOffset, tailStart);
      await target.truncate(size);
      await target.write(readRange(fd, range.offset + start, size - start), 0, size - start, start);
      const info = Zip.findZipEocd(target.fd);
      if (!info || info.zipBase !== 0) return false;
      const entries = new Map();
      for (const entry of Zip.readCentralDirectory(target.fd, info, { metadata: true })) {
        if (entries.has(entry.name)) return false;
        entries.set(entry.name, entry);
      }
      // Copies an entry's local header and data, and returns the data.
      const copy = async entry => {
        const at = entry?.absoluteLocalHeaderOffset;
        if (!Number.isSafeInteger(at) || at < 0 || at > size - 30) return null;
        const header = readRange(fd, range.offset + at, 30), data = 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
        if (at + data + entry.compressedSize > size) return null;
        const bytes = readRange(fd, range.offset + at, data + entry.compressedSize);
        await target.write(bytes, 0, bytes.length, at);
        return bytes.subarray(data);
      };
      if (!await copy(entries.get("AndroidManifest.xml"))) return false;
      const table = entries.get("resources.arsc");
      if (method === "resources" && table) {
        const data = await copy(table);
        if (!data || ![0, 8].includes(table.compressionMethod) || table.uncompressedSize > LIMITS.fileBytes) return false;
        const bytes = table.compressionMethod ? zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, table.uncompressedSize) }) : data;
        if (bytes.length !== table.uncompressedSize || zlib.crc32(bytes) !== table.crc32) return false;
        const names = tableStrings(bytes);
        if (!names) return false;
        for (const name of names) {
          signal?.throwIfAborted();
          if (entries.has(name) && name !== "AndroidManifest.xml" && name !== "resources.arsc" && !await copy(entries.get(name))) return false;
        }
      }
    }
    complete = true;
    return true;
  } finally {
    await target.close();
    if (!complete) await fs.promises.rm(output, { force: true });
  }
}
function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

// `method` chooses each APK's output: "copy" is the archive reader's verified
// copy with its SHA-256; "plain" copies a stored APK's bytes directly without
// a digest; "sparse" and "resources" write only what package inspection, or
// the resource reader, reads.
async function unpack(input, directory, signal, { method = "copy" } = {}) {
  const outputs = [];
  await withApk(input, async archive => {
    let fd = null, info = null, stat = null;
    if (method !== "copy") {
      fd = fs.openSync(input, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      stat = fs.fstatSync(fd);
      info = sameFile(stat, archive.stat) ? Zip.findZipEocd(fd) : null;
      if (!info || info.zipBase !== 0) { fs.closeSync(fd); fd = null; }
    }
    try {
      let apks = archive.entries.filter(entry => /\.apk$/i.test(entry.name));
      // bundletool may include mutually exclusive standalone/system variants.
      // Its split installation lives under splits/; never combine both variants.
      if (/\.apks$/i.test(input) && apks.some(entry => entry.name.startsWith("splits/")))
        apks = apks.filter(entry => entry.name.startsWith("splits/"));
      if (!apks.length || apks.length > MAX_APKS) throw new Error("The Android archive requires 1–64 APKs.");
      let bytes = 0;
      for (const entry of apks.sort((a, b) => a.name.localeCompare(b.name))) {
        bytes += entry.uncompressedSize;
        if (bytes > LIMITS.extractedBytes) throw new Error("The Android package set exceeds the supported size.");
        if ((entry.externalAttributes >>> 16 & 0xf000) === 0xa000) throw new Error("Linked Android packages are unsupported.");
        const file = path.join(directory, "package-" + outputs.length + ".apk");
        const range = fd !== null && storedRange(fd, info, entry, stat);
        if (range && await writeStored(fd, range, file, signal, method)) { outputs.push({ file, originalName: entry.name }); continue; }
        const copied = await archive.copy(entry.name, file, { signal });
        outputs.push({ file, originalName: entry.name, ...copied });
      }
    } finally { if (fd !== null) fs.closeSync(fd); }
  });
  return outputs;
}

async function inspectUnpacked(input, signal, method, options) {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), "maclauncher-apk-inspect-"));
  try { return inspectFiles((await unpack(input, temporary, signal, { method })).map(item => item.file), options); }
  finally { await fs.promises.rm(temporary, { recursive: true, force: true }); }
}

// Inspection first reads sparse copies of an archive's APKs. Any failure there
// repeats the inspection on complete copies, so a damaged or unusual archive
// gives the same result and error as before.
async function inspectInput(input, { signal, profile = {}, requireLauncher = true, inspection = false } = {}) {
  const options = { profile, requireLauncher, inspection };
  if (!ARCHIVES.test(input)) return inspectFiles(directFiles(input), options);
  try { return await inspectUnpacked(input, signal, "sparse", options); }
  catch { signal?.throwIfAborted(); }
  return inspectUnpacked(input, signal, "copy", options);
}

module.exports = { ARCHIVES, MAX_APKS, directFiles, inspectFiles, inspectInput, unpack, clearVerified, plan, installedName };
