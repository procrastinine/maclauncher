const fs = require("node:fs");
const path = require("node:path");

const OPTION_FILES = ["options.rpy", "gui.rpy"];
const DEFAULT_ICON_CANDIDATES = ["gui/icon.png", "gui/window_icon.png"];

function readText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function existsFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function parseConfigValue(text, key) {
  if (!text) return null;
  const regex = new RegExp(`\\bconfig\\.${key}\\s*=\\s*["']([^"']+)["']`, "i");
  const match = text.match(regex);
  if (!match) return null;
  const value = match[1] ? String(match[1]).trim() : "";
  return value || null;
}

function normalizeRenpyAssetPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  let cleaned = raw.replace(/^[\\/]+/, "").replace(/^\.\//, "");
  const parts = cleaned.split(/[\\/]+/);
  if (parts[0] && parts[0].toLowerCase() === "game") {
    parts.shift();
  }
  cleaned = parts.join(path.sep);
  return cleaned || null;
}

function resolveConfigValueFromRoots(roots, key) {
  const list = Array.isArray(roots) ? roots : [];
  for (const root of list) {
    if (!root) continue;
    for (const filename of OPTION_FILES) {
      const text = readText(path.join(root, filename));
      const value = parseConfigValue(text, key);
      if (value) return value;
    }
  }
  return null;
}

function resolveRenpyIconPath(roots, iconValue) {
  const list = Array.isArray(roots) ? roots : [];
  const candidates = [];
  if (iconValue) candidates.push(iconValue);
  candidates.push(...DEFAULT_ICON_CANDIDATES);

  for (const root of list) {
    if (!root) continue;
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (path.isAbsolute(candidate)) {
        if (existsFile(candidate)) return candidate;
        continue;
      }
      const normalized = normalizeRenpyAssetPath(candidate);
      if (!normalized) continue;
      const resolved = path.join(root, normalized);
      if (existsFile(resolved)) return resolved;
    }
  }

  return null;
}

module.exports = {
  DEFAULT_ICON_CANDIDATES,
  normalizeRenpyAssetPath,
  parseConfigValue,
  resolveConfigValueFromRoots,
  resolveRenpyIconPath
};
