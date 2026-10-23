const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");
const Graphics = require("./legacy-build");
const Catalog = require("./catalog");
const Download = require("./download");

// HashLink's bytecode JIT is Intel-only. A genuine x64 package can serve Apple
// Silicon through Rosetta without relabeling its executable as native ARM.
const intelBundle = createBundledNativeRuntime({ managerId: "hashlink", arch: "x64" });
const bundledRuntime = { ...intelBundle, resolve: options => intelBundle.resolve({ ...options, arch: "x64" }) };

const RELEASES = [["1.16", "c3f2a1563cf7aa9f4076b0808a7eaf40e18e8f14"],
  ["1.15", "742581569d4052babac359658e443e42c7c3e0c7"], ["1.14", "03110f7e11fb76acf13312864b1d0bb700a6eda4"],
  ["1.12", "68daa125ad115a1f1d1db65d38e6045858d55013"], ["1.9", "4a4cfe91f3388a0b05bf2e45e7c4e38bae686dc6"]];
const { sourceEntry } = Catalog;
const discoverCatalog = Catalog.createDiscovery();

function createManager(dependencies = {}) { return createPinnedNativeManager({ id: "hashlink", label: "HashLink", discoverCatalog: Catalog.createDiscovery(dependencies), bundledRuntime,
  projectBuilds: { projectId: "hashlink", repository: "procrastinine/maclauncher-builds" },
  bundledExecution: "direct", distributionRequired: true, importLocal: true,
  recommendedVersion: Catalog.SNAPSHOT_VERSION,
  sourceUrl: "https://github.com/HaxeFoundation/hashlink/releases",
  buildSourcePath: path.resolve(__dirname, "../../../external/hashlink"),
  buildHelpUrl: "https://github.com/HaxeFoundation/hashlink/blob/1.16/README.md",
  buildRuntime: ({ userDataDir, version, sourceDir, logger, signal, onProgress }) =>
    require("./build").buildRuntime({ userDataDir, version, sourcePath: sourceDir, logger, signal, onProgress }),
  catalog: [Catalog.SNAPSHOT, ...RELEASES.map(([version, revision]) => sourceEntry(version, revision, `https://github.com/HaxeFoundation/hashlink/releases/tag/${version}`)),
    { ...sourceEntry(Graphics.UPSTREAM_VERSION, Graphics.REVISION, `https://github.com/HaxeFoundation/hashlink/releases/tag/${Graphics.UPSTREAM_VERSION}`),
      version: Graphics.VERSION, versionLabel: "1.9 · Mac graphics v2", upstreamVersion: Graphics.UPSTREAM_VERSION,
      minimumMacOS: "13.0", hostArchitectures: ["arm64", "x64"],
      primitiveProfileId: "typed-1.9-macos-v2", primitiveProfileSha256: "a22d96b6fea6dd8b9031489a1c0d89c091ff8c6ee9a090d2f95795ac30790296",
      sourceArtifact: { directoryRelative: "hashlink/1.9-macos-v2-source.tar.gz",
        sha256: "7a1b7b40995534903611887022b681f75d83edec0bef38844e287b0484cebbd5", bytes: 13117194 },
      localBuild: true, macPackageVersion: Graphics.VERSION, compilerPathMapProfile: "maclauncher-logical-roots-v2",
      installReason: "Intel HashLink 1.9 with typed SDL Event ABI and SDL2/OpenAL. Apple Silicon requires Rosetta." },
    { ...sourceEntry("1.12", "68daa125ad115a1f1d1db65d38e6045858d55013", "https://github.com/HaxeFoundation/hashlink/releases/tag/1.12"),
      version: "1.12-macos-v1", versionLabel: "1.12 · Mac graphics v1", upstreamVersion: "1.12", minimumMacOS: "13.0",
      hostArchitectures: ["arm64", "x64"],
      primitiveProfileId: "legacy-dynamic-1.12-macos-v1", primitiveProfileSha256: "8ffb3f20d0356494fb853c36a7d35339fa19cd5e50c7cd2df6fbe7324f3f7301",
      sourceTreeSha256: "54fb884acca4c47ebeb79834453144d123290e123ed2f9c87f44c2a4b130617e",
      overlaySha256: "1157d5aceaddc5586a40550dff629d1435e7f15d14db920758d013bbe7258a44",
      additionalSources: [
        { id: "sdl2", upstreamRevision: "53dea9830964eee8b5c2a7ee0a65d6e268dc78a1", sourceTreeSha256: "fc793003760383bcfe9dd9d259a5e1b2018952a1956dd8e4d78ac236f01e646e" },
        { id: "openal-soft", upstreamRevision: "dc7d7054a5b4f3bec1dc23a42fd616a0847af948", sourceTreeSha256: "e9ce670b33526670a5bdc5592b20332aa8edfb0f519bd9c81e71b5cc33a64b96" },
      ],
      sourceArtifact: { directoryRelative: "hashlink/1.12-macos-v1-source.tar.gz", sha256: "4298cc441fc3ff096602792b289afdea2af153d43b48a19f1482551ee3cd42ff", bytes: 13152771 },
      localBuild: true, macPackageVersion: "1.12-macos-v1", compilerPathMapProfile: "maclauncher-logical-roots-v2",
      installReason: "Intel HashLink 1.12 with legacy fmt primitives, dynamic SDL events and OpenAL effects. Apple Silicon requires Rosetta." },
    // Validate existing copies of this removed artifact without offering it.
    { version: "snapshot-3b7bd74", upstreamRevision: "3b7bd74aa316583e4b7a48859d6ec3a07a24e5f7", deprecated: true,
    architecture: "x86_64", requiresRosettaOnArm: true, supportedBytecodeVersions: [2, 3, 4, 5, 6], nativeAbi: { sdlEventLoop: "dynamic" },
    installReason: "This historical development artifact was removed upstream. Choose a real published HashLink release.",
    asset: { filename: "hashlink-3b7bd74-darwin-cmake.tar.gz",
      url: "https://github.com/HaxeFoundation/hashlink/releases/download/latest/hashlink-3b7bd74-darwin-cmake.tar.gz",
      sha256: "e3a7f1ee1fd28df9f3f61d366bcac98f2468eed1e453005b3123b48d61e3fcca" } }],
  resolveExecutable: Download.resolveExecutable,
  prepareInstall: options => Download.prepareInstall(options, dependencies), dependencies }); }
const manager = createManager();
// Stock complete builds are managed downloads; only the adapted typed-ABI
// runtime needs an included fallback.
manager.distributionVersions = [Graphics.VERSION, "1.12-macos-v1"];
manager.distributionArchitectures = { arm64: ["x64"], x64: ["x64"] };
manager.createManager = createManager;
manager.discoverCatalog = discoverCatalog;
module.exports = manager;
