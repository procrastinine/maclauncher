const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GameData = require("../shared/game-data");
const Packaging = require("../shared/web/runtime/nwjs-packaging");
const Zip = require("../shared/runtime/zip");
const { buildEvbunpackCommand } = require("../shared/runtime/python");
const SevenZip = require("../shared/runtime/sevenzip");
const { scanEntries, scanRoot, isNscripterRoot } = require("./scan");

const EXTRACT_META = ".maclauncher-nscripter-extract.json";
const SKIP_DIRS = new Set(["$PLUGINSDIR", "__MACOSX"]);

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function existsDir(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readExtractionMeta(extractRoot) {
  const metaPath = path.join(extractRoot, EXTRACT_META);
  try {
    if (!fs.existsSync(metaPath)) return null;
  } catch {
    return null;
  }
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

function resolveExtractionRoot({ entry, userDataDir, moduleId }) {
  if (!userDataDir) return null;
  const gameId = entry?.gameId;
  if (!gameId) throw new Error("Missing gameId for extraction root.");
  const moduleKey = moduleId || entry?.moduleId || "nscripter";
  return path.join(GameData.resolveGameModuleDir(userDataDir, gameId, moduleKey), "extracted");
}

function listZipEntries(filePath) {
  try {
    const result = Zip.readZipEntries(filePath);
    if (!result || !Array.isArray(result.entries)) return null;
    return result.entries.map(entry => entry.name);
  } catch {
    return null;
  }
}

function listSevenZipEntries(filePath) {
  const entries = SevenZip.listArchiveEntriesSync(filePath);
  if (!entries) return null;
  return entries.filter(entry => !entry.isDirectory).map(entry => entry.path);
}

function inspectExe(filePath) {
  const zipEntries = listZipEntries(filePath);
  if (zipEntries) {
    const scan = scanEntries(zipEntries);
    if (isNscripterRoot(scan)) return { packagedType: "zip-exe" };
  }

  const sevenZipEntries = listSevenZipEntries(filePath);
  if (sevenZipEntries) {
    const scan = scanEntries(sevenZipEntries);
    if (isNscripterRoot(scan)) return { packagedType: "7z-exe" };
  }

  return null;
}

function findNscripterRoot(rootDir, maxDepth = 3) {
  if (!rootDir || !existsDir(rootDir)) return null;
  if (isNscripterRoot(scanRoot(rootDir))) return rootDir;

  const queue = [{ dir: rootDir, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (depth >= maxDepth) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const child = path.join(dir, entry.name);
      if (isNscripterRoot(scanRoot(child))) return child;
      queue.push({ dir: child, depth: depth + 1 });
    }
  }

  return null;
}

function resolveExtractionStatus({ entry, userDataDir, moduleId }) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const packagedPath = moduleData.packagedPath || null;
  if (!packagedPath || !userDataDir) {
    return { extractedReady: false, extractedRoot: null, contentRootDir: null, packagedPath };
  }

  const extractRoot = moduleData.extractedRoot || resolveExtractionRoot({ entry, userDataDir, moduleId });
  if (!existsDir(extractRoot)) {
    return { extractedReady: false, extractedRoot: extractRoot, contentRootDir: null, packagedPath };
  }

  const meta = readExtractionMeta(extractRoot);
  if (meta?.sourcePath && packagedPath && meta.sourcePath !== packagedPath) {
    return { extractedReady: false, extractedRoot: extractRoot, contentRootDir: null, packagedPath };
  }

  const contentRootDir = findNscripterRoot(extractRoot);
  if (!contentRootDir) {
    return { extractedReady: false, extractedRoot: extractRoot, contentRootDir: null, packagedPath };
  }

  return { extractedReady: true, extractedRoot: extractRoot, contentRootDir, packagedPath };
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

async function extractWithEvbunpack(packagePath, extractRoot, userDataDir, logger) {
  const evb = buildEvbunpackCommand({ userDataDir });
  logger?.info?.("[nscripter] running evbunpack fallback");
  await runCommand(evb.command, [...evb.args, packagePath, extractRoot], { env: evb.env });
  return { method: "evbunpack" };
}

async function extractPackage({ packagePath, extractRoot, userDataDir, logger }) {
  safeRm(extractRoot);
  ensureDir(extractRoot);

  let zipResult = null;
  try {
    zipResult = await Packaging.extractZipPayload(packagePath, extractRoot);
  } catch {
    zipResult = null;
  }
  if (zipResult) return { method: "zip" };

  safeRm(extractRoot);
  ensureDir(extractRoot);

  let overlay = null;
  try {
    overlay = await Packaging.extractPeOverlayZip(packagePath, extractRoot);
  } catch {
    overlay = null;
  }
  if (overlay) return { method: "pe-overlay" };

  safeRm(extractRoot);
  ensureDir(extractRoot);

  const sevenZipPath = SevenZip.resolveSevenZipBinary();
  if (sevenZipPath) {
    try {
      await SevenZip.extractArchive(packagePath, extractRoot, sevenZipPath);
      return { method: "7zip" };
    } catch (err) {
      logger?.warn?.("[nscripter] 7zip extraction failed", String(err?.message || err));
    }
  }

  safeRm(extractRoot);
  ensureDir(extractRoot);

  return extractWithEvbunpack(packagePath, extractRoot, userDataDir, logger);
}

async function extractPackagedExe({ entry, userDataDir, moduleId, logger }) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const packagedPath = moduleData.packagedPath || null;
  if (!packagedPath) return null;

  const extractRoot = moduleData.extractedRoot || resolveExtractionRoot({ entry, userDataDir, moduleId });
  const result = await extractPackage({
    packagePath: packagedPath,
    extractRoot,
    userDataDir,
    logger
  });

  writeExtractionMeta(extractRoot, {
    sourcePath: packagedPath,
    extractedAt: Date.now(),
    method: result?.method || null
  });

  const contentRootDir = findNscripterRoot(extractRoot);
  if (!contentRootDir) return null;

  return { extractedRoot: extractRoot, contentRootDir, method: result?.method || null };
}

module.exports = {
  EXTRACT_META,
  extractPackagedExe,
  inspectExe,
  findNscripterRoot,
  readExtractionMeta,
  resolveExtractionRoot,
  resolveExtractionStatus,
  writeExtractionMeta
};
