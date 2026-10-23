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
const PUBLIC_REVISION = "fcc295961097b801e24f3dd2f9a41851db899ac2";
const SOURCE_PROFILE = Object.freeze({ minimumMacOS: "26.0.0", cliProfile: "data-path-save-folder-legacy-gl-v1", versionFlagAvailable: false,
  sourceMetadata: { argsSha256: "6be3363bcf62776495adcf00af75c27f4c5ae9f99df49cfec732a911e1d2d000",
    entrySha256: "4ed4d0d15d9f0a53c8b5faa0b47650231e021d5bff4996df6c8c43d992b0c14a",
    cmakeSha256: "98ada341afb8b262240eebbaa27ceebeb6a49ea3867506a9e2dd7ff61f7e77db",
    workflowSha256: "2af90e5445ed5296cebc5e2b47a3fa27d18f451923dc8e409820c138334ee901" } });

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

const PUBLIC_BUILDS = Object.freeze([
  { id: 11581123937, name: "butterscotch-appkit-macos-arm64", sha256: "6c4d557e579677b1d576b2dc55b71239f204e9354cf3d8dec76a7d5998bf6f73", created: "2026-10-08T22:02:27Z" },
  { id: 11582380123, name: "butterscotch-appkit-macos-x86_64", sha256: "59841acb40f06a124f964920bd7e38c7750e86b3f162414b57f8f876354b026f", created: "2026-10-08T22:03:16Z" }
].map(item => Object.freeze(artifactEntry({ id: item.id, name: item.name, created_at: item.created, expires_at: "2027-01-06T22:01:51Z" },
  { run: { id: 37850821255, head_sha: PUBLIC_REVISION, created_at: "2026-10-08T22:01:51Z" },
    sourceUrl: `https://github.com/ButterscotchRunner/Butterscotch/commit/${PUBLIC_REVISION}`,
    githubAssetDigest: () => item.sha256,
    nightlyArtifactUrl: () => `https://nightly.link/ButterscotchRunner/Butterscotch/actions/artifacts/${item.id}.zip` }, SOURCE_PROFILE))));

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
      const profile = context.run.head_sha === PUBLIC_REVISION ? SOURCE_PROFILE : await readSourceProfile(context.run.head_sha, architecture, { ...dependencies, signal: context.signal });
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

function automaticVersion(catalog, { hostVersion, architecture = process.arch, now = Date.now() } = {}) {
  return catalog.filter(pin => pin.asset && pin.workflow?.branch === "main" && pin.workflow.event === "push" && !pin.deprecated &&
    pin.hostArchitectures?.includes(architecture) && versionAtLeast(hostVersion, pin.minimumMacOS) && Date.parse(pin.asset.expiresAt) > now)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))[0]?.version || null;
}

module.exports = { PUBLIC_REVISION, PUBLIC_BUILDS, SOURCE_PROFILE, artifactEntry, parseSourceProfile, readSourceProfile,
  createDownloadDiscovery, resolveExecutable, prepareInstall, automaticVersion };
