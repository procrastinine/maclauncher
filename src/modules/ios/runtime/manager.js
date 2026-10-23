const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { catalog, SOURCE_URL, createCatalogDiscovery } = require("./catalog");
const { systemVersionSync, versionAtLeast } = require("../../shared/runtime/bundled-native");
const Native = require("../../shared/runtime/local-native");
const MachO = require("../macho");
async function extractArchive(file, destination, signal) {
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-playtools-")); let mounted = false;
  try {
    await execFile("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, file], { signal, timeout: 60000, maxBuffer: 1024 * 1024 }); mounted = true;
    const inventory = inspectPlayTools(mount), directory = path.join(mount, "PlayCover.app/Contents/Frameworks");
    for (const name of ["PlayTools.framework", ...inventory.playToolsDependencies.map(item => item.name)])
      await execFile("/usr/bin/ditto", [path.join(directory, name), path.join(destination, name)], { signal, timeout: 60000 });
  } finally {
    if (mounted) await execFile("/usr/bin/hdiutil", ["detach", mount], { timeout: 30000 });
    fs.rmSync(mount, { recursive: true, force: true });
  }
}
function framework(install) {
  // Existing managed PlayCover installations remain usable without redownload.
  return path.basename(install.executablePath) === "PlayTools" ? path.dirname(install.executablePath)
    : path.resolve(install.executablePath, "../../Frameworks/PlayTools.framework");
}
function inspectPlayTools(unpacked) {
  const root = fs.realpathSync(unpacked), directory = fs.existsSync(path.join(root, "PlayTools.framework")) ? root : path.join(root, "PlayCover.app/Contents/Frameworks");
  const binary = path.join(directory, "PlayTools.framework/PlayTools"), dependencies = new Map();
  function inspect(file) {
    const actual = fs.realpathSync(file), stat = fs.statSync(actual);
    if (!actual.startsWith(root + path.sep) || !stat.isFile() || stat.size > 64 * 1024 * 1024)
      throw new Error("PlayTools contains an invalid or oversized native library.");
    if (!Native.readMachOArchitectures(actual, { allowLibrary: true }).includes("arm64"))
      throw new Error("The download does not include an ARM64 PlayTools library.");
    const info = MachO.inspect(fs.readFileSync(actual));
    for (const { cmd, bytes } of info.commands) {
      if (![0xc, 0x80000018, 0x8000001f, 0x80000023].includes(cmd)) continue;
      if (bytes.length < 24) throw new Error("PlayTools contains an invalid library reference.");
      const offset = bytes.readUInt32LE(8), end = bytes.indexOf(0, offset);
      if (offset < 24 || end < offset) throw new Error("PlayTools contains an invalid library reference.");
      const reference = bytes.toString("utf8", offset, end);
      if (!reference.startsWith("@rpath/")) continue;
      const name = reference.slice(7);
      if (!/^[A-Za-z0-9._-]+\.dylib$/.test(name)) throw new Error("PlayTools requires an unsupported bundled library: " + reference);
      if (dependencies.has(name)) continue;
      if (dependencies.size >= 32) throw new Error("PlayTools has too many bundled library dependencies.");
      const dependency = path.join(directory, name);
      dependencies.set(name, null);
      inspect(dependency);
      dependencies.set(name, Native.hashFile(dependency));
    }
  }
  inspect(binary);
  return { playToolsSha256: Native.hashFile(binary), playToolsDependencies: [...dependencies].map(([name, sha256]) => ({ name, sha256 })) };
}
function createManager({ dependencies = {}, catalogDependencies = {} } = {}) {
  const hostVersion = dependencies.systemVersionSync ? dependencies.systemVersionSync() : process.platform === "darwin" ? systemVersionSync() : null;
  const recommendedVersion = hostVersion && versionAtLeast(hostVersion, "26.0") ? "4.0.0-prerelease" : "3.1.0";
  // Keep the persisted manager ID and version selections from earlier releases.
  const manager = createPinnedNativeManager({ id: "playcover", label: "PlayCover", nativeLibrary: true,
  recommendedVersion,
  sourceUrl: SOURCE_URL, discoverCatalog: createCatalogDiscovery(catalogDependencies), catalog,
  dependencies: { extractArchive, ...dependencies }, resolveExecutable: root => path.join(root, "PlayTools.framework/PlayTools"),
  prepareInstall: async ({ unpacked }) => inspectPlayTools(unpacked) });
  const getState = manager.getState;
  manager.getState = options => {
    const state = getState(options);
    const installed = state.installed.some(item => item.version === recommendedVersion && item.ready !== false);
    const requirements = state.catalog.versionRequirements[recommendedVersion];
    // First use needs no catalog refresh or separate application installation.
    // Keep the recommended download separate from the publisher's release list.
    const setupActions = installed ? [] : [{ id: "installRecommended", toolLabel: "Recommended PlayCover",
      version: recommendedVersion, buttonLabel: "Install recommended",
      available: process.platform === "darwin" && process.arch === "arm64" && !requirements?.installReason,
      description: "Downloads the recommended PlayCover release and installs its compatibility libraries in MacLauncher. Play also handles this automatically after confirmation. No separate PlayCover app setup is needed." }];
    const description = "PlayCover provides iOS compatibility. Import an IPA and choose Play; MacLauncher handles the runtime download and application setup. Keyboard, mouse and display options are available in Settings and each game's Runtime Settings.";
    const decorate = section => ({ ...section, description, setupActions,
      catalog: { ...section.catalog, ...(!section.catalog.versions.length ? { installReason: null } : {}) } });
    return { ...decorate(state), sections: state.sections.map(decorate) };
  };
  manager.performSetupAction = async ({ setupActionId, toolVersion, ...context } = {}) => {
    if (setupActionId !== "installRecommended" || toolVersion && toolVersion !== recommendedVersion)
      throw new Error("Choose the recommended PlayCover download or select a version from the release list.");
    const installed = await manager.installRuntime({ ...context, version: recommendedVersion });
    return { ...installed, message: `PlayCover ${installed.version} is ready. Import an IPA and choose Play.` };
  };
  manager.updateSettingsAfterSetup = manager.updateSettingsAfterInstall;
  return manager;
}
module.exports = createManager();
module.exports.framework = framework;
module.exports.createManager = createManager;
module.exports.createCatalogDiscovery = createCatalogDiscovery;
module.exports.inspectPlayTools = inspectPlayTools;
