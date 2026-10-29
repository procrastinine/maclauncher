const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createGithubActionsDiscovery } = require("../../shared/runtime/github-actions-catalog");
const { fetchUrlBuffer, throwIfAborted } = require("../../shared/runtime/download-utils");
const { readMachOLoadCommands, assertSystemLibraryClosure } = require("../../shared/runtime/macho-load-commands");
const { hashFile } = require("../../shared/runtime/pinned-native-manager");
const { versionAtLeast } = require("../../shared/runtime/bundled-native");
const run = promisify(execFile);
function artifactEntry(artifact, { run: workflowRun, sourceUrl, githubAssetDigest, nightlyArtifactUrl }, profile) {
  const architecture = artifact.name.endsWith("arm64") ? "arm64" : "x86_64";
  const host = architecture === "x86_64" ? "x64" : "arm64";
  const date = workflowRun.created_at.slice(0, 10), revision = workflowRun.head_sha.toLowerCase();
  return { ...profile, version: `${date}-${revision.slice(0, 12)}-appkit-${host}-${artifact.id}`,
    versionLabel: `${date} · ${revision.slice(0, 12)} (AppKit nightly, ${architecture === "arm64" ? "ARM" : "Intel"})`,
    upstreamRevision: revision, sourceKind: "commit", sourceUrl, publishedAt: artifact.created_at,
    architecture, hostArchitectures: [host], backend: "appkit", renderer: "legacy-opengl", videoBackend: "upstream-default",
    license: "AGPL-3.0-only", localBuild: false, wadVersions: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
    workflow: { id: workflowRun.id, event: "push", branch: "main", artifactName: artifact.name, artifactId: artifact.id },
    installReason: `Public AppKit nightly; macOS ${profile.minimumMacOS} or later.`,
    asset: { url: nightlyArtifactUrl(), filename: `${artifact.name}-${artifact.id}.zip`, sha256: githubAssetDigest(artifact),
      assetId: artifact.id, expiresAt: artifact.expires_at, integritySource: "publisher-sha256" } };
}

