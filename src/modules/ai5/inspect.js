const fs = require("node:fs");
const path = require("node:path");
const { readPeVersion } = require("../shared/runtime/pe-version");

const MAX_INI_BYTES = 64 * 1024;
const SUPPORTED = Object.freeze({
  yuno: "YU-NO (elf Classics)", "yuno-eng": "YU-NO (English translation)", doukyuusei: "Doukyuusei (Windows)",
  doukyuusei2: "Doukyuusei 2 (Windows CD)", kakyuusei: "Kakyuusei (1998 CD)", isaku: "Isaku Renewal", shuusaku: "Shuusaku", aishimai: "Ai Shimai"
});
const TITLES = new Map([["～この世の果てで恋を唄う少女～", "yuno"], ["YU-NO - The Girl that Chants Love at the Edge of the World", "yuno-eng"],
  ["遺作９８", "isaku"], ["Isaku98", "isaku"], ["AISHIMAI", "aishimai"], ["DOUKYUSEI", "doukyuusei"],
  ["同級生２", "doukyuusei2"], ["下級生", "kakyuusei"], ["臭作", "shuusaku"]]);
const INI_NAMES = ["ai5eng.ini", "ai5win.ini", "syuusaku.ini", "aiwin.ini"];
const ARC_KEYS = Object.freeze({ bg: ["arcbgname", "pic"], mes: ["arcmesname", "mes"], bgm: ["arcbgmname", "bgm"],
  voice: ["arcvoicename", "voice"], voice2: ["arcvoice2name"], voicesub: ["arcvoicesubname"], effect: ["arceffectname", "se"],
  data: ["arcdataname", "seq"], priv: ["arcspecialname"], movie: ["arcmoviename", "movie"], sysse: ["arcsysse", "sysse"] });

function io(detection) {
  return { stat: file => detection?.stat ? detection.stat(file) : (() => { try { return fs.statSync(file); } catch { return null; } })(),
    readdir: directory => detection?.readdir ? detection.readdir(directory) : fs.readdirSync(directory, { withFileTypes: true }),
    read: (file, offset, size) => {
      if (detection?.readBytes) return detection.readBytes(file, offset, size);
      const fd = fs.openSync(file, "r"); try { const bytes = Buffer.alloc(size); return bytes.subarray(0, fs.readSync(fd, bytes, 0, size, offset)); } finally { fs.closeSync(fd); }
    } };
}

