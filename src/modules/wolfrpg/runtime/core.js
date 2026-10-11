const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const Zip = require("../../shared/runtime/zip");
const { assertOwnDirectory } = require("../../shared/writable-input");
const { fetchUrlBuffer, downloadToFile, throwIfAborted } = require("../../shared/runtime/download-utils");

const CATALOG_URL = "https://frostyhowl.com/browser-woditor/";
const SOURCE_LABEL = "Browser Woditor downloads";
const REQUIRED_FILES = ["index.html", "woditor.js", "woditor.wasm", "lib/system.js", "DefaultFont.ttf", "DefaultSoundFont.sf2", "LICENSE/LICENSE.txt"];
function normalizeVersion(value) {
  const version = String(value || "").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid Browser Woditor version.");
  return version;
}
function compareVersions(a, b) {
  const aa = normalizeVersion(a).split(".").map(Number), bb = normalizeVersion(b).split(".").map(Number);
  for (let index = 0; index < 4; index++) if (aa[index] !== bb[index]) return aa[index] - bb[index];
  return 0;
}
const compareVersionsDesc = (a, b) => compareVersions(b, a);
function collectCatalog(html) {
  const records = {};
  for (const match of String(html || "").matchAll(/href\s*=\s*["']([^"']*BrowserWoditor_(\d+)_(\d+)_(\d+)_(\d+)\.zip)["']/gi)) {
    const version = normalizeVersion(match.slice(2, 6).join("."));
    const url = new URL(match[1].replace(/&amp;/g, "&"), CATALOG_URL);
    if (url.protocol !== "https:" || url.hostname !== "frostyhowl.com") continue;
    records[version] = { version, downloadUrl: url.href, assetName: path.posix.basename(url.pathname) };
  }
  return { versions: Object.keys(records).sort(compareVersionsDesc), releasesByVersion: records, source: SOURCE_LABEL };
}
async function fetchAvailableVersions({ signal } = {}) {
  const response = await fetchUrlBuffer(CATALOG_URL, { headers: { "User-Agent": "MacLauncher" }, signal });
  if (response.status !== 200 || response.body.length > 2 * 1024 ** 2) throw new Error("Browser Woditor versions could not be loaded.");
  const catalog = collectCatalog(response.body.toString("utf8"));
  if (!catalog.versions.length) throw new Error("No Browser Woditor downloads were found.");
  return catalog;
}
function installRootDir(userDataDir) { return path.join(userDataDir, "runtimes", "browser-woditor"); }
function getInstallDir({ userDataDir, version }) { return path.join(installRootDir(userDataDir), normalizeVersion(version)); }
function readInstall(installDir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(installDir, "install.json"), "utf8"));
    const version = normalizeVersion(meta.version), contentRoot = path.join(installDir, "public");
    if (path.basename(installDir) !== version) return null;
    if (!REQUIRED_FILES.every(name => fs.statSync(path.join(contentRoot, name)).isFile()) || !fs.statSync(path.join(installDir, "BrowserWoditor.dat")).isFile()) return null;
    return { version, installDir, contentRoot, platformKey: "web", source: SOURCE_LABEL, ready: true, sha256: meta.sha256 || null };
  } catch { return null; }
}
function listInstalled(userDataDir) {
  try {
    return fs.readdirSync(installRootDir(userDataDir), { withFileTypes: true }).filter(item => item.isDirectory() && !item.name.startsWith(".")).map(item => readInstall(path.join(installRootDir(userDataDir), item.name))).filter(Boolean).sort((a, b) => compareVersionsDesc(a.version, b.version));
  } catch { return []; }
}
function resolveInstalled({ userDataDir, version } = {}) {
  const installed = listInstalled(userDataDir);
  return version ? installed.find(item => item.version === normalizeVersion(version)) || null : installed[0] || null;
}
function extractRuntime(archivePath, destination, version) {
  assertOwnDirectory(destination, destination);
  const archive = Zip.readZipEntries(archivePath);
  if (!archive?.entries?.length) throw new Error("The Browser Woditor download is not a ZIP archive.");
  let size = 0, marker = false;
  const paths = new Set();
  if (archive.entries.length > 5000) throw new Error("Browser Woditor download contains too many entries.");
  for (const item of archive.entries) {
    const name = String(item.name).replace(/\\/g, "/");
    if (name.split("/").some(part => part === "..") || name.startsWith("/") || name.includes("\0")) throw new Error("Unsafe Browser Woditor archive path.");
    const publicFile = name.startsWith("public/") && !name.endsWith("/");
    if (!publicFile && !name.endsWith("/BrowserWoditor.dat")) continue;
    // The upstream example is a game, not a runtime dependency.
    if (["public/Data.wolf", "public/Game.ini", "public/InitialDownloadList.ini", "public/settings.js"].includes(name) || name.startsWith("public/assets/")) continue;
    size += Number(item.uncompressedSize || 0);
    if (size > 128 * 1024 ** 2 || Number(item.uncompressedSize) > 64 * 1024 ** 2) throw new Error("Browser Woditor download exceeds the extraction limit.");
    const content = Zip.readZipEntryBuffer(archivePath, item.name);
    if (!content) throw new Error("A Browser Woditor archive entry could not be read.");
    if (content.length !== Number(item.uncompressedSize)) throw new Error("Browser Woditor archive entry size does not match.");
    const relative = publicFile ? name : "BrowserWoditor.dat", file = path.join(destination, relative);
    if (paths.has(relative.toLowerCase())) throw new Error("Duplicate Browser Woditor archive path.");
    paths.add(relative.toLowerCase());
    assertOwnDirectory(destination, path.dirname(file)); fs.writeFileSync(file, content, { flag: "wx", mode: 0o600 });
    if (!publicFile) marker = true;
  }
  if (!marker || !REQUIRED_FILES.every(name => fs.existsSync(path.join(destination, "public", name)))) throw new Error("Browser Woditor runtime files are missing from the download.");
  return { version, extractedBytes: size };
}
async function installVersion({ userDataDir, version, releasesByVersion, onProgress, signal } = {}) {
  const normalized = normalizeVersion(version), existing = resolveInstalled({ userDataDir, version: normalized });
  if (existing) return existing;
  let selected = releasesByVersion?.[normalized];
  if (!selected?.downloadUrl) selected = (await fetchAvailableVersions({ signal })).releasesByVersion[normalized];
  if (!selected?.downloadUrl) throw new Error(`Browser Woditor ${normalized} is not available for download.`);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-woditor-"));
  const root = installRootDir(userDataDir), installDir = getInstallDir({ userDataDir, version: normalized });
  assertOwnDirectory(userDataDir, root);
  assertOwnDirectory(root, installDir, { create: false });
  const staging = path.join(root, ".install-" + crypto.randomUUID());
  try {
    const archive = path.join(temporary, "runtime.zip");
    await downloadToFile(selected.downloadUrl, archive, { headers: { "User-Agent": "MacLauncher" }, onProgress, signal });
    throwIfAborted(signal); fs.mkdirSync(staging);
    extractRuntime(archive, staging, normalized);
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
    fs.writeFileSync(path.join(staging, "install.json"), JSON.stringify({ version: normalized, source: CATALOG_URL, downloadUrl: selected.downloadUrl, sha256, installedAt: new Date().toISOString() }, null, 2) + "\n");
    throwIfAborted(signal);
    fs.rmSync(installDir, { recursive: true, force: true }); fs.renameSync(staging, installDir);
    return readInstall(installDir);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); fs.rmSync(staging, { recursive: true, force: true }); }
}
function uninstallVersion({ userDataDir, version } = {}) {
  const directory = getInstallDir({ userDataDir, version });
  assertOwnDirectory(userDataDir, directory, { create: false });
  fs.rmSync(directory, { recursive: true, force: true }); return true;
}
module.exports = { CATALOG_URL, SOURCE_LABEL, REQUIRED_FILES, normalizeVersion, compareVersions, compareVersionsDesc, collectCatalog, fetchAvailableVersions, installRootDir, getInstallDir, listInstalled, resolveInstalled, extractRuntime, installVersion, uninstallVersion };
