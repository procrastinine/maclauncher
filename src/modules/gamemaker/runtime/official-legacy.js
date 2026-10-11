const fs = require("node:fs");
const path = require("node:path");
const Native = require("../../shared/runtime/local-native");
const { hashFile } = require("../inspect");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const { readPackageMember } = require("./official-legacy-zip");

// Studio 1.4.9999 is the final public Studio 1 Mac module and has a 64-bit
// Intel runner. Earlier releases remain visible in the catalog, but their
// architecture and transport artifacts have not been qualified here.
const BUILD = Object.freeze({ version: "1.4.9999", family: "studio-1.4", channel: "Studio 1.4", backend: "official-studio-vm",
  upstreamRevision: "vendor-runtime:1.4.9999", source: "https://store.yoyogames.com/downloads/gm-studio/update-studio.rss",
  releaseNotesUrl: "https://store.yoyogames.com/downloads/gm-studio/release-notes-studio.html",
  architectures: Object.freeze(["x86_64"]), gameplayQualified: false,
  diskImageSha256: "0fb6bca1920eba53b3d9ea98d07cea46961e0aeaaed633fe2b27e2616c6e5cbd",
  binarySha256: "dd8395d9dcdb5eb6e58641a730b22640d1909e72a55a48c3450cf6d0231040fa",
  runnerTreeSha256: "9dad54e397132ab70a5c37a44e6222f90d86a2babbfb521726f922a43d36c632",
  packages: Object.freeze([Object.freeze({ module: "mac", filename: "55a7c0e7-fd96-45ae-971d-31164ec69b9e.zip",
    url: "https://store.yoyogames.com/downloads/gm-studio/55a7c0e7-fd96-45ae-971d-31164ec69b9e.zip",
    publishedUrl: "https://updater.yoyogames.com/api/download/mac/55a7c0e7-fd96-45ae-971d-31164ec69b9e.zip",
    bytes: 34471534, sha256: "68fbbb50bf281eb856890ca3c7d2a2d2ae7a43bd9158487a3380576e7aaa1f55",
    signature: "MCwCFG6UxBEN8k4BWgsQ1IXzC9MhCTLAAhQjWzDnfVsDxHHh64BFfmWl30XTsA==" })])
});

function resolveBuild(version, discovered) {
  if (version !== BUILD.version) throw new Error(`Official Studio ${version} has no supported 64-bit Mac package. Studio ${BUILD.version} is the available legacy Mac runtime.`);
  if (discovered && (discovered.family !== BUILD.family || discovered.packages?.length !== 1 ||
    ["module", "filename", "url", "bytes", "signature"].some(key => discovered.packages[0]?.[key] !== BUILD.packages[0][key]))) {
    throw new Error("Official Studio 1.4 package metadata changed.");
  }
  return BUILD;
}
function resolveInstalled({ record, directory, version }) {
  const build = resolveBuild(version), app = path.join(directory, "YoYo Runner.app");
  const diskImage = path.join(directory, "vendor", "Mac-YoYoRunner.dmg");
  const pin = build.packages[0], installedPin = record.packages?.[0];
  if (record.source !== "vendor-legacy-package" || record.family !== build.family || record.version !== build.version ||
    record.upstreamRevision !== build.upstreamRevision || record.binarySha256 !== build.binarySha256 ||
    record.runnerTreeSha256 !== build.runnerTreeSha256 || record.diskImageSha256 !== build.diskImageSha256 ||
    record.runnerAppPath !== app || record.diskImagePath !== diskImage || record.packages?.length !== 1 ||
    ["url", "filename", "bytes", "sha256"].some(key => installedPin?.[key] !== pin[key]) || !record.launchReady) return null;
  if (!fs.lstatSync(diskImage).isFile() || fs.lstatSync(diskImage).isSymbolicLink() || hashFile(diskImage) !== build.diskImageSha256) return null;
  const native = Native.resolveLocalRuntime({ runtimePath: app, runtimeVersion: version, upstreamRevision: build.upstreamRevision,
    expectedSha256: build.binarySha256, preferredExecutable: "Mac_Runner" });
  if (require("./official-launch").hashRunnerTree(app) !== build.runnerTreeSha256) return null;
  return { ...record, ...native, installDir: directory, ready: true, installed: true, runtimeReady: true, status: "experimental" };
}

async function installLegacyVersion({ userDataDir, version, signal, onProgress, dependencies = {}, runProcess }) {
  const build = resolveBuild(version), Installer = require("./official-installer");
  const root = Installer.ownedDirectory(userDataDir, path.join("runtimes", "gamemaker-official"));
  const destination = path.join(root, version);
  if (fs.existsSync(destination)) throw new Error("Remove the existing or incomplete official runtime registration before installing this version.");
  const artifacts = await Installer.cacheArtifacts({ userDataDir, build, signal, onProgress, download: dependencies.downloadToFile });
  const staging = fs.mkdtempSync(path.join(root, ".legacy-install-"));
  try {
    throwIfAborted(signal);
    const image = readPackageMember(path.join(artifacts.root, build.packages[0].filename), build.packages[0].filename, "Mac/Mac-YoYoRunner.dmg");
    if (require("node:crypto").createHash("sha256").update(image).digest("hex") !== build.diskImageSha256) throw new Error("Legacy official runner disk image checksum changed.");
    fs.mkdirSync(path.join(staging, "vendor"));
    const diskImage = path.join(staging, "vendor", "Mac-YoYoRunner.dmg");
    fs.writeFileSync(diskImage, image, { flag: "wx" });
    const app = path.join(staging, "YoYo Runner.app");
    const executable = await (dependencies.extractRunnerApp || Installer.extractRunnerApp)(diskImage, app, { runProcess });
    const native = Native.resolveLocalRuntime({ runtimePath: executable, runtimeVersion: version,
      upstreamRevision: build.upstreamRevision, expectedSha256: build.binarySha256 });
    const runnerTreeSha256 = require("./official-launch").hashRunnerTree(app);
    if (runnerTreeSha256 !== build.runnerTreeSha256) throw new Error("Legacy official runner bundle checksum changed.");
    const record = { version, family: build.family, source: "vendor-legacy-package", backend: build.backend, upstreamRevision: build.upstreamRevision,
      releaseSource: build.source, channel: build.channel, packages: artifacts.packages.map(({ signature, ...item }) => item),
      runnerAppPath: path.join(destination, "YoYo Runner.app"), executablePath: path.join(destination, "YoYo Runner.app", "Contents", "MacOS", "Mac_Runner"),
      architectures: native.architectures, binarySha256: build.binarySha256, runnerTreeSha256,
      diskImagePath: path.join(destination, "vendor", "Mac-YoYoRunner.dmg"), diskImageSha256: build.diskImageSha256,
      artifactIntegrity: "reviewed-sha256", artifactsPinned: true, vendorSignatureVerified: false,
      runtimeReady: true, launchReady: true, gameplayQualified: false, installedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(staging, "runtime.json"), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
    throwIfAborted(signal);
    fs.renameSync(staging, destination);
    const result = require("./official").manager.core.resolveInstalled({ userDataDir, version });
    if (!result?.ready) throw new Error("Legacy official runtime failed its final artifact identity check.");
    return result;
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

module.exports = { BUILD, resolveBuild, resolveInstalled, installLegacyVersion };
