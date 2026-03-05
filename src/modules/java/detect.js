const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const Zip = require("../shared/runtime/zip");

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const LTS_LINES = [8, 11, 17, 21, 25];

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function existsFile(p) {
  const st = safeStat(p);
  return Boolean(st && st.isFile());
}

function normalizeZipEntryName(name) {
  return String(name || "").replace(/\\/g, "/");
}

function parseJavaMajor(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const legacy = text.match(/^1\.(\d+)(?:\D|$)/);
  if (legacy) {
    const major = Number(legacy[1]);
    return Number.isFinite(major) ? major : null;
  }
  const match = text.match(/^(\d+)(?:\D|$)/);
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isFinite(major) ? major : null;
}

function resolveRuntimeLine(javaMajor) {
  const major = Number(javaMajor);
  if (!Number.isFinite(major) || major <= 0) return null;
  for (const line of LTS_LINES) {
    if (line >= major) return line;
  }
  return major;
}

function classMajorToJavaMajor(classMajor) {
  const major = Number(classMajor);
  if (!Number.isFinite(major) || major < 45) return null;
  return major - 44;
}

function parseManifest(text) {
  const out = {};
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  let currentKey = null;

  for (const line of lines) {
    if (!line) {
      currentKey = null;
      continue;
    }
    if (line.startsWith(" ")) {
      if (currentKey) out[currentKey] = `${out[currentKey] || ""}${line.slice(1)}`;
      continue;
    }
    const idx = line.indexOf(":");
    if (idx <= 0) {
      currentKey = null;
      continue;
    }
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!key) {
      currentKey = null;
      continue;
    }
    out[key] = value;
    currentKey = key;
  }

  return out;
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

function readZipEntryBuffer(fd, entry, maxBytes = MAX_ENTRY_BYTES) {
  const localOffset = Number(entry?.absoluteLocalHeaderOffset);
  const compressedSize = Number(entry?.compressedSize);
  if (!Number.isFinite(localOffset) || localOffset < 0) return null;
  if (!Number.isFinite(compressedSize) || compressedSize < 0) return null;

  const local = readLocalHeader(fd, localOffset);
  if (!local) return null;

  const dataOffset = localOffset + 30 + local.nameLength + local.extraLength;
  if (!Number.isFinite(dataOffset) || dataOffset < 0) return null;
  if (compressedSize > maxBytes * 2) return null;

  const compressed = Buffer.alloc(compressedSize);
  const read = fs.readSync(fd, compressed, 0, compressedSize, dataOffset);
  if (read < compressedSize) return null;

  if (local.method === 0) {
    if (compressed.length > maxBytes) return null;
    return compressed;
  }

  if (local.method === 8) {
    let uncompressed = null;
    try {
      uncompressed = zlib.inflateRawSync(compressed);
    } catch {
      return null;
    }
    if (!uncompressed || uncompressed.length > maxBytes) return null;
    return uncompressed;
  }

  return null;
}

function readManifestEntry(fd, entries) {
  const manifestEntry = entries.find(entry => normalizeZipEntryName(entry?.name).toLowerCase() === "meta-inf/manifest.mf");
  if (!manifestEntry) return null;
  const raw = readZipEntryBuffer(fd, manifestEntry, 512 * 1024);
  if (!raw) return null;
  return parseManifest(raw.toString("utf8"));
}

function readClassMajor(fd, entry) {
  const buf = readZipEntryBuffer(fd, entry, 1024 * 1024);
  if (!buf || buf.length < 8) return null;
  if (buf.readUInt32BE(0) !== 0xcafebabe) return null;
  return buf.readUInt16BE(6);
}

