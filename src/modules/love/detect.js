const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const Zip = require("../shared/runtime/zip");
const SevenZip = require("../shared/runtime/sevenzip");
const { normalizeLoveVersion } = require("./version");

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const MAX_TEXT_ENTRY_BYTES = 512 * 1024;
const PE_MAGIC = Buffer.from("MZ", "ascii");
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function existsFile(filePath) {
  const stat = safeStat(filePath);
  return Boolean(stat && stat.isFile());
}

function existsDir(filePath) {
  const stat = safeStat(filePath);
  return Boolean(stat && stat.isDirectory());
}

function normalizeZipEntryName(name) {
  return String(name || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
}

function readLocalHeader(fd, offset) {
  if (!Number.isFinite(offset) || offset < 0) return null;
  const header = Buffer.alloc(30);
  const read = fs.readSync(fd, header, 0, header.length, offset);
  if (read < header.length) return null;
  if (header.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIGNATURE) return null;
  return {
    method: header.readUInt16LE(8),
    nameLength: header.readUInt16LE(26),
    extraLength: header.readUInt16LE(28)
  };
}

function readZipEntryBuffer(fd, entry, maxBytes = MAX_TEXT_ENTRY_BYTES) {
  const localOffset = Number(entry?.absoluteLocalHeaderOffset);
  const compressedSize = Number(entry?.compressedSize);
  if (!Number.isFinite(localOffset) || localOffset < 0) return null;
  if (!Number.isFinite(compressedSize) || compressedSize < 0) return null;
  if (compressedSize > maxBytes * 2) return null;
  const local = readLocalHeader(fd, localOffset);
  if (!local) return null;
  const dataOffset = localOffset + 30 + local.nameLength + local.extraLength;
  if (!Number.isFinite(dataOffset) || dataOffset < 0) return null;
  const compressed = Buffer.alloc(compressedSize);
  const read = fs.readSync(fd, compressed, 0, compressedSize, dataOffset);
  if (read < compressedSize) return null;
  if (local.method === 0) {
    return compressed.length <= maxBytes ? compressed : null;
  }
  if (local.method === 8) {
    try {
      const zlib = require("node:zlib");
      const uncompressed = zlib.inflateRawSync(compressed);
      return uncompressed.length <= maxBytes ? uncompressed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function stripLuaComments(text) {
  return String(text || "")
    .replace(/--\[\[[\s\S]*?\]\]/g, "")
    .replace(/--[^\n\r]*/g, "");
}

function parseLoveConf(text) {
  const cleaned = stripLuaComments(text);
  const matchString = pattern => {
    const match = cleaned.match(pattern);
    return match && match[1] ? match[1].trim() : null;
  };
  return {
    version: matchString(/\bt\.version\s*=\s*["']([^"']+)["']/),
    identity: matchString(/\bt\.identity\s*=\s*["']([^"']+)["']/),
    icon: matchString(/\bt\.window\.icon\s*=\s*["']([^"']+)["']/)
  };
}

function fileStartsWith(filePath, magic) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(magic.length);
    const read = fs.readSync(fd, buffer, 0, magic.length, 0);
    return read === magic.length && buffer.equals(magic);
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function looksLikePeBinary(filePath) {
  return fileStartsWith(filePath, PE_MAGIC);
}

function looksLikeElfBinary(filePath) {
  return fileStartsWith(filePath, ELF_MAGIC);
}

function findArchiveMainEntry(entries) {
  const normalized = (entries || []).map(entry => ({
    entry,
    name: normalizeZipEntryName(entry?.name || "")
  }));
  const exact = normalized.find(item => item.name.toLowerCase() === "main.lua");
  if (exact) return exact.entry;
  const fallback = normalized
    .filter(item => item.name.toLowerCase().endsWith("/main.lua"))
    .sort((a, b) => a.name.length - b.name.length);
  return fallback[0]?.entry || null;
}

function buildSiblingEntryCandidates(mainEntryName, fileName) {
  const normalized = normalizeZipEntryName(mainEntryName);
  if (!normalized) return [fileName];
  const dirName = path.posix.dirname(normalized);
  if (!dirName || dirName === ".") return [fileName];
  return [`${dirName}/${fileName}`, fileName];
}

function findArchiveEntry(entries, candidates) {
  const wanted = new Set((candidates || []).map(item => normalizeZipEntryName(item).toLowerCase()));
  const matches = (entries || [])
    .map(entry => ({ entry, name: normalizeZipEntryName(entry?.name || "") }))
    .filter(item => wanted.has(item.name.toLowerCase()));
  matches.sort((a, b) => a.name.length - b.name.length);
  return matches[0]?.entry || null;
}

function readArchiveTextEntry(filePath, entry) {
  if (!entry) return null;
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = readZipEntryBuffer(fd, entry, MAX_TEXT_ENTRY_BYTES);
    return buffer ? buffer.toString("utf8") : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function inspectLoveArchive(filePath) {
  const zip = Zip.readZipEntries(filePath);
  if (!zip || !Array.isArray(zip.entries) || zip.entries.length === 0) return null;
  const mainEntry = findArchiveMainEntry(zip.entries);
  if (!mainEntry) return { entries: zip.entries, mainEntry: null, confEntry: null, parsedConf: null };
  const confEntry = findArchiveEntry(zip.entries, buildSiblingEntryCandidates(mainEntry.name, "conf.lua"));
  const confText = readArchiveTextEntry(filePath, confEntry);
  return {
    entries: zip.entries,
    mainEntry,
    confEntry,
    confText,
    parsedConf: confText ? parseLoveConf(confText) : null
  };
}

function readTextFile(filePath, maxBytes = MAX_TEXT_ENTRY_BYTES) {
  try {
    const buffer = fs.readFileSync(filePath);
    if (buffer.length > maxBytes) return buffer.subarray(0, maxBytes).toString("utf8");
    return buffer.toString("utf8");
  } catch {
    return null;
  }
}

function parsePlistJsonSync(plistPath) {
  try {
    const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath], {
      encoding: "utf8"
    });
    if (result.status !== 0 || !result.stdout) return null;
    const parsed = JSON.parse(result.stdout);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function readXmlPlistValue(plistPath, key) {
  const raw = readTextFile(plistPath, 128 * 1024);
  if (!raw) return null;
  const escapedKey = String(key || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = raw.match(new RegExp(`<key>${escapedKey}</key>\\s*<string>([^<]+)</string>`));
  return match && match[1] ? match[1].trim() : null;
}

function readAppBundleMetadata(appPath) {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  const plist = parsePlistJsonSync(plistPath) || null;
  return {
    bundleName:
      typeof plist?.CFBundleName === "string" && plist.CFBundleName.trim()
        ? plist.CFBundleName.trim()
        : readXmlPlistValue(plistPath, "CFBundleName") ||
          path.basename(appPath, ".app"),
    executableName:
      typeof plist?.CFBundleExecutable === "string" && plist.CFBundleExecutable.trim()
        ? plist.CFBundleExecutable.trim()
        : readXmlPlistValue(plistPath, "CFBundleExecutable") || null,
    version:
      typeof plist?.CFBundleShortVersionString === "string" &&
      plist.CFBundleShortVersionString.trim()
        ? plist.CFBundleShortVersionString.trim()
        : readXmlPlistValue(plistPath, "CFBundleShortVersionString") || null
  };
}

function walkFiles(rootDir, predicate, maxDepth = 4) {
  const matches = [];
  const stack = [{ dir: rootDir, depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    if (!current) break;
    let entries = [];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.name) continue;
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < maxDepth) stack.push({ dir: full, depth: current.depth + 1 });
        continue;
      }
      if (entry.isFile() && predicate(full, entry.name)) matches.push(full);
    }
  }
  return matches;
}

function findEmbeddedLoveArchive(appPath) {
  const resourcesDir = path.join(appPath, "Contents", "Resources");
  if (!existsDir(resourcesDir)) return null;
  const matches = walkFiles(
    resourcesDir,
    (_full, name) => name.toLowerCase().endsWith(".love"),
    3
  );
  return matches.length === 1 ? matches[0] : null;
}

function extractPrintableStrings(buffer, minLength = 4) {
  const strings = [];
  let current = "";
  for (const byte of buffer || []) {
    if (byte >= 32 && byte <= 126) {
      current += String.fromCharCode(byte);
      continue;
    }
    if (current.length >= minLength) strings.push(current);
    current = "";
  }
  if (current.length >= minLength) strings.push(current);
  return strings;
}

function detectLoveVersionFromDll(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    const strings = extractPrintableStrings(buffer, 6);
    for (const text of strings) {
      const match = text.match(
        /\b(?:L(?:O|Ö)VE|love(?:\.dll)?)(?:\s+version)?\s+v?(\d+\.\d+(?:\.\d+)?[A-Za-z]?)\b/
      );
      if (match?.[1]) return match[1];
    }
    return null;
  } catch {
    return null;
  }
}

function detectVersionFromLibloveNames(names) {
  for (const name of names || []) {
    const match = String(name || "").match(/liblove-([0-9A-Za-z._-]+)\.so/i);
    if (match?.[1]) return match[1];
  }
  return null;
}

function listDirEntries(rootDir) {
  try {
    return fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function chooseWindowsExecutable(rootDir) {
  const entries = listDirEntries(rootDir)
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));
  if (!entries.length) return null;
  const folderName = path.basename(rootDir).toLowerCase();
  const exact = entries.find(name => path.basename(name, ".exe").toLowerCase() === folderName);
  return path.join(rootDir, exact || entries[0]);
}

function chooseLinuxBinary(rootDir) {
  const binDir = path.join(rootDir, "bin");
  if (existsDir(binDir)) {
    const files = listDirEntries(binDir)
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b));
    if (files.length) {
      const folderName = path.basename(rootDir).toLowerCase();
      const exact = files.find(name => name.toLowerCase() === folderName);
      return path.join(binDir, exact || files[0]);
    }
  }
  const appRunPath = path.join(rootDir, "AppRun");
  return existsFile(appRunPath) ? appRunPath : null;
}

