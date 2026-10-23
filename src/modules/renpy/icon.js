const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const GameData = require("../shared/game-data");
const Images = require("../../core/icon-utils");
const { readGameConfigurationSources, readRpaIndex, readRpaMember } = require("./script-config");
const { sourceAssignments, parseSaveDirectoryLiteral } = require("./save-location");

const MAX_ICON_BYTES = 8 * 1024 ** 2;
const DEFAULTS = ["gui/window_icon.png", "gui/icon.png", "gui/window_icon.webp", "gui/icon.webp", "window_icon.png", "icon.png"];
function assetName(value) {
  if (typeof value !== "string" || value.length > 4096 || /[\\\x00-\x1f]/.test(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return null;
  const name = value.replace(/^\.\//, "").replace(/^game\//, "");
  return name.split("/").every(part => part && part !== "." && part !== "..") && /\.(?:png|webp)$/i.test(name) ? name : null;
}
function configuredIcon(roots) {
  const inspected = readGameConfigurationSources(roots, { keys: ["window_icon"] });
  const assignments = inspected.sources.flatMap(item => item.compiledAssignments
    ? item.compiledAssignments.flatMap(assignment => assignment.python
      ? sourceAssignments(assignment.python, assignment.source, { keys: ["window_icon"], python: true, unsafeContext: assignment.unsafeContext }) : [assignment])
    : sourceAssignments(item.text, item.source, { keys: ["window_icon"] }));
  const values = assignments.map(item => item.unsafeContext ? null : assetName(parseSaveDirectoryLiteral(item.expression || "")));
  return values.length && values.every(Boolean) && new Set(values).size === 1 ? values[0] : null;
}
function identity(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Icon source must be a regular file.");
  return { stat, fingerprint: [fs.realpathSync(filename), stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs] };
}
function within(root, file) {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(file));
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}
function candidates(roots, names) {
  const results = [], archives = new Map();
  for (const root of roots) {
    try {
      const files = fs.readdirSync(root, { withFileTypes: true });
      if (files.length > 4096) continue;
      archives.set(root, files.filter(item => item.isFile() && /\.rpa$/i.test(item.name)).map(item => path.join(root, item.name)).sort().reverse().slice(0, 32));
    } catch {}
  }
  for (const name of names) for (const root of roots) {
    const file = path.join(root, name);
    try {
      const { stat, fingerprint } = identity(file);
      if (stat.size > 0 && stat.size <= MAX_ICON_BYTES && within(root, file)) results.push({ source: file, fingerprint, name, path: file, load: () => fs.readFileSync(file) });
    } catch {}
    for (const archive of archives.get(root) || []) {
      try {
        const member = readRpaIndex(archive).members.get(name);
        if (!member || member.size < 1 || member.size > MAX_ICON_BYTES) continue;
        const { fingerprint } = identity(archive);
        results.push({ source: `${archive}!/${name}`, fingerprint: [...fingerprint, name], name, load: () => readRpaMember(archive, name) });
      } catch {}
    }
  }
  return results.slice(0, 64);
}
function cacheDirectory(userDataDir, gameId) {
  if (typeof userDataDir !== "string" || !path.isAbsolute(userDataDir) || !/^[A-Za-z0-9_-]{1,128}$/.test(gameId || "")) return null;
  const directory = path.join(GameData.resolveGameModuleDir(userDataDir, gameId, "renpy"), "icons");
  let current = userDataDir;
  for (const segment of path.relative(userDataDir, directory).split(path.sep)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("Ren'Py icon cache contains a symlink.");
    fs.mkdirSync(current, { recursive: true });
  }
  return directory;
}
function resolveRenpyIcon({ roots, userDataDir, gameId, validateImage = () => true }) {
  roots = [...new Set((roots || []).filter(root => typeof root === "string" && path.isAbsolute(root)))].slice(0, 4);
  const configured = configuredIcon(roots), names = [...new Set([configured, ...DEFAULTS].filter(Boolean))];
  for (const candidate of candidates(roots, names)) {
    try {
      const fingerprint = JSON.stringify(candidate.fingerprint);
      const directory = userDataDir && gameId ? cacheDirectory(userDataDir, gameId) : null;
      const cache = directory && path.join(directory, `window-icon${path.extname(candidate.name).toLowerCase()}`), recordPath = cache && cache + ".source.json";
      if (cache) {
        for (const file of [cache, recordPath]) {
          try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Ren'Py icon cache file is a symlink."); } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        try {
          if (identity(cache).stat.size > MAX_ICON_BYTES || identity(recordPath).stat.size > 16384) throw new Error("Oversized cached icon metadata.");
          const record = JSON.parse(fs.readFileSync(recordPath));
          const bytes = fs.readFileSync(cache);
          if (record.fingerprint === fingerprint && record.sha256 === crypto.createHash("sha256").update(bytes).digest("hex") && Images.isSupportedImageBuffer(bytes) && validateImage(bytes)) return { path: cache, source: candidate.source, fingerprint };
        } catch {}
      }
      const bytes = candidate.load();
      if (!Images.isSupportedImageBuffer(bytes) || !validateImage(bytes)) continue;
      if (!cache) { if (candidate.path) return { path: candidate.path, source: candidate.source, fingerprint }; continue; }
      fs.writeFileSync(cache, bytes);
      fs.writeFileSync(recordPath, JSON.stringify({ fingerprint, source: candidate.source, sha256: crypto.createHash("sha256").update(bytes).digest("hex") }) + "\n");
      return { path: cache, source: candidate.source, fingerprint };
    } catch {}
  }
  return null;
}

module.exports = { resolveRenpyIcon, configuredIcon, assetName, MAX_ICON_BYTES };
