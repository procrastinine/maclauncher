const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Archive = require("./archive");
const { readPeVersion } = require("../shared/runtime/pe-version");
const manifest = require("./manifest.json");

const IMPACTO = Object.freeze({ version: "0.10.8.810", revision: "ba51381fb65da70697be29e6a817dc4af5c98d19",
  source: "https://github.com/CommitteeOfZero/impacto/tree/ba51381fb65da70697be29e6a817dc4af5c98d19",
  support: "https://github.com/CommitteeOfZero/impacto/issues/1" });
const LIMITS = Object.freeze({ roots: 32, directoryEntries: 4096, archives: 64, totalIndexBytes: 24 * 1024 * 1024,
  scripts: 1024, scriptBytes: 64 * 1024 * 1024, bootStoredBytes: 1024 * 1024, bootDecodedBytes: 1024 * 1024 });

function entries(directory, detection) {
  const result = detection?.readdir ? detection.readdir(directory) : fs.readdirSync(directory, { withFileTypes: true });
  if (result.length > LIMITS.directoryEntries) throw new Error("MAGES. directory exceeds its inspection limit.");
  return result;
}
function findEntry(list, name, kind) {
  const found = list.filter(entry => entry.name.toLowerCase() === name.toLowerCase() && entry[kind === "directory" ? "isDirectory" : "isFile"]());
  if (found.length > 1) throw new Error("Ambiguous case variants in MAGES. data.");
  return found[0] || null;
}
function dataDirectory(root, detection) {
  const list = entries(root, detection), assets = findEntry(list, "USRDIR", "directory");
  const assetDir = assets ? path.join(root, assets.name) : root;
  const assetEntries = assets ? entries(assetDir, detection) : list;
  const script = findEntry(assetEntries, "script.mpk", "file"), system = findEntry(assetEntries, "system.mpk", "file");
  return script && system ? { root, assetDir, rootEntries: list, assetEntries, scriptPath: path.join(assetDir, script.name), systemPath: path.join(assetDir, system.name) } : null;
}
function rootCandidates(root, detection) {
  const absolute = path.resolve(root), results = [];
  if (path.basename(absolute).toLowerCase() === "usrdir") results.push(path.dirname(absolute));
  results.push(absolute);
  const children = entries(absolute, detection).filter(entry => entry.isDirectory() && !/\.app$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Search only one directory level. This handles wrapper folders without
  // scanning an entire library or following symlinked game directories.
  for (const entry of children.slice(0, LIMITS.roots - results.length)) results.push(path.join(absolute, entry.name));
  return [...new Set(results)];
}

function executableMetadata(layout, inputPath, detection) {
  const candidates = layout.rootEntries.filter(entry => entry.isFile() && /\.exe$/i.test(entry.name) &&
    !/(?:launcher|setup|uninstall|^unins|redist)/i.test(entry.name)).sort((a, b) =>
    Number(b.name.toLowerCase() === "game.exe") - Number(a.name.toLowerCase() === "game.exe") ||
    Number(path.join(layout.root, b.name) === inputPath) - Number(path.join(layout.root, a.name) === inputPath) || a.name.localeCompare(b.name));
  for (const runner of candidates.slice(0, 4)) {
    const originalRunnerPath = path.join(layout.root, runner.name), originalRunner = readPeVersion(originalRunnerPath, { detection });
    if (/\bMAGES\b/i.test(originalRunner?.strings?.CompanyName || "")) return { originalRunnerPath, originalRunner };
  }
  const runner = candidates.find(entry => entry.name.toLowerCase() === "game.exe");
  return { originalRunnerPath: runner ? path.join(layout.root, runner.name) : null, originalRunner: null };
}

function patchMetadata(layout, detection) {
  const directory = findEntry(layout.rootEntries, "languagebarrier", "directory");
  if (!directory) return null;
  const patchDir = path.join(layout.root, directory.name), files = entries(patchDir, detection);
  const version = findEntry(files, "versioninfo.json", "file");
  if (!version) return { present: true, channel: null, intVersion: null };
  try {
    const file = path.join(patchDir, version.name), stat = detection?.stat ? detection.stat(file) : fs.statSync(file);
    if (!stat?.isFile() || stat.size > 65536) return { present: true, channel: null, intVersion: null };
    const raw = detection?.readText ? detection.readText(file, 65536) : fs.readFileSync(file, "utf8"), value = JSON.parse(raw);
    return { present: true, channel: /^[a-z0-9_-]{1,64}$/i.test(value?.channel || "") ? value.channel : null,
      intVersion: Number.isSafeInteger(value?.intVersion) && value.intVersion >= 0 ? value.intVersion : null };
  } catch (error) { if (error.code === "DETECTION_LIMIT") throw error; return { present: true, channel: null, intVersion: null }; }
}

function compatibility(edition) {
  if (manifest.supports.launch && edition === "steins-gate-windows-hd")
    return "Runs the Windows HD data profile with native input, voice, sound effects and Bink 2 video.";
  return edition === "steins-gate-windows-hd"
    ? `Impacto ${IMPACTO.version} has no Windows STEINS;GATE profile. Its STEINS;GATE profile targets English PS3 CPK data and the SGPS3 instruction set.`
    : `Native gameplay is unavailable: no compatible Windows MPK/SC3 game profile is available for Impacto ${IMPACTO.version}.`;
}

function inspectLayout(layout, { inputPath, detection } = {}) {
  // Import reads indexes and one small boot program, never the large asset
  // payloads. Every read participates in the shared detection byte budget.
  const script = Archive.inspectArchive(layout.scriptPath, { detection, maximumIndexBytes: 2 * 1024 * 1024 });
  const system = Archive.inspectArchive(layout.systemPath, { detection, maximumIndexBytes: 2 * 1024 * 1024 });
  const candidates = [...script.members.values()].filter(member => /\.scx$/i.test(member.name)).sort((a, b) =>
    Number(/(?:^|[\\/])_startup_win\.scx$/i.test(b.name)) - Number(/(?:^|[\\/])_startup_win\.scx$/i.test(a.name)) ||
    Number(/startup/i.test(b.name)) - Number(/startup/i.test(a.name)) || a.id - b.id);
  let boot;
  for (const member of candidates.slice(0, 8)) {
    try {
      const data = Archive.readMember(script, member, { detection, maximumBytes: LIMITS.bootStoredBytes, maximumOutput: LIMITS.bootDecodedBytes });
      const structure = Archive.inspectScript(data);
      if (structure.empty) continue;
      boot = { filename: member.name, id: member.id, storedBytes: member.storedBytes, decodedBytes: data.length, ...structure }; break;
    } catch (error) { if (error.code === "DETECTION_LIMIT") throw error; }
  }
  if (!boot) throw new Error("No validated SC3 boot program was found in script.mpk.");
  const runner = executableMetadata(layout, inputPath, detection), patch = patchMetadata(layout, detection);
  const product = runner.originalRunner?.strings?.ProductName?.trim();
  const isSteins = /^steins\s*;\s*gate$/i.test(product || "");
  const windows = script.members.has("_startup_win.scx");
  const bink2 = Boolean(findEntry(layout.rootEntries, "bink2w32.dll", "file"));
  const steam = Boolean(findEntry(layout.rootEntries, "steam_api.dll", "file"));
  const editionId = isSteins && windows && bink2 ? "steins-gate-windows-hd" : windows ? "windows-mpk-sc3" : "mpk-sc3";
  const edition = editionId === "steins-gate-windows-hd" ? `STEINS;GATE Windows HD${steam ? " (Steam data)" : ""}` : windows ? "Windows MPK / SC3" : "MPK / SC3 (edition unknown)";
  return { title: product && product.length <= 256 ? product : path.basename(layout.root), contentRootDir: layout.root,
    assetDir: layout.assetDir, scriptArchivePath: script.file, systemArchivePath: system.file,
    archiveFormat: script.format, scriptFormat: "SC3", scriptCount: candidates.length,
    scriptIndexBytes: script.bytesRead, systemIndexBytes: system.bytesRead, boot,
    ...runner, editionId, edition, editionSource: [runner.originalRunner?.source, windows && "script.mpk!/_STARTUP_WIN.SCX", bink2 && "bink2w32.dll", steam && "steam_api.dll"].filter(Boolean).join("; "),
    patch, compatibility: compatibility(editionId), nativeSupport: { supported: manifest.supports.launch && editionId === "steins-gate-windows-hd",
      scope: "Original Windows HD data", reason: compatibility(editionId), impacto: IMPACTO },
    detectedVersion: "unknown", detectedVersionConfidence: "unknown",
    detectedVersionSource: "MPK 2.0 / SC3 structures; executable file and product versions identify this game build, not a common MAGES. engine version" };
}

function inspectGame(rootDir, options = {}) {
  if (typeof rootDir !== "string" || !rootDir) return null;
  try {
    const matches = new Map();
    for (const root of rootCandidates(rootDir, options.detection)) {
      try {
        const layout = dataDirectory(root, options.detection);
        if (layout) {
          const key = fs.realpathSync(layout.scriptPath);
          if (!matches.has(key)) matches.set(key, inspectLayout(layout, options));
        }
      }
      catch (error) { if (error.code === "DETECTION_LIMIT") throw error; }
    }
    // Multiple real games under a wrapper folder require a precise import.
    return matches.size === 1 ? matches.values().next().value : null;
  } catch (error) { if (error.code === "DETECTION_LIMIT") throw error; return null; }
}

function inspectArchives(rootDir) {
  const game = inspectGame(rootDir);
  if (!game) throw new Error("A unique validated MAGES. MPK/SC3 game was not found.");
  const files = entries(game.assetDir).filter(entry => entry.isFile() && /\.mpk$/i.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (files.length > LIMITS.archives) throw new Error("MAGES. archive count exceeds its inspection limit.");
  let indexBytes = 0;
  const archives = [], skippedArchives = [];
  for (const item of files) {
    const remaining = Math.min(Archive.LIMITS.indexBytes, LIMITS.totalIndexBytes - indexBytes);
    if (remaining < 64) throw new Error("MAGES. archive indexes exceed their aggregate inspection limit.");
    try {
      const archive = Archive.inspectArchive(path.join(game.assetDir, item.name), { maximumIndexBytes: remaining });
      indexBytes += archive.bytesRead;
      archives.push({ filename: item.name, format: archive.format, memberCount: archive.members.size, paddingEntries: archive.paddingEntries,
        fileBytes: archive.size, indexBytes: archive.bytesRead,
        compressedMembers: [...archive.members.values()].filter(member => member.compression === 1).length });
    } catch (error) { indexBytes += error.archiveBytesRead || 0; skippedArchives.push({ filename: item.name, reason: error.message }); }
  }
  return { edition: game.edition, originalRunner: game.originalRunner, compatibility: game.compatibility, archives, skippedArchives,
    archiveCount: archives.length, scannedArchives: files.length, complete: skippedArchives.length === 0, indexBytes, impacto: IMPACTO };
}

function inspectScripts(rootDir) {
  const game = inspectGame(rootDir);
  if (!game) throw new Error("A unique validated MAGES. MPK/SC3 game was not found.");
  const archive = Archive.inspectArchive(game.scriptArchivePath), scripts = [], skippedScripts = [];
  const candidates = [...archive.members.values()].filter(member => /\.scx$/i.test(member.name));
  if (candidates.length > LIMITS.scripts) throw new Error("MAGES. script count exceeds its inspection limit.");
  let scriptBytes = 0, storedScriptBytes = 0;
  for (const member of candidates) {
    if (member.storedBytes > LIMITS.scriptBytes - storedScriptBytes) throw new Error("MAGES. stored scripts exceed their aggregate inspection limit.");
    storedScriptBytes += member.storedBytes;
    if (member.decodedBytes > LIMITS.scriptBytes - scriptBytes) throw new Error("MAGES. scripts exceed their aggregate inspection limit.");
    try {
      const data = Archive.readMember(archive, member); scriptBytes += data.length;
      scripts.push({ filename: member.name, relativePath: member.relativePath, id: member.id, archiveOffset: member.offset,
        storedBytes: member.storedBytes, decodedBytes: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex"), ...Archive.inspectScript(data) });
    } catch (error) { skippedScripts.push({ filename: member.name, reason: error.message }); }
  }
  return { edition: game.edition, archivePath: archive.file, archiveFormat: archive.format, scriptFormat: "SC3", scripts, skippedScripts,
    programCount: scripts.length, scriptBytes, storedScriptBytes, indexBytes: archive.bytesRead, complete: skippedScripts.length === 0,
    nativeSupport: game.nativeSupport, originalRunner: game.originalRunner };
}

module.exports = { IMPACTO, LIMITS, inspectGame, inspectArchives, inspectScripts, compatibility };
