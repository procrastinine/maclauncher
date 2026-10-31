const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const Upstream = require("../../shared/runtime/upstream");
const { locatePackaged } = require("../../shared/runtime/release-files");
const MachO = require("../../shared/runtime/macho-load-commands");
const { systemVersionSync, versionAtLeast } = require("../../shared/runtime/bundled-native");
const { isMacName } = require("../../shared/runtime/archive");
const exec = promisify(execFile);
const SOURCE = "https://github.com/SamboyCoding/Cpp2IL/actions/workflows/dotnet-core.yml";

// Artifacts are named like Cpp2IL-net9-osx-arm64. A later .NET version, Mac
// word or a universal build is read the same way.
const upstream = Upstream.githubActions({ repository: "SamboyCoding/Cpp2IL", workflow: "dotnet-core.yml", branch: "development", limit: 1, maxRuns: 5,
  recognize: (artifact, { run }) => {
    const name = String(artifact.name || ""), architecture = require("../../shared/runtime/architecture").assetArchitecture(name);
    if (!/^Cpp2IL(?:[._-]|$)/i.test(name) || !isMacName(name) || !architecture || /(?:^|[._-])(?:debug|symbols?|pdb)(?:[._-]|$)/i.test(name)) return null;
    return { version: `${run.created_at.slice(0, 10)}-${run.head_sha.slice(0, 12)}-${artifact.id}`,
      label: `${run.created_at.slice(0, 10)} · ${run.head_sha.slice(0, 12)}`, architecture, details: { sourceKind: "commit" } };
  } });

// The standalone tool is the archive's Cpp2IL file, at any folder depth.
const executable = root => locatePackaged(root, "Cpp2IL", { files: true }) || path.join(root, "Cpp2IL");

async function prepareInstall({ unpacked, signal, pin }, dependencies = {}) {
  const Architecture = require("../../shared/runtime/architecture");
  const architecture = Architecture.targetArchitecture(pin?.architecture) || dependencies.architecture || Architecture.selectedArchitecture();
  const file = executable(unpacked);
  const image = MachO.readMachOLoadCommands(file, { architecture });
  const minimumMacOS = image.slices[0].minimumMacOS;
  if (!versionAtLeast((dependencies.systemVersionSync || systemVersionSync)(), minimumMacOS))
    throw new Error(`Cpp2IL requires macOS ${minimumMacOS} or later.`);
  fs.chmodSync(file, 0o755);
  // Upstream's self-contained executable needs a local signature on macOS.
  const run = dependencies.run || exec;
  await run("/usr/bin/codesign", ["--force", "--sign", "-", file], { signal });
  await run("/usr/bin/codesign", ["--verify", "--strict", file], { signal });
}

function createManager({ dependencies = {} } = {}) {
  const core = createPinnedNativeManager({ id: "cpp2il", label: "Cpp2IL", supportsDefault: true,
    sourceUrl: SOURCE, upstream, resolveExecutable: executable,
    prepareInstall: options => prepareInstall(options, dependencies), dependencies });
  return { ...core,
    ui: { groupId: "tools", tabLabel: "Tools", sectionLabel: "Cpp2IL", order: 200, memberOrder: 220, management: "managed" },
    getState: options => {
      const state = core.getState(options);
      const catalog = { ...state.catalog, installReason: state.catalog.versions.length ? state.catalog.installReason
        : "Refresh versions or start IL2CPP decompilation to download Cpp2IL." };
      return { ...state, catalog, sections: [{ ...state.sections[0], label: "Cpp2IL", catalog }] };
    },
    __test: { createManager, upstream, executable, prepareInstall }
  };
}
module.exports = createManager();
