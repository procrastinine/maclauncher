const fs = require("node:fs");
const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { runDownloadTask } = require("../../shared/runtime/download-manager");
const { buildRuntimeDownloadMeta } = require("../../shared/runtime/runtime-downloads");
const Catalog = require("./catalog");
const Package = require("./package");
const { VERSION } = require("../detect");
const Custom = require("../../shared/runtime/custom-runtime");

function createManager({ dependencies = {} } = {}) {
  // A game runs only on its exact player version, so there is no default.
  const core = createPinnedNativeManager({ id: "unity", label: "Unity Mono", catalog: [], supportsDefault: false,
    discoverCatalog: args => Catalog.discoverCatalog({ ...args, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) }), sourceUrl: Catalog.SOURCE,
    verifyArtifact: args => Package.verifyArtifact(args, dependencies), prepareInstall: args => Package.prepareInstall(args, dependencies),
    resolveExecutable: root => path.join(root, "player", "UnityPlayer.app", "Contents", "MacOS", "UnityPlayer"),
    dependencies: { ...dependencies, extractArchive: dependencies.extractArchive || Package.extractPackage } });
  const statusCache = new Map();
  function readProfile(install, { cached = false } = {}) {
    if (!install) return null;
    try {
      const file = path.join(install.installDir, "player-profile.json"), stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) return null;
      if (install.installationMetadata?.profileSha256 && require("../../shared/runtime/local-native").hashFile(file) !== install.installationMetadata.profileSha256) return null;
      const profile = JSON.parse(fs.readFileSync(file, "utf8"));
      if (profile.schemaVersion !== 1 || profile.version !== install.version || profile.revision !== install.upstreamRevision ||
        profile.scriptingBackend !== "mono" || profile.templateRelative !== "UnityPlayer.app" || !profile.files || !profile.symlinks ||
        Object.keys(profile.files).length + Object.keys(profile.symlinks).length > 5000) return null;
      const root = path.join(install.installDir, "player"), identities = [];
      for (const relative of [...Object.keys(profile.files), ...Object.keys(profile.symlinks)]) {
        if (!Package.safeRelative(relative)) return null;
        const metadata = fs.lstatSync(path.join(root, relative), { bigint: true });
        identities.push([relative, metadata.dev, metadata.ino, metadata.size, metadata.mode, metadata.mtimeNs, metadata.ctimeNs].join(":"));
      }
      const identity = [stat.size, stat.mtimeMs, stat.ctimeMs, ...identities].join("\n"), existing = cached && statusCache.get(install.installDir);
      if (existing?.identity === identity) return existing.profile;
      const result = Package.verifyInventory(root, profile) ? { ...profile, root, templatePath: path.join(root, "UnityPlayer.app") } : null;
      if (cached) { if (statusCache.size >= 128) statusCache.delete(statusCache.keys().next().value); statusCache.set(install.installDir, { identity, profile: result }); }
      return result;
    } catch { return null; }
  }
  function resolveSelection(entry, _settings, userDataDir) {
    const detected = entry?.moduleData?.detectedVersion, override = entry?.runtimeData?.unity?.version;
    const version = override || detected;
    if (!VERSION.test(version || "")) return { version: null, ready: false, install: null, reason: "The game does not report an exact Unity player version." };
    if (detected && version !== detected) return { version, ready: false, install: null, reason: `This game needs Unity ${detected}. A different player version is not automatically substituted.` };
    const install = core.core.resolveInstalled({ userDataDir, version }), profile = readProfile(install);
    return { version, install: profile ? install : null, profile, ready: Boolean(profile), reason: profile ? null : install ? "The Unity player component changed or is incomplete. Reinstall this version in Runtimes." : `Unity ${version} is not installed.` };
  }
  async function ensureCatalogVersion({ userDataDir, version, signal, logger } = {}) {
    if (!VERSION.test(version || "")) throw new Error("Choose an exact Unity player version.");
    // Load persisted catalog records before deciding whether an exact lookup is
    // needed. This is called on explicit Play/Install/Import, never on startup.
    core.getState({ userDataDir });
    const known = core.core.catalog.find(pin => pin.version === version);
    if (known) return known;
    const verified = Catalog.REVIEWED.find(pin => pin.version === version);
    if (verified) return core.core.rememberResolvedVersion({ userDataDir, entry: verified });
    const pin = await Catalog.discoverVersion(version, { signal, logger, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) });
    return core.core.rememberResolvedVersion({ userDataDir, entry: pin });
  }
  async function installRuntime(options = {}) {
    await ensureCatalogVersion(options);
    const install = await core.installRuntime(options), profile = readProfile(install);
    if (!profile) throw new Error("Installed Unity component failed its native engine and Mono payload integrity check.");
    statusCache.delete(install.installDir); return { ...install, profile };
  }
  async function importRuntime(options = {}) {
    const source = options.runtimePath || options.runtimeRoot;
    if (typeof source !== "string" || !path.isAbsolute(source) || source.includes("\0") || !fs.statSync(source).isFile()) throw new Error("Choose an official Unity Mac Mono component .pkg file.");
    const match = /^UnitySetup-Mac-(?:Mono-)?Support-for-Editor-(.+)\.pkg$/.exec(path.basename(source));
    if (!match || !VERSION.test(match[1])) throw new Error("The selected file is not a Unity Mac Mono component package.");
    const version = match[1], pin = await ensureCatalogVersion({ ...options, version });
    const importer = createManager({ dependencies: { ...dependencies, downloadToFile: async (url, output) => {
      if (url !== pin.asset.url) throw new Error("Imported Unity package does not match the selected release.");
      fs.copyFileSync(source, output);
    } } });
    return runDownloadTask(options.downloads, buildRuntimeDownloadMeta({ label: "Import Unity player", managerId: "unity", sectionId: "default", version, kind: "runtime-import" }), task =>
      importer.installRuntime({ ...options, version, downloads: null, signal: task.signal && options.signal ? AbortSignal.any([task.signal, options.signal]) : task.signal || options.signal, onProgress: task.onProgress }));
  }
  function getState(options = {}) {
    const state = core.getState(options);
    const installed = state.installed.map(install => {
      const profile = install.ready !== false && readProfile(install, { cached: true });
      return { ...install, ready: Boolean(profile), status: profile ? "ready" : install.status === "incomplete" ? "incomplete" : "damaged",
        ...(profile ? { architectures: profile.architectures } : { error: "The Unity Mono component is incomplete or changed. Reinstall the selected version." }) };
    });
    const catalog = { ...state.catalog, importable: true, importLabel: "Import player component…", importInputKinds: ["file"], importExtensions: ["pkg"],
      importDescription: "Choose a UnitySetup-Mac-Mono-Support-for-Editor-VERSION.pkg. The launcher extracts the player without installing the editor.",
      versionRequirements: Object.fromEntries(Object.entries(state.catalog.versionRequirements).map(([version, value]) => [version, { ...value, exactGameVersion: true }])) };
    return { ...state, installed, catalog, sections: [{ ...state.sections[0], label: "Mono player", installed, catalog }] };
  }
  const manager = { ...core, id: "unity", label: "Unity Mono", resolveSelection, getState, installRuntime, importRuntime, ensureCatalogVersion, readProfile,
    refreshCatalog: async options => { statusCache.clear(); return core.refreshCatalog(options); },
    uninstallRuntime: options => { statusCache.clear(); return core.uninstallRuntime(options); },
    __test: { createManager, statusCache } };
  Custom.configure(manager, { inspect(runtimePath) {
    let root = fs.statSync(runtimePath).isDirectory() ? runtimePath : path.dirname(runtimePath);
    for (let depth = 0; depth < 7 && !fs.existsSync(path.join(root, "player-profile.json")); depth += 1) root = path.dirname(root);
    const record = JSON.parse(fs.readFileSync(path.join(root, "player-profile.json"), "utf8"));
    const executable = path.join(root, "player", "UnityPlayer.app", "Contents", "MacOS", "UnityPlayer");
    const install = { ...Custom.inspectExecutable(executable), installDir: root, runtimeVersion: record.version, upstreamRevision: record.revision };
    const profile = readProfile({ ...install, version: record.version });
    if (!profile) throw new Error("Select a complete Unity Mono player component with its player profile.");
    return { ...install, profile };
  }, selection(install, { entry }) {
    const detected = entry?.moduleData?.detectedVersion;
    if (detected && detected !== install.runtimeVersion) throw new Error(`This game needs Unity ${detected}. The selected player provides ${install.runtimeVersion}.`);
    return { profile: install.profile };
  } });
  return manager;
}

module.exports = createManager();
