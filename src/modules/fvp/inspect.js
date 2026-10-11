const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const LIMITS = Object.freeze({ files: 4096, scripts: 16, archives: 64, scriptBytes: 512 * 1024 * 1024,
  descriptorBytes: 256 * 1024, syscalls: 1024, archiveEntries: 100000, archiveIndexBytes: 8 * 1024 * 1024 });
const RESOLUTIONS = [[640, 480], [800, 600], [1024, 768], [1280, 960], [1600, 1200], [640, 480],
  [1024, 576], [1024, 640], [1280, 720], [1280, 800], [1440, 810], [1440, 900], [1680, 945], [1680, 1050], [1920, 1080], [1920, 1200]];
const KNOWN_SYSCALLS = new Set(["GraphLoad", "GraphMove", "TextPrint", "TextFont", "TextBuff", "ThreadWait", "ThreadSleep", "SoundPlay", "SoundLoad", "SaveWrite", "WindowMode", "TitleMenu"]);
const propagate = error => { if (error?.code === "DETECTION_LIMIT" || error?.name === "AbortError" || error?.code === "ABORT_ERR") throw error; };
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
function statFile(file, detection) {
  const stat = detection?.stat ? detection.stat(file) : fs.lstatSync(file);
  return stat?.isFile() && !stat.isSymbolicLink?.() ? stat : null;
}
function readAt(file, offset, length, detection) {
  if (detection?.readBytes) return detection.readBytes(file, offset, length);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const bytes = Buffer.alloc(length); let done = 0;
    while (done < length) { const count = fs.readSync(descriptor, bytes, done, length - done, offset + done); if (!count) return null; done += count; }
    return bytes;
  } finally { fs.closeSync(descriptor); }
}
function decodeTitle(bytes, encoding) {
  const nul = bytes.indexOf(0), raw = bytes.subarray(0, nul < 0 ? bytes.length : nul);
  const labels = { sjis: "shift_jis", gbk: "gbk", utf8: "utf-8" };
  try { return new TextDecoder(labels[encoding], { fatal: true }).decode(raw).replace(/[\x00-\x1f\x7f]/g, "").trim() || null; }
  catch { return null; }
}
function inspectScript(file, { detection, textEncoding = "sjis" } = {}) {
  try {
    const stat = statFile(file, detection);
    if (!stat || stat.size < 24 || stat.size > LIMITS.scriptBytes) return null;
    const head = readAt(file, 0, 4, detection); if (!head) return null;
    const sysDescOffset = head.readUInt32LE(0);
    if (sysDescOffset < 5 || sysDescOffset > stat.size - 16) return null;
    const bytes = readAt(file, sysDescOffset, Math.min(stat.size - sysDescOffset, LIMITS.descriptorBytes), detection);
    if (!bytes || bytes.length < 16) return null;
    const entryPoint = bytes.readUInt32LE(0), mode = bytes[8], titleBytes = bytes[10];
    if (entryPoint < 4 || entryPoint >= sysDescOffset || !RESOLUTIONS[mode] || !titleBytes || 11 + titleBytes + 4 > bytes.length) return null;
    const initial = readAt(file, entryPoint, 1, detection); if (!initial || initial[0] > 39) return null;
    const rawTitle = bytes.subarray(11, 11 + titleBytes), title = decodeTitle(rawTitle, textEncoding) || decodeTitle(rawTitle, "utf8") || decodeTitle(rawTitle, "gbk");
    if (!title) return null;
    let offset = 11 + titleBytes;
    const syscallCount = bytes.readUInt16LE(offset); offset += 2;
    if (syscallCount < 2 || syscallCount > LIMITS.syscalls) return null;
    const syscalls = [], names = new Set();
    for (let id = 0; id < syscallCount; id++) {
      if (offset + 2 > bytes.length) return null;
      const args = bytes[offset++], length = bytes[offset++];
      if (!length || args > 64 || offset + length > bytes.length) return null;
      const raw = bytes.subarray(offset, offset + length); offset += length;
      const end = raw.indexOf(0), name = raw.subarray(0, end < 0 ? raw.length : end).toString("ascii");
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || names.has(name) || raw.subarray(0, end < 0 ? raw.length : end).some(byte => byte > 127)) return null;
      names.add(name); syscalls.push({ id, name, args });
    }
    if (offset + 2 > bytes.length || [...names].filter(name => KNOWN_SYSCALLS.has(name)).length < 2) return null;
    const customSyscallCount = bytes.readUInt16LE(offset);
    return { path: file, name: path.basename(file), bytes: stat.size, identity: identity(stat), sysDescOffset, entryPoint,
      title, textEncoding, resolution: RESOLUTIONS[mode].join(" × "), width: RESOLUTIONS[mode][0], height: RESOLUTIONS[mode][1],
      syscallCount, customSyscallCount, syscalls, descriptorBytes: offset + 2 };
  } catch (error) { propagate(error); return null; }
}
function inspectArchive(file, { detection } = {}) {
  try {
    const stat = statFile(file, detection); if (!stat || stat.size < 22) return null;
    const header = readAt(file, 0, 8, detection); if (!header) return null;
    const count = header.readUInt32LE(0), namesBytes = header.readUInt32LE(4), indexBytes = 8 + count * 12 + namesBytes;
    if (!count || count > LIMITS.archiveEntries || !namesBytes || indexBytes > LIMITS.archiveIndexBytes || indexBytes > stat.size) return null;
    // A complete index identifies this signature-less format without reading assets.
    const index = readAt(file, 8, indexBytes - 8, detection); if (!index) return null;
    const names = index.subarray(count * 12);
    if (names[names.length - 1] !== 0) return null;
    for (let i = 0; i < count; i++) {
      const offset = i * 12, nameOffset = index.readUInt32LE(offset), dataOffset = index.readUInt32LE(offset + 4), size = index.readUInt32LE(offset + 8);
      if (nameOffset >= names.length || nameOffset !== 0 && names[nameOffset - 1] !== 0 || names[nameOffset] === 0 || dataOffset < indexBytes || dataOffset > stat.size - size) return null;
    }
    return { path: file, name: path.basename(file), bytes: stat.size, identity: identity(stat), count, indexBytes };
  } catch (error) { propagate(error); return null; }
}
function inspectGame(root, { inputPath, detection, textEncoding = "sjis" } = {}) {
  try {
    const items = detection?.readdir ? detection.readdir(root) : fs.readdirSync(root, { withFileTypes: true });
    if (items.length > LIMITS.files) return null;
    const names = new Map();
    for (const item of items) {
      if (!item.isFile() || item.isSymbolicLink()) continue;
      const key = item.name.normalize("NFC").toLowerCase(); if (names.has(key)) return null;
      names.set(key, item.name);
    }
    const scriptNames = [...names.keys()].filter(name => /\.(?:hcb|bch)$/.test(name));
    if (!scriptNames.length || scriptNames.length > LIMITS.scripts) return null;
    const chosen = inputPath && path.dirname(path.resolve(inputPath)) === path.resolve(root) ? path.basename(inputPath).toLowerCase() : null;
    const stems = new Set(scriptNames.map(name => name.slice(0, -4)));
    if (stems.size !== 1 && !scriptNames.includes(chosen)) return null;
    const scriptName = scriptNames.includes(chosen) ? chosen : scriptNames.find(name => name.endsWith(".bch")) || scriptNames[0];
    const script = inspectScript(path.join(root, names.get(scriptName)), { detection, textEncoding }); if (!script) return null;
    const archiveNames = [...names.keys()].filter(name => name.endsWith(".bin")); if (archiveNames.length > LIMITS.archives) return null;
    const archives = archiveNames.map(name => inspectArchive(path.join(root, names.get(name)), { detection })).filter(Boolean);
    // HCB's descriptor + independently recognized syscall names identify loose
    // exports too; BIN indexes supplement evidence but are not a launch requirement.
    return { format: "FAVORITE / FVP", scriptPath: script.path, selectedScriptPath: scriptNames.includes(chosen) ? script.path : null, scriptName: script.name, title: script.title,
      textEncoding, resolution: script.resolution, width: script.width, height: script.height,
      sysDescOffset: script.sysDescOffset, entryPoint: script.entryPoint, syscallCount: script.syscallCount,
      customSyscallCount: script.customSyscallCount, scriptIdentity: script.identity, scriptBytes: script.bytes,
      archives, archiveCount: archives.length, syscalls: script.syscalls,
      originalRunnerPath: chosen?.endsWith(".exe") ? path.join(root, names.get(chosen) || path.basename(inputPath)) : null,
      compatibility: "RFVP supports newer FVP game data beginning with White Eternity. Compatibility varies by game and translation." };
  } catch (error) { propagate(error); return null; }
}
module.exports = { LIMITS, RESOLUTIONS, inspectScript, inspectArchive, inspectGame, readAt };
