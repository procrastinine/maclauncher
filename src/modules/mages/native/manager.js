const fs = require("node:fs");
const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");
const { createGithubReleaseDiscovery } = require("../../shared/runtime/github-runtime-catalog");
const Adapter = require("./adapter");

const SOURCE_URL = "https://github.com/CommitteeOfZero/impacto/releases";

// An installed runtime names the game profile it was built for by checksum.
function profileFor(profileSha256) {
  if (!/^[a-f0-9]{64}$/.test(profileSha256 || "")) return null;
  const file = fs.readdirSync(__dirname).filter(name => /^windows-game(?:-v\d+)?\.lua$/.test(name)).sort()
    .map(name => path.join(__dirname, name)).find(candidate => Adapter.hash(candidate) === profileSha256);
  return file || null;
}

function releaseEntry(version, revision, sourceUrl) {
  return { version, upstreamRevision: revision, upstreamTag: version, sourceUrl,
    localBuild: false, installReason: "Windows HD requires the Mac Windows HD runtime. Other releases support different editions." };
}

function createManager({ resourceRoot, dependencies = {} } = {}) {
  const bundledRuntime = createBundledNativeRuntime({ managerId: "impacto", resourceRoot,
    ...(dependencies.bundled ? { dependencies: dependencies.bundled } : {}) });
  const manager = createPinnedNativeManager({ id: "impacto", label: "Impacto", maxEntries: 1000,
    projectBuilds: { projectId: "impacto", repository: "procrastinine/maclauncher-builds" },
    sourceUrl: SOURCE_URL, legacyInstalledRuntime: bundledRuntime, resolveExecutable: root => path.join(root, "Impacto.app", "Contents", "MacOS", "Impacto"),
    catalog: [],
    discoverCatalog: createGithubReleaseDiscovery({ owner: "CommitteeOfZero", repo: "impacto", includePrerelease: true, maxPages: 10, maxEntries: 1000,
      dependencies: dependencies.github,
      mapRelease: async (release, { resolveRevision, sourceUrl }) => /^\d+(?:\.\d+){3}$/.test(release.tag_name || "")
        ? releaseEntry(release.tag_name, await resolveRevision(release), sourceUrl) : null }) });
  manager.distributionRequired = false;
  return manager;
}

module.exports = { SOURCE_URL, profileFor, releaseEntry, createManager };
