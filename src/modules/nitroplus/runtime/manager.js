const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");
const Github = require("../../shared/runtime/github-releases");
const Build = require("./build");
const Portable = require("./portable-build");

const TAGS = [
  ["0.5.3", "cd4da42390476bef1e25eaf3081f2055fc2fb4db"], ["0.5.2", "bf5fb807f3b7ca29e11b338a5f7780c0e01ddf3b"],
  ["0.5.1", "b95e47b77b7f558364de07602acffdde97706141"], ["0.5.0", "46d0d95ff13c6b52d4693c450888de955a37ddee"],
  ["0.4.0", "6426c736515eb03ca9c3393341e9be435cb70123"], ["0.3.5", "bfc95f7d7cc33bf2562fc799ce2d5b33e8a2c07d"],
  ["0.3.4", "233adde93277b995e3b552306f2ac8bd1d5088f4"], ["0.3.3", "342093a013bd7a051d541b98ccc1ee4f4959a281"],
  ["0.3.2", "bbe38fcfa1c3d1182da3f01d7ff9ed97218656d3"], ["0.3.1", "970ec5c686c0bbecbf6b2d1451475e339de58d8a"],
  ["0.3.0a", "30636d28a8b2fc8826fde9e28aec473aa76eddc2"], ["0.3.0", "9f6014119068f28d2765d375093268bed8a84794"],
  ["0.2.0", "92fa16b01c8f5f2994faabbaa020560029d209d2"], ["0.1.5", "fa756aa26fc8afb33d8b24ff4163ff512a894f99"],
  ["0.1.4", "e7984c3b01efbc8adc129d9de21ded48815ca700"], ["0.1.3", "0200c1f9d66d75be74c9a6ad65f5bb12913b4238"],
  ["0.1.2", "5adfe6a7ad72d823ca672cff100201763c71c40e"], ["0.1.1a", "3c416b575af835bb555e1a1a2318322ab8268513"],
  ["0.1.1", "489a5d2573ca8a0de85bdb0cb5d294300c63fafb"], ["0.1.0", "cc56a7a6b30531052fc17775789f7e79802354b2"],
  ["0.0.5", "e7f354f87899a4a7a3b886a0e47fda27bff0ec5d"], ["0.0.4", "0295f722fbf3feb2d13cca2072b2766021e450e0"],
  ["0.0.3", "1edc20d471e57f98ea377e5af2ffd747a1fe7912"], ["0.0.2", "59531793ab7b0381a44b1d3164a89bd516fc61fd"],
  ["0.0.1", "f0a43a456fa307146079337ad4c8c165b5a4adf8"]
];
const historical = (version, revision, tag = `v${version}`) => ({ version, upstreamRevision: revision, upstreamTag: tag,
  sourceUrl: `https://github.com/FGRE/libnpengine/tree/${encodeURIComponent(tag)}`, localBuild: false,
  installReason: "Source release only. The 0.5.3 Mac v8 runtime supports NPA/NSS and per-game saves." });

