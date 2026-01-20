const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function stableIdForPath(input) {
  return crypto.createHash("sha256").update(String(input || "")).digest("hex").slice(0, 12);
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function removePrefixedDirs(rootDir, prefix) {
  if (!rootDir || !prefix) return;
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name === prefix || name.startsWith(`${prefix}-`)) {
      safeRm(path.join(rootDir, name));
    }
  }
}

function cleanupNwjsGameData({ userDataDir, moduleId, gamePath } = {}) {
  if (!userDataDir || !moduleId || !gamePath) return false;
  const id = stableIdForPath(gamePath);

  const wrapperRoots = [
    path.join(userDataDir, "modules", moduleId, "nwjs", "wrappers"),
    path.join(userDataDir, "modules", moduleId, "nwjs-patched", "wrappers")
  ];
  for (const root of wrapperRoots) {
    removePrefixedDirs(root, id);
  }

  const profileRoots = [
    path.join(userDataDir, "modules", moduleId, "nwjs", "profiles"),
    path.join(userDataDir, "modules", moduleId, "nwjs-patched", "profiles")
  ];
  for (const root of profileRoots) {
    safeRm(path.join(root, id));
  }

  const appsRoot = path.join(userDataDir, "modules", moduleId, "nwjs", "apps");
  safeRm(path.join(appsRoot, `${id}.app`));
  const patchedAppsRoot = path.join(userDataDir, "modules", moduleId, "nwjs-patched", "apps");
  safeRm(path.join(patchedAppsRoot, `${id}.app`));

  return true;
}

module.exports = {
  cleanupNwjsGameData,
  stableIdForPath
};
