const fs = require("node:fs");
const path = require("node:path");
const Native = require("../../shared/runtime/local-native");
const Host = require("../../shared/runtime/host-capabilities");
const { readMachOLoadCommands } = require("../../shared/runtime/macho-load-commands");
const Manager = require("./opengl-helper-manager");
const { selectRuntimeVersion, managerDefaultVersion } = require("../../shared/runtime/version-choices");

// Source identities describe the coordinate ABI of existing owned receipts.
// They never select or map to a downloadable package version.
const LEGACY_SOURCE_ABI = Object.freeze({
  "7b9e4779af97a2bd7d5f2dd5c1a643ebc9eabc864e649940b294b05d0724c994": [
    "1.4.9999"
  ],
  "37e4954370bfcd7c17e8c49eed6a59011ba092f17e688bdf7de7e97202912ba0": [],
  "08bc3b3f878b52486e480d824262c5b056f6214a4bee72bfcde5516f4aa335ba": [
    "1.4.9999"
  ],
  "b62a0fb9bac03d6e82b7af25766d03a6ffb5487cf4b30fd18d070815584a008b": [
    "1.4.9999"
  ],
  "03417fe7ff4696a2c2c58eb513f44534725654c9b130fbe094634dae4e691387": [
    "1.4.9999"
  ]
});
const OPENGL = /^\/System\/Library\/Frameworks\/OpenGL\.framework\//;
function installDirectory(userDataDir, helperVersion) {
  const version = Manager.core.normalizeVersion(helperVersion);
  if (typeof userDataDir !== "string" || !path.isAbsolute(userDataDir) || userDataDir.includes("\0")) {
    throw new Error("An absolute launcher data directory is required for the OpenGL helper.");
  }
  return path.join(userDataDir, "runtimes", "gamemaker-opengl-helper", version);
}
function hasLegacyReceipt(userDataDir, helperVersion) {
  try { return fs.existsSync(path.join(installDirectory(userDataDir, helperVersion), "helper.json")); }
  catch { return false; }
}
function checkHost() {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(Host.getHostCapabilities().hardwareArch)) {
    throw new Error("The software OpenGL helper requires an Apple Silicon or Intel Mac.");
  }
}
function legacyStatus({ userDataDir, helperVersion } = {}) {
  try {
    checkHost();
    const directory = installDirectory(userDataDir, helperVersion);
    const record = JSON.parse(fs.readFileSync(path.join(directory, "helper.json"), "utf8"));
    const dylibPath = path.join(directory, "software-opengl.dylib");
    const architectures = Native.readMachOArchitectures(dylibPath, { allowLibrary: true });
    if (!architectures.some(arch=>require('../../shared/runtime/host-capabilities').architectureSupport(arch).supported)) {
      throw new Error("The OpenGL helper library changed or has an incompatible architecture. Install the graphics helper in Runtimes.");
    }
    const logical = record.legacyLogicalRunnerVersions || LEGACY_SOURCE_ABI[record.sourceSha256] || [];
    return { ...record, legacy: true, legacyLogicalRunnerVersions: [...logical],
      ready: true, dylibPath, installDir: directory, reason: null };
  } catch (error) {
    const missing = error.code === "ENOENT";
    return { ready: false, version: helperVersion, reason: missing
        ? "The selected graphics helper is not installed. Install it in Runtimes."
        : error.message };
  }
}

function selection(entry, context = {}, manager = Manager) {
  const manual = selectRuntimeVersion({ manual: context.runtimeSettings?.graphicsHelperVersion,
    defaultVersion: entry?.runtimeData?.[manager.id]?.version }).version;
  const saved = selectRuntimeVersion({ manual, defaultVersion: context.settings?.runtimes?.[manager.id]?.defaultVersion }).version;
  if (saved) {
    if (hasLegacyReceipt(context.userDataDir, saved)) {
      const retained = legacyStatus({ userDataDir: context.userDataDir, helperVersion: saved });
      return { ready: retained.ready, version: saved, install: retained.ready ? retained : null,
        legacy: true, reason: retained.reason };
    }
    return manager.resolveSelection(entry, context.settings, context.userDataDir, { version: saved });
  }
  const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
  if (selected.version) return selected;
  let versions = [];
  try { versions = fs.readdirSync(path.join(context.userDataDir, "runtimes", manager.id), { withFileTypes: true })
    .filter(item => item.isDirectory()).map(item => item.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); } catch {}
  const retained = versions.filter(version => hasLegacyReceipt(context.userDataDir, version))
    .map(version => legacyStatus({ userDataDir: context.userDataDir, helperVersion: version })).filter(row => row.ready);
  const fallback = managerDefaultVersion({ installed: retained.map(row => row.version) });
  const install = retained.find(row => row.version === fallback);
  if (install) return { ready: true, version: fallback, install, legacy: true, reason: null };
  return selected;
}
function getFallbackStatus({ userDataDir, helperVersion, entry, settings, manager = Manager } = {}) {
  if (helperVersion && hasLegacyReceipt(userDataDir, helperVersion)) return legacyStatus({ userDataDir, helperVersion });
  const selected = helperVersion
    ? manager.resolveSelection(entry, settings, userDataDir, { version: helperVersion })
    : selection(entry, { userDataDir, settings }, manager);
  if (!selected.ready) return { ...selected, reason: selected.reason || "Install the graphics helper in Runtimes." };
  if (selected.legacy) return selected.install;
  try { return Manager.verifyInstall(selected.install); }
  catch (error) { return { ready: false, version: selected.version, reason: error.message }; }
}
// The helper replaces AppKit's OpenGL pixel-format request, so it serves any
// runner that draws through OpenGL; the runner's own load commands say so.
// Before the runner is installed, the helper is planned together with it.
function drawsWithOpenGL(executablePath) {
  if (!executablePath) return false;
  try { return readMachOLoadCommands(executablePath).slices.some(slice => slice.dependencies.some(library => OPENGL.test(library.path))); }
  catch { return false; }
}
function runtimeRequirements(entry, context, official, manager = Manager) {
  const mode = context.runtimeSettings?.softwareOpenGLFallback;
  if (mode === "disabled" || !official?.version) return [];
  const selected = selection(entry, context, manager);
  if (!selected.ready && mode !== "enabled" && official.install?.executablePath && !drawsWithOpenGL(official.install.executablePath)) return [];
  return selected.ready ? [] : [{ managerId: manager.id, version: selected.version,
    ...(selected.discoveryRequired ? { discoveryRequired: true } : {}),
    requiresDownload: true, installOptions: {} }];
}

// The caller owns a private, ad-hoc-signed runner stage. Never apply this
// environment to the installed vendor binary or the launcher process itself.
// Its package names the runner versions that use the reviewed legacy
// coordinates; every other runner keeps AppKit's coordinates.
function resolveFallback({ userDataDir, runnerVersion, helperVersion, entry, settings, manager = Manager } = {}) {
  const status = getFallbackStatus({ userDataDir, helperVersion, entry, settings, manager });
  if (!status.ready) return status;
  return { ...status, environment: {
    DYLD_INSERT_LIBRARIES: status.dylibPath,
    MACLAUNCHER_ALLOW_SOFTWARE_OPENGL: "1",
    MACLAUNCHER_LEGACY_LOGICAL_OPENGL: (status.legacyLogicalRunnerVersions || []).includes(runnerVersion) ? "1" : "0"
  } };
}

module.exports = { getFallbackStatus, resolveFallback, selection, runtimeRequirements, manager: Manager,
  drawsWithOpenGL, __test: { installDirectory } };
