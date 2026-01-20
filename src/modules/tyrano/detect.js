const fs = require("node:fs");
const path = require("node:path");

const Packaging = require("../shared/web/runtime/nwjs-packaging");

const KAG_REL_PATH = "tyrano/plugins/kag/kag.js";

function existsFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function existsDir(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function normalizeZipName(name) {
  return String(name || "").replace(/\\/g, "/");
}

function parseTyranoVersion(text) {
  const patterns = [
    /TYRANO_ENGINE_VERSION\s*[:=]\s*["']?([0-9.]+)["']?/i,
    /tyrano_version\s*[:=]\s*["']?([0-9.]+)["']?/i,
    /TYRANO_VERSION\s*[:=]\s*["']?([0-9.]+)["']?/i
  ];
  for (const re of patterns) {
    const match = String(text || "").match(re);
    if (match && match[1]) return match[1];
  }
  return null;
}

function readKagVersion(kagPath) {
  try {
    const raw = fs.readFileSync(kagPath, "utf8");
    return parseTyranoVersion(raw);
  } catch {
    return null;
  }
}

function zipMatchesTyrano(entries) {
  const names = entries.map(entry => normalizeZipName(entry.name));
  const hasKag = names.some(name => name.endsWith(KAG_REL_PATH));
  if (!hasKag) return false;
  const hasPackage = names.some(name => name.endsWith("package.json"));
  const hasBuilderConfig = names.some(name => name.endsWith("builder_config.json"));
  return hasPackage || hasBuilderConfig;
}

function asarMatchesTyrano(entries) {
  const names = entries.map(entry => normalizeZipName(entry.path));
  return names.some(name => name.endsWith(KAG_REL_PATH));
}

function detectFromDirectory(rootDir, findIndexHtml) {
  const indexHtml = findIndexHtml(rootDir);
  if (!indexHtml) return null;
  const indexDir = path.dirname(indexHtml);
  const kagPath = path.join(indexDir, "tyrano", "plugins", "kag", "kag.js");
  if (!existsFile(kagPath)) return null;

  const version = readKagVersion(kagPath);

  return {
    indexHtml,
    indexDir,
    contentRootDir: rootDir,
    version
  };
}

function detectFromPackageFile(filePath) {
  let info = null;
  try {
    info = Packaging.readZipEntries(filePath);
  } catch {
    info = null;
  }
  if (!info || !Array.isArray(info.entries)) return null;
  if (!zipMatchesTyrano(info.entries)) return null;
  return info;
}

function detectGame(context, helpers) {
  const rootDir = context?.rootDir;
  if (typeof rootDir !== "string" || !rootDir) return null;

  const findIndexHtml =
    typeof helpers?.findIndexHtml === "function" ? helpers.findIndexHtml : null;
  if (!findIndexHtml) return null;

  if (context?.isAppBundle) {
    const appNwDir = path.join(rootDir, "Contents", "Resources", "app.nw");
    if (existsDir(appNwDir)) {
      const unpacked = detectFromDirectory(appNwDir, findIndexHtml);
      if (unpacked) {
        return {
          gameType: "web",
          engine: "tyrano",
          gamePath: rootDir,
          contentRootDir: unpacked.contentRootDir,
          name: path.basename(rootDir),
          indexDir: unpacked.indexDir,
          indexHtml: unpacked.indexHtml,
          moduleData: {
            version: unpacked.version || null,
            packagedType: null
          }
        };
      }
    }

    const appAsar = path.join(rootDir, "Contents", "Resources", "app.asar");
    if (existsFile(appAsar)) {
      try {
        const { header, dataOffset } = Packaging.readAsarHeader(appAsar);
        const entries = Packaging.listAsarEntries(header, dataOffset);
        if (asarMatchesTyrano(entries)) {
          return {
            gameType: "web",
            engine: "tyrano",
            gamePath: rootDir,
            contentRootDir: rootDir,
            name: path.basename(rootDir),
            indexDir: null,
            indexHtml: null,
            moduleData: {
              version: null,
              packagedType: "asar",
              packagedPath: appAsar
            }
          };
        }
      } catch {}
    }
    return null;
  }

  if (context?.stat?.isFile && context.stat.isFile()) {
    const inputPath = context?.inputPath;
    const ext = path.extname(String(inputPath || "")).toLowerCase();
    if (ext === ".exe") {
      const zip = detectFromPackageFile(inputPath);
      if (zip) {
        return {
          gameType: "web",
          engine: "tyrano",
          gamePath: rootDir,
          contentRootDir: rootDir,
          name: path.basename(rootDir),
          indexDir: null,
          indexHtml: null,
          moduleData: {
            version: null,
            packagedType: "zip-exe",
            packagedPath: inputPath
          }
        };
      }
    }
  }

  const unpacked = detectFromDirectory(rootDir, findIndexHtml);
  if (unpacked) {
    return {
      gameType: "web",
      engine: "tyrano",
      gamePath: rootDir,
      contentRootDir: unpacked.contentRootDir,
      name: path.basename(rootDir),
      indexDir: unpacked.indexDir,
      indexHtml: unpacked.indexHtml,
      moduleData: {
        version: unpacked.version || null,
        packagedType: null
      }
    };
  }

  const packageNwPath = path.join(rootDir, "package.nw");
  if (existsDir(packageNwPath)) {
    const pkg = detectFromDirectory(packageNwPath, findIndexHtml);
    if (pkg) {
      return {
        gameType: "web",
        engine: "tyrano",
        gamePath: rootDir,
        contentRootDir: pkg.contentRootDir,
        name: path.basename(rootDir),
        indexDir: pkg.indexDir,
        indexHtml: pkg.indexHtml,
        moduleData: {
          version: pkg.version || null,
          packagedType: "package.nw",
          packagedPath: packageNwPath
        }
      };
    }
  }

  if (existsFile(packageNwPath)) {
    const zip = detectFromPackageFile(packageNwPath);
    if (zip) {
      return {
        gameType: "web",
        engine: "tyrano",
        gamePath: rootDir,
        contentRootDir: rootDir,
        name: path.basename(rootDir),
        indexDir: null,
        indexHtml: null,
        moduleData: {
          version: null,
          packagedType: "package.nw",
          packagedPath: packageNwPath
        }
      };
    }
  }

  return null;
}

module.exports = {
  detectGame
};
