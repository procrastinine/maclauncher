const fs = require("node:fs");
const path = require("node:path");

const GameData = require("../shared/game-data");
const SevenZip = require("../shared/runtime/sevenzip");

const APPIMAGE_META = ".maclauncher-love-appimage.json";

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

function resolveAppImageRoot(userDataDir, gameId) {
  return path.join(GameData.resolveGameModuleDir(userDataDir, gameId, "love"), "appimage");
}

function resolveAppImageMetaPath(rootDir) {
  return path.join(rootDir, APPIMAGE_META);
}

function readMeta(rootDir) {
  try {
    const raw = fs.readFileSync(resolveAppImageMetaPath(rootDir), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeMeta(rootDir, payload) {
  try {
    fs.writeFileSync(resolveAppImageMetaPath(rootDir), JSON.stringify(payload, null, 2));
  } catch {}
}

function findBinaryRelativePath(rootDir, preferredRelativePath) {
  const preferred = typeof preferredRelativePath === "string" ? preferredRelativePath.trim() : "";
  if (preferred) {
    const preferredPath = path.join(rootDir, preferred);
    if (existsFile(preferredPath)) return preferred.replace(/\\/g, "/");
  }

  const binDir = path.join(rootDir, "bin");
  if (!existsDir(binDir)) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(binDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const files = entries
    .filter(entry => entry.isFile() && entry.name && !entry.name.toLowerCase().endsWith(".lua"))
    .map(entry => `bin/${entry.name}`)
    .sort((a, b) => a.localeCompare(b));
  return files[0] || null;
}

function resolvePreparedState(entry, { userDataDir } = {}) {
  const gameId = entry?.gameId;
  if (!gameId || !userDataDir) {
    return {
      ready: false,
      extractRoot: null,
      binaryPath: null,
      extractedAt: null,
      binaryRelativePath: null
    };
  }
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const extractRoot =
    typeof moduleData.appImageExtractRoot === "string" && moduleData.appImageExtractRoot.trim()
      ? moduleData.appImageExtractRoot.trim()
      : resolveAppImageRoot(userDataDir, gameId);
  const meta = existsDir(extractRoot) ? readMeta(extractRoot) : null;
  const binaryRelativePath = findBinaryRelativePath(
    extractRoot,
    moduleData.appImageBinaryRelativePath || meta?.binaryRelativePath || null
  );
  const binaryPath = binaryRelativePath ? path.join(extractRoot, binaryRelativePath) : null;
  const extractedAt = Number.isFinite(Number(moduleData.appImageExtractedAt))
    ? Number(moduleData.appImageExtractedAt)
    : Number.isFinite(Number(meta?.extractedAt))
      ? Number(meta.extractedAt)
      : null;
  return {
    ready: Boolean(binaryPath && existsFile(binaryPath)),
    extractRoot: existsDir(extractRoot) ? extractRoot : null,
    binaryPath: binaryPath && existsFile(binaryPath) ? binaryPath : null,
    extractedAt,
    binaryRelativePath: binaryRelativePath || null
  };
}

async function ensureExtracted(entry, { userDataDir, logger } = {}) {
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const packagedPath =
    typeof moduleData.packagedPath === "string" && moduleData.packagedPath.trim()
      ? moduleData.packagedPath.trim()
      : typeof entry?.gamePath === "string"
        ? entry.gamePath
        : null;
  if (!packagedPath || !existsFile(packagedPath)) {
    throw new Error("AppImage file is missing.");
  }
  if (!entry?.gameId || !userDataDir) {
    throw new Error("AppImage extraction needs a saved game entry.");
  }

  const current = resolvePreparedState(entry, { userDataDir });
  if (current.ready) return current;

  const extractRoot = resolveAppImageRoot(userDataDir, entry.gameId);
  const tempRoot = `${extractRoot}.tmp-${Date.now()}`;
  safeRm(tempRoot);
  safeRm(extractRoot);
  ensureDir(path.dirname(extractRoot));
  ensureDir(tempRoot);

  try {
    logger?.info?.(`[love] extracting AppImage ${packagedPath}`);
    await SevenZip.extractArchive(packagedPath, tempRoot);
    const binaryRelativePath = findBinaryRelativePath(
      tempRoot,
      moduleData.appImageBinaryRelativePath || null
    );
    if (!binaryRelativePath) {
      throw new Error("Extracted AppImage is missing a runnable bin entry.");
    }
    fs.renameSync(tempRoot, extractRoot);
    const extractedAt = Date.now();
    writeMeta(extractRoot, {
      sourcePath: packagedPath,
      extractedAt,
      binaryRelativePath
    });
    return {
      ready: true,
      extractRoot,
      binaryPath: path.join(extractRoot, binaryRelativePath),
      extractedAt,
      binaryRelativePath
    };
  } catch (err) {
    safeRm(tempRoot);
    safeRm(extractRoot);
    throw err;
  }
}

module.exports = {
  APPIMAGE_META,
  resolveAppImageRoot,
  resolvePreparedState,
  ensureExtracted
};
