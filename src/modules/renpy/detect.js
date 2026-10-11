const fs = require("node:fs");
const path = require("node:path");
const { resolveConfiguredSaveLocation } = require("./save-location");

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function existsDir(p) {
  const st = safeStat(p);
  return Boolean(st && st.isDirectory());
}

function existsFile(p) {
  const st = safeStat(p);
  return Boolean(st && st.isFile());
}

function readText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function isDefiniteRenpyVersion(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return false;
  return /^(?:\d+\.){2}\d+(?:\.\d+)*$/.test(trimmed);
}

function parseVersionFromVc(vcVersionPath) {
  const text = readText(vcVersionPath);
  if (!text) return null;
  const match = text.match(/^\s*version\s*=\s*(?:[uUrRbB]{0,2})?["']([^"']+)["']/m);
  if (!match) return null;
  const candidate = match[1] ? String(match[1]).trim() : "";
  if (!candidate) return null;
  return isDefiniteRenpyVersion(candidate) ? candidate : null;
}

function findVersionTupleInLines(lines, start, end) {
  for (let i = start; i < end; i += 1) {
    const match = lines[i].match(
      /^\s*version_tuple\s*=\s*(?:VersionTuple\s*)?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/
    );
    if (!match) continue;
    return `${match[1]}.${match[2]}.${match[3]}`;
  }
  return null;
}

function parsePy2ConditionalVersion(text, pythonMajor) {
  if (pythonMajor !== 2 && pythonMajor !== 3) return null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^\s*if\s+PY2\s*:/.test(line)) continue;
    const indent = line.match(/^\s*/)?.[0]?.length ?? 0;
    let elseIndex = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (!next.trim()) continue;
      const nextIndent = next.match(/^\s*/)?.[0]?.length ?? 0;
      if (nextIndent < indent) break;
      if (nextIndent === indent && /^\s*else\s*:/.test(next)) {
        elseIndex = j;
        break;
      }
      if (nextIndent === indent) break;
    }
    if (elseIndex === -1) continue;
    const py2Version = findVersionTupleInLines(lines, i + 1, elseIndex);
    if (pythonMajor === 2) {
      if (py2Version) return py2Version;
      continue;
    }
    let end = lines.length;
    for (let k = elseIndex + 1; k < lines.length; k += 1) {
      const next = lines[k];
      if (!next.trim()) continue;
      const nextIndent = next.match(/^\s*/)?.[0]?.length ?? 0;
      if (nextIndent <= indent) {
        end = k;
        break;
      }
    }
    const py3Version = findVersionTupleInLines(lines, elseIndex + 1, end);
    if (py3Version) return py3Version;
  }
  return null;
}

function parseVersionFromInit(initPath, pythonMajor) {
  const text = readText(initPath);
  if (!text) return null;
  // Compatibility SDKs contain both 7/Python 2 and 8/Python 3 tuples. Without
  // an identifiable Python runtime, their first branch is not evidence.
  if (!pythonMajor && (parsePy2ConditionalVersion(text, 2) || parsePy2ConditionalVersion(text, 3))) return null;
  const conditional = parsePy2ConditionalVersion(text, pythonMajor);
  if (conditional) return conditional;
  const match = text.match(
    /^\s*version_tuple\s*=\s*(?:VersionTuple\s*)?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/m
  );
  if (!match) return null;
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function findAppRoot(inputPath) {
  const parts = path.resolve(inputPath).split(path.sep);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i].toLowerCase().endsWith(".app")) {
      return parts.slice(0, i + 1).join(path.sep);
    }
  }
  return null;
}

function resolveLibDir(contentRootDir) {
  const direct = path.join(contentRootDir, "lib");
  if (existsDir(direct)) return direct;

  if (path.basename(contentRootDir).toLowerCase() === "autorun") {
    const parentLib = path.join(path.dirname(contentRootDir), "lib");
    if (existsDir(parentLib)) return parentLib;
  }

  const appRoot = findAppRoot(contentRootDir);
  if (appRoot) {
    const appLib = path.join(appRoot, "Contents", "Resources", "lib");
    if (existsDir(appLib)) return appLib;
  }

  return null;
}

function parsePythonMajorFromLibName(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.startsWith("py2") || lower.startsWith("python2")) return 2;
  if (lower.startsWith("py3") || lower.startsWith("python3")) return 3;
  return null;
}

function platformTags() {
  switch (process.platform) {
    case "darwin":
      return ["mac", "osx", "darwin"];
    case "win32":
      return ["win", "windows"];
    case "linux":
      return ["linux"];
    default:
      return [];
  }
}

