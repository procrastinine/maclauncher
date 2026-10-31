const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { throwIfAborted } = require("../../runtime/download-utils");
const Archive = require("../../runtime/archive");
const ReleaseFiles = require("../../runtime/release-files");
const Upstream = require("../../runtime/upstream");
const Native = require("../../runtime/local-native");
const Custom = require("../../runtime/custom-runtime");
const { inspectNativeSteamConsumer } = require("../../runtime/steamworks/native-consumer-probe");

const INSTALL_META_FILE = ".maclauncher-greenworks.json";
const checksumCache = new Map();

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function normalizeNwVersion(input) {
  const v = String(input ?? "").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    throw new Error(`Invalid NW.js version: ${String(input ?? "")}`);
  }
  return v;
}

function compareSemverDesc(a, b) {
  const pa = String(a || "").split(".").map(Number), pb = String(b || "").split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
  return 0;
}

// Greenworks publishes one Mac bridge per NW.js version; the archive name
// states that NW.js version. The newest Greenworks release serving a version wins.
const source = Upstream.github({ repository: "greenheartgames/greenworks", recognize: release => {
  const greenworksVersion = /\d+\.\d+\.\d+/.exec(release.tag_name || release.name || "")?.[0] || null, rows = new Map();
  for (const asset of release.assets || []) {
    const name = String(asset?.name || ""), nwVersion = /nw-v?(\d+\.\d+\.\d+)/i.exec(name)?.[1];
    if (nwVersion && /osx|darwin|mac/i.test(name) && !rows.has(nwVersion))
      rows.set(nwVersion, { version: nwVersion, details: { greenworksVersion }, assets: [asset] });
  }
  return [...rows.values()];
} });

function installRootDir(userDataDir) {
  return path.join(userDataDir, "runtimes", "greenworks");
}

function getInstallDir({ userDataDir, nwVersion }) {
  const v = normalizeNwVersion(nwVersion);
  return path.join(installRootDir(userDataDir), v);
}

function metaPath(installDir) {
  return path.join(installDir, INSTALL_META_FILE);
}

function readInstallMeta(installDir) {
  try {
    const p = metaPath(installDir);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeInstallMeta(installDir, payload) {
  try {
    const p = metaPath(installDir);
    ensureDir(path.dirname(p));
    fs.writeFileSync(p, JSON.stringify(payload, null, 2));
  } catch {}
}

function looksLikeGreenworks(dir) {
  const markers = ["greenworks.js", "greenworks.node"];
  return markers.some(name => fs.existsSync(path.join(dir, name)));
}

function checksum(filePath) {
  const stat = fs.statSync(filePath, { bigint: true }), realPath = fs.realpathSync(filePath);
  const identity = JSON.stringify([realPath, String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)]);
  if (checksumCache.has(identity)) return checksumCache.get(identity);
  const value = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  checksumCache.set(identity, value);
  if (checksumCache.size > 128) checksumCache.delete(checksumCache.keys().next().value);
  return value;
}

function bridgeStatus(installDir, { nwVersion } = {}) {
  try {
    const root = fs.realpathSync(installDir), metadata = readInstallMeta(installDir);
    if (metadata?.nwVersion && metadata.nwVersion !== nwVersion) throw new Error("Greenworks metadata does not match its NW.js version.");
    const scriptPath = path.join(installDir, "greenworks.js");
    const scriptStat = fs.statSync(scriptPath);
    if (!scriptStat.isFile() || scriptStat.size === 0 || scriptStat.size > 2 * 1024 * 1024) throw new Error("Greenworks JavaScript entry is missing or invalid.");
    const candidates = ["lib/greenworks-osx.node", "lib/greenworks-osx64.node", "greenworks-osx.node", "greenworks-osx64.node", "greenworks.node"];
    const nativePath = candidates.map(relative => path.join(installDir, relative)).find(candidate => fs.existsSync(candidate));
    if (!nativePath) throw new Error("Greenworks native macOS bridge is missing.");
    for (const filePath of [scriptPath, nativePath]) {
      const relative = path.relative(root, fs.realpathSync(filePath));
      if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("Greenworks payload references a file outside its installation.");
    }
    const consumer = inspectNativeSteamConsumer(nativePath);
    Native.readMachOArchitectures(nativePath, { allowLibrary: true });
    if (consumer.format !== "mach-o" || !consumer.architectures.some(arch => arch === "arm64" || arch === "x86_64")) throw new Error("Greenworks native bridge is not a supported macOS binary.");
    const payload = [scriptPath, nativePath].map(filePath => ({ path: path.relative(installDir, filePath).split(path.sep).join("/"), sha256: checksum(filePath) }));
    if (metadata?.files && (!Array.isArray(metadata.files) || metadata.files.length !== payload.length ||
      payload.some(file => !metadata.files.some(record => record.path === file.path && record.sha256 === file.sha256)))) throw new Error("Greenworks bridge changed since installation.");
    return { ready: true, reason: null, scriptPath, nativePath, architectures: consumer.architectures,
      files: payload, requiresEncryptedTicket: consumer.dependencies.some(dependency =>
        path.basename(dependency.library) === "libsdkencryptedappticket.dylib"),
      source: metadata?.downloadUrl || null, archiveSha256: metadata?.archiveSha256 || null };
  } catch (error) {
    return { ready: false, reason: String(error.message || error) };
  }
}

// The shallowest folder with the bridge files, wherever the archive places it.
function findGreenworksRoot(extractedDir) {
  if (looksLikeGreenworks(extractedDir)) return extractedDir;
  return Archive.findEntry(extractedDir, (file, item) => item.isDirectory() && looksLikeGreenworks(file), { maxDepth: 3 }) || extractedDir;
}

function listInstalled(userDataDir) {
  const root = installRootDir(userDataDir);
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const version = entry.name;
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
    const installDir = path.join(root, version);
    const meta = readInstallMeta(installDir);
    if (!looksLikeGreenworks(installDir) && !meta) continue;
    out.push({
      version,
      installDir,
      greenworksVersion: meta?.greenworksVersion || null,
      platformKey: meta?.greenworksVersion ? `gw ${meta.greenworksVersion}` : null,
      ...bridgeStatus(installDir, { nwVersion: version })
    });
  }

  out.sort((a, b) => compareSemverDesc(a.version, b.version));
  return out;
}

