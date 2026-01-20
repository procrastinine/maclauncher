const fs = require("node:fs");
const path = require("node:path");

function existsDir(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function existsFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function findWebIndexHtml(contentRootDir, findIndexHtml) {
  const indexHtml = findIndexHtml(contentRootDir);
  if (indexHtml) return indexHtml;
  const distIndex = path.join(contentRootDir, "dist", "index.html");
  if (existsFile(distIndex)) return distIndex;
  return null;
}

function detectFromContentRoot(rootDir, contentRootDir, findIndexHtml) {
  if (!existsDir(contentRootDir)) return null;
  const indexHtml = findWebIndexHtml(contentRootDir, findIndexHtml);
  if (!indexHtml) return null;
  const indexDir = path.dirname(indexHtml);
  return {
    gameType: "web",
    engine: "web",
    gamePath: rootDir,
    contentRootDir,
    name: path.basename(rootDir),
    indexDir,
    indexHtml
  };
}

function detectGame(context, helpers) {
  const rootDir = context?.rootDir;
  if (typeof rootDir !== "string" || !rootDir) return null;

  const findIndexHtml =
    typeof helpers?.findIndexHtml === "function" ? helpers.findIndexHtml : null;
  if (!findIndexHtml) return null;

  const isAppBundle = context?.isAppBundle === true;

  if (isAppBundle) {
    const appNwDir = path.join(rootDir, "Contents", "Resources", "app.nw");
    if (existsDir(appNwDir)) {
      const indexHtml = findIndexHtml(appNwDir);
      if (indexHtml) {
        const indexDir = path.dirname(indexHtml);
        return {
          gameType: "web",
          engine: "web",
          gamePath: rootDir,
          contentRootDir: appNwDir,
          name: path.basename(rootDir),
          indexDir,
          indexHtml
        };
      }
    }

    const appDir = path.join(rootDir, "Contents", "Resources", "app");
    return detectFromContentRoot(rootDir, appDir, findIndexHtml);
  }

  const direct = detectFromContentRoot(rootDir, rootDir, findIndexHtml);
  if (direct) return direct;

  const candidates = [];
  const base = path.basename(rootDir).toLowerCase();
  if (base === "resources") {
    candidates.push(path.join(rootDir, "app"));
  } else {
    candidates.push(path.join(rootDir, "resources", "app"));
    candidates.push(path.join(rootDir, "Resources", "app"));
  }

  for (const candidate of candidates) {
    const detected = detectFromContentRoot(rootDir, candidate, findIndexHtml);
    if (detected) return detected;
  }

  return null;
}

module.exports = {
  detectGame
};