const manager = createPinnedNativeManager({ id: "npengine", label: "Nitroplus", recommendedVersion: Portable.VERSION,
  projectBuilds: { projectId: "npengine", repository: "procrastinine/maclauncher-builds" },
  bundledExecution: "direct",
  sourceUrl: "https://github.com/FGRE/libnpengine/tags", buildSourcePath: Build.sourcePath,
  buildHelpUrl: "https://github.com/FGRE/libnpengine", buildRequirements: "Source builds require CMake, Ninja, pkg-config, Boost, Flex, Bison, SDL2, GLEW, Pango, GStreamer, JPEG, PNG and zlib.",
  buildRuntime: options => Build.buildRuntime(options), bundledRuntime: createBundledNativeRuntime({ managerId: "npengine" }),
  resolveExecutable: root => path.join(root, "bin/npengine-runner"),
  catalog: [{ version: Portable.VERSION, versionLabel: "0.5.3 · Mac v8", upstreamRevision: Portable.REVISION,
    npaRevision: Portable.NPA_REVISION, sourceKind: "commit", sourceUrl: `https://github.com/FGRE/libnpengine/commit/${Portable.REVISION}`,
    localBuild: false, profile: Portable.PROFILE_REVISION, minimumMacOS: "13.0", hostArchitectures: ["arm64"],
    sourceTreeSha256: Portable.ENGINE_TREE_SHA256, overlaySha256: Portable.overlayIdentity(),
    additionalSources: [{ id: "libnpa", upstreamRevision: Portable.NPA_REVISION, sourceTreeSha256: Portable.NPA_TREE_SHA256 }],
    sourcePackageVersion: "0.5.3-macos-v8-source-package3",
    sourceArtifact: { directoryRelative: "npengine/0.5.3-macos-v8-source.tar.gz", bytes: 226714584,
      sha256: "6a3856bfa4aaa957529944c34c168cf110dd7b60a2752f159b90e2f2589e3e36" } },
    { version: Build.VERSION, versionLabel: "0.5.3 · Mac v7", upstreamRevision: Build.REVISION,
    npaRevision: Build.NPA_REVISION, sourceKind: "commit", sourceUrl: `https://github.com/FGRE/libnpengine/commit/${Build.REVISION}`,
    localBuild: true, profile: Build.PROFILE_REVISION },
    { version: Build.PREVIOUS_VERSION, versionLabel: "0.5.3 · Mac v6", upstreamRevision: Build.REVISION,
      npaRevision: Build.NPA_REVISION, sourceKind: "commit", sourceUrl: `https://github.com/FGRE/libnpengine/commit/${Build.REVISION}`,
      localBuild: false, profile: "macos-npa-nss-private-v6", installReason: "Older Mac version; existing v6 installations remain available." },
    { version: Build.V5_VERSION, versionLabel: "0.5.3 · Mac v5", upstreamRevision: Build.REVISION,
      npaRevision: Build.NPA_REVISION, sourceKind: "commit", sourceUrl: `https://github.com/FGRE/libnpengine/commit/${Build.REVISION}`,
      localBuild: false, profile: "macos-npa-nss-private-v5", installReason: "Older Mac version; existing v5 installations remain available." },
    { version: Build.V4_VERSION, versionLabel: "0.5.3 · Mac v4", upstreamRevision: Build.REVISION,
      npaRevision: Build.NPA_REVISION, sourceKind: "commit", sourceUrl: `https://github.com/FGRE/libnpengine/commit/${Build.REVISION}`,
      localBuild: false, profile: "macos-npa-nss-private-v4", installReason: "Older Mac version; existing v4 installations remain available." },
    { version: Build.V3_VERSION, versionLabel: "0.5.3 · Mac v3", upstreamRevision: Build.REVISION,
      npaRevision: Build.NPA_REVISION, sourceKind: "commit", sourceUrl: `https://github.com/FGRE/libnpengine/commit/${Build.REVISION}`,
      localBuild: false, profile: "macos-npa-nss-private-v3", installReason: "Older Mac version; existing v3 installations remain available." },
    { version: Build.V2_VERSION, versionLabel: "0.5.3 · Mac v2", upstreamRevision: Build.REVISION,
      npaRevision: Build.NPA_REVISION, sourceKind: "commit", sourceUrl: `https://github.com/FGRE/libnpengine/commit/${Build.REVISION}`,
      localBuild: false, profile: "macos-npa-nss-private-v2", installReason: "Older Mac version; existing v2 installations remain available." },
    { version: Build.LEGACY_VERSION, versionLabel: "0.5.3 · Mac v1", upstreamRevision: Build.REVISION,
      npaRevision: Build.NPA_REVISION, sourceKind: "commit", sourceUrl: `https://github.com/FGRE/libnpengine/commit/${Build.REVISION}`,
      localBuild: false, profile: "macos-npa-nss-private-v1", installReason: "Older Mac version; existing v1 installations remain available. New installations use Mac v8." },
    ...TAGS.map(([version, revision]) => historical(version, revision))],
  // Upstream publishes source tags, with no Mac runtime assets. The shared
  // provider supplies the complete paginated tag history on explicit refresh.
  discoverCatalog: async ({ signal }) => (await Github.fetchGithubTags({ owner: "FGRE", repo: "libnpengine", signal }))
    .filter(tag => /^v?\d+\.\d+\.\d+[a-z]?$/.test(tag.name || ""))
    .map(tag => historical(tag.name.replace(/^v/, ""), tag.commit.sha, tag.name)) });
manager.distributionRequired = true;
manager.distributionVersions = [Portable.VERSION];
manager.distributionArchitectures = { arm64: ["arm64"], x64: [] };
module.exports = manager;
