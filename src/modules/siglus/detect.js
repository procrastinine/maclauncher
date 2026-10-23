const fs = require("node:fs");
const path = require("node:path");
const { readPeVersion } = require("../shared/runtime/pe-version");

const TOC_BYTES = 10000 * 8;
const KNOWN_COMPILERS = new Set([10002, 110002, 1110002]);
const inside = (root, file) => { const relative = path.relative(root, file); return !relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)); };

function reader(detection) {
  let bytes = 0, reads = 0;
  const stat = file => { try { return detection?.stat ? detection.stat(file) : fs.statSync(file); } catch (error) { if (error.code === "DETECTION_LIMIT") throw error; return null; } };
  const list = dir => { try { return detection?.readdir ? detection.readdir(dir) : fs.readdirSync(dir, { withFileTypes: true }).slice(0, 12000); } catch (error) { if (error.code === "DETECTION_LIMIT") throw error; return []; } };
  function read(file, offset, length) {
    if (++reads > 64 || (bytes += length) > 1024 * 1024) return null;
    if (detection?.readBytes) return detection.readBytes(file, offset, length);
    let fd;
    try { const size = Math.min(length, Math.max(0, (stat(file)?.size || 0) - offset)), output = Buffer.alloc(size); fd = fs.openSync(file, "r"); return output.subarray(0, fs.readSync(fd, output, 0, size, offset)); }
    catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function local(root, relative) {
    if (!relative || path.isAbsolute(relative) || relative.includes("\0")) return null;
    let candidate = root;
    for (const component of relative.replace(/\\/g, "/").split("/")) {
      if (!component || component === ".") continue;
      if (component === "..") return null;
      const entries = list(candidate).filter(entry => entry.name.toLowerCase() === component.toLowerCase());
      if (entries.length !== 1) return null;
      candidate = path.join(candidate, entries[0].name);
    }
    try { if (!inside(fs.realpathSync(root), fs.realpathSync(candidate))) return null; } catch { return null; }
    return candidate;
  }
  return { stat, list, read, local };
}

function decodeIni(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.includes(0)) return null;
  // Engine directives and version strings are ASCII. Preserve non-ASCII titles
  // through the declared Japanese encoding; scripts choose their own encoding.
  return new TextDecoder("shift-jis").decode(bytes).replace(/^\uFEFF/, "");
}

function iniMetadata(text) {
  const fields = {};
  for (const line of (text || "").split(/\r?\n/)) {
    const match = /^\s*#([A-Z0-9_.]+)\s*=\s*(.*)$/i.exec(line);
    if (match && !Object.hasOwn(fields, match[1].toUpperCase())) fields[match[1].toUpperCase()] = match[2];
  }
  const quoted = value => /"([^"\r\n]*)"/.exec(value || "")?.[1] || null;
  const fold = [...(fields["FOLDNAME.TXT"] || "").matchAll(/"([^"\r\n]*)"/g)].map(match => match[1]);
  const dlls = Object.entries(fields).filter(([key]) => /^DLL\.\d+$/.test(key)).map(([, value]) => quoted(value)).filter(Boolean);
  return { title: quoted(fields.CAPTION), gameVersion: quoted(fields.VERSION_STR), registryName: quoted(fields.REGNAME),
    scenarioFolder: fold[0] || "", scenarioFilename: fold[1] || "SEEN.TXT", dlls };
}

function parseRealLiveHeader(bytes, size) {
  if (!bytes || bytes.length < 0x34) return null;
  const headerSize = bytes.readUInt32LE(0), compilerVersion = bytes.readUInt32LE(4);
  if (![0x1d0, 0x1cc].includes(headerSize) || size < headerSize || compilerVersion < 10000 || compilerVersion > 9999999) return null;
  const codeOffset = bytes.readUInt32LE(0x20), unpacked = bytes.readUInt32LE(0x24), packed = bytes.readUInt32LE(0x28);
  if (codeOffset < headerSize || codeOffset > size || !unpacked || unpacked > 128 * 1024 * 1024 || !packed || packed > size - codeOffset) return null;
  const kidokuOffset = bytes.readUInt32LE(8), kidokuCount = bytes.readUInt32LE(12);
  if (kidokuCount > 10000000 || kidokuOffset > size || kidokuCount * 4 > size - kidokuOffset) return null;
  return { headerSize, compilerVersion, secondaryXor: compilerVersion === 110002 || compilerVersion === 1110002,
    interpreterSupported: headerSize === 0x1d0 && KNOWN_COMPILERS.has(compilerVersion) };
}

