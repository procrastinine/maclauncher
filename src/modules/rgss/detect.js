const fs = require("node:fs");
const path = require("node:path");
const { normalizeRgssVersion, normalizeRtpId, rgssVersionFromRtpId } = require("./rgss-utils");

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function stripInlineComment(value) {
  const idx = String(value || "").search(/\s[;#]/);
  if (idx >= 0) return String(value || "").slice(0, idx).trim();
  return String(value || "").trim();
}

function parseIni(raw) {
  const text = String(raw || "").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  const out = {};
  let section = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
    const sectionMatch = trimmed.match(/^\[(.+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      if (!out[section]) out[section] = {};
      continue;
    }
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim().toLowerCase();
    if (!key) continue;
    const value = stripInlineComment(trimmed.slice(idx + 1));
    if (!out[section]) out[section] = {};
    out[section][key] = value;
  }

  return out;
}

function readIniFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return parseIni(raw);
  } catch {
    return null;
  }
}

function findGameIni(rootDir) {
  const candidate = path.join(rootDir, "Game.ini");
  const stat = safeStat(candidate);
  if (stat && stat.isFile()) return candidate;
  return null;
}

function detectRgssFromScripts(rootDir) {
  const dataDir = path.join(rootDir, "Data");
  const scripts = [
    { file: "Scripts.rxdata", version: "RGSS1" },
    { file: "Scripts.rvdata", version: "RGSS2" },
    { file: "Scripts.rvdata2", version: "RGSS3" }
  ];
  for (const entry of scripts) {
    const candidate = path.join(dataDir, entry.file);
    const stat = safeStat(candidate);
    if (stat && stat.isFile()) return entry.version;
  }
  return null;
}

function detectRgssFromDll(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name || "";
    if (!name.toLowerCase().endsWith(".dll")) continue;
    if (!name.toLowerCase().startsWith("rgss")) continue;
    const version = normalizeRgssVersion(name);
    if (version) return version;
  }
  return null;
}

function detectRgssFromDlls(rootDir) {
  const direct = detectRgssFromDll(rootDir);
  if (direct) return direct;
  const systemDir = path.join(rootDir, "System");
  const stat = safeStat(systemDir);
  if (!stat || !stat.isDirectory()) return null;
  return detectRgssFromDll(systemDir);
}

function listExeBases(rootDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry.isFile())
    .map(entry => entry.name || "")
    .filter(name => name.toLowerCase().endsWith(".exe"))
    .map(name => name.slice(0, -4))
    .filter(Boolean);
}

function resolveExecName(rootDir, iniBase) {
  if (iniBase) return iniBase;
  const exeBases = listExeBases(rootDir);
  const gameExe = exeBases.find(base => base.toLowerCase() === "game");
  if (gameExe) return gameExe;
  if (exeBases.length === 1) return exeBases[0];
  return iniBase || "Game";
}

function detectGame(context) {
  const rootDir = context?.rootDir;
  if (!rootDir || typeof rootDir !== "string") return null;

  const gameIniPath = findGameIni(rootDir);
  const iniBase = gameIniPath ? path.basename(gameIniPath, path.extname(gameIniPath)) : null;
  const ini = gameIniPath ? readIniFile(gameIniPath) : null;
  const gameSection = ini?.game || ini?.["game"] || null;

  const name =
    typeof gameSection?.title === "string" && gameSection.title.trim()
      ? gameSection.title.trim()
      : path.basename(rootDir);

  const rtpId = normalizeRtpId(gameSection?.rtp);
  let rgssVersion = normalizeRgssVersion(gameSection?.library);
  if (!rgssVersion) rgssVersion = rgssVersionFromRtpId(rtpId);
  if (!rgssVersion) rgssVersion = detectRgssFromScripts(rootDir);
  if (!rgssVersion) rgssVersion = detectRgssFromDlls(rootDir);

  if (!gameIniPath && !rgssVersion) return null;

  const execName = resolveExecName(rootDir, iniBase);
  const moduleData = { execName };
  if (rgssVersion) moduleData.rgssVersion = rgssVersion;
  if (rtpId) moduleData.rtpId = rtpId;

  return {
    gameType: "rgss",
    engine: "rgss",
    gamePath: rootDir,
    contentRootDir: rootDir,
    name,
    moduleData,
    // TODO: Confirm RGSS save location; this uses the root directory.
    defaultSaveDir: rootDir
  };
}

module.exports = {
  detectGame
};
