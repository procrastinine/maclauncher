const fs = require("node:fs");
const path = require("node:path");
const Catalog = require("./ilspy-catalog");
const Tool = require("./managed-decompiler");
const Custom = require("./custom-runtime");
const { selectRuntimeVersion, managerDefaultVersion } = require("./version-choices");
const Host = require("./dotnet-tool-host");
const { throwIfAborted } = require("./download-utils");
const Bundled = require("./bundled-native");
const { withRuntimeMutation } = require("../../../core/coordinated-runtime-managers");

const SECTION = "decompiler", stateByDirectory = new Map(), pendingByDirectory = new Map();
function normalizeSettings(settings) {
  let defaultVersion = null;
  try { if (settings?.defaultVersion) defaultVersion = Catalog.normalizeVersion(settings.defaultVersion); } catch {}
  return { defaultVersion };
}
function reason(pin, { minimumMacOS = Host.minimumMacOS(pin.framework), systemVersion = Bundled.systemVersionSync() } = {}) {
  if (pin.installReason) return pin.installReason;
  if (!Host.supported(pin.framework)) return "This version requires an unsupported .NET tool host.";
  if (process.arch !== "arm64") return "The managed tool host requires Apple Silicon.";
  if (!Bundled.versionAtLeast(systemVersion, minimumMacOS)) return "This tool requires macOS " + minimumMacOS + " or later.";
  return null;
}
function requirementsFor(pins, context, installed = []) {
  const systemVersion = Bundled.systemVersionSync(), byVersion = new Map(installed.map(item => [item.version, item]));
  let host;
  if (pins.some(pin => pin.framework === "net8.0" && !pin.installReason)) {
    try { host = Tool.resolveHost(context, { framework: "net8.0", minimumRuntime: "8.0.0" }, "status"); } catch {}
  }
  return Object.fromEntries(pins.map(pin => {
    let minimumMacOS = Host.minimumMacOS(pin.framework);
    const minimumRuntime = byVersion.get(pin.version)?.minimumRuntime || pin.minimumRuntime || pin.framework?.replace(/^net/, "") + ".0";
    const hostFloor = host?.install?.minimumMacOS || host?.profile?.minimumMacOS;
    if (pin.framework === "net8.0" && host?.ready && hostFloor &&
      Host.matchingVersion(pin.framework, host.profile?.dotnetVersion) &&
      Bundled.versionAtLeast(host.profile.dotnetVersion, minimumRuntime)) minimumMacOS = hostFloor;
    return [pin.version, { minimumMacOS, installReason: reason(pin, { minimumMacOS, systemVersion }) }];
  }));
}
function listInstalled(userDataDir) {
  if (!path.isAbsolute(userDataDir || "")) return [];
  let names; try { names = fs.readdirSync(path.join(userDataDir, "runtimes", "fna-tools", "ilspy")); } catch { return []; }
  return names.filter(name => Catalog.VERSION.test(name)).slice(0, Catalog.LIMITS.versions).flatMap(version => {
    try {
      const tool = Tool.resolveTool({ userDataDir, version, verification: "status" });
      if (!tool) return [];
      return [{ version, ready: true, sectionId: SECTION, installDir: tool.root, executablePath: tool.entryPath,
        sourceRevision: tool.sourceRevision, framework: tool.framework, minimumRuntime: tool.minimumRuntime, architecture: "arm64", removable: true }];
    } catch { return []; }
  }).sort((a, b) => Catalog.compareVersions(b.version, a.version));
}
function getState({ userDataDir, settings } = {}) {
  const cfg = normalizeSettings(settings), installed = listInstalled(userDataDir);
  const key = userDataDir || "", cached = Catalog.cachedCatalog(userDataDir);
  const versions = new Set([...(cached?.entries || []).map(pin => pin.version), ...installed.map(row => row.version)]);
  const pins = [...versions].map(version => Catalog.pinFor(version, userDataDir)).sort((a, b) => Catalog.compareVersions(b.version, a.version));
  const previous = stateByDirectory.get(key) || { status: cached ? "success" : "idle", fetchedAt: cached?.fetchedAt || null, error: null };
  const requirements = requirementsFor(pins, { userDataDir }, installed);
  const installable = pins.filter(pin => !requirements[pin.version].installReason);
  const listed = installable.filter(pin => cached?.entries.some(row => row.version === pin.version)).map(pin => pin.version);
  const base = { supportsDefault: true, defaultVersion: cfg.defaultVersion || managerDefaultVersion({ listed, installed: installed.map(row => row.version) }), defaultSource: cfg.defaultVersion ? "saved" : "manager", installed, installing: null, variants: [],
    versionLabels: Object.fromEntries(pins.map(pin => [pin.version, pin.framework
      ? pin.version + " · " + pin.framework.replace(/^net(?:coreapp)?/, ".NET ") : pin.version])),
    catalog: { ...previous, mode: "all", source: Catalog.SOURCE, sourceUrl: Catalog.SOURCE,
      versions: pins.map(pin => pin.version),
      installable: installable.length > 0, installableVersions: installable.map(pin => pin.version),
      versionRequirements: Object.fromEntries(pins.map(pin => [pin.version, {
        ...requirements[pin.version],
        requiresDownload: !installed.some(row => row.version === pin.version), requiresBuild: false,
        available: installed.some(row => row.version === pin.version), included: false, installLabel: "Install"
      }])), includedVersions: [], buildableVersions: [], supportsLatestOnly: false,
      latestAvailableVersion: pins[0]?.version || null, latestInstalledVersion: installed[0]?.version || null,
      updateAvailable: pins.some(pin => !requirements[pin.version].installReason && Catalog.compareVersions(pin.version, cfg.defaultVersion || "") > 0) } };
  return { ...base, sections: [{ id: SECTION, label: "ILSpy", ...base }] };
}
async function refreshCatalog({ userDataDir, force = false, signal, logger } = {}, dependencies = {}) {
  if (!path.isAbsolute(userDataDir || "")) throw new Error("ILSpy requires the launcher's data directory.");
  const previous = stateByDirectory.get(userDataDir);
  if (!force && previous?.status === "success" && Date.now() - previous.fetchedAt < 6 * 60 * 60 * 1000) return getState({ userDataDir }).catalog;
  if (pendingByDirectory.has(userDataDir)) return pendingByDirectory.get(userDataDir);
  stateByDirectory.set(userDataDir, { status: "loading", fetchedAt: previous?.fetchedAt || null, error: null });
  const promise = (async () => {
    try {
      const rows = await (dependencies.discover || Catalog.discover)({ signal, logger });
      throwIfAborted(signal);
      const installed = listInstalled(userDataDir), versions = new Set(rows.map(row => row.version));
      const retained = installed.filter(row => !versions.has(row.version)).map(row => Catalog.pinFor(row.version, userDataDir));
      Catalog.saveCatalog(userDataDir, rows, retained);
      stateByDirectory.set(userDataDir, { status: "success", fetchedAt: Date.now(), error: null });
      return getState({ userDataDir }).catalog;
    } catch (error) {
      stateByDirectory.set(userDataDir, { status: "error", fetchedAt: previous?.fetchedAt || null, error: String(error.message || error) });
      throw error;
    } finally { pendingByDirectory.delete(userDataDir); }
  })();
  if (stateByDirectory.size > 32) stateByDirectory.delete(stateByDirectory.keys().next().value);
  pendingByDirectory.set(userDataDir, promise); return promise;
}
async function installRuntime(context = {}, dependencies = {}) {
  const settings = context.settings?.runtimes?.ilspy || context.settings;
  const version = selectRuntimeVersion({ manual: context.version, defaultVersion: getState({ userDataDir: context.userDataDir, settings }).defaultVersion }).version;
  let pin; try { if (version) pin = Catalog.pinFor(version, context.userDataDir); } catch {}
  if (pin) {
    const installed = Tool.resolveTool({ userDataDir: context.userDataDir, version, verification: "status" });
    const unavailable = requirementsFor([pin], context, installed ? [installed] : [])[pin.version].installReason;
    if (unavailable) throw new Error(unavailable);
  }
  const tool = await Tool.ensureTool(context, version, dependencies.tool);
  await Tool.ensureHost(context, tool, dependencies.host);
  return { version: tool.version, ready: true, sectionId: SECTION, installDir: tool.root,
    executablePath: tool.entryPath, framework: tool.framework, sourceRevision: tool.sourceRevision };
}
async function uninstallRuntime({ userDataDir, version, installDir } = {}) {
  const pin = Catalog.pinFor(version, userDataDir), target = Tool.installRoot(userDataDir, pin.version);
  if (installDir && path.resolve(installDir) !== target) throw new Error("The selected directory does not belong to ILSpy.");
  return withRuntimeMutation({ managerId: "ilspy", version: pin.version, sectionId: SECTION, sourcePath: target }, () => {
    fs.rmSync(target, { recursive: true, force: true }); return true;
  }, { userDataDir });
}
module.exports = {
  id: "ilspy", label: "ILSpy", distributionRequired: false,
  delivery: { included: "none", catalog: "remote", sourceBuild: false },
  ui: { groupId: "tools", tabLabel: "Tools", sectionLabel: "ILSpy", order: 200, memberOrder: 200, management: "managed" },
  normalizeVersion: Catalog.normalizeVersion, normalizeSettings, getState, refreshCatalog, installRuntime, uninstallRuntime,
  applySettingsUpdate: (action, payload, settings) => action === "setDefault"
    ? { ...normalizeSettings(settings), defaultVersion: payload?.version ? Catalog.normalizeVersion(payload.version) : null } : settings,
  updateSettingsAfterInstall: (settings, installed) => normalizeSettings(settings).defaultVersion ? settings : { ...settings, defaultVersion: installed.version },
  updateSettingsAfterUninstall: (settings, payload) => normalizeSettings(settings).defaultVersion === payload.version
    ? { ...normalizeSettings(settings), defaultVersion: null } : settings,
  core: { normalizeVersion: Catalog.normalizeVersion, listInstalled, listCatalog: ({ userDataDir } = {}) => Catalog.pins(userDataDir),
    get catalog() { return Object.values(Catalog.PINS).map(pin => ({ ...pin, upstreamRevision: pin.sourceRevision,
      asset: { url: pin.url, sha256: pin.sha256, sha512: pin.sha512 } })); } },
  __test: { reason }
};

Custom.configure(module.exports, {
  inspect: Tool.inspectCustomTool,
  defaultsPath: () => ["defaultVersion"],
  providers: [
    { core: Tool, resolves: { resolveTool: SECTION,
      ensureTool: { section: SECTION, version: ({ args }) => args[1], userDataDir: ({ args }) => args[0]?.userDataDir,
        missing: "The selected custom ILSpy tool is unavailable. Check its path in Runtimes." } },
      directories: { installRoot: { version: ({ args }) => args[1] } } },
    { core: module.exports.core, versions: ["normalizeVersion"] }
  ]
});
