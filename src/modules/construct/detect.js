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

function readTextFile(p, maxBytes = 65536) {
  try {
    const stat = fs.statSync(p);
    const size = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(p, "r");
    try {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function detectRuntimeFromHtml(html) {
  const source = String(html || "");
  if (!source) return null;

  const meta = source.match(/<meta[^>]+name=["']generator["'][^>]*>/i);
  if (meta && meta[0]) {
    const content = meta[0].match(/content=["']([^"']+)["']/i);
    const value = content && content[1] ? content[1] : "";
    if (/construct\s*2/i.test(value)) return "Construct 2";
    if (/construct\s*3/i.test(value)) return "Construct 3";
    if (/scirra\s+construct/i.test(value)) return "Construct 3";
  }

  if (/made with construct/i.test(source)) return "Construct 3";
  if (/scirra\s+construct/i.test(source)) return "Construct 3";
  if (/construct\.net/i.test(source)) return "Construct 3";
  if (/construct\s*3/i.test(source)) return "Construct 3";
  if (/construct\s*2/i.test(source)) return "Construct 2";
  return null;
}

function detectRuntimeFromIndex(indexDir, indexHtml) {
  if (!indexDir) return null;
  const c2Runtime = path.join(indexDir, "c2runtime.js");
  const c3Runtime = path.join(indexDir, "c3runtime.js");
  const c3RuntimeAlt = path.join(indexDir, "scripts", "c3runtime.js");
  const c3Main = path.join(indexDir, "scripts", "c3main.js");

  if (existsFile(c2Runtime)) return "Construct 2";
  if (existsFile(c3Runtime) || existsFile(c3RuntimeAlt) || existsFile(c3Main)) {
    return "Construct 3";
  }

  if (indexHtml) {
    const html = readTextFile(indexHtml);
    return detectRuntimeFromHtml(html);
  }

  return null;
}

function normalizeZipName(name) {
  return String(name || "").replace(/\\/g, "/");
}

function detectRuntimeFromZipEntries(entries) {
  const names = entries.map(entry => normalizeZipName(entry.name));
  const hasC2 = names.some(name => name.endsWith("c2runtime.js"));
  const hasC3 = names.some(
    name =>
      name.endsWith("c3runtime.js") ||
      name.endsWith("scripts/c3runtime.js") ||
      name.endsWith("scripts/c3main.js")
  );
  if (hasC2) return "Construct 2";
  if (hasC3) return "Construct 3";
  return null;
}

function detectFromDirectory(rootDir, findIndexHtml) {
  const indexHtml = findIndexHtml(rootDir);
  if (!indexHtml) return null;
  const indexDir = path.dirname(indexHtml);
  const constructRuntime = detectRuntimeFromIndex(indexDir, indexHtml);
  if (!constructRuntime) return null;
  return {
    indexHtml,
    indexDir,
    contentRootDir: rootDir,
    constructRuntime
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
  const constructRuntime = detectRuntimeFromZipEntries(info.entries);
  if (!constructRuntime) return null;
  return {
    constructRuntime
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
      const unpacked = detectFromDirectory(appNwDir, findIndexHtml);
      if (unpacked) {
        return {
          gameType: "web",
          engine: "construct",
          gamePath: rootDir,
          contentRootDir: unpacked.contentRootDir,
          name: path.basename(rootDir),
          indexDir: unpacked.indexDir,
          indexHtml: unpacked.indexHtml,
          moduleData: {
            constructRuntime: unpacked.constructRuntime,
            packagedType: null
          }
        };
      }
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
          engine: "construct",
          gamePath: rootDir,
          contentRootDir: rootDir,
          name: path.basename(rootDir),
          indexDir: null,
          indexHtml: null,
          moduleData: {
            constructRuntime: zip.constructRuntime,
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
      engine: "construct",
      gamePath: rootDir,
      contentRootDir: unpacked.contentRootDir,
      name: path.basename(rootDir),
      indexDir: unpacked.indexDir,
      indexHtml: unpacked.indexHtml,
      moduleData: {
        constructRuntime: unpacked.constructRuntime,
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
        engine: "construct",
        gamePath: rootDir,
        contentRootDir: pkg.contentRootDir,
        name: path.basename(rootDir),
        indexDir: pkg.indexDir,
        indexHtml: pkg.indexHtml,
        moduleData: {
          constructRuntime: pkg.constructRuntime,
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
        engine: "construct",
        gamePath: rootDir,
        contentRootDir: rootDir,
        name: path.basename(rootDir),
        indexDir: null,
        indexHtml: null,
        moduleData: {
          constructRuntime: zip.constructRuntime,
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
