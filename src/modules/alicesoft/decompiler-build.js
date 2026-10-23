const fs = require("node:fs");
const path = require("node:path");
const { buildPinnedRuntime } = require("../shared/runtime/pinned-native-build");
const Native = require("../shared/runtime/local-native");
const profiles = require("./decompiler-profiles.json");

const OVERLAY_REVISION = "alicesoft-decompiler-cmake-v1";
const templatePath = path.join(__dirname, "overlays/decompiler-cmake-v1.cmake");

async function buildManagedDecompiler({ manager, version, sourceDir, userDataDir, logger, signal, onProgress, dependencies }) {
  const profile = profiles.find(row => row.managerId === manager.id);
  if (!profile || version !== profile.version) throw new Error("No Mac build is available for this decompiler source version.");
  const installDir = manager.core.getInstallDir({ userDataDir, version });
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  const mappings = [[installDir, `maclauncher-build/${manager.id}/${version}`], [path.join(installDir, "build-source"), `src/external/${profile.repo}`]];
  const flags = mappings.flatMap(([from, to]) => ["file", "debug", "macro"].map(kind => `-f${kind}-prefix-map=${quote(from + "=" + to)}`)).join(" ");
  return buildPinnedRuntime({ manager, version, sourceDir: sourceDir || path.resolve(__dirname, "../../external", profile.repo), userDataDir,
    context: { logger }, signal, onProgress, dependencies,
    cmakeOptions: [`-DMACLAUNCHER_TOOL=${profile.executable}`,
      `-DMACLAUNCHER_TOOL_VERSION=${profile.releases.find(release => release.version === version).toolVersion || version}`,
      `-DCMAKE_C_FLAGS=${flags}`],
    prepareSource: ({ sourceRoot, revision }) => {
      if (revision !== profile.upstreamRevision) throw new Error("The decompiler source revision does not match the selected version.");
      const output = path.join(sourceRoot, "CMakeLists.txt");
      fs.writeFileSync(output, fs.readFileSync(templatePath), { flag: "wx" });
      return { revision: OVERLAY_REVISION, upstreamRevision: revision, sha256: Native.hashFile(templatePath),
        generatedFile: "CMakeLists.txt", target: profile.executable, operations: ["compile only unchanged pinned decompiler/common C sources"] };
    },
    resolveExecutable: root => path.join(root, profile.executable)
  });
}

module.exports = { OVERLAY_REVISION, templatePath, buildManagedDecompiler };
