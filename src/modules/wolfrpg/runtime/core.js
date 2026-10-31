const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const Zip = require("../../shared/runtime/zip");
const { assertOwnDirectory } = require("../../shared/writable-input");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const Upstream = require("../../shared/runtime/upstream");

const CATALOG_URL = "https://frostyhowl.com/browser-woditor/";
const SOURCE_LABEL = "Browser Woditor downloads";
const REQUIRED_FILES = ["index.html", "woditor.js", "woditor.wasm", "lib/system.js", "DefaultFont.ttf", "DefaultSoundFont.sf2", "LICENSE/LICENSE.txt"];
function normalizeVersion(value) {
  const version = String(value || "").trim().replace(/^v/i, "");
  if (!/^\d+(?:\.\d+){1,3}$/.test(version)) throw new Error("Invalid Browser Woditor version.");
  return version;
}
function compareVersions(a, b) {
  const aa = normalizeVersion(a).split(".").map(Number), bb = normalizeVersion(b).split(".").map(Number);
  for (let index = 0; index < 4; index++) if ((aa[index] || 0) !== (bb[index] || 0)) return (aa[index] || 0) - (bb[index] || 0);
  return 0;
}
const compareVersionsDesc = (a, b) => compareVersions(b, a);
// The publisher's download links, named like BrowserWoditor_0_6_2_0.zip.
// Another separator, a shorter version or a frostyhowl.com subdomain is read
// the same way; a link that cannot be read is skipped and the others stay listed.
function collectCatalog(html) {
  const records = {};
  for (const match of String(html || "").matchAll(/href\s*=\s*["']([^"']*Browser[-_ ]?Woditor[-_ ]?v?(\d+(?:[._-]\d+){1,3})\.zip)(?:[?#][^"']*)?["']/gi)) {
    try {
      const version = normalizeVersion(match[2].replace(/[_-]/g, "."));
      const url = new URL(match[1].replace(/&amp;/g, "&"), CATALOG_URL);
      if (url.protocol !== "https:" || !/(?:^|\.)frostyhowl\.com$/.test(url.hostname) || records[version]) continue;
      records[version] = { version, downloadUrl: url.href, assetName: path.posix.basename(url.pathname) };
    } catch {}
  }
  return { versions: Object.keys(records).sort(compareVersionsDesc), releasesByVersion: records, source: SOURCE_LABEL };
}
// The download page lists every version; the publisher states no digest, so
// each archive's SHA-256 is recorded at installation.
const source = Upstream.index({ locations: [CATALOG_URL], hosts: ["frostyhowl.com"], parse: ([page]) =>
  Object.values(collectCatalog(page.text).releasesByVersion).map(record => ({ version: record.version, sourceUrl: CATALOG_URL,
    files: [{ name: record.assetName, url: record.downloadUrl }] })) });
async function fetchAvailableVersions({ signal, logger } = {}) {
  const releasesByVersion = {};
  for (const row of await source.discover({ signal, logger })) {
    const file = row.files[0];
    if (file && !releasesByVersion[row.version]) releasesByVersion[row.version] = { version: row.version, downloadUrl: file.url, assetName: file.name, file };
  }
  const versions = Object.keys(releasesByVersion).sort(compareVersionsDesc);
  if (!versions.length) throw new Error("No Browser Woditor downloads were found.");
  return { versions, releasesByVersion, source: SOURCE_LABEL };
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
  // An archive that wraps the runtime in a folder is read from that folder.
  const index = archive.entries.map(item => String(item.name).replace(/\\/g, "/")).filter(name => /(?:^|\/)public\/index\.html$/.test(name) && !name.startsWith("__MACOSX/"))
    .sort((a, b) => a.length - b.length)[0];
  const prefix = index ? index.slice(0, -"public/index.html".length) : "";
  for (const item of archive.entries) {
    const original = String(item.name).replace(/\\/g, "/");
    if (original.split("/").some(part => part === "..") || original.startsWith("/") || original.includes("\0")) throw new Error("Unsafe Browser Woditor archive path.");
    if (!original.startsWith(prefix)) continue;
    const name = original.slice(prefix.length);
    const publicFile = name.startsWith("public/") && !name.endsWith("/");
    if (!publicFile && name !== "BrowserWoditor.dat" && !name.endsWith("/BrowserWoditor.dat")) continue;
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
  if (!selected?.file) selected = (await fetchAvailableVersions({ signal })).releasesByVersion[normalized];
  if (!selected?.file) throw new Error(`Browser Woditor ${normalized} is not available for download.`);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-woditor-"));
  const root = installRootDir(userDataDir), installDir = getInstallDir({ userDataDir, version: normalized });
  assertOwnDirectory(userDataDir, root);
  assertOwnDirectory(root, installDir, { create: false });
  const staging = path.join(root, ".install-" + crypto.randomUUID());
  try {
    const archive = path.join(temporary, "runtime.zip");
    const { sha256, integrity } = await source.download(selected.file, archive, { onProgress, signal });
    throwIfAborted(signal); fs.mkdirSync(staging);
    extractRuntime(archive, staging, normalized);
    fs.writeFileSync(path.join(staging, "install.json"), JSON.stringify({ version: normalized, source: CATALOG_URL, downloadUrl: selected.file.url, sha256, integrity, installedAt: new Date().toISOString() }, null, 2) + "\n");
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
module.exports = { CATALOG_URL, SOURCE_LABEL, REQUIRED_FILES, normalizeVersion, compareVersions, compareVersionsDesc, collectCatalog, fetchAvailableVersions, source, installRootDir, getInstallDir, listInstalled, resolveInstalled, extractRuntime, installVersion, uninstallVersion };
