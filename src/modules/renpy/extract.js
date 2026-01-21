const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const EXTRACT_META = ".maclauncher-renpy-extract.json";

function stableIdForPath(input) {
  return crypto.createHash("sha256").update(String(input || "")).digest("hex").slice(0, 12);
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

function resolveExtractionRoot({ entry, userDataDir }) {
  const key = entry?.gamePath || entry?.contentRootDir || entry?.importPath || "";
  const id = stableIdForPath(key);
  return path.join(userDataDir, "modules", "renpy", "extracted", id);
}

function resolveExtractionStatus({ entry, userDataDir, sourcePath } = {}) {
  if (!userDataDir) {
    return { extractedReady: false, extractedRoot: null, extractedAt: null, sourcePath: null };
  }
  const moduleData = entry?.moduleData && typeof entry.moduleData === "object" ? entry.moduleData : {};
  const extractRoot = moduleData.extractedRoot || resolveExtractionRoot({ entry, userDataDir });
  if (!existsDir(extractRoot)) {
    return { extractedReady: false, extractedRoot: extractRoot, extractedAt: null, sourcePath: null };
  }
  const meta = readExtractionMeta(extractRoot);
  const extractedAt = meta?.extractedAt || null;
  const recordedSource = meta?.sourcePath || null;
  if (sourcePath && recordedSource) {
    try {
      if (path.resolve(recordedSource) !== path.resolve(sourcePath)) {
        return {
          extractedReady: false,
          extractedRoot: extractRoot,
          extractedAt,
          sourcePath: recordedSource
        };
      }
    } catch {}
  }
  return { extractedReady: true, extractedRoot: extractRoot, extractedAt, sourcePath: recordedSource };
}

module.exports = {
  EXTRACT_META,
  readExtractionMeta,
  resolveExtractionRoot,
  resolveExtractionStatus,
  writeExtractionMeta
};
