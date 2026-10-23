const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Inspect = require("./inspect");

const LIMITS = Object.freeze({ images: 4, descriptors: 32, directories: 256, depth: 8, entries: 8192, directoryBytes: 2 * 1024 * 1024, totalMetadata: 8 * 1024 * 1024, archiveBytes: 0xffffffff });

// ISO9660 uses logical 2048-byte blocks. Raw MODE1/2352 images carry the same
// data at byte16 of each physical sector. Only metadata and requested ranges
// are read; archives/audio remain in the original disc image.
function openImage(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("AI5 disc image must be a regular file.");
  const fd = fs.openSync(file, "r");
  function physical(offset, length) {
    if (offset < 0 || offset + length > stat.size) throw new Error("AI5 disc read leaves the original image.");
    const bytes = Buffer.alloc(length);
    if (fs.readSync(fd, bytes, 0, length, offset) !== length) throw new Error("Truncated AI5 disc image.");
    return bytes;
  }
  try {
    let geometry;
    for (const [sectorBytes, dataOffset] of [[2048, 0], [2352, 16]]) {
      if (stat.size < 17 * sectorBytes) continue;
      if (sectorBytes === 2352) {
        const header = physical(0, 16);
        if (header[0] !== 0 || header[11] !== 0 || header[15] !== 1 || !header.subarray(1, 11).every(byte => byte === 255)) continue;
      }
      const descriptor = physical(16 * sectorBytes + dataOffset, 2048);
      if (descriptor.subarray(1, 6).equals(Buffer.from("CD001")) && descriptor[6] === 1) { geometry = { sectorBytes, dataOffset }; break; }
    }
    if (!geometry) throw new Error("Unsupported AI5 disc image; expected ISO9660 or MODE1/2352.");
    const blocks = Math.floor(stat.size / geometry.sectorBytes);
    function read(offset, length) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > LIMITS.directoryBytes || offset + length > blocks * 2048) throw new Error("AI5 logical disc read exceeds its bounds.");
      const bytes = Buffer.alloc(length);
      let copied = 0;
      while (copied < length) {
        const logical = offset + copied, count = Math.min(2048 - logical % 2048, length - copied);
        const physicalOffset = Math.floor(logical / 2048) * geometry.sectorBytes + geometry.dataOffset + logical % 2048;
        if (fs.readSync(fd, bytes, copied, count, physicalOffset) !== count) throw new Error("Truncated AI5 disc data.");
        copied += count;
      }
      return bytes;
    }
    let pvd;
    for (let i = 16; i < 16 + LIMITS.descriptors; i++) {
      const descriptor = read(i * 2048, 2048);
      if (!descriptor.subarray(1, 6).equals(Buffer.from("CD001")) || descriptor[6] !== 1) throw new Error("Invalid ISO9660 descriptor sequence.");
      if (descriptor[0] === 1) { pvd = descriptor; break; }
      if (descriptor[0] === 255) break;
    }
    if (!pvd || pvd.readUInt16LE(128) !== 2048 || pvd.readUInt16BE(130) !== 2048 ||
      pvd.readUInt32LE(80) !== pvd.readUInt32BE(84) || pvd.readUInt32LE(80) > blocks) throw new Error("Invalid ISO9660 volume geometry.");
    const volumeBlocks = pvd.readUInt32LE(80);
    function record(bytes, offset, limit) {
      const length = bytes[offset], nameBytes = bytes[offset + 32];
      if (length < 34 || offset + length > limit || offset % 2048 + length > 2048 || !nameBytes || 33 + nameBytes > length || bytes[offset + 1] || bytes[offset + 26] || bytes[offset + 27]) throw new Error("Unsupported ISO9660 directory record.");
      const extent = bytes.readUInt32LE(offset + 2), size = bytes.readUInt32LE(offset + 10), flags = bytes[offset + 25];
      if (extent !== bytes.readUInt32BE(offset + 6) || size !== bytes.readUInt32BE(offset + 14) ||
        flags & 0x80 || extent + Math.ceil(size / 2048) > volumeBlocks || size > LIMITS.archiveBytes) throw new Error("Invalid or multi-extent ISO9660 file.");
      const rawName = bytes.subarray(offset + 33, offset + 33 + nameBytes);
      const special = rawName.length === 1 && rawName[0] < 2;
      const name = special ? null : rawName.toString("latin1").replace(/;1$/, "").replace(/\.$/, "");
      if (!special && (!name || /[\x00-\x1f/\\]/.test(name) || name === "." || name === "..")) throw new Error("Unsafe ISO9660 name.");
      return { extent, size, directory: Boolean(flags & 2), name, length };
    }
    const root = record(pvd, 156, 2048), entries = [], visited = new Set(); let metadata = 0;
    function walk(directory, prefix, depth) {
      if (depth > LIMITS.depth || visited.size >= LIMITS.directories || visited.has(directory.extent) || directory.size > LIMITS.directoryBytes ||
        (metadata += directory.size) > LIMITS.totalMetadata) throw new Error("ISO9660 directory tree exceeds its bounds or is cyclic.");
      visited.add(directory.extent);
      const bytes = read(directory.extent * 2048, directory.size), siblings = new Set();
      for (let offset = 0; offset < bytes.length;) {
        if (!bytes[offset]) { offset = Math.ceil((offset + 1) / 2048) * 2048; continue; }
        const item = record(bytes, offset, bytes.length); offset += item.length;
        if (item.name == null) continue;
        if (siblings.has(item.name.toLowerCase()) || entries.length >= LIMITS.entries) throw new Error("Ambiguous or excessive ISO9660 entries.");
        siblings.add(item.name.toLowerCase()); item.path = prefix ? prefix + "/" + item.name : item.name; entries.push(item);
        if (item.directory) walk(item, item.path, depth + 1);
      }
    }
    walk(root, "", 0);
    return { file, ...geometry, entries, read, size: stat.size, close: () => fs.closeSync(fd) };
  } catch (error) { fs.closeSync(fd); throw error; }
}

