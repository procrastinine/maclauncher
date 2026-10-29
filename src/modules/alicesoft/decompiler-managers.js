const { createPinnedNativeManager } = require("../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../shared/runtime/bundled-native");
const { createCatalogDiscovery } = require("./catalog");
const tools = [
  { repo: "sys3c", managerId: "sys3-decompiler", label: "System1–3 decompiler", executable: "sys3dc" },
  { repo: "xsys35c", managerId: "xsys35-decompiler", label: "System3.x decompiler", executable: "xsys35dc" }
];

const managers = Object.fromEntries(tools.map(profile => {
  const manager = createPinnedNativeManager({ id: profile.managerId, label: profile.label, supportsDefault: true,
    projectBuilds: { projectId: profile.managerId, repository: "procrastinine/maclauncher-builds" },
    sourceUrl: `https://github.com/kichikuou/${profile.repo}/releases`,
    legacyInstalledRuntime: createBundledNativeRuntime({ managerId: profile.managerId }),
    discoverCatalog: createCatalogDiscovery(profile.repo), catalog: [] });
  manager.distributionRequired = false;
  return [profile.managerId, manager];
}));

module.exports = { managers, tools };
