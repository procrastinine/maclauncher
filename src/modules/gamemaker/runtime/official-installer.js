const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const crypto = require("node:crypto");
const Native = require("../../shared/runtime/local-native");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const Upstream = require("../../shared/runtime/upstream");
const { extractDmg } = require("../../shared/runtime/dmg");
const { runTool, createToolRunner } = require("../tools");
const { hashFile } = require("../inspect");

// The vendor replaces these downloads in place. A download is accepted by its
// Igor files and YoYo Games' Developer ID signature; its version is read from
// Igor.dll, and each installation is keyed by the archive's SHA-256.
const BOOTSTRAPS = Object.freeze(Object.fromEntries(["arm64", "x64"].map(arch => [arch,
  Upstream.vendor({ location: `https://gms.yoyogames.com/igor_osx-${arch}.zip`, teamIdentifier: "C9E7J7HL3D" })])));
const HEADERS = { "User-Agent": "MacLauncher/1.0" };

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
const isToolDirectory = directory => ["Igor", "Igor.dll"].every(name => fs.lstatSync(path.join(directory, name), { throwIfNoEntry: false })?.isFile());
// The archive holds osx/<arch>/Igor and Igor.dll. A later archive may place
// them deeper or elsewhere, so a bounded search follows the known path.
function toolDirectory(root, arch) {
  const known = path.join("osx", arch);
  if (isToolDirectory(path.join(root, known))) return known;
  const found = [];
  (function search(relative, depth) {
    if (depth > 4 || found.length > 8) return;
    for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!item.isDirectory() || item.name === "__MACOSX" || item.name.startsWith(".")) continue;
      const child = path.join(relative, item.name);
      if (isToolDirectory(path.join(root, child))) found.push(child); else search(child, depth + 1);
    }
  })("", 0);
  const selected = found.find(relative => relative.split(path.sep).includes(arch)) || (found.length === 1 ? found[0] : null);
  if (!selected) throw new Error("The Igor download has no Igor tool for this Mac.");
  return selected;
}
// Every file the vendor ships with Igor is recorded by size and SHA-256.
function toolFiles(root, relativeDirectory) {
  let current = root;
  for (const part of relativeDirectory.split(path.sep)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error("Igor tool directory is missing or not an owned regular directory.");
  }
  const files = []; let bytes = 0;
  (function walk(relative, depth) {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const child = path.join(relative, name), stat = fs.lstatSync(path.join(root, child));
      if (stat.isDirectory() && !stat.isSymbolicLink() && depth < 8) { walk(child, depth + 1); continue; }
      bytes += stat.size;
      if (!stat.isFile() || stat.size > 128 * 1024 ** 2 || bytes > 1024 ** 3 || files.length >= 3000) throw new Error("Igor tool files are not a bounded native installation.");
      files.push({ relative: child, bytes: stat.size, sha256: hashFile(path.join(root, child)) });
    }
  })(relativeDirectory, 0);
  return files;
}
const sortedFiles = files => [...(files || [])].sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
// Public Igor installations live in tools/<archive-sha256>/. Their records
// carry the version read from Igor.dll, so earlier installations keep resolving.
function bootstrapStatus(directory, arch) {
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Igor installation path is a symlink.");
  const record = JSON.parse(fs.readFileSync(path.join(directory, "tool.json"), "utf8"));
  const relative = record.toolDirectory || path.join("osx", arch);
  if (path.isAbsolute(relative) || relative.split(path.sep).includes("..")) throw new Error("Igor tool directory escapes its installation.");
  const build = require("./official-tool-version").readIgorVersion(path.join(directory, relative, "Igor.dll"));
  if (record.version !== build.version || record.archiveSha256 !== path.basename(directory) || record.architecture !== arch ||
    JSON.stringify(sortedFiles(record.files)) !== JSON.stringify(toolFiles(directory, relative))) throw new Error("Igor tool identity or files changed.");
  const native = Native.resolveLocalRuntime({ runtimePath: path.join(directory, relative, "Igor"), runtimeVersion: record.version,
    upstreamRevision: record.archiveSha256, expectedSha256: record.binarySha256, arch });
  return { ...record, ready: true, installed: true, status: "ready", toolPath: native.executablePath, installDir: directory };
}
function listBootstrapIgors({ userDataDir, arch = process.arch } = {}) {
  if (!path.isAbsolute(userDataDir || "")) return [];
  const root = path.join(userDataDir, "runtimes", "gamemaker-official", "tools"), sourceUrl = bootstrapForArch(arch).location;
  let names = [];
  try { names = fs.readdirSync(root).filter(name => /^[a-f0-9]{64}$/.test(name)).sort().slice(0, 64); } catch {}
  return names.flatMap(name => {
    const directory = path.join(root, name);
    let record = null;
    try { record = JSON.parse(fs.readFileSync(path.join(directory, "tool.json"), "utf8")); } catch {}
    if (record && record.architecture !== arch) return [];
    try { return [{ sourceUrl, ...bootstrapStatus(directory, arch) }]; } catch (error) {
      return [{ version: typeof record?.version === "string" ? record.version : null, architecture: arch, ready: false, installed: false,
        status: "damaged", sourceUrl, archiveSha256: name, reason: error.message }];
    }
  });
}
function getIgorStatus({ userDataDir, arch = process.arch, toolVersion } = {}) {
  const bootstrap = bootstrapForArch(arch), Tools = require("./official-tools");
  const installs = listBootstrapIgors({ userDataDir, arch });
  const version = toolVersion || Tools.getSelectedIgorVersion({ userDataDir });
  if (version) {
    const match = installs.find(item => item.version === version && item.ready) || installs.find(item => item.version === version);
    if (match) return match;
    const local = Tools.getLocalIgorStatus({ userDataDir, arch, toolVersion: version });
    // A saved choice with no installation left falls back to the public download.
    if (toolVersion || local.status !== "missing") return local;
  }
  const { versionCompare } = require("./official-catalog");
  return installs.filter(item => item.ready).sort((a, b) => versionCompare(b.version, a.version))[0] ||
    { version: null, architecture: arch, ready: false, installed: false, status: "missing", sourceUrl: bootstrap.location, reason: "Igor is not installed." };
}
async function ensureIgor({ userDataDir, arch = process.arch, toolVersion, signal, onProgress, runProcess,
  prerequisiteContext, confirmRuntimeInstall, logger } = {}) {
  if (process.platform !== "darwin") throw new Error("Official native Igor requires macOS.");
  runProcess ||= createToolRunner({ prerequisiteContext: { confirmRuntimeInstall, logger, signal, onProgress, ...prerequisiteContext } });
  const bootstrap = bootstrapForArch(arch);
  const Tools = require("./official-tools");
  const existing = getIgorStatus({ userDataDir, arch, toolVersion });
  if (existing.ready) { Tools.selectIgorVersion(userDataDir, existing.version); return existing; }
  if (existing.version && !existing.archiveSha256) return Tools.installLocalIgor({ userDataDir, arch, toolVersion: existing.version, runProcess, signal });
  const tools = ownedDirectory(userDataDir, path.join("runtimes", "gamemaker-official", "tools"));
  const staging = fs.mkdtempSync(path.join(tools, ".igor-")), archive = `${staging}.zip`;
  try {
    const [listed] = (await bootstrap.discover({ signal }))[0]?.files || [];
    const { sha256: archiveSha256 } = await bootstrap.download(listed, archive, { signal, onProgress, headers: HEADERS });
    await runProcess("/usr/bin/ditto", ["-x", "-k", archive, staging], { timeout: 60000, ...(signal ? { signal } : {}) });
    const relative = toolDirectory(staging, arch), executable = path.join(staging, relative, "Igor");
    fs.chmodSync(executable, 0o755);
    const files = toolFiles(staging, relative);
    const build = require("./official-tool-version").readIgorVersion(path.join(staging, relative, "Igor.dll"));
    const native = Native.resolveLocalRuntime({ runtimePath: executable, runtimeVersion: build.version, upstreamRevision: archiveSha256, arch });
    await bootstrap.verifySigner(executable, { execute: runProcess, signal });
    const record = { ...build, architecture: arch, archiveSha256, binarySha256: native.sha256, sourceUrl: bootstrap.location,
      teamIdentifier: bootstrap.teamIdentifier, toolDirectory: relative, files, installedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(staging, "tool.json"), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
    throwIfAborted(signal);
    const destination = path.join(tools, archiveSha256);
    if (fs.existsSync(destination)) {
      if (fs.lstatSync(destination).isSymbolicLink()) throw new Error("Igor installation path is a symlink.");
      fs.rmSync(destination, { recursive: true, force: true });
    }
    fs.renameSync(staging, destination);
    const status = getIgorStatus({ userDataDir, arch, toolVersion: build.version });
    if (!status.ready) throw new Error(status.reason);
    Tools.selectIgorVersion(userDataDir, build.version);
    return status;
  } finally { fs.rmSync(staging, { recursive: true, force: true }); fs.rmSync(archive, { force: true }); }
}
// Feed packages download once per feed identity (URL, size and signature). The
// first download's SHA-256 is recorded, and a package YoYo Games replaced
// downloads again.
async function cacheArtifacts({ userDataDir, build, arch = process.arch, signal, onProgress }) {
  const root = ownedDirectory(userDataDir, path.join("runtimes", "gamemaker-official", "artifacts", build.version));
  const pins = build.packages;
  const observedPath = path.join(root, `observed-${arch}.json`);
  let observations = {};
  if (fs.existsSync(observedPath)) observations = JSON.parse(fs.readFileSync(observedPath, "utf8"));
  const total = pins.reduce((sum, item) => sum + item.bytes, 0);
  const current = pin => observations[pin.filename]?.url === pin.url && observations[pin.filename].bytes === pin.bytes &&
    observations[pin.filename].signature === pin.signature && fs.existsSync(path.join(root, pin.filename));
  let completed = 0;
  for (const pin of pins) {
    throwIfAborted(signal);
    const target = path.join(root, pin.filename);
    if (!current(pin)) {
      fs.rmSync(target, { force: true }); delete observations[pin.filename];
      const temporary = path.join(root, `.artifact-${crypto.randomUUID()}.zip`);
      try {
        const { sha256 } = await Upstream.download(Upstream.listedFile({ filename: pin.filename, url: pin.url, bytes: pin.bytes }), temporary, { signal, headers: HEADERS,
          onProgress: progress => onProgress?.({ downloaded: completed + progress.downloaded, total }) });
        fs.renameSync(temporary, target);
        observations[pin.filename] = { url: pin.url, bytes: pin.bytes, signature: pin.signature, sha256, integrity: "official-https-observed-sha256" };
        const metadata = observedPath + "." + crypto.randomUUID();
        fs.writeFileSync(metadata, JSON.stringify(observations, null, 2) + "\n", { flag: "wx" }); fs.renameSync(metadata, observedPath);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    checkArtifact(target, { ...pin, sha256: observations[pin.filename].sha256 });
    completed += pin.bytes;
    onProgress?.({ downloaded: completed, total });
  }
  return { root, packages: pins.map(pin => ({ ...pin, sha256: observations[pin.filename].sha256, integrity: "official-https-observed-sha256" })) };
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

// The runner app is "YoYo Runner.app"; a renamed or nested app is found by
// its Mac_Runner executable.
function runnerAppIn(root) {
  const known = path.join(root, "YoYo Runner.app"), found = [];
  const runner = app => { const stat = fs.lstatSync(path.join(app, "Contents", "MacOS", "Mac_Runner"), { throwIfNoEntry: false }); return stat?.isFile() && !fs.lstatSync(app).isSymbolicLink(); };
  if (fs.existsSync(known) && runner(known)) return known;
  (function search(directory, depth) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!item.isDirectory() || item.name === "__MACOSX" || item.name.startsWith(".")) continue;
      const child = path.join(directory, item.name);
      if (item.name.endsWith(".app")) { if (runner(child)) found.push(child); } else if (depth < 2) search(child, depth + 1);
    }
  })(root, 0);
  if (found.length !== 1) throw new Error("Official disk image has no YoYo Runner app.");
  return found[0];
}
// The shared extractor mounts the image, copies its visible files and detaches.
async function extractRunnerApp(diskImage, destination, { runProcess = runTool, version } = {}) {
  const volume = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-official-dmg-"));
  try {
    await extractDmg(diskImage, volume, undefined, { project: "GameMaker runtime" });
    const app = runnerAppIn(volume);
    await runProcess("/usr/bin/ditto", [app, destination], { timeout: 60000 });
    const executable = path.join(destination, "Contents", "MacOS", "Mac_Runner");
    Native.resolveLocalRuntime({ runtimePath: executable, runtimeVersion: version, upstreamRevision: `vendor-runtime:${version}` });
    return executable;
  } finally {
    fs.rmSync(volume, { recursive: true, force: true });
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
  const identity = await ensureIgor({ userDataDir, signal, onProgress, runProcess });
  const artifacts = await cacheArtifacts({ userDataDir, build, signal, onProgress });
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
    const diskImage = require("./official").runnerDiskImage(installedRoot);
    if (!diskImage) throw new Error("The installed official runtime has no Mac runner disk image.");
    const diskImageSha256 = hashFile(diskImage);
    const runner = path.join(staging, "YoYo Runner.app");
    const binary = await (dependencies.extractRunnerApp || extractRunnerApp)(diskImage, runner, { runProcess, version });
    const binarySha256 = hashFile(binary);
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
      artifactsPinned: false, artifactIntegrity: "official-https-feed-and-recorded-sha256",
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

module.exports = { BOOTSTRAPS, ownedDirectory, checkArtifact, cacheArtifacts, pinnedFeed, servePinnedArtifacts, extractRunnerApp, runnerAppIn, toolDirectory,
  installOfficialVersion, bootstrapForArch, resolveBuild, listBootstrapIgors, getIgorStatus, ensureIgor };