function inspectJar(jarPath) {
  const zip = Zip.readZipEntries(jarPath);
  if (!zip || !Array.isArray(zip.entries) || zip.entries.length === 0) {
    return {
      mainClass: null,
      implementationTitle: null,
      requiredJava: null,
      recommendedJava: null,
      runtimeLine: null,
      detectedJavaSource: "fallback",
      detectedJavaConfidence: "low"
    };
  }

  let fd = null;
  try {
    fd = fs.openSync(jarPath, "r");
    const entries = zip.entries;
    const manifest = readManifestEntry(fd, entries) || {};
    const mainClass =
      typeof manifest["main-class"] === "string" && manifest["main-class"].trim()
        ? manifest["main-class"].trim()
        : null;
    const implementationTitle =
      typeof manifest["implementation-title"] === "string" && manifest["implementation-title"].trim()
        ? manifest["implementation-title"].trim()
        : null;

    const manifestJava =
      parseJavaMajor(manifest["build-jdk-spec"]) || parseJavaMajor(manifest["created-by"]);

    let baseMaxClassMajor = null;
    let versionedMaxClassMajor = null;

    for (const entry of entries) {
      const entryName = normalizeZipEntryName(entry?.name || "");
      if (!entryName.toLowerCase().endsWith(".class")) continue;
      const versionedMatch = entryName.match(/^meta-inf\/versions\/(\d+)\/.+\.class$/i);
      const classMajor = readClassMajor(fd, entry);
      if (!Number.isFinite(classMajor)) continue;
      if (versionedMatch) {
        if (!Number.isFinite(versionedMaxClassMajor) || classMajor > versionedMaxClassMajor) {
          versionedMaxClassMajor = classMajor;
        }
      } else if (!Number.isFinite(baseMaxClassMajor) || classMajor > baseMaxClassMajor) {
        baseMaxClassMajor = classMajor;
      }
    }

    const baseRequired = classMajorToJavaMajor(baseMaxClassMajor);
    const versionedRecommended = classMajorToJavaMajor(versionedMaxClassMajor);

    let requiredJava = baseRequired || manifestJava || null;
    if (!requiredJava && versionedRecommended) requiredJava = versionedRecommended;

    let recommendedJava = requiredJava;
    if (Number.isFinite(versionedRecommended)) {
      recommendedJava = Number.isFinite(recommendedJava)
        ? Math.max(recommendedJava, versionedRecommended)
        : versionedRecommended;
    }

    const hasBytecode = Number.isFinite(baseRequired) || Number.isFinite(versionedRecommended);
    const hasManifest = Number.isFinite(manifestJava);

    let detectedJavaSource = "fallback";
    let detectedJavaConfidence = "low";
    if (hasBytecode && hasManifest) {
      detectedJavaSource = "mixed";
      detectedJavaConfidence = "high";
    } else if (hasBytecode) {
      detectedJavaSource = "bytecode";
      detectedJavaConfidence = "high";
    } else if (hasManifest) {
      detectedJavaSource = "manifest";
      detectedJavaConfidence = "medium";
    }

    return {
      mainClass,
      implementationTitle,
      requiredJava: Number.isFinite(requiredJava) ? requiredJava : null,
      recommendedJava: Number.isFinite(recommendedJava) ? recommendedJava : null,
      runtimeLine: resolveRuntimeLine(requiredJava),
      detectedJavaSource,
      detectedJavaConfidence
    };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function listRootJarFiles(rootDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".jar"))
    .map(entry => path.join(rootDir, entry.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

function detectFromJarPath(jarPath) {
  if (!existsFile(jarPath)) return null;
  const info = inspectJar(jarPath);
  const baseName = path.basename(jarPath, path.extname(jarPath));

  return {
    gameType: "scripted",
    engine: "java",
    gamePath: jarPath,
    contentRootDir: path.dirname(jarPath),
    name: info.implementationTitle || baseName,
    indexDir: null,
    indexHtml: null,
    moduleData: {
      jarPath,
      mainClass: info.mainClass || null,
      requiredJava: info.requiredJava,
      recommendedJava: info.recommendedJava,
      runtimeLine: info.runtimeLine,
      detectedJavaSource: info.detectedJavaSource,
      detectedJavaConfidence: info.detectedJavaConfidence
    }
  };
}

function detectGame(context) {
  const inputPath =
    typeof context?.inputPath === "string" && context.inputPath
      ? context.inputPath
      : typeof context?.rootDir === "string"
        ? context.rootDir
        : null;
  if (!inputPath) return null;

  const stat = context?.stat;
  if (stat?.isFile?.()) {
    if (path.extname(inputPath).toLowerCase() !== ".jar") return null;
    return detectFromJarPath(inputPath);
  }

  const rootDir = typeof context?.rootDir === "string" ? context.rootDir : null;
  if (!rootDir) return null;
  const jars = listRootJarFiles(rootDir);
  if (jars.length !== 1) return null;

  // Conservative directory mode: only accept when manifest declares a runnable main class.
  const detected = detectFromJarPath(jars[0]);
  if (!detected?.moduleData?.mainClass) return null;
  return detected;
}

module.exports = {
  LTS_LINES,
  detectGame,
  inspectJar,
  __test: {
    classMajorToJavaMajor,
    parseJavaMajor,
    parseManifest,
    resolveRuntimeLine
  }
};
