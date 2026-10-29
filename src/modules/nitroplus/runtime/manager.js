const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");
const Github = require("../../shared/runtime/github-releases");
const historical = (version, revision, tag = `v${version}`) => ({ version, upstreamRevision: revision, upstreamTag: tag,
  sourceUrl: `https://github.com/FGRE/libnpengine/tree/${encodeURIComponent(tag)}`, localBuild: false,
  installReason: "Source release only. Mac runtimes from MacLauncher Builds support NPA/NSS and per-game saves." });

const manager = createPinnedNativeManager({ id: "npengine", label: "Nitroplus", projectBuilds: { projectId: "npengine", repository: "procrastinine/maclauncher-builds" },
  sourceUrl: "https://github.com/FGRE/libnpengine/tags", legacyInstalledRuntime: createBundledNativeRuntime({ managerId: "npengine" }),
  resolveExecutable: root => path.join(root, "bin/npengine-runner"),
  catalog: [],
  // Upstream publishes source tags, with no Mac runtime assets. The shared
  // provider supplies the complete paginated tag history on explicit refresh.
  discoverCatalog: async ({ signal }) => (await Github.fetchGithubTags({ owner: "FGRE", repo: "libnpengine", signal }))
    .filter(tag => /^v?\d+\.\d+\.\d+[a-z]?$/.test(tag.name || ""))
    .map(tag => historical(tag.name.replace(/^v/, ""), tag.commit.sha, tag.name)) });
manager.distributionRequired = false;
module.exports = manager;
