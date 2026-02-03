const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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
    const match = lines[i].match(/version_tuple\s*=\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
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
    }
    if (elseIndex === -1) return null;
    if (pythonMajor === 2) {
      return findVersionTupleInLines(lines, i + 1, elseIndex);
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
    return findVersionTupleInLines(lines, elseIndex + 1, end);
  }
  return null;
}

function parseVersionFromInit(initPath, pythonMajor) {
  const text = readText(initPath);
  if (!text) return null;
  const conditional = parsePy2ConditionalVersion(text, pythonMajor);
  if (conditional) return conditional;
  const match = text.match(/version_tuple\s*=\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/m);
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

function resolveRenpyVersion(contentRootDir) {
  const vcVersionPath = path.join(contentRootDir, "renpy", "vc_version.py");
  const fromVc = parseVersionFromVc(vcVersionPath);
  const initPath = path.join(contentRootDir, "renpy", "__init__.py");
  const pythonMajor = resolvePythonMajor(contentRootDir);
  const fromInit = parseVersionFromInit(initPath, pythonMajor);
  if (!fromVc) return fromInit;
  if (!fromInit) return fromVc;
  const vcMajor = parseMajor(fromVc);
  const initMajor = parseMajor(fromInit);
  if (vcMajor != null && initMajor != null && vcMajor !== initMajor) return fromInit;
  return fromVc;
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

function parseSaveDirectory(gameDir) {
  const optionsPath = path.join(gameDir, "game", "options.rpy");
  const guiPath = path.join(gameDir, "game", "gui.rpy");
  const optionsFallback = path.join(gameDir, "options.rpy");
  const guiFallback = path.join(gameDir, "gui.rpy");
  const text = [optionsPath, guiPath, optionsFallback, guiFallback]
    .map(readText)
    .filter(Boolean)
    .join("\n");
  if (!text) return null;
  const match = text.match(/config\.save_directory\s*=\s*["']([^"']+)["']/);
  if (!match) return null;
  return match[1] ? String(match[1]).trim() : null;
}

function normalizeSaveName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function scoreSaveCandidate(candidate, gameName) {
  const rawCandidate = String(candidate || "");
  const rawGame = String(gameName || "");
  if (!rawCandidate || !rawGame) return null;

  const lowerCandidate = rawCandidate.toLowerCase();
  const lowerGame = rawGame.toLowerCase();
  const normCandidate = normalizeSaveName(rawCandidate);
  const normGame = normalizeSaveName(rawGame);

  if (!lowerCandidate.includes(lowerGame) && !normCandidate.includes(normGame)) return null;

  let score = 0;
  if (lowerCandidate === lowerGame) score += 120;
  if (normCandidate === normGame) score += 100;
  if (lowerCandidate.startsWith(lowerGame)) score += 50;
  if (normCandidate.startsWith(normGame)) score += 40;
  if (lowerCandidate.includes(lowerGame)) score += 20;
  if (normCandidate.includes(normGame)) score += 10;

  if (lowerCandidate.startsWith(lowerGame)) {
    const next = lowerCandidate[lowerGame.length];
    if (!next) score += 10;
    else if (/[-_ ]/.test(next)) score += 6;
    else if (/\d/.test(next)) score -= 6;
    else score -= 8;
  } else if (normCandidate.startsWith(normGame)) {
    const next = normCandidate[normGame.length];
    if (next && /\d/.test(next)) score -= 3;
  }

  score -= Math.min(20, Math.max(0, rawCandidate.length - rawGame.length));
  return score;
}

function findSaveDirByName(gameName) {
  const root = path.join(os.homedir(), "Library", "RenPy");
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
  if (candidates.length === 0) return null;

  let best = null;
  let bestScore = -Infinity;
  for (const name of candidates) {
    const score = scoreSaveCandidate(name, gameName);
    if (score == null) continue;
    if (score > bestScore) {
      bestScore = score;
      best = name;
      continue;
    }
    if (score === bestScore && best) {
      if (name.length < best.length || (name.length === best.length && name < best)) {
        best = name;
      }
    }
  }

  return best ? path.join(root, best) : null;
}

function resolveDefaultSaveDir(gameDir, gameName) {
  const saveDirName = parseSaveDirectory(gameDir);
  if (saveDirName) {
    const configured = path.join(os.homedir(), "Library", "RenPy", saveDirName);
    if (existsDir(configured)) return configured;
  }

  return findSaveDirByName(gameName);
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

function parseScriptVersion(gameDir) {
  const candidates = [
    path.join(gameDir, "game", "script_version.txt"),
    path.join(gameDir, "script_version.txt")
  ];
  const text = candidates.map(readText).filter(Boolean)[0];
  if (!text) return null;
  const tuple = text.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (tuple) return `${tuple[1]}.${tuple[2]}.${tuple[3]}`;
  const dotted = text.match(/(\d+\.\d+\.\d+)/);
  if (dotted) return dotted[1];
  const major = text.match(/(\d+)/);
  return major ? major[1] : null;
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

  const runtimeVersion = gameFolderOnly
    ? parseScriptVersion(contentRootDir)
    : resolveRenpyVersion(contentRootDir);
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

  return {
    gameType: "scripted",
    gamePath: rootDir,
    contentRootDir,
    name,
    engine: "renpy",
    indexDir: null,
    indexHtml: null,
    defaultSaveDir: resolveDefaultSaveDir(contentRootDir, name),
    moduleData: {
      version: runtimeVersion || null,
      major: runtimeMajor || null,
      baseName: baseName || null,
      gameOnly: gameFolderOnly
    }
  };
}

module.exports = {
  detectGame
};
