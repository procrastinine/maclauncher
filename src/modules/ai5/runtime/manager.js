const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");
const { createGithubReleaseDiscovery } = require("../../shared/runtime/github-runtime-catalog");
const Build = require("./build");
const Portable = require("./portable-build");
const CurrentPortable = require("./portable-build-v4");

const RELEASES = [["1.5.0", Build.REVISION], ["1.4.1", "0d2432f2227ae002770723fdc6c70ec5114c7a8c"],
  ["1.4.0", "81a335ee78620efa4f4a96db8d2406452553115b"], ["1.3.0", "7a8d817326e0083d247bce7dd4aa40018de5914f"],
  ["1.2.0", "02ef90fb840f3b95c89beee05ae7237bfb910d52"], ["1.1.0", "96bcc57b3e864dd25d869dc340e04d4d0e8a4fb0"],
  ["1.0.0", "d88316d09821d333b776604a3e3752306f87ca16"]];
function entry(version, revision, sourceUrl) {
  const reviewed = version === "1.5.0" && revision === Build.REVISION;
  return { version: reviewed ? Portable.VERSION : version, upstreamRevision: revision, upstreamTag: version,
    sourceUrl, ...(reviewed ? { versionLabel: "1.5.0 · Mac v3", localBuild: false,
      profile: Portable.PROFILE, movieSupport: "ffmpeg", audioBackend: "sndfile", hostArchitectures: ["arm64"], minimumMacOS: "13.0",
      sourceTreeSha256: Portable.SOURCE_SHA256, overlaySha256: Portable.overlayIdentity(),
      sourceArtifact: { directoryRelative: "ai5/1.5.0-macos-v3-source.tar.gz", bytes: 103057448,
        sha256: "2e1e6baeb2b62519132f9c00e454fd4a41c24f77742263604553fe0057963759" } }
      : { localBuild: false, installReason: "Source release only. The 1.5.0 Mac v3 runtime includes per-game saves." }) };
}

const manager = createPinnedNativeManager({ id: "ai5", label: "AI5WIN", recommendedVersion: Portable.VERSION,
  projectBuilds: { projectId: "ai5", repository: "procrastinine/maclauncher-builds" },
  distributionRequired: false,
  sourceUrl: "https://github.com/nunuhara/ai5-sdl2/releases", buildSourcePath: Build.sourcePath,
  buildHelpUrl: "https://github.com/nunuhara/ai5-sdl2/tree/1.5.0#building",
  buildRequirements: "Development build: Meson, Ninja, pkg-config, SDL2/SDL2_ttf, libpng, libsndfile and FFmpeg. The complete Mac profile downloads automatically after consent.",
  buildRuntime: options => Build.buildRuntime(options), legacyInstalledRuntime: createBundledNativeRuntime({ managerId: "ai5" }),
  catalog: [{ version: CurrentPortable.VERSION, upstreamRevision: CurrentPortable.REVISION, sourceKind: "commit",
    sourceUrl: `https://github.com/nunuhara/ai5-sdl2/tree/${CurrentPortable.REVISION}`, versionLabel: "1.5.0 · Source snapshot ad7a703f · Mac v4",
    profile: CurrentPortable.PROFILE, movieSupport: "ffmpeg", audioBackend: "sndfile", hostArchitectures: ["arm64"], minimumMacOS: "13.0",
    sourceTreeSha256: CurrentPortable.SOURCE_SHA256, overlaySha256: CurrentPortable.overlayIdentity(), localBuild: false }, ...RELEASES.map(([version, revision]) => entry(version, revision, `https://github.com/nunuhara/ai5-sdl2/releases/tag/${version}`)),
    { version: Build.VERSION, upstreamRevision: Build.REVISION, upstreamTag: "1.5.0", versionLabel: "1.5.0 · Mac v2",
      sourceUrl: "https://github.com/nunuhara/ai5-sdl2/releases/tag/1.5.0", localBuild: false, profile: "macos-original-disc-v2", movieSupport: "ffmpeg", audioBackend: "sndfile" },
    { version: Build.LEGACY_VERSION, upstreamRevision: Build.REVISION, upstreamTag: "1.5.0", versionLabel: "1.5.0 · Mac v1",
      sourceUrl: "https://github.com/nunuhara/ai5-sdl2/releases/tag/1.5.0", localBuild: false, profile: "macos-private-saves-v1", movieSupport: "ffmpeg", audioBackend: "sndfile" }],
  discoverCatalog: createGithubReleaseDiscovery({ owner: "nunuhara", repo: "ai5-sdl2",
    mapRelease: async (release, { resolveRevision, sourceUrl }) => /^\d+\.\d+\.\d+$/.test(release.tag_name || "")
      ? entry(release.tag_name, await resolveRevision(release), sourceUrl) : null }),
  resolveExecutable: root => path.join(root, "bin", "ai5") });
manager.payloadPolicy = require("./payload-policy.json");
module.exports = manager;
