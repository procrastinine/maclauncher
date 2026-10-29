const fs = require("node:fs");
const path = require("node:path");
const Native = require("../../shared/runtime/local-native");
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
const TESTED_VENDOR_SHA256 = "d63b5d5152d427b333b64883c26edc6701214d0a5ad027fa6f09e579fa31c1b0";
const TESTED_VENDOR_BUILDS = Object.freeze({ "2026.0.0.23": TESTED_VENDOR_SHA256,
  "2024.13.1.242": "4871c81c7425b18cb8aa0650c82019f75dde504ca2d1d7e61d14aa5f1e874ffe",
  "2.3.7.476": "50916940fb11afe911f1bb11b24be075c8b616d5afae10b933c407bf618e1fbb",
  "1.4.9999": "dd8395d9dcdb5eb6e58641a730b22640d1909e72a55a48c3450cf6d0231040fa",
  "2.2.5.378": "054debab706e5fd42ce73df6c4739ce86c31804e00e039b9e78c16dfaffc265a" });
const SUPPORTED_RUNNER_VERSIONS = Object.freeze(Object.keys(TESTED_VENDOR_BUILDS));
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
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) {
    throw new Error("The software OpenGL helper requires an Apple Silicon or Intel Mac.");
  }
}
function legacyStatus({ userDataDir, helperVersion } = {}) {
  try {
    checkHost();
    const directory = installDirectory(userDataDir, helperVersion);
    const record = JSON.parse(fs.readFileSync(path.join(directory, "helper.json"), "utf8"));
    if (record.version !== helperVersion || !Object.hasOwn(LEGACY_SOURCE_ABI, record.sourceSha256) || record.architecture !== "universal" ||
      record.testedVendorSha256 !== TESTED_VENDOR_SHA256 ||
      !Array.isArray(record.supportedRunnerVersions) || !record.supportedRunnerVersions.length ||
      record.supportedRunnerVersions.some(version => !SUPPORTED_RUNNER_VERSIONS.includes(version)) ||
      !/^[a-f0-9]{64}$/.test(record.binarySha256 || "")) {
      throw new Error("The OpenGL helper build record does not match its pinned source/version.");
    }
    const dylibPath = path.join(directory, "software-opengl.dylib");
    const architectures = Native.readMachOArchitectures(dylibPath, { allowLibrary: true });
    if (Native.hashFile(dylibPath) !== record.binarySha256 || !["arm64", "x86_64"].every(arch => architectures.includes(arch))) {
      throw new Error("The OpenGL helper library changed or has an incompatible architecture. Install the graphics helper in Runtimes.");
    }
    const logical = LEGACY_SOURCE_ABI[record.sourceSha256];
    if (record.legacyLogicalRunnerVersions !== undefined &&
      (!Array.isArray(record.legacyLogicalRunnerVersions) || JSON.stringify(record.legacyLogicalRunnerVersions) !== JSON.stringify(logical)))
      throw new Error("The OpenGL helper coordinate ABI differs from its owned source.");
    return { ...record, legacy: true, legacyLogicalRunnerVersions: [...logical],
      runnerChecksums: Object.fromEntries(record.supportedRunnerVersions.map(version => [version, TESTED_VENDOR_BUILDS[version]])),
      ready: true, dylibPath, installDir: directory, reason: null };
  } catch (error) {
    const missing = error.code === "ENOENT";
    return { ready: false, version: helperVersion,
      supportedRunnerVersions: [...SUPPORTED_RUNNER_VERSIONS], reason: missing
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
function supportsRunner(helper, runnerVersion, runnerSha256) {
  const checksums = helper?.runnerChecksums || helper?.manifest?.runnerChecksums || TESTED_VENDOR_BUILDS;
  return Boolean(runnerSha256 && checksums[runnerVersion] === runnerSha256);
}
function runtimeRequirements(entry, context, official, manager = Manager) {
  const mode = context.runtimeSettings?.softwareOpenGLFallback;
  if (mode === false || mode === "disabled" || !official?.version) return [];
  const runnerVersion = official.install?.runtimeVersion || official.version;
  const selected = selection(entry, context, manager);
  if (!selected.ready && mode !== true && mode !== "enabled" && !supportsRunner(null, runnerVersion, official.install?.binarySha256 || TESTED_VENDOR_BUILDS[runnerVersion])) return [];
  return selected.ready ? [] : [{ managerId: manager.id, version: selected.version,
    ...(selected.discoveryRequired ? { discoveryRequired: true } : {}),
    requiresDownload: true, installOptions: {} }];
}

// The caller owns a private, ad-hoc-signed runner stage. Never apply this
// environment to the installed vendor binary or the launcher process itself.
function resolveFallback({ userDataDir, runnerVersion, runnerSha256, helperVersion, entry, settings, manager = Manager } = {}) {
  const status = getFallbackStatus({ userDataDir, helperVersion, entry, settings, manager });
  if (!status.ready) return status;
  if (!supportsRunner(status, runnerVersion, runnerSha256))
    return { ready: false, version: status.version, reason: "The selected graphics helper does not support this official runner checksum." };
  return { ...status, environment: {
    DYLD_INSERT_LIBRARIES: status.dylibPath,
    MACLAUNCHER_ALLOW_SOFTWARE_OPENGL: "1",
    MACLAUNCHER_LEGACY_LOGICAL_OPENGL: (status.legacyLogicalRunnerVersions || []).includes(runnerVersion) ? "1" : "0"
  } };
}

module.exports = { getFallbackStatus, resolveFallback, selection, runtimeRequirements, manager: Manager,
  supportsRunner, SUPPORTED_RUNNER_VERSIONS, TESTED_VENDOR_SHA256, TESTED_VENDOR_BUILDS,
  __test: { installDirectory } };
