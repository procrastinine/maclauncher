const fs = require("node:fs");
const path = require("node:path");
const Packaging = require("../shared/web/runtime/nwjs-packaging");

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
  if (existsFile(distIndex)) {
    try {
      const relative = path.relative(fs.realpathSync(contentRootDir), fs.realpathSync(distIndex));
      if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return distIndex;
    } catch {}
  }
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

function detectCarrierExport(context, helpers, contentRootDir, carrier, format) {
  const rootDir = context.rootDir;
  if (!existsDir(contentRootDir)) return null;
  try {
    const contained = (root, candidate) => {
      const relative = path.relative(root, candidate);
      return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    const realRoot = fs.realpathSync(rootDir), realContent = fs.realpathSync(contentRootDir);
    if (!contained(realRoot, realContent)) return null;
    const packagePath = path.join(contentRootDir, "package.json");
    if (!contained(realContent, fs.realpathSync(packagePath))) return null;
    const stat = fs.statSync(packagePath);
    if (!stat.isFile() || stat.size > 65536) return null;
    const source = helpers.readText ? helpers.readText(packagePath, 65536) : fs.readFileSync(packagePath, "utf8");
    const pkg = JSON.parse(source);
    if (typeof pkg?.main !== "string" || !pkg.main.trim() || pkg.main.includes("\0") ||
      path.isAbsolute(pkg.main) || /^[a-z][a-z\d+.-]*:/i.test(pkg.main)) return null;
    const main = path.resolve(contentRootDir, pkg.main);
    if (!contained(path.resolve(contentRootDir), main) || !contained(realContent, fs.realpathSync(main)) || !existsFile(main)) return null;
    const detected = detectFromContentRoot(rootDir, contentRootDir, helpers.findIndexHtml);
    if (!detected) return null;
    detected.detectionEvidence = [{ type: "selected-artifact", path: context.inputPath, format, source: carrier.source }];
    return detected;
  } catch (error) {
    if (error.code === "DETECTION_LIMIT") throw error;
    return null;
  }
}

function detectGame(context, helpers) {
  const rootDir = context?.rootDir;
  if (typeof rootDir !== "string" || !rootDir) return null;

  const findIndexHtml =
    typeof helpers?.findIndexHtml === "function" ? helpers.findIndexHtml : null;
  if (!findIndexHtml) return null;

  const isAppBundle = context?.isAppBundle === true;

  if (context?.stat?.isFile && context.stat.isFile()) {
    const extension = path.extname(String(context.inputPath || "")).toLowerCase();
    if (extension !== ".html" && extension !== ".htm") {
      if (extension !== ".exe") return null;
      const options = { detection: context.detection };
      const nw = Packaging.readNwjsCarrier(context.inputPath, options);
      const electron = nw ? null : Packaging.readElectronCarrier(context.inputPath, options);
      if (!nw && !electron) return null;
      const roots = nw
        ? [rootDir, path.join(rootDir, "package.nw"), path.join(rootDir, "app.nw")]
        : [path.join(rootDir, "resources", "app"), path.join(rootDir, "Resources", "app")];
      for (const contentRoot of roots) {
        const detected = detectCarrierExport(context, helpers, contentRoot, nw || electron, nw ? "NW.js PE carrier" : "Electron PE carrier");
        if (detected) return detected;
      }
      return null;
    }
  }

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