// One row per NW.js version, from the newest Greenworks release that serves it.
async function fetchAvailableVersions({ logger, signal } = {}) {
  const rows = [], seen = new Set();
  for (const row of (await source.discover({ logger, signal })).slice()
    .sort((a, b) => compareSemverDesc(a.details?.greenworksVersion, b.details?.greenworksVersion))) {
    if (!seen.has(row.version) && row.files.length) { seen.add(row.version); rows.push(row); }
  }
  rows.sort((a, b) => compareSemverDesc(a.version, b.version));
  return { versions: rows.map(row => row.version), source: "https://github.com/greenheartgames/greenworks/releases", rows };
}

async function installVersion({
  userDataDir,
  nwVersion,
  logger,
  onProgress,
  rows,
  signal,
  dependencies = {}
} = {}) {
  const v = normalizeNwVersion(nwVersion);
  const existing = listInstalled(userDataDir).find(item => item.version === v && item.ready !== false);
  if (existing) return existing;
  // The archive is read by its published name: ZIP, tar or disk image.
  const extract = dependencies.extract || ReleaseFiles.extractArchive;
  const listed = (Array.isArray(rows) && rows.some(row => row.version === v) ? rows : (await fetchAvailableVersions({ logger, signal })).rows)
    .find(row => row.version === v);
  const file = listed?.files?.[0];
  if (!file) throw new Error(`No Greenworks asset found for NW.js v${v}`);

  const downloadUrl = file.url;
  const installRoot = installRootDir(userDataDir);
  ensureDir(installRoot);
  const tmpDir = fs.mkdtempSync(path.join(installRoot, ".install-"));
  const zipPath = path.join(tmpDir, file.name);
  const extractDir = path.join(tmpDir, "extract");
  const installDir = getInstallDir({ userDataDir, nwVersion: v });

  try {
    logger?.info?.(`[greenworks] downloading ${downloadUrl}`);
    const { sha256: archiveSha256, integrity } = await source.download(file, zipPath, { onProgress, signal });
    throwIfAborted(signal);
    logger?.info?.(`[greenworks] extracting ${path.basename(zipPath)}`);
    ensureDir(extractDir);
    await extract(zipPath, extractDir, signal);
    throwIfAborted(signal);
    const root = findGreenworksRoot(extractDir);
    const status = bridgeStatus(root, { nwVersion: v });
    if (!status.ready) throw new Error(status.reason);
    writeInstallMeta(root, { nwVersion: v, greenworksVersion: listed.details?.greenworksVersion || null,
      assetName: file.name, downloadUrl, archiveSha256, integrity,
      files: status.files, installedAt: Date.now() });
    if (!readInstallMeta(root)) throw new Error("Greenworks install metadata could not be saved.");
    const backup = path.join(tmpDir, "previous");
    let replaced = false;
    if (fs.existsSync(installDir)) { fs.renameSync(installDir, backup); replaced = true; }
    try { fs.renameSync(root, installDir); }
    catch (error) { if (replaced) fs.renameSync(backup, installDir); throw error; }
    return listInstalled(userDataDir).find(item => item.version === v);
  } finally {
    safeRm(tmpDir);
  }
}

function uninstallVersion({ userDataDir, nwVersion, installDir } = {}) {
  const target = installDir || getInstallDir({ userDataDir, nwVersion });
  safeRm(target);
  return true;
}

function inspectCustomRuntime(runtimePath) {
  let root = fs.statSync(runtimePath).isDirectory() ? runtimePath : path.dirname(runtimePath);
  if (path.basename(root) === "lib") root = path.dirname(root);
  const metadata = readInstallMeta(root);
  const runtimeVersion = metadata?.nwVersion;
  if (!runtimeVersion || Custom.isPath(runtimeVersion)) throw new Error("The Greenworks runtime requires its NW.js version metadata and JavaScript/native bridge files.");
  normalizeNwVersion(runtimeVersion);
  const status = bridgeStatus(root, { nwVersion: runtimeVersion });
  if (!status.ready) throw new Error(status.reason);
  return { ...status, installDir: root, root, runtimeVersion,
    greenworksVersion: metadata.greenworksVersion, executablePath: status.nativePath };
}

module.exports = {
  inspectCustomRuntime,
  installRootDir,
  bridgeStatus,
  getInstallDir,
  listInstalled,
  fetchAvailableVersions,
  installVersion,
  uninstallVersion,
  normalizeNwVersion,
  source
};