function decodeIni(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) return bytes.subarray(3).toString("utf8");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return new TextDecoder("shift_jis", { fatal: true }).decode(bytes); }
}
function parseIni(text) {
  const result = {}; let section = "";
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^[;#]/.test(trimmed)) continue;
    const heading = /^\[([^\]\x00-\x1f]+)\]\s*(?:[;#].*)?$/.exec(trimmed);
    if (heading) { section = heading[1].trim().toLowerCase(); result[section] ||= {}; continue; }
    const field = /^([^=\x00-\x1f]+)=(.*)$/.exec(trimmed);
    if (field && section) {
      const key = field[1].trim().toLowerCase();
      // Different legacy keys can name the same archive. Preserve assignment
      // order, including repeated keys, to match the native INI handler.
      delete result[section][key];
      result[section][key] = field[2].trim().replace(/^"(.*)"$/, "$1");
    }
  }
  return result;
}
function localFile(root, reference, access, { windowsInstallPath = false } = {}) {
  if (typeof reference !== "string" || !reference || /[\x00-\x1f]/.test(reference)) return null;
  let normalized = reference.replace(/\\/g, "/");
  // Original Windows INIs often retain a drive/install prefix. Use only an
  // existing local basename from the selected game, never an external path.
  if (/^[a-z]:\//i.test(normalized) && windowsInstallPath) normalized = path.posix.basename(normalized);
  if (path.posix.isAbsolute(normalized) || normalized.split("/").some(part => !part || part === "." || part === "..")) return null;
  let current = root;
  for (const part of normalized.split("/")) {
    const matches = access.readdir(current).filter(entry => entry.name.toLowerCase() === part.toLowerCase());
    if (matches.length !== 1) return null;
    current = path.join(current, matches[0].name);
  }
  if (!access.stat(current)?.isFile()) return null;
  const realRoot = fs.realpathSync(root), realFile = fs.realpathSync(current);
  return realFile.startsWith(realRoot + path.sep) ? current : null;
}

function validName(bytes) {
  const end = bytes.indexOf(0), name = bytes.subarray(0, end < 0 ? bytes.length : end).toString("latin1");
  return name && /^[\x20-\x7e]+$/.test(name) && !/[\/:]/.test(name) && name !== "." && name !== ".." ? name : null;
}

// These tables/schemes are derived from pinned libai5/src/arc/open.c. Read only
// metadata: infer typical XOR from three entries, then validate its full index
// in <=2 MiB chunks. Kakyuusei uses a <=2 MiB shuffled index. No game payload is
// decompressed to identify the archive; filenames alone never establish AI5.
function inspectArchive(file, profile, detection, wantedName) {
  const access = io(detection), stat = access.stat(file);
  if (!stat?.isFile() || stat.size < 64) return null;
  const first = access.read(file, 0, Math.min(stat.size, 4 + 0x318));
  if (!first || first.length < 64) return null;
  let count = first.readUInt32LE(0), layout;
  if (/\.dat$/i.test(file)) {
    const key = first.readUInt32LE(4); count = (count ^ key) >>> 0;
    layout = { index: 8, stride: 28, name: 20, nameOffset: 8, offset: 4, size: 0, nameKey: first[35], offsetKey: key, sizeKey: key, scheme: "DAT XOR" };
  } else if (profile === "kakyuusei") {
    if (!count || count > 100000 || 4 + count * 20 > stat.size) return null;
    const index = access.read(file, 4, count * 20), names = [], shuffle = [17, 2, 8, 19, 0, 5, 10, 13, 1, 15, 6, 4, 11, 16, 3, 9, 18, 12, 7, 14];
    let key = count & 255, wantedEntry = null;
    if (!index || index.length !== count * 20) return null;
    for (let i = 0; i < count; i++) {
      const decoded = Buffer.alloc(20);
      for (let b = 0; b < 20; b++) { decoded[shuffle[b]] = index[i * 20 + b] ^ key; key = (key * 3 + 1) & 255; }
      const name = validName(decoded.subarray(0, 12)), size = decoded.readUInt32LE(12), offset = decoded.readUInt32LE(16);
      if (!name || offset < 4 + count * 20 || offset + size > stat.size) return null;
      if (!wantedEntry && wantedName && name.toLowerCase() === wantedName.toLowerCase()) wantedEntry = { name, offset, size };
      if (i < 16) names.push(name);
    }
    if (wantedName && !wantedEntry) return null;
    return { count, scheme: "Kakyuusei shuffled ARC", entryBytes: 20, names, inspectedEntries: count, wantedEntry };
  } else {
    if (count < 3 || count > 100000 || first.length !== 4 + 0x318) return null;
    for (const nameBytes of [12, 16, 20, 30, 32, 256]) {
      const stride = nameBytes + 8, nameKey = first[4 + nameBytes - 1];
      const decodedName = Buffer.from(first.subarray(4, 4 + nameBytes)); for (let i = 0; i < decodedName.length; i++) decodedName[i] ^= nameKey;
      if (!validName(decodedName)) continue;
      for (const [offsetField, sizeField] of [[nameBytes + 4, nameBytes], [nameBytes, nameBytes + 4]]) {
        const offsetGuess = 4 + count * stride, offsetKey = (first.readUInt32LE(4 + offsetField) ^ offsetGuess) >>> 0;
        const secondOffset = (first.readUInt32LE(4 + stride + offsetField) ^ offsetKey) >>> 0;
        if (secondOffset <= offsetGuess || secondOffset >= stat.size) continue;
        const sizeKey = (first.readUInt32LE(4 + sizeField) ^ (secondOffset - offsetGuess)) >>> 0;
        const secondSize = (first.readUInt32LE(4 + stride + sizeField) ^ sizeKey) >>> 0;
        const thirdOffset = (first.readUInt32LE(4 + stride * 2 + offsetField) ^ offsetKey) >>> 0;
        const thirdSize = (first.readUInt32LE(4 + stride * 2 + sizeField) ^ sizeKey) >>> 0;
        if (secondOffset + secondSize !== thirdOffset || thirdOffset + thirdSize > stat.size) continue;
        layout = { index: 4, stride, name: nameBytes, nameOffset: 0, offset: offsetField, size: sizeField, nameKey, offsetKey, sizeKey, scheme: "ARC XOR" }; break;
      }
      if (layout) break;
    }
  }
  if (!layout || !count || count > 100000 || layout.index + count * layout.stride > stat.size) return null;
  const names = []; let wantedEntry = null;
  const chunkEntries = Math.floor(2 * 1024 * 1024 / layout.stride);
  for (let first = 0; first < count; first += chunkEntries) {
    const length = Math.min(chunkEntries, count - first), chunk = access.read(file, layout.index + first * layout.stride, length * layout.stride);
    if (!chunk || chunk.length !== length * layout.stride) return null;
    for (let i = 0; i < length; i++) {
      const entry = chunk.subarray(i * layout.stride, (i + 1) * layout.stride);
      const bytes = Buffer.from(entry.subarray(layout.nameOffset, layout.nameOffset + layout.name)); for (let b = 0; b < bytes.length; b++) bytes[b] ^= layout.nameKey;
      const name = validName(bytes), offset = (entry.readUInt32LE(layout.offset) ^ layout.offsetKey) >>> 0, size = (entry.readUInt32LE(layout.size) ^ layout.sizeKey) >>> 0;
      if (!name || offset < layout.index + count * layout.stride || offset + size > stat.size) return null;
      if (first + i < 16) names.push(name);
      if (!wantedEntry && wantedName && name.toLowerCase() === wantedName.toLowerCase()) wantedEntry = { name, offset, size };
    }
  }
  if (wantedName && !wantedEntry) return null;
  return { count, scheme: layout.scheme, entryBytes: layout.stride, names, inspectedEntries: count, wantedEntry };
}

function inspectGame(root, { inputPath, detection } = {}) {
  const access = io(detection), names = access.readdir(root);
  const candidates = [...(inputPath && /\.ini$/i.test(inputPath) ? [path.basename(inputPath).toLowerCase()] : []), ...INI_NAMES];
  const iniName = candidates.map(name => names.filter(entry => entry.name.toLowerCase() === name)).find(matches => matches.length === 1)?.[0]?.name;
  if (!iniName) return null;
  const iniPath = localFile(root, iniName, access), stat = iniPath && access.stat(iniPath);
  if (!stat?.isFile() || stat.size > MAX_INI_BYTES) return null;
  const iniBytes = access.read(iniPath, 0, stat.size); let iniText = decodeIni(iniBytes);
  const extraIniPath = localFile(root, "AI5SDL2.INI", access);
  if (extraIniPath) {
    const extraStat = access.stat(extraIniPath);
    if (extraStat.size > MAX_INI_BYTES) throw new Error("AI5SDL2.INI exceeds its configuration size limit.");
    iniText += "\n" + decodeIni(access.read(extraIniPath, 0, extraStat.size));
  }
  const config = parseIni(iniText);
  if (!config.file || (!config.config && !["syuusaku.ini", "aiwin.ini"].includes(iniName.toLowerCase()))) return null;
  const title = config.config?.title || (/[a-z]*syuusaku|^aiwin\.ini$/i.test(iniName) ? "臭作" : null), profile = TITLES.get(title) || null;
  const fileConfig = config.file, archiveReferences = [], missingOptionalArchives = [];
  let archiveMode = profile === "kakyuusei";
  for (const [key, value] of Object.entries(fileConfig)) {
    if (key === "mes") archiveMode = true;
    if (key === "barcmes") archiveMode = Boolean(parseInt(value, 10) || 0);
  }
  for (const [type, keys] of Object.entries(ARC_KEYS)) {
    if (type === "mes" && !archiveMode) continue;
    const key = Object.keys(fileConfig).filter(key => keys.includes(key) && fileConfig[key]).at(-1), value = key && fileConfig[key];
    if (!value) continue;
    const resolved = localFile(root, value, access, { windowsInstallPath: true });
    const normalized = value.replace(/\\/g, "/");
    if (/^[\\/]|^[a-z]:[^\\/]/i.test(value) || normalized.split("/").includes("..")) throw new Error(`AI5 archive '${value}' leaves the game folder.`);
    if (!resolved) {
      if (type === "mes") throw new Error(`AI5 script archive '${value}' was not found.`);
      missingOptionalArchives.push(value); continue;
    }
    archiveReferences.push({ type, key, authoredPath: value, path: resolved });
  }
  const startMes = config.config?.startmes || "START.MES";
  let scriptArchive = archiveReferences.find(reference => reference.type === "mes"), archive = null, looseScript = null;
  if (archiveMode) {
    if (!scriptArchive) {
      const scriptPath = localFile(root, "MES.ARC", access);
      if (!scriptPath) return null;
      scriptArchive = { type: "mes", key: "arcmesname", authoredPath: "MES.ARC", path: scriptPath };
      archiveReferences.push(scriptArchive);
    }
    archive = inspectArchive(scriptArchive.path, profile, detection, startMes);
    if (!archive || !/\.mes$/i.test(startMes) || /[\/:\x00-\x1f]/.test(startMes)) return null;
  } else {
    looseScript = localFile(root, startMes, access);
    if (!looseScript || !config.mes || !["0", "1"].includes(config.mes.bmestype || "")) return null;
    const prefix = access.read(looseScript, 0, 16);
    if (!prefix?.length) return null;
  }
  const derivedExe = iniName.replace(/\.ini$/i, ".exe"), selectedExe = inputPath && /\.exe$/i.test(inputPath) ? localFile(root, path.basename(inputPath), access) : null;
  const originalRunnerPath = selectedExe || localFile(root, derivedExe, access);
  const runner = originalRunnerPath ? readPeVersion(originalRunnerPath, { detection }) : null;
  const engineIdentity = runner && /\bAI5(?:WIN)?\b|\bAIWIN\b/i.test([runner.strings.ProductName, runner.strings.FileDescription].filter(Boolean).join(" "));
  return { iniPath, iniName, extraIniPath, title, gameProfile: profile, gameProfileLabel: SUPPORTED[profile] || null,
    profileSource: profile ? `${iniName} [CONFIG] TITLE` : null, config, archiveReferences, missingOptionalArchives, scriptArchivePath: scriptArchive?.path || null,
    archive, looseScript, startMes, originalRunnerPath, originalRunner: runner,
    detectedVersion: engineIdentity && runner.fileVersion !== "0.0.0.0" ? runner.fileVersion : null,
    detectedVersionSource: engineIdentity ? `${runner.source} (original AI5WIN file version)` : null,
    detectedVersionConfidence: engineIdentity ? "embedded" : "unknown", engineFamily: "AI5WIN" };
}

module.exports = { MAX_INI_BYTES, SUPPORTED, TITLES, INI_NAMES, ARC_KEYS, parseIni, decodeIni, inspectArchive, inspectGame, localFile };
