const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");
const { createGithubReleaseDiscovery } = require("../../shared/runtime/github-runtime-catalog");
const Releases = require("./releases.json");
const WindowsVersions = require("./windows-versions.json");

const VERSION = "0.10.8.810-windows-v9";
const V9_VERSION = "0.10.8.810-windows-v9";
const CURRENT_VERSION = "0.10.8.903-windows-v10";
const V9_PROFILE = "windows-mpk2-sc3-sfx-macos13-v9";
const V8_VERSION = "0.10.8.810-windows-v8";
const V8_PROFILE = "windows-mpk2-sc3-backlog-macos13-v8";
const V7_VERSION = "0.10.8.810-windows-v7";
const V7_PROFILE = "windows-mpk2-sc3-checkpoint-macos13-v7";
const V6_VERSION = "0.10.8.810-windows-v6";
const V6_PROFILE = "windows-mpk2-sc3-voice-macos13-v6";
const V5_VERSION = "0.10.8.810-windows-v5";
const V5_PROFILE = "windows-mpk2-sc3-input-macos13-v5";
const V4_VERSION = "0.10.8.810-windows-v4";
const V3_VERSION = "0.10.8.810-windows-v3";
const V2_VERSION = "0.10.8.810-windows-v2";
const LEGACY_VERSION = "0.10.8.810-windows-v1";
const PROFILE = "windows-mpk2-sc3-v1";
const SOURCE_URL = "https://github.com/CommitteeOfZero/impacto/releases";

function reviewedVersion(version) { return WindowsVersions.find(pin => pin.version === version) || null; }
function profilePath(version) {
  return path.join(__dirname, [V9_VERSION, CURRENT_VERSION].includes(version) ? "windows-game-v9.lua" :
    version === V8_VERSION ? "windows-game-v8.lua" :
    version === V7_VERSION ? "windows-game-v7.lua" :
    version === V6_VERSION ? "windows-game-v6.lua" :
    version === V5_VERSION ? "windows-game-v5.lua" :
    version === LEGACY_VERSION ? "windows-game-v1.lua" : "windows-game.lua");
}

function releaseEntry(version, revision, sourceUrl) {
  return { version, upstreamRevision: revision, upstreamTag: version, sourceUrl,
    localBuild: false, installReason: "Windows HD requires the Mac Windows HD runtime. Other releases support different editions." };
}

function createManager({ resourceRoot, dependencies = {} } = {}) {
  const bundle = createBundledNativeRuntime({ managerId: "impacto", resourceRoot,
    ...(dependencies.bundled ? { dependencies: dependencies.bundled } : {}) });
  const bundledRuntime = { ...bundle,
    resolve: options => reviewedVersion(options.version) ? bundle.resolve(options) : null,
    install: options => reviewedVersion(options.version) ? bundle.install(options) : null,
    verifyInstalled: options => Boolean(reviewedVersion(options.record?.version)) && bundle.verifyInstalled(options) };
  const manager = createPinnedNativeManager({ id: "impacto", label: "Impacto Windows beta", recommendedVersion: VERSION, maxEntries: 1000,
    projectBuilds: { projectId: "impacto", repository: "procrastinine/maclauncher-builds" },
    sourceUrl: SOURCE_URL, legacyInstalledRuntime: bundledRuntime, resolveExecutable: root => path.join(root, "Impacto.app", "Contents", "MacOS", "Impacto"),
    catalog: [...WindowsVersions,
      ...Releases.map(([version, revision]) => releaseEntry(version, revision, `${SOURCE_URL}/tag/${version}`))],
    discoverCatalog: createGithubReleaseDiscovery({ owner: "CommitteeOfZero", repo: "impacto", includePrerelease: true, maxPages: 10, maxEntries: 1000,
      dependencies: dependencies.github,
      mapRelease: async (release, { resolveRevision, sourceUrl }) => /^\d+(?:\.\d+){3}$/.test(release.tag_name || "")
        ? releaseEntry(release.tag_name, await resolveRevision(release), sourceUrl) : null }) });
  manager.distributionRequired = false;
  return manager;
}

module.exports = { VERSION, CURRENT_VERSION, V9_VERSION, V9_PROFILE, V8_VERSION, V8_PROFILE, V7_VERSION, V7_PROFILE, V6_VERSION, V6_PROFILE, V5_VERSION, V5_PROFILE, V4_VERSION, V3_VERSION, V2_VERSION, LEGACY_VERSION, PROFILE, SOURCE_URL, reviewedVersion, profilePath, releaseEntry, createManager };
