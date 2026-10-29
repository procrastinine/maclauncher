const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");
const { createGithubReleaseDiscovery } = require("../../shared/runtime/github-runtime-catalog");

function catalogEntry(version, upstreamRevision, sourceUrl) {
  return { version, upstreamRevision, upstreamTag: version, sourceUrl, localBuild: false,
    installReason: "Source release; Mac runtimes are available from MacLauncher Builds." };
}
function createManager({ dependencies = {} } = {}) {
  const manager = createPinnedNativeManager({
    id: "onscripter-en", label: "ONScripter-EN", projectBuilds: { projectId: "onscripter-en", repository: "procrastinine/maclauncher-builds" },
    sourceUrl: "https://github.com/Galladite27/ONScripter-EN/releases",
    catalog: [],
    discoverCatalog: createGithubReleaseDiscovery({ owner: "Galladite27", repo: "ONScripter-EN",
      mapRelease: async (release, { resolveRevision, sourceUrl }) => /^\d{4}-\d{2}-\d{2}$/.test(release.tag_name || "")
        ? catalogEntry(release.tag_name, await resolveRevision(release), sourceUrl) : null,
      dependencies: dependencies.discovery || {} }),
    legacyInstalledRuntime: createBundledNativeRuntime({ managerId: "onscripter-en", ...(dependencies.bundle || {}) }),
    resolveExecutable: root => path.join(root, "bin", "onscripter-en"),
    dependencies: dependencies.manager || {}
  });
  const resolveSelection = manager.resolveSelection;
  manager.resolveSelection = (entry, settings, userDataDir) => {
    const version = entry?.runtimeData?.onscripter_en?.version;
    if (typeof version !== "string" || !version.trim()) return resolveSelection(entry, settings, userDataDir);
    return resolveSelection({ ...entry, runtimeData: { ...entry.runtimeData,
      "onscripter-en": { ...entry.runtimeData?.["onscripter-en"], version } } }, settings, userDataDir);
  };
  manager.distributionRequired = false;
  return manager;
}
module.exports = createManager();
module.exports.createManager = createManager;
