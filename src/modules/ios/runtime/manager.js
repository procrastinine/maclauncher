const fs = require("node:fs");
const { cloneOrCopy } = require("../../shared/copy-file");
const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const Catalog = require("./catalog");
const Native = require("../../shared/runtime/local-native");
const Release = require("../../shared/runtime/release-files");
const MachO = require("../macho");
// Only PlayTools and its libraries are kept from the PlayCover download, in
// whichever archive format and folder the publisher uses.
async function extractArchive(file, destination, signal) {
  const download = fs.mkdtempSync(path.join(path.dirname(destination), ".download-"));
  try {
    await Release.extractArchive(file, download, signal);
    const inventory = inspectPlayTools(download), directory = frameworks(fs.realpathSync(download));
    for (const name of ["PlayTools.framework", ...inventory.playToolsDependencies.map(item => item.name)])
      await cloneOrCopy(path.join(directory, name), path.join(destination, name), { signal });
  } finally { fs.rmSync(download, { recursive: true, force: true }); }
}
const frameworks = root => path.dirname(Release.locatePackaged(root, ["PlayTools.framework", "PlayCover.app/Contents/Frameworks/PlayTools.framework"]) ||
  path.join(root, "PlayTools.framework"));
function framework(install) {
  // Existing managed PlayCover installations remain usable without redownload.
  return path.basename(install.executablePath) === "PlayTools" ? path.dirname(install.executablePath)
    : path.resolve(install.executablePath, "../../Frameworks/PlayTools.framework");
}
function inspectPlayTools(unpacked) {
  const root = fs.realpathSync(unpacked), directory = frameworks(root);
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
function createManager({ dependencies = {} } = {}) {
  // Keep the persisted manager ID and version selections from earlier releases.
  const manager = createPinnedNativeManager({
    // The injected iOS environment and PlayCover library must retain a matching native ABI.
    versionCompatibility: "exact",
     id: "playcover", label: "PlayCover", nativeLibrary: true,
  sourceUrl: Catalog.SOURCE_URL, upstream: Catalog.source,
  dependencies: { extractArchive, ...dependencies }, resolveExecutable: root => path.join(root, "PlayTools.framework/PlayTools"),
  prepareInstall: async ({ unpacked }) => inspectPlayTools(unpacked) });
  const getState = manager.getState;
  manager.getState = options => {
    const state = getState(options);
    const description = "PlayCover provides iOS compatibility. Import an IPA and choose Play; MacLauncher handles the runtime download and application setup. Keyboard, mouse and display options are available in Settings and each game's Runtime Settings.";
    const decorate = section => ({ ...section, description, setupActions: [],
      catalog: { ...section.catalog, ...(!section.catalog.versions.length ? { installReason: null } : {}) } });
    return { ...decorate(state), sections: state.sections.map(decorate) };
  };
  manager.performSetupAction = async ({ setupActionId, toolVersion, ...context } = {}) => {
    if (setupActionId !== "installRecommended") throw new Error("Unknown PlayCover installation action.");
    const installed = await manager.installRuntime({ ...context, version: toolVersion });
    return { ...installed, message: `PlayCover ${installed.version} is ready. Import an IPA and choose Play.` };
  };
  manager.updateSettingsAfterSetup = manager.updateSettingsAfterInstall;
  return manager;
}
module.exports = createManager();
module.exports.framework = framework;
module.exports.createManager = createManager;
module.exports.inspectPlayTools = inspectPlayTools;
module.exports.frameworksDirectory = frameworks;
