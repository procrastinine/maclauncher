const fs = require("node:fs");
const path = require("node:path");
const { readPeVersion } = require("../shared/runtime/pe-version");

const LIMITS = Object.freeze({ runners: 8, archives: 64, entries: 100000, headerBytes: 80 });
function access(detection) {
  return {
    stat: file => { try { return detection?.stat ? detection.stat(file) : fs.statSync(file); } catch (error) { if (error.code === "DETECTION_LIMIT") throw error; return null; } },
    names: dir => { try { return (detection?.readdir ? detection.readdir(dir) : fs.readdirSync(dir)).map(entry => typeof entry === "string" ? entry : entry.name); } catch (error) { if (error.code === "DETECTION_LIMIT") throw error; return []; } },
    read: (file, offset, size) => {
      if (detection?.readBytes) return detection.readBytes(file, offset, size);
      const fd = fs.openSync(file, "r"), bytes = Buffer.alloc(size);
      try { if (fs.readSync(fd, bytes, 0, size, offset) !== size) return null; return bytes; } finally { fs.closeSync(fd); }
    }
  };
}
function confined(root, file) {
  try { const original = fs.realpathSync(root), target = fs.realpathSync(file); return target === original || target.startsWith(original + path.sep); } catch { return false; }
}
function inspectKif(file, { detection } = {}) {
  const io = access(detection), stat = io.stat(file);
  if (!stat?.isFile() || stat.size < LIMITS.headerBytes) return null;
  const bytes = io.read(file, 0, LIMITS.headerBytes);
  if (!bytes || bytes.subarray(0, 4).toString("hex") !== "4b494600") return null;
  const entries = bytes.readUInt32LE(4), indexBytes = 8 + entries * 72;
  if (!entries || entries > LIMITS.entries || indexBytes > stat.size) return null;
  const name = bytes.subarray(8, 72), end = name.indexOf(0);
  if (end <= 0) return null;
  const encrypted = name.subarray(0, end).equals(Buffer.from("__key__.dat"));
  if (encrypted && entries < 2) return null;
  if (!encrypted) {
    if (name.subarray(0, end).some(byte => byte < 32)) return null;
    const offset = bytes.readUInt32LE(72), length = bytes.readUInt32LE(76);
    if (offset < indexBytes || offset > stat.size || length > stat.size - offset) return null;
  }
  return { path: file, signature: "KIF", entryNameBytes: 64, entries, encrypted, indexBytes,
    inspectionScope: "bounded-header-and-index-extent; encrypted names/offsets require separate decoding" };
}

// Structural candidate roots only: the imported directory and its one-level
// data sibling. No game/title allowlist, executable execution or asset extraction.
function inspectGame(root, { inputPath = root, detection } = {}) {
  const io = access(detection), roots = [root];
  const nested = io.names(root).filter(name => name.toLowerCase() === "data");
  if (nested.length === 1) roots.push(path.join(root, nested[0]));
  const matches = [];
  for (const dataRoot of roots) {
    if (!io.stat(dataRoot)?.isDirectory() || !confined(root, dataRoot)) continue;
    const names = io.names(dataRoot), scene = names.filter(name => name.toLowerCase() === "scene.int");
    if (scene.length !== 1) continue;
    const scenePath = path.join(dataRoot, scene[0]);
    if (!confined(root, scenePath) || !inspectKif(scenePath, { detection })) continue;
    const exes = names.filter(name => /\.(?:exe|bin)$/i.test(name)).sort((a, b) => {
      const rank = name => path.resolve(dataRoot, name) === path.resolve(inputPath) ? 0 : name.toLowerCase() === "cs2.exe" ? 1 : 2;
      return rank(a) - rank(b) || a.localeCompare(b);
    }).slice(0, LIMITS.runners);
    const runners = [];
    for (const name of exes) {
      const file = path.join(dataRoot, name); if (!confined(root, file)) continue;
      const version = readPeVersion(file, { detection });
      if (!version || ![version.strings.ProductName, version.strings.FileDescription].some(value => /^(?:cs2|catsystem2)$/i.test(value || ""))) continue;
      runners.push({ path: file, ...version });
    }
    if (runners.length !== 1) continue;
    const archiveNames = names.filter(name => /\.int$/i.test(name));
    if (archiveNames.length > LIMITS.archives) continue;
    const archives = archiveNames.sort().flatMap(name => {
      const file = path.join(dataRoot, name); if (!confined(root, file)) return [];
      const info = inspectKif(file, { detection }); return info ? [info] : [];
    });
    const runner = runners[0], fixed = runner.fileVersion;
    const detectedVersion = fixed !== "0.0.0.0" ? fixed : null;
    matches.push({ engineFamily: "CatSystem2", dataRoot, sceneArchivePath: scenePath, originalRunnerPath: runner.path, originalRunner: runner,
      detectedVersion, detectedVersionSource: detectedVersion ? runner.source : null,
      detectedVersionConfidence: detectedVersion ? "embedded" : "unknown", archives,
      requiredFeatures: [
        ...(names.some(name => name.toLowerCase() === "fes.int") ? ["FES startup/system scripts"] : []),
        ...(names.some(name => name.toLowerCase() === "kcs.int") ? ["KCS startup/system scripts"] : []),
        ...(names.some(name => name.toLowerCase() === "emotedriver.dll") ? ["E-mote native plugin"] : [])
      ],
      archiveFormat: "KIF-64", compatibility: "Archive and script tools are available. Native gameplay is not supported.",
      executionStatus: "Tools only; FES/KCS and E-mote playback is unsupported." });
  }
  return matches.length === 1 ? matches[0] : null;
}

module.exports = { LIMITS, inspectKif, inspectGame };