function detectSourceDirectory(rootDir) {
  const mainPath = path.join(rootDir, "main.lua");
  if (!existsFile(mainPath)) return null;
  const confPath = path.join(rootDir, "conf.lua");
  const mainText = readTextFile(mainPath, 256 * 1024) || "";
  const confText = existsFile(confPath) ? readTextFile(confPath, 256 * 1024) : null;
  const hasMarker =
    Boolean(confText) ||
    /function\s+love\.[A-Za-z0-9_]+\s*\(/.test(mainText) ||
    /\blove\.[A-Za-z0-9_]+/.test(mainText);
  if (!hasMarker) return null;

  const parsedConf = confText ? parseLoveConf(confText) : null;
  const rawVersion = parsedConf?.version || null;
  return {
    gameType: "engine",
    engine: "love",
    gamePath: rootDir,
    contentRootDir: rootDir,
    name: path.basename(rootDir),
    moduleData: {
      sourceKind: "source-dir",
      launchTargetPath: rootDir,
      detectedVersion: rawVersion,
      detectedVersionNormalized: normalizeLoveVersion(rawVersion),
      detectedVersionSource: rawVersion ? "conf.lua" : null,
      saveIdentity: parsedConf?.identity || null
    }
  };
}

function detectLoveArchiveFile(inputPath, rootDir) {
  const archive = inspectLoveArchive(inputPath);
  if (!archive?.mainEntry) return null;
  const rawVersion = archive.parsedConf?.version || null;
  return {
    gameType: "engine",
    engine: "love",
    gamePath: inputPath,
    contentRootDir: rootDir,
    name: path.basename(inputPath, path.extname(inputPath)),
    moduleData: {
      sourceKind: "love-archive",
      launchTargetPath: inputPath,
      detectedVersion: rawVersion,
      detectedVersionNormalized: normalizeLoveVersion(rawVersion),
      detectedVersionSource: rawVersion ? "conf.lua" : null,
      saveIdentity: archive.parsedConf?.identity || null
    }
  };
}

function detectAppBundle(appPath) {
  const executablePath = path.join(appPath, "Contents", "MacOS", "love");
  if (!existsFile(executablePath)) return null;
  const embeddedLovePath = findEmbeddedLoveArchive(appPath);
  if (!embeddedLovePath) return null;
  const appInfo = readAppBundleMetadata(appPath);
  const embedded = inspectLoveArchive(embeddedLovePath);
  const confVersion = embedded?.parsedConf?.version || null;
  const rawVersion = appInfo.version || confVersion;
  return {
    gameType: "engine",
    engine: "love",
    gamePath: appPath,
    contentRootDir: appPath,
    nativeAppPath: appPath,
    runtimeId: "native",
    name: appInfo.bundleName || path.basename(appPath, ".app"),
    moduleData: {
      sourceKind: "app-bundle",
      embeddedLovePath,
      launchTargetPath: embeddedLovePath,
      detectedVersion: rawVersion,
      detectedVersionNormalized: normalizeLoveVersion(rawVersion),
      detectedVersionSource: appInfo.version ? "Info.plist" : confVersion ? "conf.lua" : null,
      saveIdentity: embedded?.parsedConf?.identity || null
    }
  };
}

function detectWindowsFile(inputPath, rootDir) {
  if (!looksLikePeBinary(inputPath)) return null;
  const archive = inspectLoveArchive(inputPath);
  if (!archive?.mainEntry) return null;
  const rawVersion = archive.parsedConf?.version || null;
  return {
    gameType: "engine",
    engine: "love",
    gamePath: inputPath,
    contentRootDir: rootDir,
    name: path.basename(inputPath, ".exe"),
    moduleData: {
      sourceKind: "windows-fused",
      packagedPath: inputPath,
      launchTargetPath: inputPath,
      detectedVersion: rawVersion,
      detectedVersionNormalized: normalizeLoveVersion(rawVersion),
      detectedVersionSource: rawVersion ? "conf.lua" : null,
      saveIdentity: archive.parsedConf?.identity || null
    }
  };
}

function detectWindowsDirectory(rootDir) {
  const loveDllPath = path.join(rootDir, "love.dll");
  if (!existsFile(loveDllPath)) return null;
  const exePath = chooseWindowsExecutable(rootDir);
  if (!exePath) return null;
  const archive = inspectLoveArchive(exePath);
  if (!archive?.mainEntry) return null;
  const rawVersion = archive.parsedConf?.version || null;
  return {
    gameType: "engine",
    engine: "love",
    gamePath: rootDir,
    contentRootDir: rootDir,
    name: path.basename(rootDir),
    moduleData: {
      sourceKind: "windows-fused",
      packagedPath: exePath,
      launchTargetPath: exePath,
      detectedVersion: rawVersion,
      detectedVersionNormalized: normalizeLoveVersion(rawVersion),
      detectedVersionSource: rawVersion ? "conf.lua" : null,
      saveIdentity: archive.parsedConf?.identity || null
    }
  };
}

function detectLinuxFile(inputPath, rootDir) {
  if (!looksLikeElfBinary(inputPath)) return null;
  const archive = inspectLoveArchive(inputPath);
  if (!archive?.mainEntry) return null;
  const rawVersion = archive.parsedConf?.version || null;
  return {
    gameType: "engine",
    engine: "love",
    gamePath: inputPath,
    contentRootDir: rootDir,
    name: path.basename(inputPath),
    moduleData: {
      sourceKind: "linux-fused",
      packagedPath: inputPath,
      launchTargetPath: inputPath,
      detectedVersion: rawVersion,
      detectedVersionNormalized: normalizeLoveVersion(rawVersion),
      detectedVersionSource: rawVersion ? "conf.lua" : null,
      saveIdentity: archive.parsedConf?.identity || null
    }
  };
}

function detectLinuxDirectory(rootDir) {
  const libDir = path.join(rootDir, "lib");
  if (!existsDir(libDir)) return null;
  const libNames = listDirEntries(libDir)
    .filter(entry => entry.isFile())
    .map(entry => entry.name);
  const libloveVersion = detectVersionFromLibloveNames(libNames);
  if (!libloveVersion) return null;
  const binaryPath = chooseLinuxBinary(rootDir);
  if (!binaryPath) return null;
  const archive = inspectLoveArchive(binaryPath);
  const rawVersion = archive?.parsedConf?.version || libloveVersion;
  return {
    gameType: "engine",
    engine: "love",
    gamePath: rootDir,
    contentRootDir: rootDir,
    name: path.basename(rootDir),
    moduleData: {
      sourceKind: "linux-fused",
      packagedPath: binaryPath,
      launchTargetPath: binaryPath,
      detectedVersion: rawVersion,
      detectedVersionNormalized: normalizeLoveVersion(rawVersion),
      detectedVersionSource:
        archive?.parsedConf?.version ? "conf.lua" : libloveVersion ? "liblove-so" : null,
      saveIdentity: archive?.parsedConf?.identity || null
    }
  };
}

function detectAppImage(inputPath, rootDir) {
  const entries = SevenZip.listArchiveEntriesSync(inputPath);
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const names = entries.map(entry => normalizeZipEntryName(entry?.path || ""));
  const binaries = names.filter(name => /^bin\/[^/]+$/i.test(name)).sort((a, b) => a.localeCompare(b));
  const rawVersion = detectVersionFromLibloveNames(names);
  if (!binaries.length || !rawVersion) return null;
  return {
    gameType: "engine",
    engine: "love",
    gamePath: inputPath,
    contentRootDir: rootDir,
    name: path.basename(inputPath, path.extname(inputPath)),
    moduleData: {
      sourceKind: "appimage",
      packagedPath: inputPath,
      launchTargetPath: null,
      detectedVersion: rawVersion,
      detectedVersionNormalized: normalizeLoveVersion(rawVersion),
      detectedVersionSource: "appimage-liblove",
      appImageReady: false,
      appImageLaunchRelativePath: binaries[0]
    }
  };
}

function detectGame(context) {
  const inputPath = typeof context?.inputPath === "string" ? context.inputPath.trim() : "";
  if (!inputPath) return null;
  const rootDir = typeof context?.rootDir === "string" ? context.rootDir : path.dirname(inputPath);

  if (context?.isAppBundle) {
    return detectAppBundle(inputPath);
  }

  if (context?.stat?.isFile?.()) {
    const ext = path.extname(inputPath).toLowerCase();
    if (ext === ".love") return detectLoveArchiveFile(inputPath, rootDir);
    if (ext === ".appimage") return detectAppImage(inputPath, rootDir);
    if (ext === ".exe") return detectWindowsFile(inputPath, rootDir);
    return detectLinuxFile(inputPath, rootDir);
  }

  if (!context?.stat?.isDirectory?.()) return null;
  return (
    detectSourceDirectory(rootDir) ||
    detectWindowsDirectory(rootDir) ||
    detectLinuxDirectory(rootDir)
  );
}

module.exports = {
  detectGame,
  __test: {
    normalizeZipEntryName,
    parseLoveConf,
    inspectLoveArchive,
    readAppBundleMetadata,
    detectLoveVersionFromDll,
    detectVersionFromLibloveNames,
    findEmbeddedLoveArchive
  }
};