function parseSourceProfile({ args, entry, cmake, workflow }, architecture) {
  const option = name => new RegExp(`\\{\\s*"${name}"\\s*,\\s*required_argument\\s*,`).test(args);
  const job = /\n  build-appkit-macos:[\s\S]*?(?=\n  [A-Za-z0-9_-]+:|$)/.exec("\n" + workflow)?.[0];
  const label = architecture === "x64" ? "x86_64" : "arm64";
  const target = new RegExp(`- label: ${label}\\s+runner: macos-(\\d+)(?:-intel)?(?:\\s|$)`).exec(job || "")?.[1];
  const explicitFloor = /-DCMAKE_OSX_DEPLOYMENT_TARGET=(\d+\.\d+(?:\.\d+)?)(?:\s|\\)/.exec(job || "")?.[1];
  if (!option("save-folder") || !option("renderer") || !/"legacy-gl"/.test(args) || !/case 'H':\s*printUsage\(argv\[0\]\);\s*exit\(0\);/.test(args) ||
    !/parseCommandLineArgs\(&args, argc, argv\);/.test(entry) || !target || !/-DBACKEND=appkit(?:\s|\\)/.test(job) ||
    !["14", "16", "17"].every(version => new RegExp(`option\\(ENABLE_WAD${version}\\s+"[^"]+"\\s+ON\\)`).test(cmake)) ||
    !/option\(ENABLE_LEGACY_GL\s+"[^"]+"\s+ON\)/.test(cmake) || /-DENABLE_(?:WAD14|WAD16|WAD17|LEGACY_GL)=OFF/.test(job))
    throw new Error("This Butterscotch build has an unsupported AppKit or command-line profile.");
  const digest = value => crypto.createHash("sha256").update(value).digest("hex");
  return { minimumMacOS: explicitFloor || `${target}.0.0`, cliProfile: "data-path-save-folder-legacy-gl-v1",
    versionFlagAvailable: /\{\s*"version"\s*,\s*no_argument/.test(args),
    sourceMetadata: { argsSha256: digest(args), entrySha256: digest(entry), cmakeSha256: digest(cmake), workflowSha256: digest(workflow) } };
}

async function readSourceProfile(revision, architecture, { request = fetchUrlBuffer, signal } = {}) {
  if (!/^[a-f0-9]{40}$/.test(revision || "") || !["arm64", "x64"].includes(architecture)) throw new Error("Butterscotch builds require an exact source commit and CPU.");
  const files = { args: "src/cli/args.c", entry: "src/cli/main.c", cmake: "CMakeLists.txt", workflow: ".github/workflows/build-macos.yml" };
  const rows = await Promise.all(Object.entries(files).map(async ([name, file]) => {
    const response = await request(`https://raw.githubusercontent.com/ButterscotchRunner/Butterscotch/${revision}/${file}`,
      { signal, headers: { "User-Agent": "maclauncher" } });
    throwIfAborted(signal);
    if (response.status !== 200 || !Buffer.isBuffer(response.body) || response.body.length > 256 * 1024)
      throw new Error("Butterscotch source version metadata is unavailable.");
    return [name, response.body.toString("utf8")];
  }));
  return parseSourceProfile(Object.fromEntries(rows), architecture);
}

function createDownloadDiscovery({ architecture = process.arch, dependencies = {} } = {}) {
  if (!["arm64", "x64"].includes(architecture)) throw new Error("Butterscotch AppKit downloads require an ARM or Intel Mac.");
  return createGithubActionsDiscovery({ owner: "ButterscotchRunner", repo: "Butterscotch", workflow: "build.yml", limit: 1, maxRuns: 5,
    dependencies, mapArtifact: async (artifact, context) => {
      const label = architecture === "x64" ? "x86_64" : "arm64";
      if (artifact.name !== `butterscotch-appkit-macos-${label}`) return null;
      if (artifact.size_in_bytes > 64 * 1024 * 1024) throw new Error("The Butterscotch archive exceeds its supported size.");
      const profile = await readSourceProfile(context.run.head_sha, architecture, { ...dependencies, signal: context.signal });
      return artifactEntry(artifact, context, profile);
    } });
}

function resolveExecutable(root) {
  const file = path.join(root, "butterscotch");
  if (!fs.lstatSync(file).isFile()) throw new Error("The Butterscotch archive has no native runner.");
  return file;
}
async function prepareInstall({ unpacked, pin, signal }, dependencies = {}) {
  const executable = resolveExecutable(unpacked);
  if (fs.statSync(executable).size > 64 * 1024 * 1024 || fs.readdirSync(unpacked).some(name => name !== "butterscotch")) throw new Error("The Butterscotch archive has an unsupported layout.");
  const native = readMachOLoadCommands(executable, { signal });
  if (native.architectures.length !== 1 || native.architectures[0] !== pin.architecture) throw new Error("The Butterscotch archive has a different CPU architecture.");
  assertSystemLibraryClosure(native, { fileType: 2, maximumMacOS: pin.minimumMacOS });
  await (dependencies.run || run)("/usr/bin/codesign", ["--force", "--sign", "-", executable], { signal, timeout: 30000, maxBuffer: 1024 * 1024 });
  await (dependencies.run || run)("/usr/bin/codesign", ["--verify", "--strict", executable], { signal, timeout: 30000, maxBuffer: 1024 * 1024 });
  const help = await (dependencies.run || run)(executable, ["--help"], { signal, timeout: 10000, maxBuffer: 1024 * 1024, cwd: unpacked });
  if (!/--save-folder\s+</.test(help.stdout || "") || !/--renderer\s+</.test(help.stdout || "")) throw new Error("This Butterscotch build has incompatible launch options.");
  return { schemaVersion: 1, architecture: pin.architecture, minimumMacOS: native.slices[0].minimumMacOS,
    cliProfile: pin.cliProfile, executableSha256: hashFile(executable), sourceMetadata: pin.sourceMetadata,
    workflow: pin.workflow, versionFlagAvailable: pin.versionFlagAvailable };
}


module.exports = { artifactEntry, parseSourceProfile, readSourceProfile,
  createDownloadDiscovery, resolveExecutable, prepareInstall };
