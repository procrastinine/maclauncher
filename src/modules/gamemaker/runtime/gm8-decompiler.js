const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { OPEN_GMK_REVISION } = require("./catalog");
const { createBundledNativeRuntime } = require("../../shared/runtime/bundled-native");
const { createGithubReleaseDiscovery } = require("../../shared/runtime/github-runtime-catalog");

async function mapRelease(release, { resolveRevision, sourceUrl }) {
  const version = release.tag_name.replace(/^v(?=\d)/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  return { version, toolVersion: version, upstreamTag: release.tag_name, upstreamRevision: await resolveRevision(release), backend: "cli", sourceUrl,
    license: "GPL-2.0-only", evidence: "historical-source-release", localBuild: false,
    installReason: "Windows executables only. A separate Mac version is available in Runtimes." };
}
const discoverCatalog = createGithubReleaseDiscovery({ owner: "OpenGMK", repo: "GM8Decompiler", mapRelease });

const manager = createPinnedNativeManager({ id: "gm8-decompiler", label: "GM8Decompiler (Classic)", supportsDefault: true, catalog: [
  { version: "2.2.0-9ccc47a9", upstreamRevision: OPEN_GMK_REVISION, backend: "cli",
    sourceArtifact: { directoryRelative: "gm8-decompiler/2.2.0-9ccc47a9-source.tar.gz",
      sha256: "91be3a309db481f6f069a9ac0021c113d8485ab54d7ac72cbc0330aa7e338270", bytes: 8570093 },
    sourceKind: "commit", sourceUrl: `https://github.com/OpenGMK/OpenGMK/tree/${OPEN_GMK_REVISION}`,
    license: "GPL-2.0-only", evidence: "native-arm64-build-only" }
], recommendedVersion: "2.2.0-9ccc47a9", discoverCatalog, sourceUrl: "https://github.com/OpenGMK/GM8Decompiler/releases",
  projectBuilds: { projectId: "gm8-decompiler", repository: "procrastinine/maclauncher-builds" },
  distributionRequired: false,
  legacyInstalledRuntime: createBundledNativeRuntime({ managerId: "gm8-decompiler" }) });

module.exports = { manager, mapRelease, discoverCatalog };
