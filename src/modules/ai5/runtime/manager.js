const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");
const { createGithubReleaseDiscovery } = require("../../shared/runtime/github-runtime-catalog");
const manager = createPinnedNativeManager({ id: "ai5", label: "AI5WIN", projectBuilds: { projectId: "ai5", repository: "procrastinine/maclauncher-builds" },
  distributionRequired: false,
  sourceUrl: "https://github.com/nunuhara/ai5-sdl2/releases", legacyInstalledRuntime: createBundledNativeRuntime({ managerId: "ai5" }),
  catalog: [],
  discoverCatalog: createGithubReleaseDiscovery({ owner: "nunuhara", repo: "ai5-sdl2",
    mapRelease: async (release, { resolveRevision, sourceUrl }) => /^\d+\.\d+\.\d+$/.test(release.tag_name || "")
      ? { version: release.tag_name, upstreamRevision: await resolveRevision(release), upstreamTag: release.tag_name, sourceUrl, localBuild: false, installReason: "Source release; Mac runtimes are available from MacLauncher Builds." } : null }),
  resolveExecutable: root => path.join(root, "bin", "ai5") });
manager.payloadPolicy = require("./payload-policy.json");
module.exports = manager;