function resolvePythonMajor(contentRootDir) {
  const libDir = resolveLibDir(contentRootDir);
  if (!libDir) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(libDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const names = entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
  if (names.length === 0) return null;
  const tags = platformTags();
  const majors = new Set();
  const platformMajors = new Set();
  for (const name of names) {
    const major = parsePythonMajorFromLibName(name);
    if (!major) continue;
    majors.add(major);
    const lower = name.toLowerCase();
    if (tags.some(tag => lower.includes(tag))) {
      platformMajors.add(major);
    }
  }
  if (platformMajors.size === 1) return [...platformMajors][0];
  if (majors.size === 1) return [...majors][0];
  return null;
}

function resolveRenpyVersionEvidence(contentRootDir) {
  const vcVersionPath = path.join(contentRootDir, "renpy", "vc_version.py");
  const fromVc = parseVersionFromVc(vcVersionPath);
  const initPath = path.join(contentRootDir, "renpy", "__init__.py");
  const pythonMajor = resolvePythonMajor(contentRootDir);
  const fromInit = parseVersionFromInit(initPath, pythonMajor);
  const initEvidence = { version: fromInit, versionSource: "renpy/__init__.py version_tuple", versionConfidence: "exact" };
  const vcEvidence = { version: fromVc, versionSource: "renpy/vc_version.py version", versionConfidence: "exact" };
  if (!fromVc) return fromInit ? initEvidence : { version: null, versionSource: null, versionConfidence: "unknown" };
  if (!fromInit) return vcEvidence;
  const vcMajor = parseMajor(fromVc);
  const initMajor = parseMajor(fromInit);
  if (vcMajor != null && initMajor != null && vcMajor !== initMajor) return initEvidence;
  return vcEvidence;
}

function resolveRenpyVersion(contentRootDir) {
  return resolveRenpyVersionEvidence(contentRootDir).version;
}

function parseMajor(version) {
  const m = String(version || "").trim().match(/^(\d+)(?:\.|$)/);
  if (!m) return null;
  const major = Number(m[1]);
  return Number.isFinite(major) ? major : null;
}

function normalizeRenpyMajor(input) {
  const major = Number(input);
  if (!Number.isFinite(major)) return null;
  if (major >= 8) return 8;
  if (major >= 1) return 7;
  return null;
}

function resolveDefaultSaveDir(gameDir) {
  const scriptsDir = existsDir(path.join(gameDir, "game")) ? path.join(gameDir, "game") : gameDir;
  return resolveConfiguredSaveLocation([scriptsDir, gameDir], { gameDir: scriptsDir, renpyBaseDir: gameDir,
    isMacApp: Boolean(findAppBundleForGameFolder(scriptsDir)) });
}

function readBuildInfo(gameDir) {
  const buildInfoPath = path.join(gameDir, "game", "cache", "build_info.json");
  const buildInfoFallback = path.join(gameDir, "cache", "build_info.json");
  const target = existsFile(buildInfoPath)
    ? buildInfoPath
    : existsFile(buildInfoFallback)
      ? buildInfoFallback
      : null;
  if (!target) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function parseScriptVersionEvidence(gameDir) {
  const candidates = [
    path.join(gameDir, "game", "script_version.txt"),
    path.join(gameDir, "script_version.txt")
  ];
  const source = candidates.find(candidate => readText(candidate));
  if (!source) return { version: null, versionSource: null, versionConfidence: "unknown" };
  const text = readText(source);
  const tuple = text.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (tuple) return { version: `${tuple[1]}.${tuple[2]}.${tuple[3]}`, versionSource: path.relative(gameDir, source), versionConfidence: "reported" };
  const dotted = text.match(/(\d+\.\d+\.\d+)/);
  if (dotted) return { version: dotted[1], versionSource: path.relative(gameDir, source), versionConfidence: "reported" };
  const major = text.match(/(\d+)/);
  return { version: major ? major[1] : null, versionSource: path.relative(gameDir, source), versionConfidence: major ? "inferred" : "unknown" };
}

function isGameFolder(rootDir) {
  if (!existsDir(rootDir)) return false;
  if (path.basename(rootDir).toLowerCase() !== "game") return false;
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return false;
  }
  const extensions = new Set([".rpa", ".rpy", ".rpyc", ".rpyb"]);
  return entries.some(entry => {
    if (!entry.isFile()) return false;
    const ext = path.extname(entry.name).toLowerCase();
    return extensions.has(ext);
  });
}

function findAppBundleForGameFolder(gameDir) {
  const parent = path.dirname(gameDir);
  if (path.basename(parent).toLowerCase() !== "autorun") return null;
  const resources = path.dirname(parent);
  if (path.basename(resources).toLowerCase() !== "resources") return null;
  const contents = path.dirname(resources);
  if (path.basename(contents).toLowerCase() !== "contents") return null;
  const appPath = path.dirname(contents);
  return appPath.toLowerCase().endsWith(".app") ? appPath : null;
}

function findExecutableBaseName(inputPath, rootDir) {
  const ext = path.extname(inputPath || "").toLowerCase();
  if ([".sh", ".exe", ".py"].includes(ext)) {
    const base = path.basename(inputPath, ext);
    if (base && base.toLowerCase() !== "renpy") return base;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = { sh: [], exe: [], py: [] };
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    const lower = name.toLowerCase();
    if (lower === "renpy.sh" || lower === "renpy.py") continue;
    if (lower.endsWith(".sh")) candidates.sh.push(name.slice(0, -3));
    else if (lower.endsWith(".exe")) candidates.exe.push(name.slice(0, -4));
    else if (lower.endsWith(".py")) candidates.py.push(name.slice(0, -3));
  }

  for (const list of [candidates.sh, candidates.exe, candidates.py]) {
    if (list.length === 1) return list[0];
    for (const name of list) {
      if (candidates.exe.includes(name) || candidates.py.includes(name) || candidates.sh.includes(name)) {
        return name;
      }
    }
  }

  const fallback = path.basename(rootDir);
  if (fallback.toLowerCase().endsWith(".app")) {
    return path.basename(rootDir, ".app");
  }
  return fallback;
}

function resolveContentRoot(context) {
  if (!context?.isAppBundle) return context.rootDir;
  const autorun = path.join(context.rootDir, "Contents", "Resources", "autorun");
  if (existsDir(autorun)) return autorun;
  return context.rootDir;
}

function isRoot(rootDir) {
  const runtimeDir = path.join(rootDir, "renpy");
  const gameDir = path.join(rootDir, "game");
  const vcVersion = path.join(runtimeDir, "vc_version.py");
  return existsDir(runtimeDir) && existsDir(gameDir) && existsFile(vcVersion);
}

function detectGame(context) {
  let rootDir = context?.rootDir;
  if (typeof rootDir !== "string" || !rootDir) return null;

  let gameFolderOnly = false;
  let adjustedContext = context;

  if (isGameFolder(rootDir)) {
    const appPath = findAppBundleForGameFolder(rootDir);
    if (appPath) {
      adjustedContext = { ...context, rootDir: appPath, isAppBundle: true };
      rootDir = appPath;
    } else {
      const parent = path.dirname(rootDir);
      if (isRoot(parent)) {
        adjustedContext = { ...context, rootDir: parent, isAppBundle: false };
        rootDir = parent;
      } else {
        gameFolderOnly = true;
      }
    }
  }

  const contentRootDir = resolveContentRoot(adjustedContext);
  if (gameFolderOnly) {
    if (!isGameFolder(contentRootDir)) return null;
  } else if (!isRoot(contentRootDir)) {
    return null;
  }

  const versionEvidence = gameFolderOnly
    ? parseScriptVersionEvidence(contentRootDir)
    : resolveRenpyVersionEvidence(contentRootDir);
  const runtimeVersion = versionEvidence.version;
  const runtimeMajor = normalizeRenpyMajor(parseMajor(runtimeVersion));
  const buildInfo = readBuildInfo(contentRootDir);

  const baseName = gameFolderOnly
    ? null
    : findExecutableBaseName(adjustedContext.inputPath || rootDir, contentRootDir);
  const parentName = path.basename(path.dirname(contentRootDir));
  const fallbackName =
    gameFolderOnly && parentName && parentName.toLowerCase() !== "game"
      ? parentName
      : path.basename(rootDir);
  const name =
    (typeof buildInfo?.name === "string" && buildInfo.name.trim() && buildInfo.name.trim()) ||
    baseName ||
    fallbackName;
  const saveLocation = resolveDefaultSaveDir(contentRootDir);

  return {
    gameType: "scripted",
    gamePath: rootDir,
    contentRootDir,
    name,
    engine: "renpy",
    indexDir: null,
    indexHtml: null,
    defaultSaveDir: saveLocation.directory,
    moduleData: {
      version: runtimeVersion || null,
      versionSource: versionEvidence.versionSource,
      versionConfidence: versionEvidence.versionConfidence,
      saveDirectorySource: saveLocation.source,
      saveDirectoryConfidence: saveLocation.confidence,
      saveDirectoryWarning: saveLocation.error,
      saveDirectories: saveLocation.directories,
      configuredSaveDirectory: saveLocation.name,
      major: runtimeMajor || null,
      baseName: baseName || null,
      gameOnly: gameFolderOnly
    }
  };
}

module.exports = {
  detectGame,
  resolveRenpyVersion,
  resolveRenpyVersionEvidence
};