function inspectSeen(file, io) {
  const size = io.stat(file)?.size || 0, head = io.read(file, 0, Math.min(size, TOC_BYTES));
  if (!head) return null;
  if (head.toString("ascii", 0, 4) === "PACL") {
    if (head.length < 32) return null;
    const count = head.readUInt32LE(16), tableEnd = 32 + count * 32;
    if (!count || count > 10000 || tableEnd > size) return null;
    const table = tableEnd <= head.length ? head.subarray(32, tableEnd) : io.read(file, 32, count * 32);
    if (!table || table.length !== count * 32) return null;
    let scenarios = 0;
    for (let index = 0; index < count; index++) {
      const at = index * 32, name = table.toString("ascii", at, at + 16).replace(/\0.*$/, ""), offset = table.readUInt32LE(at + 16), packed = table.readUInt32LE(at + 20), unpacked = table.readUInt32LE(at + 24);
      if (!name || offset < tableEnd || packed < 5 || offset > size || packed > size - offset || !unpacked || unpacked > 128 * 1024 * 1024) return null;
      if (/^SEEN\d{3}\.TXT$/i.test(name)) scenarios++;
    }
    return scenarios ? { engineKind: "avg32", format: "PACL", scenarios, compilerVersion: null, interpreterSupported: true } : null;
  }
  if (size < TOC_BYTES || head.length < TOC_BYTES) return null;
  const entries = [];
  for (let number = 0; number < 10000; number++) {
    const offset = head.readUInt32LE(number * 8), length = head.readUInt32LE(number * 8 + 4);
    if (!offset && !length) continue;
    if (offset < TOC_BYTES || length < 0x1cc || offset > size || length > size - offset) return null;
    entries.push({ number, offset, length });
  }
  if (!entries.length) return null;
  const samples = entries.slice(0, 6).map(entry => ({ ...entry, header: parseRealLiveHeader(io.read(file, entry.offset, 0x34), entry.length) }));
  if (samples.some(entry => !entry.header)) return null;
  const compilers = [...new Set(samples.map(entry => entry.header.compilerVersion))];
  return { engineKind: "reallive", format: "RealLive SEEN", scenarios: entries.length, samples: samples.map(entry => ({ number: entry.number, ...entry.header })),
    compilerVersion: compilers.length === 1 ? compilers[0] : null, compilerVersions: compilers,
    interpreterSupported: samples.every(entry => entry.header.interpreterSupported) };
}

function inspectScenePack(file, io) {
  const size = io.stat(file)?.size || 0, head = io.read(file, 0, 256);
  if (!head || head.length < 92) return null;
  const signature = head.toString("ascii", 0, 8) === "pack_scn", base = signature ? 8 : 0;
  if (head.length < base + 92) return null;
  const value = index => head.readInt32LE(base + index * 4), headerSize = value(0);
  if (headerSize < 92 || headerSize > 4096 || headerSize > size) return null;
  for (const [offsetIndex, countIndex, unit] of [[1, 2, 8], [3, 4, 8], [7, 8, 8], [9, 10, 8], [13, 14, 8], [17, 18, 8]]) {
    const offset = value(offsetIndex), count = value(countIndex);
    if (count < 0 || count > 100000 || offset < 0 || offset > size || count * unit > size - offset || (count && offset < headerSize)) return null;
  }
  const scenes = value(20) || value(18), dataBase = value(19), indexBase = value(17), keyMode = value(21);
  if (!scenes || scenes < 0 || scenes > 100000 || value(18) < scenes || dataBase < headerSize || dataBase > size || ![0, 1].includes(keyMode)) return null;
  const index = io.read(file, indexBase, Math.min(scenes, 6) * 8);
  if (!index || index.length !== Math.min(scenes, 6) * 8) return null;
  for (let at = 0; at < index.length; at += 8) {
    const offset = index.readInt32LE(at), length = index.readInt32LE(at + 4);
    if (offset < 0 || length <= 0 || dataBase + offset > size || length > size - dataBase - offset) return null;
  }
  return { engineKind: "siglus", format: signature ? "pack_scn" : "Siglus legacy scene pack", headerSize, scenarios: scenes,
    secondaryKeyRequired: Boolean(keyMode), interpreterSupported: true };
}

