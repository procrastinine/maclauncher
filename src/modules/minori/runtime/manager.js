const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");
const { createGithubCommitDiscovery } = require("../../shared/runtime/github-runtime-catalog");
const Build = require("./build");
const manager = createPinnedNativeManager({ id: "reminori", label: "Minori", recommendedVersion: Build.VERSION,
  projectBuilds: { projectId: "reminori", repository: "procrastinine/maclauncher-builds" },
  distributionRequired: false, sourceUrl: "https://github.com/luoyily/ReMinori/commits/main/",
  buildSourcePath: Build.sourcePath, buildHelpUrl: "https://github.com/luoyily/ReMinori",
  buildRequirements: "Developer builds use Rust from https://rustup.rs/ in ~/.cargo/bin and Apple Command Line Tools. Native packages include the interpreter and its versioned movie decoder.",
  legacyInstalledRuntime: createBundledNativeRuntime({ managerId: "reminori" }),
  buildRuntime: options => Build.buildRuntime(options), resolveExecutable: root => path.join(root, "bin/eden"),
  catalog: [{ version: Build.VERSION, versionLabel: "0.1.0 · Mac v2", upstreamRevision: Build.REVISION,
    sourceArtifact: { directoryRelative: "reminori/0.1.0-79b0099-macos-v2-source.tar.gz",
      sha256: "46847dfbec612b5c73743b154d2b38d74b1b8cc0eeadbb13acb4cc05579b9425", bytes: 30225243 },
    hostArchitectures: ["arm64"], architecture: "arm64",
    sourceKind: "commit", sourceUrl: `https://github.com/luoyily/ReMinori/commit/${Build.REVISION}`,
    localBuild: true, profile: Build.PROFILE }],
  discoverCatalog: createGithubCommitDiscovery({ owner: "luoyily", repo: "ReMinori", limit: 20,
    mapCommit: (commit, { sourceUrl }) => ({ version: commit.sha === Build.REVISION ? Build.VERSION : `snapshot-${commit.sha.slice(0, 12)}`,
      upstreamRevision: commit.sha, sourceKind: "commit", sourceUrl, localBuild: false, hostArchitectures: ["arm64"], architecture: "arm64",
      installReason: "Source snapshot; the Mac adapter applies to the explicitly pinned 0.1.0 profile." }) }) });
module.exports = manager;
