const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const Upstream = require("../../shared/runtime/upstream");
const { readMachOLoadCommands } = require("../../shared/runtime/macho-load-commands");
const { hashFile } = require("../../shared/runtime/pinned-native-manager");
const { macDownloads, locatePackaged } = require("../../shared/runtime/release-files");
const run = promisify(execFile);
const CURRENT = ["butterscotch-appkit-macos-arm64", "butterscotch-appkit-macos-x86_64"];
// One row per CPU an artifact serves; its file, size and digest are GitHub's.
function artifactRow(artifact, { run: workflowRun }, host) {
  const architecture = host === "x64" ? "x86_64" : "arm64";
  const date = workflowRun.created_at.slice(0, 10), revision = workflowRun.head_sha.toLowerCase();
  // Builds of one day differ by their UTC start time; the commit stays in the version.
  return { version: `${date}-${revision.slice(0, 12)}-appkit-${host}-${artifact.id}`,
    label: `${date} ${workflowRun.created_at.slice(11, 16)} UTC (nightly${architecture === "arm64" ? "" : ", Intel"})`,
    publishedAt: artifact.created_at, channel: "nightly", architecture,
    details: { sourceKind: "commit", hostArchitectures: [host], backend: "appkit", renderer: "legacy-opengl", videoBackend: "upstream-default",
      license: "AGPL-3.0-only", localBuild: false, wadVersions: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
      workflow: { id: workflowRun.id, event: "push", branch: "main", artifactName: artifact.name, artifactId: artifact.id } } };
}
// Each run publishes one AppKit artifact per CPU. A renamed Mac artifact is
// used as well; one without a CPU word serves each CPU without its own
// artifact, and installation reads the CPU from the executable.
function artifactHosts(artifact, artifacts = [artifact]) {
  const named = artifacts.filter(item => /butterscotch/i.test(item?.name || "")).map(item => ({ ...item, name: `${item.name}.zip`, artifact: item }));
  const selected = macDownloads(named, { preferred: CURRENT.map(name => `${name}.zip`) });
  const dedicated = new Set(selected.map(item => item.architecture).filter(value => value === "arm64" || value === "x64"));
  const match = selected.find(item => item.asset.artifact.id === artifact.id);
  if (!match) return [];
  return match.architecture === "arm64" || match.architecture === "x64" ? [match.architecture] : ["arm64", "x64"].filter(host => !dedicated.has(host));
}

// Nightly AppKit builds from the build.yml workflow, every CPU in one list;
// Reload lists the newest successful run and All versions the last five.
const source = Upstream.githubActions({ repository: "ButterscotchRunner/Butterscotch", workflow: "build.yml", limit: 1, maxRuns: 5, allArchitectures: true,
  recognize: (artifact, context) => artifactHosts(artifact, context.artifacts).map(host => artifactRow(artifact, context, host)) });

// The archive holds the butterscotch executable; a later layout may place it
// in a folder next to other files.
function resolveExecutable(root) {
  const file = locatePackaged(root, "butterscotch") || path.join(root, "butterscotch");
  if (!fs.lstatSync(file).isFile()) throw new Error("The Butterscotch archive has no native runner.");
  return file;
}
// Libraries the executable loads that are neither part of macOS nor present
// in the package. A build that bundles its libraries runs as it is.
function missingLibraries(slice, executable) {
  const directory = path.dirname(executable);
  const expand = value => value.replace(/^@(?:executable|loader)_path(?=\/|$)/, directory);
  const candidates = value => value.startsWith("@rpath/")
    ? slice.runPaths.map(root => path.join(expand(root), value.slice("@rpath/".length))) : [expand(value)];
  return slice.dependencies.filter(library => library.kind !== "weak" && !/^\/(?:usr\/lib|System\/Library)\//.test(library.path) &&
    !candidates(library.path).some(file => fs.existsSync(file))).map(library => library.path);
}
// The executable's own Mach-O commands give its CPU and macOS floor, and its
// help output confirms the launch options MacLauncher passes.
async function prepareInstall({ unpacked, pin, signal }, dependencies = {}) {
  const executable = resolveExecutable(unpacked);
  const native = readMachOLoadCommands(executable, { signal });
  const slice = native.slices.find(item => item.architecture === pin.architecture);
  if (!slice) throw new Error("The Butterscotch archive has a different CPU architecture.");
  const missing = missingLibraries(slice, executable);
  if (missing.length) throw new Error(`This Butterscotch build needs a library it does not include: ${missing[0]}.`);
  await (dependencies.run || run)("/usr/bin/codesign", ["--force", "--sign", "-", executable], { signal, timeout: 30000, maxBuffer: 1024 * 1024 });
  await (dependencies.run || run)("/usr/bin/codesign", ["--verify", "--strict", executable], { signal, timeout: 30000, maxBuffer: 1024 * 1024 });
  const help = await (dependencies.run || run)(executable, ["--help"], { signal, timeout: 10000, maxBuffer: 1024 * 1024, cwd: path.dirname(executable) });
  const usage = `${help.stdout || ""}\n${help.stderr || ""}`;
  if (!/--save-folder\b/.test(usage) || !/--renderer\b/.test(usage)) throw new Error("This Butterscotch build has incompatible launch options.");
  return { schemaVersion: 1, architecture: pin.architecture, ...(slice.minimumMacOS ? { minimumMacOS: slice.minimumMacOS } : {}),
    executableSha256: hashFile(executable), workflow: pin.workflow, versionFlagAvailable: /--version\b/.test(usage) };
}

module.exports = { source, artifactRow, artifactHosts, missingLibraries, resolveExecutable, prepareInstall };