function inspectGame(root, { inputPath, detection } = {}) {
  const io = reader(detection);
  if (!io.stat(root)?.isDirectory()) return null;
  const iniPath = io.local(root, "Gameexe.ini"), scenePath = io.local(root, "Scene.pck"), datPath = io.local(root, "Gameexe.dat");
  let metadata = {};
  if (iniPath && (io.stat(iniPath)?.size || 0) <= 256 * 1024) metadata = iniMetadata(decodeIni(io.read(iniPath, 0, io.stat(iniPath).size)));
  let info, scenarioPath;
  if (scenePath) { info = inspectScenePack(scenePath, io); scenarioPath = scenePath; }
  if (!info && iniPath) {
    const candidates = [...new Set([metadata.scenarioFolder ? `${metadata.scenarioFolder}/${metadata.scenarioFilename}` : metadata.scenarioFilename, `DAT/${metadata.scenarioFilename || "SEEN.TXT"}`, metadata.scenarioFilename || "SEEN.TXT"])];
    for (const relative of candidates) {
      const file = io.local(root, relative);
      if (file) info = inspectSeen(file, io);
      if (info) { scenarioPath = file; break; }
    }
    if (!info) {
      const directory = metadata.scenarioFolder && io.local(root, metadata.scenarioFolder) || root;
      for (const entry of io.list(directory).filter(entry => entry.isFile() && /^SEEN\d{3,4}\.TXT$/i.test(entry.name)).slice(0, 6)) {
        const file = io.local(root, path.relative(root, path.join(directory, entry.name))), size = file && io.stat(file)?.size;
        const header = size && parseRealLiveHeader(io.read(file, 0, 0x34), size);
        if (header) { info = { engineKind: "reallive", format: "RealLive loose scenario", scenarios: null, ...header }; scenarioPath = file; break; }
      }
    }
  }
  if (!info) return null;
  const selected = inputPath && /\.exe$/i.test(inputPath) && inside(root, inputPath) && io.stat(inputPath)?.isFile() ? inputPath : null;
  const runners = selected ? [selected] : io.list(root).filter(entry => entry.isFile() && /\.exe$/i.test(entry.name) && /^(?:siglus|reallive|kinetic|avgwin)/i.test(entry.name)).map(entry => path.join(root, entry.name)).slice(0, 4);
  const originalRunnerPath = runners[0] || null, originalRunner = originalRunnerPath && readPeVersion(originalRunnerPath, { detection });
  const labels = { siglus: "SiglusEngine", reallive: "RealLive", avg32: "AVG32" };
  return { ...info, ...metadata, engineLabel: labels[info.engineKind], iniPath, datPath, scenarioPath, originalRunnerPath, originalRunner,
    detectedVersion: originalRunner?.fileVersion || null, detectedVersionSource: originalRunner?.source || null,
    detectedVersionConfidence: originalRunner ? "exact" : null, scriptVersion: info.compilerVersion ? String(info.compilerVersion) : null };
}

function detectGame(context) {
  if (context.isAppBundle) return null;
  const data = inspectGame(context.rootDir, { inputPath: context.inputPath, detection: context.detection });
  if (!data) return null;
  return { moduleId: "siglus", engine: data.engineKind, gamePath: context.rootDir, contentRootDir: context.rootDir,
    name: data.title || path.basename(context.rootDir), runtimeId: "siglus", moduleData: data,
    iconPath: (() => { const io = reader(context.detection); return io.local(context.rootDir, "icon.ico") || io.list(context.rootDir).filter(entry => entry.isFile() && /\.ico$/i.test(entry.name)).map(entry => io.local(context.rootDir, entry.name)).find(Boolean) || null; })(),
    detectionEvidence: [{ type: "validated-script-archive", path: data.scenarioPath, format: data.format,
      ...(data.compilerVersion ? { compilerVersion: data.compilerVersion } : {}) },
      ...(data.iniPath ? [{ type: "game-configuration", path: data.iniPath }] : [])] };
}

module.exports = { detectGame, inspectGame, parseRealLiveHeader, inspectSeen, inspectScenePack, iniMetadata, reader, KNOWN_COMPILERS };
