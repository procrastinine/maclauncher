const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const crypto = require("node:crypto");
const Native = require("../../shared/runtime/local-native");
const { downloadToFile, throwIfAborted } = require("../../shared/runtime/download-utils");
const { runTool, createToolRunner } = require("../tools");
const { hashFile } = require("../inspect");

// The vendor bootstrap URL is mutable. Build version and artifact digest are
// independent; a changed upstream archive requires an explicit new artifact pin.
const BOOTSTRAP = Object.freeze({ version: "2024.0.0.32", filename: "igor_osx-arm64.zip", url: "https://gms.yoyogames.com/igor_osx-arm64.zip",
  bytes: 30832009, sha256: "850260ede5f591000533d760a2c0379bd753e5a6ebb0db30e1003c7957ca1599" });
const BOOTSTRAPS = Object.freeze({ arm64: BOOTSTRAP, x64: Object.freeze({ version: "2024.0.0.32", filename: "igor_osx-x64.zip",
  url: "https://gms.yoyogames.com/igor_osx-x64.zip", bytes: 32324796,
  sha256: "1a5cadc5e0f2eac5eaf3d1aede08bd220b445bcbc54e19aae32642b3a88d2c18" }) });

function ownedDirectory(userDataDir, relative) {
  if (typeof userDataDir !== "string" || !path.isAbsolute(userDataDir)) throw new Error("An absolute launcher data directory is required.");
  const root = path.resolve(userDataDir);
  let current = root;
  for (const part of relative.split(path.sep)) {
    if (!part || part === "." || part === "..") throw new Error("Invalid owned runtime path.");
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("Official runtime path contains a symlink.");
    fs.mkdirSync(current, { recursive: true });
  }
  return current;
}
function checkArtifact(file, pin) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== pin.bytes || hashFile(file) !== pin.sha256) {
    throw new Error(`Official ${pin.filename} size or SHA-256 does not match its expected checksum.`);
  }
  return file;
}
function bootstrapForArch(arch = process.arch) {
  const bootstrap = BOOTSTRAPS[arch];
  if (!bootstrap) throw new Error("Official Igor installation supports Apple Silicon and Intel Macs.");
  return bootstrap;
}
function resolveBuild({ userDataDir, version, arch = process.arch }) {
  const Catalog = require("./official-catalog");
  const discovered = Catalog.cachedCatalog(userDataDir)?.entries.find(entry => entry.version === version);
  if (!discovered) throw new Error(`Official ${version} is not in the cached release feed. Refresh the official catalog and select an exact version.`);
  const release = discovered.family === "studio-1.4" ? require("./official-legacy").resolveBuild(version, discovered) : discovered;
  return { ...release, packages: Catalog.selectPackages(release, arch), hostArchitecture: arch };
}
function toolFiles(root, arch) {
  const base = path.join("osx", arch);
  for (const parent of [path.join(root, "osx"), path.join(root, base)]) {
    const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Igor tool directory is not an owned regular directory.");
  }
  const names = ["Igor", "Igor.dll", "Igor.pdb", "Igor.dll.config"];
  if (JSON.stringify(fs.readdirSync(path.join(root, base)).sort()) !== JSON.stringify([...names].sort())) throw new Error("Igor installation contains unexpected tool files.");
  return names.map(name => {
    const relative = path.join(base, name), file = path.join(root, relative), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 ** 2) throw new Error("Igor tool files are not a bounded native installation.");
    return { relative, bytes: stat.size, sha256: hashFile(file) };
  });
}
function getIgorStatus({ userDataDir, arch = process.arch, toolVersion } = {}) {
  const pin = bootstrapForArch(arch), Tools = require("./official-tools");
  toolVersion = toolVersion || Tools.getSelectedIgorVersion({ userDataDir }) || pin.version;
  if (toolVersion !== pin.version) return Tools.getLocalIgorStatus({ userDataDir, arch, toolVersion });
  const version = pin.version;
  const directory = path.join(userDataDir || "", "runtimes", "gamemaker-official", "tools", pin.sha256);
  try {
    if (!userDataDir || !path.isAbsolute(userDataDir) || fs.lstatSync(directory).isSymbolicLink()) throw new Error("Choose an absolute launcher data directory.");
    const record = JSON.parse(fs.readFileSync(path.join(directory, "tool.json"), "utf8"));
    const build = require("./official-tool-version").readIgorVersion(path.join(directory, "osx", arch, "Igor.dll"));
    if (record.version !== version || build.version !== version || record.archiveSha256 !== pin.sha256 || record.architecture !== arch ||
      JSON.stringify(record.files) !== JSON.stringify(toolFiles(directory, arch))) throw new Error("Igor tool identity or files changed.");
    const native = Native.resolveLocalRuntime({ runtimePath: path.join(directory, "osx", arch, "Igor"), runtimeVersion: version,
      upstreamRevision: pin.sha256, expectedSha256: record.binarySha256, arch });
    return { ...record, ready: true, installed: true, status: "ready", toolPath: native.executablePath, installDir: directory, sourceUrl: pin.url };
  } catch (error) { return { version, ready: false, installed: false, status: fs.existsSync(directory) ? "damaged" : "missing",
    architecture: arch, sourceUrl: pin.url, archiveSha256: pin.sha256, reason: error.message }; }
}
async function ensureIgor({ userDataDir, arch = process.arch, toolVersion, signal, onProgress, download = downloadToFile, runProcess,
  prerequisiteContext, confirmRuntimeInstall, logger } = {}) {
  if (process.platform !== "darwin") throw new Error("Official native Igor requires macOS.");
  runProcess ||= createToolRunner({ prerequisiteContext: { confirmRuntimeInstall, logger, signal, onProgress, ...prerequisiteContext } });
  const pin = bootstrapForArch(arch);
  const Tools = require("./official-tools");
  toolVersion = toolVersion || Tools.getSelectedIgorVersion({ userDataDir }) || pin.version;
  if (toolVersion !== pin.version) return Tools.installLocalIgor({ userDataDir, arch, toolVersion, runProcess, signal });
  const existing = getIgorStatus({ userDataDir, arch, toolVersion });
  if (existing.ready) { Tools.selectIgorVersion(userDataDir, toolVersion); return existing; }
  const archiveRoot = ownedDirectory(userDataDir, path.join("runtimes", "gamemaker-official", "tool-artifacts", pin.sha256));
  const archive = path.join(archiveRoot, pin.filename);
  if (!fs.existsSync(archive)) {
    const temporary = path.join(archiveRoot, `.download-${crypto.randomUUID()}.zip`);
    try {
      await download(pin.url, temporary, { signal, onProgress, headers: { "User-Agent": "MacLauncher/1.0" } });
      checkArtifact(temporary, pin); fs.renameSync(temporary, archive);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  checkArtifact(archive, pin);
  const tools = ownedDirectory(userDataDir, path.join("runtimes", "gamemaker-official", "tools"));
  const destination = path.join(tools, pin.sha256), staging = fs.mkdtempSync(path.join(tools, ".igor-"));
  try {
    await runProcess("/usr/bin/ditto", ["-x", "-k", archive, staging], { timeout: 60000, ...(signal ? { signal } : {}) });
    const executable = path.join(staging, "osx", arch, "Igor"); fs.chmodSync(executable, 0o755);
    const build = require("./official-tool-version").readIgorVersion(path.join(staging, "osx", arch, "Igor.dll"));
    if (build.version !== pin.version) throw new Error("Igor DLL build differs from the selected tool version.");
    const native = Native.resolveLocalRuntime({ runtimePath: executable, runtimeVersion: existing.version, upstreamRevision: pin.sha256, arch });
    const record = { ...build, version: pin.version, architecture: arch, archiveSha256: pin.sha256,
      binarySha256: native.sha256, sourceUrl: pin.url, files: toolFiles(staging, arch), installedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(staging, "tool.json"), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
    throwIfAborted(signal);
    if (fs.existsSync(destination)) {
      if (fs.lstatSync(destination).isSymbolicLink()) throw new Error("Igor installation path is a symlink.");
      fs.rmSync(destination, { recursive: true, force: true });
    }
    fs.renameSync(staging, destination);
    const status = getIgorStatus({ userDataDir, arch, toolVersion });
    if (!status.ready) throw new Error(status.reason);
    Tools.selectIgorVersion(userDataDir, toolVersion);
    return status;
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
async function cacheArtifacts({ userDataDir, build, arch = process.arch, signal, onProgress, download = downloadToFile }) {
  const root = ownedDirectory(userDataDir, path.join("runtimes", "gamemaker-official", "artifacts", build.version));
  const pins = build.packages;
  const observedPath = path.join(root, `observed-${arch}.json`);
  let observations = {};
  if (fs.existsSync(observedPath)) observations = JSON.parse(fs.readFileSync(observedPath, "utf8"));
  const total = pins.reduce((sum, item) => sum + item.bytes, 0);
  let completed = 0;
  for (const pin of pins) {
    throwIfAborted(signal);
    const target = path.join(root, pin.filename);
    if (!fs.existsSync(target)) {
      const temporary = path.join(root, `.artifact-${crypto.randomUUID()}.zip`);
      try {
        await download(pin.url, temporary, { signal, headers: { "User-Agent": "MacLauncher/1.0" },
          onProgress: progress => onProgress?.({ downloaded: completed + progress.downloaded, total }) });
        const stat = fs.lstatSync(temporary), sha256 = hashFile(temporary);
        if (!stat.isFile() || stat.size !== pin.bytes || ((pin.sha256 || observations[pin.filename]?.sha256) && sha256 !== (pin.sha256 || observations[pin.filename].sha256))) throw new Error("Official package size or SHA-256 differs from its recorded artifact identity.");
        fs.renameSync(temporary, target);
        observations[pin.filename] = { url: pin.url, bytes: pin.bytes, signature: pin.signature, sha256,
          integrity: pin.sha256 ? "reviewed-sha256" : "official-https-observed-sha256" };
        const metadata = observedPath + "." + crypto.randomUUID();
        fs.writeFileSync(metadata, JSON.stringify(observations, null, 2) + "\n", { flag: "wx" }); fs.renameSync(metadata, observedPath);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    if (!pin.sha256 && (!observations[pin.filename] || observations[pin.filename].url !== pin.url || observations[pin.filename].signature !== pin.signature)) throw new Error("Unpinned cached package has no matching official download provenance. Remove the incomplete cache before retrying.");
    checkArtifact(target, { ...pin, sha256: pin.sha256 || observations[pin.filename].sha256 });
    completed += pin.bytes;
    onProgress?.({ downloaded: completed, total });
  }
  return { root, packages: pins.map(pin => ({ ...pin, sha256: pin.sha256 || observations[pin.filename].sha256,
    integrity: pin.sha256 ? "reviewed-sha256" : "official-https-observed-sha256" })) };
}

function pinnedFeed(baseUrl, build) {
  const attribute = pin => `url="${baseUrl}/${pin.filename}" sparkle:version="${build.version}" length="${pin.bytes}" sparkle:dsaSignature="${pin.signature}"`;
  const [core, ...modules] = build.packages;
  return `<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Selected official GameMaker runtime</title><item><title>Version ${build.version}</title><enclosure ${attribute(core)} type="application/octet-stream">${modules.map(pin => `<module name="${pin.module}" ${attribute(pin)}/>`).join("")}</enclosure></item></channel></rss>`;
}
async function servePinnedArtifacts(artifactsRoot, build) {
  const allowed = new Map(build.packages.map(pin => [`/${pin.filename}`, checkArtifact(path.join(artifactsRoot, pin.filename), pin)]));
  let feed;
  const server = http.createServer((request, response) => {
    if (request.method !== "GET") { response.writeHead(405).end(); return; }
    if (request.url === "/runtime.rss") {
      response.writeHead(200, { "Content-Type": "application/rss+xml", "Content-Length": Buffer.byteLength(feed) }); response.end(feed); return;
    }
    const file = allowed.get(request.url);
    if (!file) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": fs.statSync(file).size });
    const stream = fs.createReadStream(file);
    stream.on("error", () => response.destroy());
    response.on("close", () => stream.destroy());
    stream.pipe(response);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  feed = pinnedFeed(url, build);
  return { url: `${url}/runtime.rss`, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

async function extractRunnerApp(diskImage, destination, { runProcess = runTool, version } = {}) {
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-official-dmg-"));
  let attached = false;
  try {
    await runProcess("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, diskImage], { timeout: 60000 });
    attached = true;
    const app = path.join(mount, "YoYo Runner.app");
    if (!fs.lstatSync(app).isDirectory() || fs.lstatSync(app).isSymbolicLink()) throw new Error("Official disk image has no YoYo Runner app.");
    await runProcess("/usr/bin/ditto", [app, destination], { timeout: 60000 });
    const executable = path.join(destination, "Contents", "MacOS", "Mac_Runner");
    Native.resolveLocalRuntime({ runtimePath: executable, runtimeVersion: version, upstreamRevision: `vendor-runtime:${version}` });
    return executable;
  } finally {
    if (attached) await runProcess("/usr/bin/hdiutil", ["detach", mount], { timeout: 60000 });
    fs.rmSync(mount, { recursive: true, force: true });
  }
}

async function installOfficialVersion({ userDataDir, version, signal, onProgress, dependencies = {},
  prerequisiteContext, confirmRuntimeInstall, logger }) {
  if (process.platform !== "darwin" || !BOOTSTRAPS[process.arch]) throw new Error("Official native installation requires an Apple Silicon or Intel Mac.");
  if (!require("./official-catalog").VERSION.test(version || "")) throw new Error("Select an exact official runtime version.");
  const build = resolveBuild({ userDataDir, version });
  const root = ownedDirectory(userDataDir, path.join("runtimes", "gamemaker-official"));
  const destination = path.join(root, version);
  if (fs.existsSync(destination)) throw new Error("Remove the existing or incomplete official runtime registration before installing this version.");
  const runProcess = dependencies.runProcess || createToolRunner({ prerequisiteContext: {
    confirmRuntimeInstall, logger, signal, onProgress, ...prerequisiteContext
  } });
  if (build.family === "studio-1.4") return require("./official-legacy").installLegacyVersion({
    userDataDir, version, signal, onProgress, dependencies, runProcess
  });
  const identity = await ensureIgor({ userDataDir, signal, onProgress, download: dependencies.downloadToFile, runProcess });
  const artifacts = await cacheArtifacts({ userDataDir, build, signal, onProgress, download: dependencies.downloadToFile });
  const selected = { ...build, packages: artifacts.packages };
  const staging = fs.mkdtempSync(path.join(root, ".install-"));
  let server;
  try {
    server = await servePinnedArtifacts(artifacts.root, selected);
    const vendorRoot = path.join(staging, "vendor");
    const result = await runProcess(identity.toolPath, [`/rp=${vendorRoot}`, `/ru=${server.url}`, "/m=mac", "--", "Runtime", "Install", version],
      { cwd: identity.installDir, timeout: 10 * 60 * 1000, ...(signal ? { signal } : {}) });
    throwIfAborted(signal);
    const installedRoot = path.join(vendorRoot, `runtime-${version}`);
    const diskImage = path.join(installedRoot, "mac", "Mac-YoYoRunner-Release.dmg");
    const diskImageSha256 = hashFile(diskImage);
    if (build.diskImageSha256 && diskImageSha256 !== build.diskImageSha256) throw new Error("Official runner disk image checksum changed.");
    const runner = path.join(staging, "YoYo Runner.app");
    const binary = await (dependencies.extractRunnerApp || extractRunnerApp)(diskImage, runner, { runProcess, version });
    const binarySha256 = hashFile(binary);
    if (build.binarySha256 && binarySha256 !== build.binarySha256) throw new Error("Official runner executable checksum changed.");
    const inspection = require("./official").inspectOfficialRuntime(installedRoot);
    const record = { ...inspection, runtimeRoot: path.join(destination, "vendor", `runtime-${version}`),
      diskImages: inspection.diskImages.map(item => ({ ...item, path: path.join(destination, "vendor", `runtime-${version}`, path.relative(installedRoot, item.path)) })),
      runnerAppPath: path.join(destination, "YoYo Runner.app"), executablePath: path.join(destination, "YoYo Runner.app", "Contents", "MacOS", "Mac_Runner"),
      version, upstreamRevision: build.upstreamRevision, backend: build.backend, binarySha256,
      runnerTreeSha256: require("./official-launch").hashRunnerTree(runner),
      runnerReportedVersion: build.runnerReportedVersion || null, diskImageSha256,
      bootstrap: { version: identity.version, architecture: identity.architecture, source: identity.source || "public-bootstrap",
        sourceUrl: identity.sourceUrl, archiveSha256: identity.archiveSha256 || null, dependencyTreeSha256: identity.dependencyTreeSha256 || null,
        executableSha256: identity.binarySha256, toolPath: identity.toolPath },
      packages: artifacts.packages.map(({ signature, ...item }) => item), source: "vendor-native-install",
      releaseSource: build.source, releaseFeedSha256: build.feedSha256 || null, channel: build.channel || null,
      artifactsPinned: artifacts.packages.every(item => item.integrity === "reviewed-sha256"),
      artifactIntegrity: artifacts.packages.every(item => item.integrity === "reviewed-sha256") ? "reviewed-sha256" : "official-https-feed-and-recorded-sha256",
      vendorSignatureVerified: false, vendorIntegrityVerified: false, runtimeReady: true, launchReady: true, gameplayQualified: false,
      qualification: "Runs compatible GameMaker Studio VM data. Software OpenGL is available for matching runner versions.",
      installedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(staging, "vendor-install.log"), result.stdout + result.stderr);
    fs.writeFileSync(path.join(staging, "runtime.json"), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
    throwIfAborted(signal);
    fs.renameSync(staging, destination);
    return require("./official").manager.core.resolveInstalled({ userDataDir, version }) || Promise.reject(new Error("Official installation failed its final identity check."));
  } finally {
    await server?.close();
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { BOOTSTRAP, BOOTSTRAPS, ownedDirectory, checkArtifact, cacheArtifacts, pinnedFeed,
  servePinnedArtifacts, extractRunnerApp, installOfficialVersion, bootstrapForArch, resolveBuild, getIgorStatus, ensureIgor };