function matchingData(root, profile) {
  const candidates = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isFile() && /\.(iso|bin)$/i.test(entry.name));
  if (candidates.length > LIMITS.images) throw new Error("Too many adjacent AI5 disc images to select automatically.");
  const wanted = profile === "yuno-eng" ? "yuno" : profile, matches = [];
  for (const candidate of candidates) {
    const file = Inspect.localFile(root, candidate.name, { readdir: dir => fs.readdirSync(dir, { withFileTypes: true }), stat: fs.statSync });
    if (!file) continue;
    let image;
    try { image = openImage(file); } catch { continue; }
    try {
      for (const ini of image.entries.filter(entry => !entry.directory && /(?:^|\/)(?:AI5WIN|AI5ENG|SYUUSAKU|AIWIN)\.INI$/i.test(entry.path) && entry.size <= Inspect.MAX_INI_BYTES)) {
        const config = Inspect.parseIni(Inspect.decodeIni(image.read(ini.extent * 2048, ini.size)));
        const found = Inspect.TITLES.get(config.config?.title);
        if (found !== wanted && !(found === "yuno-eng" && wanted === "yuno")) continue;
        const directory = path.posix.dirname(ini.path), files = image.entries.filter(entry => !entry.directory && path.posix.dirname(entry.path) === directory);
        matches.push({ imagePath: file, sectorBytes: image.sectorBytes, dataOffset: image.dataOffset, directory, originalProfile: found,
          files: files.filter(entry => /\.(ARC|DAT)$/i.test(entry.name) || /^FLAG\d{1,2}$/i.test(entry.name)).map(entry => ({ ...entry })) });
      }
    } finally { image.close(); }
  }
  if (matches.length > 1) throw new Error("Several disc directories declare this AI5 profile; automatic selection is ambiguous.");
  return matches[0] || null;
}

