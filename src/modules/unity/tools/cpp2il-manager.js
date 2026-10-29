const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createGithubActionsDiscovery } = require("../../shared/runtime/github-actions-catalog");
const { readZipEntries, readZipEntryBuffer } = require("../../shared/runtime/zip");
const MachO = require("../../shared/runtime/macho-load-commands");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const { systemVersionSync, versionAtLeast } = require("../../shared/runtime/bundled-native");
const exec = promisify(execFile);
const SOURCE = "https://github.com/SamboyCoding/Cpp2IL/actions/workflows/dotnet-core.yml";

function mapArtifact(artifact, { run, sourceUrl, githubAssetDigest, nightlyArtifactUrl }) {
  if (!/^Cpp2IL-net(?:9|10)-osx-arm64$/.test(artifact.name) || artifact.size_in_bytes > 128 * 1024 * 1024) return null;
  return { version: `${run.created_at.slice(0, 10)}-${run.head_sha.slice(0, 12)}-${artifact.id}`,
    versionLabel: `${run.created_at.slice(0, 10)} · ${run.head_sha.slice(0, 12)}`,
    upstreamRevision: run.head_sha, sourceKind: "commit", sourceUrl, hostArchitectures: ["arm64"], localBuild: false,
    asset: { filename: `${artifact.name}-${artifact.id}.zip`, url: nightlyArtifactUrl(),
      sha256: githubAssetDigest(artifact), bytes: artifact.size_in_bytes, expiresAt: artifact.expires_at } };
}

function extractArchive(archive, destination, signal) {
  throwIfAborted(signal);
  const entries = readZipEntries(archive)?.entries;
  if (!entries || entries.length !== 1 || entries[0].name !== "Cpp2IL" ||
    entries[0].uncompressedSize > 256 * 1024 * 1024) throw new Error("Cpp2IL archive does not contain its standalone macOS tool.");
  fs.writeFileSync(path.join(destination, "Cpp2IL"), readZipEntryBuffer(archive, "Cpp2IL"), { mode: 0o755 });
}

async function prepareInstall({ unpacked, signal }, dependencies = {}) {
  const file = path.join(unpacked, "Cpp2IL");
  const image = MachO.readMachOLoadCommands(file, { architecture: "arm64" });
  MachO.assertSystemLibraryClosure(image, { fileType: 2 });
  const minimumMacOS = image.slices[0].minimumMacOS;
  if (!versionAtLeast((dependencies.systemVersionSync || systemVersionSync)(), minimumMacOS))
    throw new Error(`Cpp2IL requires macOS ${minimumMacOS} or later.`);
  fs.chmodSync(file, 0o755);
  // Upstream's self-contained ARM executable needs a local signature on macOS.
  const run = dependencies.run || exec;
  await run("/usr/bin/codesign", ["--force", "--sign", "-", file], { signal });
  await run("/usr/bin/codesign", ["--verify", "--strict", file], { signal });
}

function createManager({ dependencies = {} } = {}) {
  const discoverCatalog = createGithubActionsDiscovery({ owner: "SamboyCoding", repo: "Cpp2IL",
    workflow: "dotnet-core.yml", branch: "development", limit: 1, maxRuns: 5, mapArtifact, dependencies });
  const core = createPinnedNativeManager({ id: "cpp2il", label: "Cpp2IL", catalog: [], supportsDefault: true,
    sourceUrl: SOURCE, discoverCatalog, resolveExecutable: root => path.join(root, "Cpp2IL"),
    prepareInstall: options => prepareInstall(options, dependencies),
    dependencies: { ...dependencies, extractArchive: dependencies.extractArchive || extractArchive } });
  return { ...core,
    ui: { groupId: "tools", tabLabel: "Tools", sectionLabel: "Cpp2IL", order: 200, memberOrder: 220, management: "managed" },
    getState: options => {
      const state = core.getState(options);
      const catalog = { ...state.catalog, installReason: state.catalog.versions.length ? state.catalog.installReason
        : "Refresh versions or start IL2CPP decompilation to download Cpp2IL." };
      return { ...state, catalog, sections: [{ ...state.sections[0], label: "Cpp2IL", catalog }] };
    },
    __test: { createManager, mapArtifact, extractArchive, prepareInstall }
  };
}
module.exports = createManager();
