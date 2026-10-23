const fs = require("node:fs");
const path = require("node:path");
const AppBundle = require("../../shared/runtime/app-bundle");
const Native = require("../../shared/runtime/local-native");

const ID = "flash-projector";
const VERSION = "35.0.0.60";
const PROJECTOR_APP_RELATIVE = path.join("src", "modules", "flash", "resources", "flash-player", "Flash Player.app");

function listProjectorAppCandidates(resourcesPath = process.resourcesPath) {
  const resourceRoot = typeof resourcesPath === "string" && resourcesPath.trim() ? resourcesPath.trim() : null;
  return [...new Set([
    resourceRoot && path.join(resourceRoot, "app.asar.unpacked", PROJECTOR_APP_RELATIVE),
    resourceRoot && path.join(resourceRoot, PROJECTOR_APP_RELATIVE),
    path.resolve(__dirname, "..", "resources", "flash-player", "Flash Player.app")
  ].filter(Boolean))];
}

function fileIdentity(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("Included Flash Player has an invalid file.");
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode];
}

function createManager({ appPaths = listProjectorAppCandidates() } = {}) {
  let cached = null;

  function resolveIncluded({ verification = "full" } = {}) {
    const appPath = appPaths.find(candidate => {
      // Native children cannot execute a path inside Electron's virtual archive.
      if (/[\\/]app\.asar[\\/]/.test(candidate)) return false;
      try { return fs.lstatSync(candidate).isDirectory(); } catch { return false; }
    });
    if (!appPath) throw new Error("Included Flash Player is missing. Reinstall MacLauncher.");
    const executablePath = path.join(appPath, "Contents", "MacOS", "Flash Player");
    const plistIdentity = fileIdentity(path.join(appPath, "Contents", "Info.plist"));
    const executableIdentity = fileIdentity(executablePath);
    if (plistIdentity[2] > 256 * 1024 || !(executableIdentity[5] & 0o111)) throw new Error("Included Flash Player is invalid. Reinstall MacLauncher.");
    const relative = path.relative(fs.realpathSync(appPath), fs.realpathSync(executablePath));
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("Included Flash Player executable escapes its app bundle. Reinstall MacLauncher.");
    const key = JSON.stringify([appPath, plistIdentity, executableIdentity]);
    if (cached?.key !== key) {
      const info = AppBundle.readInfoPlist(appPath);
      const architectures = Native.readMachOArchitectures(executablePath);
      if (info?.CFBundleShortVersionString !== VERSION || info?.CFBundleExecutable !== "Flash Player" ||
          (info.CFBundleIdentifier && info.CFBundleIdentifier !== "com.macromedia.Flash Player.app") ||
          !architectures.includes("arm64") || !architectures.includes("x86_64")) {
        throw new Error("Included Flash Player is invalid. Reinstall MacLauncher.");
      }
      cached = { key, install: { version: VERSION, appPath, executablePath, runtimePath: executablePath,
        architectures, minimumMacOS: process.arch === "arm64" ? "11.0" : info.LSMinimumSystemVersion || "10.15",
        source: "bundled", bundledExecution: "direct", readOnly: true, removable: false, needsRosetta: false } };
    }
    if (verification !== "status") AppBundle.validateAppBundle(appPath, { executablePath });
    return { ...cached.install, architectures: [...cached.install.architectures] };
  }

  function resolveSelection(_entry, _settings, _userDataDir, options = {}) {
    // This fixed player has one included version. Obsolete downloader settings
    // cannot replace it with an older Intel-only player.
    try { return { version: VERSION, install: resolveIncluded(options), ready: true, reason: null }; }
    catch (error) { return { version: VERSION, install: null, ready: false,
      reason: error.code === "ENOENT" ? "Included Flash Player is missing. Reinstall MacLauncher." : error.message }; }
  }

  function getState() {
    const selection = resolveSelection(null, null, null, { verification: "status" });
    const installed = selection.ready ? [{ ...selection.install, ready: true, status: "ready" }] : [{
      version: VERSION, source: "bundled", bundledExecution: "direct", readOnly: true, removable: false,
      ready: false, status: "damaged-bundled", error: selection.reason
    }];
    const state = { defaultVersion: VERSION, installed, installing: null, variants: [],
      catalog: { status: "success", versions: [VERSION], source: "Included with MacLauncher",
        recommendedVersion: VERSION, includedVersions: selection.ready ? [VERSION] : [],
        installable: false, installableVersions: [], supportsLatestOnly: false, updateAvailable: false,
        latestAvailableVersion: VERSION, latestInstalledVersion: selection.ready ? VERSION : null,
        versionRequirements: { [VERSION]: { minimumMacOS: process.arch === "arm64" ? "11.0" : "10.15", included: selection.ready,
          available: selection.ready, requiresDownload: false, requiresBuild: false, installLabel: "Included",
          installReason: selection.reason } } } };
    return { ...state, sections: [{ id: "default", label: "Flash Player", ...state }] };
  }

  return { id: ID, label: "Flash Player", bundledExecution: "direct",
    delivery: Object.freeze({ included: "direct", catalog: "fixed", sourceBuild: false }),
    normalizeSettings: () => ({ defaultVersion: VERSION }),
    applySettingsUpdate: (_action, _payload, settings) => ({ ...settings, defaultVersion: VERSION }),
    resolveSelection, getState,
    core: { normalizeVersion: version => {
      if (version === VERSION) return VERSION;
      throw new Error(`The included Flash Player version is ${VERSION}.`);
    }, listInstalled: () => getState().installed.filter(row => row.ready),
      resolveInstalled: options => !options?.version || options.version === VERSION ? resolveSelection(null, null, null, options).install : null } };
}

const manager = createManager();
module.exports = manager;
manager.__test = { createManager, listProjectorAppCandidates, VERSION, PROJECTOR_APP_RELATIVE };