function writeDescriptor(file, disc, item) {
  const imagePath = Buffer.from(fs.realpathSync(disc.imagePath));
  if (!imagePath.length || imagePath.length >= 4096 || imagePath.includes(0)) throw new Error("AI5 image path exceeds native descriptor bounds.");
  const header = Buffer.alloc(40); header.write("MLAI5CD1"); header.writeUInt32LE(disc.sectorBytes, 8); header.writeUInt32LE(disc.dataOffset, 12);
  header.writeBigUInt64LE(BigInt(item.extent) * 2048n, 16); header.writeBigUInt64LE(BigInt(item.size), 24); header.writeUInt32LE(imagePath.length, 32);
  const temporary = file + ".tmp-" + crypto.randomUUID();
  try { fs.writeFileSync(temporary, Buffer.concat([header, imagePath]), { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
  return file;
}

function prepareResources(root, data, profile, directory, saves, disc = matchingData(root, profile)) {
  const resourceDir = path.join(directory, "disc"), references = [...data.archiveReferences], env = {}, descriptors = [], seededSaves = [];
  const access = { stat: file => { try { return fs.statSync(file); } catch { return null; } }, readdir: dir => fs.readdirSync(dir, { withFileTypes: true }) };
  let image;
  try {
    if (disc) image = openImage(disc.imagePath);
    for (const [type, standard] of Object.entries({ bg: "BG.ARC", mes: "MES.ARC", data: "DATA.ARC", bgm: "MUSIC.ARC", effect: "EFFECT.ARC" })) {
      const primary = data.archiveReferences.find(ref => ref.type === type);
      const names = Inspect.ARC_KEYS[type], key = Object.keys(data.config.file).filter(key => names.includes(key) && data.config.file[key]).at(-1) || names[0];
      const authored = data.config.file[key] || standard, baseName = path.posix.basename(authored.replace(/\\/g, "/")).replace(/^z(?=.+\.arc$)/i, "");
      const sibling = Inspect.localFile(root, baseName, access);
      if (sibling && primary?.path === sibling) continue;
      let basePath = sibling;
      if (sibling) {
        if (!Inspect.inspectArchive(sibling, profile)) throw new Error(`AI5 base archive '${baseName}' has invalid metadata.`);
      } else if (image) {
        const item = disc.files.find(file => file.name.toLowerCase() === baseName.toLowerCase());
        if (!item) continue;
        const virtual = { stat: () => ({ size: item.size, isFile: () => true }), readBytes: (_file, offset, length) => image.read(item.extent * 2048 + offset, length) };
        if (!Inspect.inspectArchive(item.name, profile, virtual)) throw new Error(`AI5 disc archive '${item.path}' has invalid metadata.`);
        fs.mkdirSync(resourceDir, { recursive: true });
        basePath = writeDescriptor(path.join(resourceDir, type + path.extname(item.name)), disc, item);
        descriptors.push({ path: basePath, imagePath: disc.imagePath, logicalPath: item.path, extent: item.extent, size: item.size, descriptorBytes: fs.statSync(basePath).size });
      }
      if (!basePath) continue;
      // Keep the configured translation archive first; native missing-member
      // fallback reads the base file directly, including virtual disc streams.
      if (primary) env[`MACLAUNCHER_AI5_${type.toUpperCase()}_BASE`] = basePath;
      else references.push({ type, key, authoredPath: authored, path: basePath, forceArchive: true });
    }
    if (image) {
      for (const item of disc.files.filter(file => /^FLAG\d{1,2}$/i.test(file.name))) {
        if (item.size > 64 * 1024) throw new Error("AI5 disc save seed exceeds its limit.");
        const existing = fs.readdirSync(saves).filter(name => name.toLowerCase() === item.name.toLowerCase());
        if (existing.length || Inspect.localFile(root, item.name, access)) continue;
        const file = path.join(saves, item.name);
        fs.writeFileSync(file, image.read(item.extent * 2048, item.size), { flag: "wx", mode: 0o600 });
        seededSaves.push({ file, source: item.path, bytes: item.size });
      }
    }
    const candidates = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).slice(0, 64)
      .map(entry => path.join(root, entry.name)).filter(dir => {
        const real = fs.realpathSync(dir), realRoot = fs.realpathSync(root);
        if (!real.startsWith(realRoot + path.sep)) return false;
        const names = fs.readdirSync(dir).map(name => name.toLowerCase());
        return ["voice_a", "voice_b", "voice_c"].every(name => names.includes(name));
      });
    if (candidates.length === 1) env.MACLAUNCHER_AI5_AUX_ROOT = candidates[0];
    if (descriptors.length) env.MACLAUNCHER_AI5_RESOURCE_DIR = resourceDir;
    return { env, references, descriptors, seededSaves, disc };
  } finally { image?.close(); }
}

module.exports = { LIMITS, openImage, matchingData, writeDescriptor, prepareResources };
