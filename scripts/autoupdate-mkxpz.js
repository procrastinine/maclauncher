const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const runtimeManagerPath = path.join(
  repoRoot,
  "src",
  "modules",
  "rgss",
  "runtime",
  "mkxpz-runtime-manager.js"
);
const resourcesRoot = path.join(
  repoRoot,
  "src",
  "modules",
  "rgss",
  "resources",
  "mkxpz"
);

const Core = require(runtimeManagerPath);

function listDirectories(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

function updateBundledVersion(filePath, version) {
  const raw = fs.readFileSync(filePath, "utf8");
  const pattern = /(const BUNDLED_VERSION\s*=\s*")([^"]+)(")/;
  if (!pattern.test(raw)) {
    throw new Error("BUNDLED_VERSION not found in mkxpz runtime manager.");
  }
  const next = raw.replace(pattern, `$1${version}$3`);
  if (next === raw) return false;
  fs.writeFileSync(filePath, next);
  return true;
}

async function updateMkxpzEmbedded({ logger = console } = {}) {
  const ghOk = await Core.canUseGh({ logger });
  if (!ghOk) {
    throw new Error("GitHub CLI unavailable or not authenticated.");
  }

  const latest = await Core.fetchLatestAvailableVersions({ logger });
  const latestVersion = Array.isArray(latest.versions) ? latest.versions[0] : null;
  const entry = Array.isArray(latest.entries) ? latest.entries[0] : null;

  if (!latestVersion || !entry) {
    throw new Error("No MKXP-Z builds available.");
  }

  if (latestVersion === Core.BUNDLED_VERSION) {
    logger?.info?.(`[mkxpz] latest version already embedded (${latestVersion}).`);
    return { updated: false, version: latestVersion };
  }

  logger?.info?.(`[mkxpz] updating embedded runtime to ${latestVersion}`);

  let tempRoot = null;
  try {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-mkxpz-"));
    const install = await Core.installFromGh({ userDataDir: tempRoot, entry, logger });
    if (!install?.installDir || !install?.version) {
      throw new Error("MKXP-Z download failed.");
    }
    if (install.version !== latestVersion) {
      throw new Error("Downloaded MKXP-Z version did not match latest build.");
    }

    fs.mkdirSync(resourcesRoot, { recursive: true });
    const targetDir = path.join(resourcesRoot, install.version);
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.cpSync(install.installDir, targetDir, { recursive: true, force: true });
    const metaPath = path.join(targetDir, ".maclauncher-mkxpz.json");
    if (fs.existsSync(metaPath)) {
      fs.rmSync(metaPath, { force: true });
    }

    const appPath = path.join(targetDir, Core.BUNDLED_APP_NAME);
    if (!fs.existsSync(appPath)) {
      throw new Error("Embedded MKXP-Z app bundle missing after update.");
    }

    for (const dir of listDirectories(resourcesRoot)) {
      if (dir !== install.version) {
        fs.rmSync(path.join(resourcesRoot, dir), { recursive: true, force: true });
      }
    }

    if (!updateBundledVersion(runtimeManagerPath, install.version)) {
      throw new Error("Failed to update bundled MKXP-Z version.");
    }

    logger?.info?.(`[mkxpz] embedded runtime updated to ${install.version}`);
    return { updated: true, version: install.version };
  } finally {
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

if (require.main === module) {
  updateMkxpzEmbedded().catch(err => {
    console.error(err?.message || err);
    process.exitCode = 1;
  });
}

module.exports = { updateMkxpzEmbedded };
