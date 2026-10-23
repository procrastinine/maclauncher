const BUTTERSCOTCH_REVISION = "d66464857303a2840a5cc5141c0035440847f441";
const BUTTERSCOTCH_ARGUMENTS_VERSION = "MCLv1-1007";
const OPEN_GMK_REVISION = "9ccc47a9cab4681a889866f7233a6b016d36a15e";
const UMT_REVISION = "03c7048438347799e0717b6e57a9358d000472e0";

const BUTTERSCOTCH_BUILDS = Object.freeze([
  Object.freeze({ version: "d66464857303-appkit", upstreamRevision: BUTTERSCOTCH_REVISION,
    sourceKind: "commit", backend: "appkit", renderer: "legacy-opengl", videoBackend: "none", license: "AGPL-3.0-only",
    minimumMacOS: "13.0",
    sourceArtifact: { directoryRelative: "butterscotch/d66464857303-appkit-source.tar.gz",
      sha256: "1c38099963ecebb1b285f95c9fa45c5580cb3e582ef37983952d7b42ceabc306", bytes: 5908005 },
    evidence: "native-arm64-build-and-four-fixture-boots", wadVersions: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17] }),
  Object.freeze({ version: BUTTERSCOTCH_ARGUMENTS_VERSION, upstreamRevision: BUTTERSCOTCH_REVISION,
    sourceKind: "commit", backend: "appkit", renderer: "legacy-opengl", videoBackend: "none", license: "AGPL-3.0-only",
    minimumMacOS: "13.0", gameArguments: "repeat-game-arg-v1",
    sourceArtifact: { directoryRelative: "butterscotch/d66464857303-appkit-args-v1-source.tar.gz",
      sha256: "c77014ab4120e8be3425b4f879333a7217931d84ce5c3c81d19af90d42049112", bytes: 5973455 },
    wadVersions: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17] })
]);

const UMT_BUILDS = Object.freeze([
  Object.freeze({ version: "0.9.2.0-arm64", cliVersion: "0.9.2.0", upstreamRevision: UMT_REVISION,
    backend: "cli", architecture: "arm64", license: "GPL-3.0-only", evidence: "native-arm64-decompilation",
    asset: Object.freeze({
      url: "https://github.com/UnderminersTeam/UndertaleModTool/releases/download/0.9.2.0/UTMT_CLI_v0.9.2.0-macOS.zip",
      filename: "UTMT_CLI_v0.9.2.0-macOS.zip", sha256: "03042fa77f93e9b7fcb06592b77fb8369876e6d6fff7680a63dc0fa2df5444ef"
    }) }),
  Object.freeze({ version: "0.9.2.0-x86_64", cliVersion: "0.9.2.0", upstreamRevision: UMT_REVISION,
    backend: "cli", architecture: "x86_64", license: "GPL-3.0-only", evidence: "upstream-artifact-only",
    asset: Object.freeze({
      url: "https://github.com/UnderminersTeam/UndertaleModTool/releases/download/0.9.2.0/UTMT_CLI_v0.9.2.0-macOS-x86.zip",
      filename: "UTMT_CLI_v0.9.2.0-macOS-x86.zip", sha256: "8c210151736d828a6fa47bcf86e1365c20d1f2d587a0341274490e6026c09ee6"
    }) })
]);

module.exports = { BUTTERSCOTCH_REVISION, BUTTERSCOTCH_ARGUMENTS_VERSION, OPEN_GMK_REVISION, UMT_REVISION, BUTTERSCOTCH_BUILDS, UMT_BUILDS };
