const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const Packaging = require("../shared/web/runtime/nwjs-packaging");

const EXTRACT_META = ".maclauncher-construct-extract.json";

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

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

function stableIdForPath(input) {
  return crypto.createHash("sha256").update(String(input || "")).digest("hex").slice(0, 12);
}

function readPackageJson(contentRootDir) {
  const pkgPath = path.join(contentRootDir, "package.json");
  if (!existsFile(pkgPath)) return null;
  try {
    const raw = fs.readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function findIndexHtml(contentRootDir) {
  const pkg = readPackageJson(contentRootDir);
  if (pkg && typeof pkg.main === "string") {
    const candidate = path.resolve(contentRootDir, pkg.main);
    if (candidate.toLowerCase().endsWith(".html") && existsFile(candidate)) {
      return candidate;
    }
  }
  const rootIndex = path.join(contentRootDir, "index.html");
  const wwwIndex = path.join(contentRootDir, "www", "index.html");
  if (existsFile(rootIndex)) return rootIndex;
  if (existsFile(wwwIndex)) return wwwIndex;
  return null;
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

function findContentRoot(extractRoot) {
  const direct = findIndexHtml(extractRoot);
  if (direct) {
    return { contentRootDir: extractRoot, indexHtml: direct };
  }

  let entries = [];
  try {
    entries = fs.readdirSync(extractRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(extractRoot, entry.name);
    const nested = findIndexHtml(candidate);
    if (nested) {
      return { contentRootDir: candidate, indexHtml: nested };
    }
  }

  return null;
}

function readExtractionMeta(extractRoot) {
  const metaPath = path.join(extractRoot, EXTRACT_META);
  if (!existsFile(metaPath)) return null;
  try {
    const raw = fs.readFileSync(metaPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeExtractionMeta(extractRoot, payload) {
  const metaPath = path.join(extractRoot, EXTRACT_META);
  try {
    fs.writeFileSync(metaPath, JSON.stringify(payload, null, 2), "utf8");
  } catch {}
}

async function extractPackage({ packagePath, packageType, extractRoot }) {
  safeRm(extractRoot);
  ensureDir(extractRoot);

  if (packageType === "asar") {
    Packaging.extractAsarToDir(packagePath, extractRoot);
    return { method: "asar" };
  }

  if (packageType === "package.nw" && existsDir(packagePath)) {
    fs.cpSync(packagePath, extractRoot, { recursive: true });
    return { method: "copy" };
  }

  let zipResult = null;
  try {
    zipResult = await Packaging.extractZipPayload(packagePath, extractRoot);
  } catch {
    zipResult = null;
  }
  if (zipResult) return { method: "zip" };

  let overlay = null;
  try {
    overlay = await Packaging.extractPeOverlayZip(packagePath, extractRoot);
  } catch {
    overlay = null;
  }
  if (overlay) return { method: "pe-overlay" };

  throw new Error("Failed to extract Construct bundle.");
}

function resolveExtractionRoot({ entry, userDataDir, moduleId }) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const key = moduleData.packagedPath || entry?.importPath || entry?.gamePath || "";
  const id = stableIdForPath(key);
  return path.join(userDataDir, "modules", moduleId, "extracted", id);
}

function resolveExtractionStatus({ entry, userDataDir, moduleId }) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const packagedType = moduleData.packagedType || null;
  const packagedPath = moduleData.packagedPath || null;

  if (!packagedType) {
    const indexHtml = entry?.indexHtml || null;
    const indexDir =
      entry?.indexDir || (typeof indexHtml === "string" ? path.dirname(indexHtml) : null);
    const constructRuntime =
      detectRuntimeFromIndex(indexDir, indexHtml) || moduleData.constructRuntime || null;
    return {
      extractedReady: true,
      extractedRoot: moduleData.extractedRoot || null,
      packagedType: null,
      packagedPath: null,
      contentRootDir: entry?.contentRootDir || entry?.gamePath || null,
      indexHtml,
      indexDir,
      constructRuntime
    };
  }

  const extractRoot =
    moduleData.extractedRoot || resolveExtractionRoot({ entry, userDataDir, moduleId });
  if (!existsDir(extractRoot)) {
    return {
      extractedReady: false,
      extractedRoot: extractRoot,
      packagedType,
      packagedPath,
      contentRootDir: null,
      indexHtml: null,
      indexDir: null,
      constructRuntime: moduleData.constructRuntime || null
    };
  }

  const meta = readExtractionMeta(extractRoot);
  if (meta?.sourcePath && packagedPath && meta.sourcePath !== packagedPath) {
    return {
      extractedReady: false,
      extractedRoot: extractRoot,
      packagedType,
      packagedPath,
      contentRootDir: null,
      indexHtml: null,
      indexDir: null,
      constructRuntime: moduleData.constructRuntime || null
    };
  }

  const content = findContentRoot(extractRoot);
  if (!content) {
    return {
      extractedReady: false,
      extractedRoot: extractRoot,
      packagedType,
      packagedPath,
      contentRootDir: null,
      indexHtml: null,
      indexDir: null,
      constructRuntime: moduleData.constructRuntime || null
    };
  }

  const indexDir = path.dirname(content.indexHtml);
  const constructRuntime =
    detectRuntimeFromIndex(indexDir, content.indexHtml) || moduleData.constructRuntime || null;

  return {
    extractedReady: true,
    extractedRoot: extractRoot,
    packagedType,
    packagedPath,
    contentRootDir: content.contentRootDir,
    indexHtml: content.indexHtml,
    indexDir,
    constructRuntime
  };
}

module.exports = {
  extractPackage,
  findContentRoot,
  resolveExtractionRoot,
  resolveExtractionStatus,
  writeExtractionMeta
};
