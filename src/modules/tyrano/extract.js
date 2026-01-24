const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GameData = require("../shared/game-data");
const Packaging = require("../shared/web/runtime/nwjs-packaging");
const { buildEvbunpackCommand } = require("../shared/runtime/python");

const EXTRACT_META = ".maclauncher-tyrano-extract.json";
const PATCH_MARKER = "maclauncher:tyrano-userenv";

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

function ensureUserEnvPatch(contentRootDir, logger) {
  const libsPath = path.join(contentRootDir, "tyrano", "libs.js");
  if (!existsFile(libsPath)) return false;
  try {
    const raw = fs.readFileSync(libsPath, "utf8");
    if (raw.includes(PATCH_MARKER) || raw.includes("jQuery.userenv")) return false;
    const suffix = `\n// ${PATCH_MARKER}\nif (typeof jQuery !== "undefined") {\n  jQuery.userenv = function () { return "pc"; };\n}\n`;
    fs.writeFileSync(libsPath, raw + suffix, "utf8");
    logger?.info?.("[tyrano] patched tyrano/libs.js for userenv");
    return true;
  } catch (e) {
    logger?.warn?.("[tyrano] userenv patch failed", String(e?.message || e));
    return false;
  }
}

function runCommand(cmd, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", b => {
      stderr += b.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) return resolve(true);
      const err = new Error(`${cmd} failed (${code})`);
      err.stderr = stderr;
      reject(err);
    });
  });
}

async function extractPackage({
  packagePath,
  packageType,
  extractRoot,
  userDataDir,
  logger
}) {
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

  const evb = buildEvbunpackCommand({ userDataDir });
  logger?.info?.("[tyrano] running evbunpack fallback");
  await runCommand(evb.command, [...evb.args, packagePath, extractRoot], { env: evb.env });
  return { method: "evbunpack" };
}

function resolveExtractionRoot({ entry, userDataDir, moduleId }) {
  if (!userDataDir) return null;
  const gameId = entry?.gameId;
  if (!gameId) throw new Error("Missing gameId for extraction root.");
  const moduleKey = moduleId || entry?.moduleId || "tyrano";
  return path.join(GameData.resolveGameModuleDir(userDataDir, gameId, moduleKey), "extracted");
}

function resolveExtractionStatus({ entry, userDataDir, moduleId, logger }) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const packagedType = moduleData.packagedType || null;
  const packagedPath = moduleData.packagedPath || null;

  if (!packagedType) {
    return {
      extractedReady: true,
      extractedRoot: moduleData.extractedRoot || null,
      packagedType: null,
      packagedPath: null,
      contentRootDir: entry?.contentRootDir || null,
      indexHtml: entry?.indexHtml || null,
      indexDir: entry?.indexDir || null,
      version: moduleData.version || null
    };
  }

  const extractRoot = moduleData.extractedRoot || resolveExtractionRoot({ entry, userDataDir, moduleId });
  if (!existsDir(extractRoot)) {
    return {
      extractedReady: false,
      extractedRoot: extractRoot,
      packagedType,
      packagedPath,
      contentRootDir: null,
      indexHtml: null,
      indexDir: null,
      version: moduleData.version || null
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
      version: moduleData.version || null
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
      version: moduleData.version || null
    };
  }

  const version = (() => {
    const kag = path.join(content.contentRootDir, "tyrano", "plugins", "kag", "kag.js");
    if (!existsFile(kag)) return moduleData.version || null;
    try {
      const raw = fs.readFileSync(kag, "utf8");
      const match = raw.match(/TYRANO_ENGINE_VERSION\s*[:=]\s*["']?([0-9.]+)["']?/i);
      return match && match[1] ? match[1] : moduleData.version || null;
    } catch {
      return moduleData.version || null;
    }
  })();

  ensureUserEnvPatch(content.contentRootDir, logger);

  return {
    extractedReady: true,
    extractedRoot: extractRoot,
    packagedType,
    packagedPath,
    contentRootDir: content.contentRootDir,
    indexHtml: content.indexHtml,
    indexDir: path.dirname(content.indexHtml),
    version
  };
}

module.exports = {
  EXTRACT_META,
  extractPackage,
  findContentRoot,
  findIndexHtml,
  resolveExtractionRoot,
  resolveExtractionStatus,
  ensureUserEnvPatch,
  readExtractionMeta,
  writeExtractionMeta
};
