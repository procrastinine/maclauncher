const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");
const Catalog = require("./catalog");
const Profile = require("./profile");

function createManager({ arch = process.arch, dependencies = {} } = {}) {
  const core = createPinnedNativeManager({ id: "siglus", label: "siglus_rs", recommendedVersion: Catalog.VERSION,
    bundledExecution: "direct",
    sourceUrl: Catalog.RELEASES,
    catalog: [Catalog.reviewedEntry(arch), Catalog.sourceEntry("1.0.0", Catalog.REVISION, `${Catalog.RELEASES}/tag/1.0.0`),
      Catalog.sourceEntry("0.2.0", "bce8eefd6923cb907d1cbd198a53f41b8c52caa9", `${Catalog.RELEASES}/tag/0.2.0`),
      Catalog.sourceEntry("0.1.0", "814ef739a7d09fb3ca46e69b32ce06d127a1b10c", `${Catalog.RELEASES}/tag/0.1.0`)],
    discoverCatalog: Catalog.createDiscovery({ arch, dependencies: dependencies.github }),
    bundledRuntime: createBundledNativeRuntime({ managerId: "siglus", arch, ...(dependencies.bundle || {}) }),
    prepareInstall: options => Profile.prepareInstall(options, dependencies.profile),
    resolveExecutable: root => path.join(root, "bin", "siglus-host"), dependencies });
  const selection = core.resolveSelection.bind(core), installed = core.core.resolveInstalled.bind(core.core), getState = core.getState.bind(core);
  core.resolveSelection = (entry, settings, userDataDir) => {
    const result = selection(entry, settings, userDataDir);
    if (!result.ready) return result;
    try { return { ...result, install: Profile.resolveProfile(result.install) }; }
    catch (error) { return { ...result, ready: false, reason: error.message, install: null }; }
  };
  core.core.resolveInstalled = options => {
    const result = installed(options);
    if (!result) return null;
    try { return Profile.resolveProfile(result, options); } catch { return null; }
  };
  core.getState = options => {
    const state = getState(options), rows = state.installed.map(install => {
      if (install.ready === false) return install;
      try { Profile.resolveProfile(install, { verification: "status" }); return install; }
      catch (error) { return { ...install, ready: false, status: "damaged", error: error.message }; }
    });
    return { ...state, installed: rows, sections: state.sections.map(section => ({ ...section, installed: rows })) };
  };
  core.distributionVersions = [Catalog.VERSION];
  return core;
}
const manager = createManager();
module.exports = Object.assign(manager, { createManager });
