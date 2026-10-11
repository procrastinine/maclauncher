const fs = require("node:fs");
const path = require("node:path");

function existsDir(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function defaultFindIndexHtml(rootDir) {
  let indexHtml = null;
  const pkgPath = path.join(rootDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (typeof pkg?.main === "string") {
        const candidate = path.resolve(rootDir, pkg.main);
        if (candidate.toLowerCase().endsWith(".html") && fs.existsSync(candidate)) {
          indexHtml = candidate;
        }
      }
    } catch {}
  }

  const rootIndex = path.join(rootDir, "index.html");
  const wwwIndex = path.join(rootDir, "www", "index.html");
  if (!indexHtml && fs.existsSync(rootIndex)) indexHtml = rootIndex;
  if (!indexHtml && fs.existsSync(wwwIndex)) indexHtml = wwwIndex;
  return indexHtml;
}

function detectRpgmakerVariant(indexDir) {
  const mzCore = path.join(indexDir, "js", "rmmz_core.js");
  const mvCore = path.join(indexDir, "js", "rpg_core.js");
  if (fs.existsSync(mzCore)) return "mz";
  if (fs.existsSync(mvCore)) return "mv";
  return null;
}

function readGameTitle(systemJson, contentRootDir, helpers) {
  try {
    const stat = helpers.stat ? helpers.stat(systemJson) : fs.statSync(systemJson);
    if (!stat?.isFile() || stat.size > 256 * 1024) return null;
    const relative = path.relative(fs.realpathSync(contentRootDir), fs.realpathSync(systemJson));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    const raw = helpers.readText ? helpers.readText(systemJson, 256 * 1024) : fs.readFileSync(systemJson, "utf8");
    const title = JSON.parse(raw)?.gameTitle;
    return typeof title === "string" && title.trim() && !title.includes("\0") ? title.trim() : null;
  } catch (error) {
    if (error.code === "DETECTION_LIMIT") throw error;
    return null;
  }
}

function detectRpgmakerGame(context, helpers = {}) {
  const rootDir = context?.rootDir;
  if (typeof rootDir !== "string" || !rootDir) return null;

  const findIndexHtml =
    typeof helpers.findIndexHtml === "function" ? helpers.findIndexHtml : defaultFindIndexHtml;

  const isAppBundle = context?.isAppBundle === true;
  let indexHtml = null;
  let contentRootDir = null;

  if (isAppBundle) {
    const appNwDir = path.join(rootDir, "Contents", "Resources", "app.nw");
    if (!existsDir(appNwDir)) return null;
    indexHtml = findIndexHtml(appNwDir);
    if (!indexHtml) return null;
    contentRootDir = appNwDir;
  } else {
    indexHtml = findIndexHtml(rootDir);
    if (!indexHtml) return null;
    contentRootDir = rootDir;
  }

  const indexDir = path.dirname(indexHtml);
  const engine = detectRpgmakerVariant(indexDir);
  if (!engine) return null;

  const systemJson = path.join(indexDir, "data", "System.json");
  const title = readGameTitle(systemJson, contentRootDir, helpers);
  const name = title || path.basename(rootDir);

  const defaultSaveDir = path.join(indexDir, "save");

  return {
    gameType: "web",
    gamePath: rootDir,
    contentRootDir: contentRootDir || rootDir,
    name,
    nameSource: title ? { type: "metadata", path: systemJson, field: "gameTitle" } : { type: "folder", path: rootDir },
    engine,
    indexDir,
    indexHtml,
    defaultSaveDir
  };
}

module.exports = {
  detectRpgmakerGame
};
