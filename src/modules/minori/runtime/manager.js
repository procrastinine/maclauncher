const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");
const { createGithubCommitDiscovery } = require("../../shared/runtime/github-runtime-catalog");
const manager = createPinnedNativeManager({ id: "reminori", label: "Minori", projectBuilds: { projectId: "reminori", repository: "procrastinine/maclauncher-builds" },
  distributionRequired: false, sourceUrl: "https://github.com/luoyily/ReMinori/commits/main/",
  legacyInstalledRuntime: createBundledNativeRuntime({ managerId: "reminori" }),
  resolveExecutable: root => path.join(root, "bin/eden"),
  catalog: [],
  discoverCatalog: createGithubCommitDiscovery({ owner: "luoyily", repo: "ReMinori", limit: 20,
    mapCommit: (commit, { sourceUrl }) => ({ version: `snapshot-${commit.sha.slice(0, 12)}`,
      upstreamRevision: commit.sha, sourceKind: "commit", sourceUrl, localBuild: false, hostArchitectures: ["arm64"], architecture: "arm64",
      installReason: "Source snapshot; Mac runtimes are available from MacLauncher Builds." }) }) });
module.exports = manager;
