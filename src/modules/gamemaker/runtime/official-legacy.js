const fs = require("node:fs");
const path = require("node:path");
const Native = require("../../shared/runtime/local-native");
const { hashFile } = require("../inspect");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const LegacyZip = require("./official-legacy-zip");

function resolveBuild(version, discovered) {
  if (!/^1\.4\.\d{1,5}$/.test(version || "") || discovered?.version !== version || discovered.family !== "studio-1.4" ||
      !require("./official-catalog").validateEntry(discovered)) throw new Error("Select an exact Studio 1.4 release from the cached official catalog.");
  return discovered;
}
function resolveInstalled({ record, directory, version }) {
  const app = path.join(directory, "YoYo Runner.app"), diskImage = path.join(directory, "vendor", "Mac-YoYoRunner.dmg");
  if (!/^1\.4\.\d{1,5}$/.test(version || "") || record.source !== "vendor-legacy-package" || record.family !== "studio-1.4" || record.version !== version ||
      record.upstreamRevision !== `vendor-runtime:${version}` ||
      [record.binarySha256, record.runnerTreeSha256, record.diskImageSha256].some(value => !/^[a-f0-9]{64}$/.test(value || "")) ||
      record.runnerAppPath !== app || record.diskImagePath !== diskImage || !Array.isArray(record.packages) || record.packages.length !== 1 || !record.launchReady) return null;
  const pin = record.packages[0];
  if (!pin || !/^[a-f0-9]{64}$/.test(pin.sha256 || "") || !Number.isSafeInteger(pin.bytes) || pin.bytes < 1 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.zip$/i.test(pin.filename || "") ||
      pin.url !== `https://store.yoyogames.com/downloads/gm-studio/${pin.filename}`) return null;
  if (!fs.lstatSync(diskImage).isFile() || fs.lstatSync(diskImage).isSymbolicLink() || hashFile(diskImage) !== record.diskImageSha256) return null;
  const native = Native.resolveLocalRuntime({ runtimePath: app, runtimeVersion: version, upstreamRevision: record.upstreamRevision,
    expectedSha256: record.binarySha256, preferredExecutable: "Mac_Runner" });
  if (require("./official-launch").hashRunnerTree(app) !== record.runnerTreeSha256) return null;
  return { ...record, ...native, installDir: directory, ready: true, installed: true, runtimeReady: true, status: "ready" };
}

async function installLegacyVersion({ userDataDir, version, signal, onProgress, dependencies = {}, runProcess }) {
  const build = require("./official-installer").resolveBuild({ userDataDir, version }), Installer = require("./official-installer");
  const root = Installer.ownedDirectory(userDataDir, path.join("runtimes", "gamemaker-official"));
  const destination = path.join(root, version);
  if (fs.existsSync(destination)) throw new Error("Remove the existing or incomplete official runtime registration before installing this version.");
  const artifacts = await Installer.cacheArtifacts({ userDataDir, build, signal, onProgress, download: dependencies.downloadToFile });
  const staging = fs.mkdtempSync(path.join(root, ".legacy-install-"));
  try {
    throwIfAborted(signal);
    const image = LegacyZip.readPackageMember(path.join(artifacts.root, build.packages[0].filename), build.packages[0].filename, "Mac/Mac-YoYoRunner.dmg");
    const diskImageSha256 = require("node:crypto").createHash("sha256").update(image).digest("hex");
    fs.mkdirSync(path.join(staging, "vendor"));
    const diskImage = path.join(staging, "vendor", "Mac-YoYoRunner.dmg");
    fs.writeFileSync(diskImage, image, { flag: "wx" });
    const app = path.join(staging, "YoYo Runner.app");
    const executable = await (dependencies.extractRunnerApp || Installer.extractRunnerApp)(diskImage, app, { runProcess, version });
    const native = Native.resolveLocalRuntime({ runtimePath: executable, runtimeVersion: version,
      upstreamRevision: build.upstreamRevision });
    const runnerTreeSha256 = require("./official-launch").hashRunnerTree(app);
    const record = { version, family: build.family, source: "vendor-legacy-package", backend: build.backend, upstreamRevision: build.upstreamRevision,
      releaseSource: build.source, channel: build.channel, packages: artifacts.packages.map(({ signature, ...item }) => item),
      runnerAppPath: path.join(destination, "YoYo Runner.app"), executablePath: path.join(destination, "YoYo Runner.app", "Contents", "MacOS", "Mac_Runner"),
      architectures: native.architectures, binarySha256: native.sha256, runnerTreeSha256,
      diskImagePath: path.join(destination, "vendor", "Mac-YoYoRunner.dmg"), diskImageSha256,
      artifactIntegrity: artifacts.packages.every(item => item.integrity === "reviewed-sha256") ? "reviewed-sha256" : "official-https-feed-and-recorded-sha256", artifactsPinned: artifacts.packages.every(item => item.integrity === "reviewed-sha256"), vendorSignatureVerified: false,
      runtimeReady: true, launchReady: true, gameplayQualified: false, installedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(staging, "runtime.json"), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
    throwIfAborted(signal);
    fs.renameSync(staging, destination);
    const result = require("./official").manager.core.resolveInstalled({ userDataDir, version });
    if (!result?.ready) throw new Error("Legacy official runtime failed its final artifact identity check.");
    return result;
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

module.exports = { resolveBuild, resolveInstalled, installLegacyVersion };
