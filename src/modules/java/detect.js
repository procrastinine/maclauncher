const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const Zip = require("../shared/runtime/zip");

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const LTS_LINES = [8, 11, 17, 21, 25];
// Automatic runs Java 8 bytecode on this line. The managed Java 8 builds are
// Intel-only on Apple silicon, and JDK 8 double-encodes escaped characters in
// ZIP file system URIs, so a JAR in a folder whose name contains a space
// cannot open its own resources through them.
const JAVA8_SUCCESSOR_LINE = 21;
const MAX_CLASS_PATH_JARS = 64;
const MAX_NATIVE_SCAN_ENTRIES = 2048;
const MAX_NATIVE_SCAN_DEPTH = 3;
const CPU_ARM64 = 0x0100000c;
const SCRIPT_ENGINE_LOOKUP = "javax/script/ScriptEngineManager";
// From Java 9 the system class loader is no longer a URLClassLoader, so code
// that casts it to add or list class path entries fails.
const SYSTEM_LOADER_CALL = "getSystemClassLoader";
const URL_CLASS_LOADER = "java/net/URLClassLoader";
const SCRIPT_ENGINE_SERVICE = "meta-inf/services/javax.script.scriptenginefactory";
// Java 8 platform APIs that Java 21 no longer provides to applications. A JAR
// that uses one without bundling it keeps the Java 8 line. JavaFX is absent
// from both managed lines, and guarded sun.* internals are common in
// libraries, so neither is evidence.
const JAVA8_ONLY_APIS = new Map([
  ["javax/xml/bind/", "javax.xml.bind"],
  ["javax/activation/", "javax.activation"],
  ["javax/xml/ws/", "javax.xml.ws"],
  ["javax/jws/", "javax.jws"],
  ["javax/xml/soap/", "javax.xml.soap"],
  ["org/omg/", "org.omg"],
  ["javax/rmi/CORBA/", "javax.rmi.CORBA"],
  ["javax/rmi/PortableRemoteObject", "javax.rmi.PortableRemoteObject"],
  ["javax/activity/", "javax.activity"],
  ["jdk/nashorn/", "jdk.nashorn"],
  ["java/util/jar/Pack200", "java.util.jar.Pack200"],
  ["java/rmi/activation/", "java.rmi.activation"],
  ["java/lang/Compiler", "java.lang.Compiler"],
  ["com/apple/eawt/", "com.apple.eawt"],
  ["com/apple/eio/", "com.apple.eio"],
  ["com/sun/awt/", "com.sun.awt"],
  ["sun/misc/BASE64Encoder", "sun.misc.BASE64Encoder"],
  ["sun/misc/BASE64Decoder", "sun.misc.BASE64Decoder"]
]);
const JAVA8_REFERENCE_PATTERN = new RegExp(
  [...JAVA8_ONLY_APIS.keys(), SCRIPT_ENGINE_LOOKUP, SYSTEM_LOADER_CALL, URL_CLASS_LOADER].join("|"), "g");

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

function readClass(fd, entry) {
  const buf = readZipEntryBuffer(fd, entry, 1024 * 1024);
  if (!buf || buf.length < 8) return null;
  if (buf.readUInt32BE(0) !== 0xcafebabe) return null;
  return buf;
}

function machOCpuTypes(head) {
  if (!head || head.length < 8) return null;
  const magic = head.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const count = head.readUInt32BE(4);
    const stride = magic === 0xcafebabf ? 32 : 20;
    if (count < 1 || count > 32 || head.length < 8 + count * stride) return null;
    return Array.from({ length: count }, (_, index) => head.readUInt32BE(8 + index * stride));
  }
  if (magic === 0xfeedface || magic === 0xfeedfacf) return [head.readUInt32BE(4)];
  if (magic === 0xcefaedfe || magic === 0xcffaedfe) return [head.readUInt32LE(4)];
  return null;
}

