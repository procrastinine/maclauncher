const fs = require("node:fs");
const path = require("node:path");

const Catalog = require("./catalog");

const BACKUP_SUFFIX = ".maclauncher-old";
const PATCH_DIR = "maclauncher-libs";
const PATCH_META = "patch.json";

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function existsFile(p) {
  const st = safeStat(p);
  return Boolean(st && st.isFile());
}

function existsDir(p) {
  const st = safeStat(p);
  return Boolean(st && st.isDirectory());
}

function assertInsideDir(rootDir, filePath) {
  const rel = path.relative(rootDir, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Path escapes root");
}

function layoutForGame(detected) {
  const indexDir = detected?.indexDir;
  if (typeof indexDir !== "string" || !indexDir) throw new Error("Missing indexDir");
  const patchDir = path.join(indexDir, PATCH_DIR);
  const patchMetaPath = path.join(patchDir, PATCH_META);
  return { indexDir, patchDir, patchMetaPath };
}

function readPatchMeta(layout) {
  if (!existsFile(layout.patchMetaPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(layout.patchMetaPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writePatchMeta(layout, meta) {
  ensureDir(layout.patchDir);
  fs.writeFileSync(layout.patchMetaPath, JSON.stringify(meta, null, 2), "utf8");
}

function readEngineVersion(layout, engine) {
  const coreName = engine === "mz" ? "rmmz_core.js" : "rpg_core.js";
  const corePath = path.join(layout.indexDir, "js", coreName);
  if (!existsFile(corePath)) return null;
  try {
    const header = fs.readFileSync(corePath, "utf8").slice(0, 2000);
    const re = engine === "mz" ? /rmmz_core\.js v([0-9.]+)/ : /rpg_core\.js v([0-9.]+)/;
    const m = header.match(re);
    return m && m[1] ? m[1] : null;
  } catch {
    return null;
  }
}

function versionPrefix(version) {
  const parts = String(version || "").split(".").filter(Boolean);
  if (parts.length >= 3) return parts.slice(0, 3).join(".");
  return parts.join(".");
}

function buildCompatibilityWarnings(engineVersion, selections) {
  const warnings = [];
  const actual = engineVersion ? String(engineVersion) : "";
  if (!actual) {
    if (selections && Object.keys(selections).length > 0) {
      warnings.push("Could not detect the game engine version.");
    }
    return warnings;
  }

  for (const [depId, versionId] of Object.entries(selections || {})) {
    if (!versionId) continue;
    const version = Catalog.getVersion(depId, versionId);
    const expected = version?.engineVersion ? String(version.engineVersion) : "";
    if (!expected) continue;
    const prefix = versionPrefix(expected);
    if (!prefix) continue;
    if (!actual.startsWith(prefix)) {
      warnings.push(
        `${depId} bundle targets engine v${expected}, but game reports v${actual}.`
      );
    }
  }

  return warnings;
}

function resolveSelectedFiles(engine, selections) {
  const deps = Catalog.listDependencies().filter(dep => dep.engine === engine);
  const out = [];
  const seen = new Map();

  for (const dep of deps) {
    const versionId = selections?.[dep.id];
    if (!versionId) continue;
    const version = Catalog.getVersion(dep.id, versionId);
    if (!version) throw new Error(`Unknown ${dep.label} version: ${versionId}`);
    for (const relPath of version.files || []) {
      if (seen.has(relPath)) {
        const existing = seen.get(relPath);
        if (existing.versionId !== versionId || existing.depId !== dep.id) {
          throw new Error(`Conflicting file selection for ${relPath}`);
        }
        continue;
      }
      out.push({
        depId: dep.id,
        versionId,
        relPath,
        bundleRoot: version.bundleRoot
      });
      seen.set(relPath, { depId: dep.id, versionId });
    }
  }

  return out;
}

function getPatchStatus(detected, selections = null) {
  const engine = detected?.engine;
  if (engine !== "mv") throw new Error("RPG Maker MV library patching is only available for MV.");
  const layout = layoutForGame(detected);
  const meta = readPatchMeta(layout);
  const engineVersion = readEngineVersion(layout, engine);
  const appliedSelections = meta?.selections || selections || {};

  let missingFiles = 0;
  let missingBackups = 0;
  let orphanedBackup = false;

  if (meta?.files && Array.isArray(meta.files)) {
    for (const entry of meta.files) {
      if (!entry || typeof entry.relPath !== "string") continue;
      const destPath = path.join(layout.indexDir, entry.relPath);
      if (!existsFile(destPath)) missingFiles += 1;
      if (entry.hadOriginal) {
        const backupPath = destPath + BACKUP_SUFFIX;
        if (!existsFile(backupPath)) missingBackups += 1;
      }
    }
  } else {
    const knownFiles = Catalog.listFilesForEngine(engine);
    orphanedBackup = knownFiles.some(relPath =>
      existsFile(path.join(layout.indexDir, relPath) + BACKUP_SUFFIX)
    );
  }

  const patched = Boolean(meta && missingFiles === 0);
  const partial = Boolean(
    (meta && (missingFiles > 0 || missingBackups > 0)) || (!meta && orphanedBackup)
  );

  return {
    engine,
    gamePath: detected?.gamePath || null,
    indexDir: layout.indexDir,
    engineVersion,
    selections: appliedSelections,
    warnings: buildCompatibilityWarnings(engineVersion, appliedSelections),
    patched,
    partial,
    details: {
      metaExists: Boolean(meta),
      expectedFiles: Array.isArray(meta?.files) ? meta.files.length : 0,
      missingFiles,
      missingBackups,
      orphanedBackup
    }
  };
}

function patchGame(detected, { selections, appVersion = null } = {}) {
  const engine = detected?.engine;
  if (engine !== "mv") {
    throw new Error("RPG Maker MV library patching is only available for MV.");
  }
  const layout = layoutForGame(detected);
  const files = resolveSelectedFiles(engine, selections);
  if (files.length === 0) throw new Error("No library versions selected.");

  const fileMeta = [];
  for (const file of files) {
    const srcPath = path.join(file.bundleRoot, file.relPath);
    if (!existsFile(srcPath)) throw new Error(`Bundle file missing: ${srcPath}`);

    const destPath = path.join(layout.indexDir, file.relPath);
    assertInsideDir(layout.indexDir, destPath);

    const hadOriginal = existsFile(destPath);
    const backupPath = destPath + BACKUP_SUFFIX;
    if (hadOriginal && !existsFile(backupPath)) {
      ensureDir(path.dirname(backupPath));
      fs.copyFileSync(destPath, backupPath);
    }

    ensureDir(path.dirname(destPath));
    fs.copyFileSync(srcPath, destPath);

    fileMeta.push({
      relPath: file.relPath,
      hadOriginal,
      backupRel: file.relPath + BACKUP_SUFFIX,
      depId: file.depId,
      versionId: file.versionId
    });
  }

  const meta = {
    patchedBy: "maclauncher",
    patchedAt: new Date().toISOString(),
    appVersion: typeof appVersion === "string" && appVersion ? appVersion : null,
    engine,
    engineVersion: readEngineVersion(layout, engine),
    selections: selections || {},
    files: fileMeta
  };

  writePatchMeta(layout, meta);
  return getPatchStatus(detected, selections);
}

function unpatchGame(detected) {
  const engine = detected?.engine;
  if (engine !== "mv") {
    throw new Error("RPG Maker MV library patching is only available for MV.");
  }
  const layout = layoutForGame(detected);
  const meta = readPatchMeta(layout);
  if (!meta) return getPatchStatus(detected);

  if (Array.isArray(meta.files)) {
    for (const entry of meta.files) {
      if (!entry || typeof entry.relPath !== "string") continue;
      const destPath = path.join(layout.indexDir, entry.relPath);
      assertInsideDir(layout.indexDir, destPath);
      const backupPath = destPath + BACKUP_SUFFIX;
      if (entry.hadOriginal) {
        if (existsFile(backupPath)) {
          fs.copyFileSync(backupPath, destPath);
          try {
            fs.rmSync(backupPath, { force: true });
          } catch {}
        }
      } else if (existsFile(destPath)) {
        try {
          fs.rmSync(destPath, { force: true });
        } catch {}
      }
    }
  }

  try {
    fs.rmSync(layout.patchMetaPath, { force: true });
  } catch {}
  try {
    if (existsDir(layout.patchDir) && fs.readdirSync(layout.patchDir).length === 0) {
      fs.rmdirSync(layout.patchDir);
    }
  } catch {}

  return getPatchStatus(detected);
}

module.exports = {
  getPatchStatus,
  patchGame,
  unpatchGame
};
