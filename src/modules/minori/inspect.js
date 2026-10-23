const fs = require("node:fs");
const path = require("node:path");
const { readPeVersion } = require("../shared/runtime/pe-version");
const LIMITS = Object.freeze({ headerBytes: 36, indexBytes: 4 * 1024 * 1024, rootFiles: 4096, archives: 32 });
const GROUPS = Object.freeze(["scr", "bg", "st", "sys", "bgm", "voice", "se", "mov"]);
function readAt(file, length, detection) {
  if (detection?.readBytes) return detection.readBytes(file, 0, length);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { const bytes = Buffer.alloc(length); return fs.readSync(fd, bytes, 0, length, 0) === length ? bytes : null; }
  finally { fs.closeSync(fd); }
}
function parseHeader(bytes, fileBytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== LIMITS.headerBytes || !Number.isSafeInteger(fileBytes) || fileBytes < 44) return null;
  const profiles = [];
  for (let key = 0; key <= 255; key++) {
    const indexBytes = ((bytes[32] ^ key) | (bytes[33] ^ key) << 8 | (bytes[34] ^ key) << 16 | (bytes[35] ^ key) << 24) >>> 0;
    if (indexBytes < 4 || indexBytes > LIMITS.indexBytes || indexBytes > fileBytes - LIMITS.headerBytes) continue;
    const prefixBytes = Buffer.alloc(32);
    // A NUL terminates the edition label; the remaining header bytes may be
    // binary edition data. Validate the label rather than assuming padding.
    // Companion labels and independently bounded indexes identify the family.
    for (let index = 0; index < prefixBytes.length; index++) prefixBytes[index] = bytes[index] ^ key;
    const nul = prefixBytes.indexOf(0), end = nul < 0 ? prefixBytes.length : nul;
    if (!end || prefixBytes.subarray(0, end).some(value => value < 0x20 || value > 0x7e)) continue;
    profiles.push({ xorKey: key, indexBytes, prefix: prefixBytes.subarray(0, end).toString("ascii") });
  }
  return profiles.length === 1 ? profiles[0] : null;
}
function inspectArchive(file, { detection } = {}) {
  try {
    const stat = detection?.stat ? detection.stat(file) : fs.lstatSync(file);
    if (!stat?.isFile() || stat.isSymbolicLink?.() || stat.size > 64 * 1024 * 1024 * 1024) return null;
    const profile = parseHeader(readAt(file, LIMITS.headerBytes, detection), stat.size);
    return profile && { path: file, bytes: stat.size, modified: stat.mtimeMs, changed: stat.ctimeMs,
      identity: [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":"), ...profile };
  } catch (error) { if (error.code === "DETECTION_LIMIT") throw error; return null; }
}
function inspectGame(root, { inputPath, detection } = {}) {
  try {
    const entries = detection?.readdir ? detection.readdir(root) : fs.readdirSync(root, { withFileTypes: true });
    if (entries.length > LIMITS.rootFiles) return null;
    const files = new Map(), archives = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const lower = entry.name.toLowerCase(); if (files.has(lower)) return null;
      files.set(lower, path.join(root, entry.name));
    }
    // One fast inventory, then only bounded headers of expected companion
    // groups. Decryption and payload validation belong to the native tool.
    if (!files.has("scr.paz") || !files.has("sys.paz") || !["bg.paz", "st.paz"].some(name => files.has(name))) return null;
    for (const group of GROUPS) {
      const file = files.get(group + ".paz"); if (!file) continue;
      const archive = inspectArchive(file, { detection }); if (!archive) return null;
      archives.push({ group, ...archive });
    }
    if (archives.some(archive => archive.xorKey !== archives[0].xorKey || archive.prefix !== archives[0].prefix)) return null;
    const runner = inputPath && /\.exe$/i.test(inputPath) && files.get(path.basename(inputPath).toLowerCase()) === inputPath ? inputPath :
      [...files.entries()].filter(([name]) => name.endsWith(".exe")).sort(([a], [b]) => a.localeCompare(b))[0]?.[1];
    const originalRunner = runner && readPeVersion(runner, { detection });
    const runnerStat = runner && (detection?.stat ? detection.stat(runner) : fs.lstatSync(runner));
    return { archiveFormat: "Minori PAZ", headerPrefix: archives[0].prefix, xorKey: archives[0].xorKey,
      archiveProfile: `PAZ / XOR ${archives[0].xorKey.toString(16).padStart(2, "0").toUpperCase()}`,
      title: originalRunner?.strings?.ProductName || path.basename(root), originalRunnerPath: runner || null, originalRunner: originalRunner || null,
      originalRunnerIdentity: runnerStat ? [runnerStat.dev, runnerStat.ino, runnerStat.size, runnerStat.mtimeMs, runnerStat.ctimeMs].join(":") : null,
      originalEngineVersion: null, versionSource: null, cryptoProfile: null,
      archives, supported: null, compatibility: "The native interpreter verifies this edition’s archive and script profile before play." };
  } catch (error) { if (error.code === "DETECTION_LIMIT") throw error; return null; }
}
module.exports = { LIMITS, GROUPS, parseHeader, inspectArchive, inspectGame };