function isNativeLibraryName(name) {
  return /\.(?:dylib|jnilib)$/i.test(name);
}

function createDependencyScan() {
  return { referenced: new Set(), provided: new Set(), scriptEngineLookup: false, scriptEngineProvided: false,
    systemLoaderCast: false, nativeLibraries: 0, arm64Native: false };
}

function scanNativeLibrary(scan, head) {
  const cpus = machOCpuTypes(head);
  if (!cpus) return;
  scan.nativeLibraries += 1;
  if (cpus.includes(CPU_ARM64)) scan.arm64Native = true;
}

function scanEntryName(scan, fd, entry, entryName) {
  const lower = entryName.toLowerCase();
  if (lower === SCRIPT_ENGINE_SERVICE) scan.scriptEngineProvided = true;
  if (isNativeLibraryName(entryName) && !scan.arm64Native) scanNativeLibrary(scan, readZipEntryBuffer(fd, entry));
  if (!lower.endsWith(".class")) return;
  for (const prefix of JAVA8_ONLY_APIS.keys()) {
    if (entryName.startsWith(prefix)) scan.provided.add(prefix);
  }
}

function scanClassReferences(scan, buf) {
  let systemLoader = false, urlClassLoader = false;
  for (const match of buf.toString("latin1").matchAll(JAVA8_REFERENCE_PATTERN)) {
    if (match[0] === SCRIPT_ENGINE_LOOKUP) scan.scriptEngineLookup = true;
    else if (match[0] === SYSTEM_LOADER_CALL) systemLoader = true;
    else if (match[0] === URL_CLASS_LOADER) urlClassLoader = true;
    else scan.referenced.add(match[0]);
  }
  // Both in one class's constant pool: the system loader used as a URLClassLoader.
  if (systemLoader && urlClassLoader) scan.systemLoaderCast = true;
}

// Names, services and base classes of one JAR. Versioned classes target newer
// releases and do not indicate a Java 8 dependency.
function scanJarEntries(scan, fd, entries, onClass) {
  for (const entry of entries) {
    const entryName = normalizeZipEntryName(entry?.name || "");
    scanEntryName(scan, fd, entry, entryName);
    if (!entryName.toLowerCase().endsWith(".class")) continue;
    const buf = readClass(fd, entry);
    if (!buf) continue;
    const versioned = /^meta-inf\/versions\/\d+\/.+\.class$/i.test(entryName);
    if (!versioned) scanClassReferences(scan, buf);
    onClass?.(buf.readUInt16BE(6), versioned);
  }
}

function resolveClassPathJars(jarPath, manifest) {
  const value = typeof manifest["class-path"] === "string" ? manifest["class-path"] : "";
  const baseDir = path.dirname(jarPath);
  const out = [];
  for (const token of value.split(/\s+/)) {
    if (out.length >= MAX_CLASS_PATH_JARS) break;
    if (!token || token.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(token)) continue;
    let relative = token;
    try {
      relative = decodeURIComponent(token);
    } catch {}
    const resolved = path.resolve(baseDir, relative);
    if (resolved !== jarPath && !out.includes(resolved) && existsFile(resolved)) out.push(resolved);
  }
  return out;
}

function scanClassPathJar(scan, jarPath, helpers) {
  let zip = null;
  try {
    zip = (helpers.readZipEntries || Zip.readZipEntries)(jarPath);
  } catch {
    return;
  }
  if (!zip || !Array.isArray(zip.entries)) return;
  let fd = null;
  try {
    fd = fs.openSync(jarPath, "r");
    scanJarEntries(scan, fd, zip.entries);
  } catch {
    // An unreadable library adds no evidence.
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function readFileHead(filePath, size = 4096) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const head = Buffer.alloc(size);
    return head.subarray(0, fs.readSync(fd, head, 0, size, 0));
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

// Native libraries shipped beside the JAR, within a bounded walk that skips
// hidden entries and app bundles.
function scanFolderNativeLibraries(scan, rootDir) {
  let budget = MAX_NATIVE_SCAN_ENTRIES;
  const visit = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scan.arm64Native || --budget < 0) return;
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_NATIVE_SCAN_DEPTH && !/\.app$/i.test(entry.name)) visit(fullPath, depth + 1);
      } else if (entry.isFile() && isNativeLibraryName(entry.name)) {
        scanNativeLibrary(scan, readFileHead(fullPath));
      }
    }
  };
  visit(rootDir, 0);
}

function listJava8Dependencies(scan) {
  const out = [...scan.referenced].filter(prefix => !scan.provided.has(prefix)).map(prefix => JAVA8_ONLY_APIS.get(prefix));
  if (scan.scriptEngineLookup && !scan.scriptEngineProvided) out.push("javax.script engine");
  if (scan.systemLoaderCast) out.push("system class loader as URLClassLoader");
  if (scan.nativeLibraries > 0 && !scan.arm64Native) out.push("macOS native libraries without arm64");
  return [...new Set(out)].sort();
}

function resolveAutomaticLine(minimumLine, java8Dependencies) {
  if (minimumLine !== 8 || java8Dependencies.length) return minimumLine;
  return JAVA8_SUCCESSOR_LINE;
}

function inspectJar(jarPath, helpers = {}) {
  const zip = (helpers.readZipEntries || Zip.readZipEntries)(jarPath);
  if (!zip || !Array.isArray(zip.entries) || zip.entries.length === 0) {
    return {
      mainClass: null,
      implementationTitle: null,
      requiredJava: null,
      recommendedJava: null,
      minimumLine: null,
      runtimeLine: null,
      java8Dependencies: [],
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
    const scan = createDependencyScan();

    scanJarEntries(scan, fd, entries, (classMajor, versioned) => {
      if (versioned) {
        if (!Number.isFinite(versionedMaxClassMajor) || classMajor > versionedMaxClassMajor) {
          versionedMaxClassMajor = classMajor;
        }
      } else if (!Number.isFinite(baseMaxClassMajor) || classMajor > baseMaxClassMajor) {
        baseMaxClassMajor = classMajor;
      }
    });
    for (const classPathJar of resolveClassPathJars(jarPath, manifest)) scanClassPathJar(scan, classPathJar, helpers);
    if (!scan.arm64Native) scanFolderNativeLibraries(scan, path.dirname(jarPath));

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

    const minimumLine = resolveRuntimeLine(requiredJava);
    const java8Dependencies = listJava8Dependencies(scan);
    return {
      mainClass,
      implementationTitle,
      requiredJava: Number.isFinite(requiredJava) ? requiredJava : null,
      recommendedJava: Number.isFinite(recommendedJava) ? recommendedJava : null,
      minimumLine,
      runtimeLine: resolveAutomaticLine(minimumLine, java8Dependencies),
      java8Dependencies,
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

function detectFromJarPath(jarPath, helpers = {}) {
  if (!existsFile(jarPath)) return null;
  const info = inspectJar(jarPath, helpers);
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
      minimumLine: info.minimumLine,
      runtimeLine: info.runtimeLine,
      java8Dependencies: info.java8Dependencies,
      detectedJavaSource: info.detectedJavaSource,
      detectedJavaConfidence: info.detectedJavaConfidence
    }
  };
}

function detectGame(context, helpers = {}) {
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
    return detectFromJarPath(inputPath, helpers);
  }

  const rootDir = typeof context?.rootDir === "string" ? context.rootDir : null;
  if (!rootDir) return null;
  const jars = listRootJarFiles(rootDir);
  if (jars.length !== 1) return null;

  // Conservative directory mode: only accept when manifest declares a runnable main class.
  const detected = detectFromJarPath(jars[0], helpers);
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
    resolveAutomaticLine,
    resolveRuntimeLine
  }
};
