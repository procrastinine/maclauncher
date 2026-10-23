const fs = require("node:fs");
const path = require("node:path");
const { hashFile } = require("../inspect");
const { downloadToFile, throwIfAborted } = require("../../shared/runtime/download-utils");
const { runDownloadTask } = require("../../shared/runtime/download-manager");

const FEED_URL = "https://gms.yoyogames.com/Zeus-Runtime-LTS2026.rss";
const CATALOG = Object.freeze([Object.freeze({ version: "2026.0.0.23", channel: "LTS2026", source: FEED_URL,
  releaseNotesUrl: "https://releases.gamemaker.io/release-notes/2026/0", packageFormat: "encrypted-vendor-zip",
  backend: "official-studio-vm", launchReady: false, packages: Object.freeze([
    Object.freeze({ module: "core", filename: "153c14b9-b540-4e13-a7a9-a0b7f451f72a.zip",
      url: "https://gms.yoyogames.com/153c14b9-b540-4e13-a7a9-a0b7f451f72a.zip", bytes: 7137554,
      sha256: "0f74e8d66e59ec63dd31a2612e8aea06b703a617765ab5c3cd29b592b08d5eb1" }),
    Object.freeze({ module: "mac", filename: "8043e028-1e87-451f-93dd-0d6593f30ac7.zip",
      url: "https://gms.yoyogames.com/8043e028-1e87-451f-93dd-0d6593f30ac7.zip", bytes: 11894986,
      sha256: "0a4d1cc21ee768414655d60ea39f779dbae31e7b3724126894ad92e09eed01ef" })
  ]) })]);

function getCatalogVersion(version, userDataDir) {
  const build = CATALOG.find(item => item.version === version);
  if (build) return build;
  try {
    const release = require("./official-installer").resolveBuild({ userDataDir, version });
    return { ...release, packages: release.packages.filter(item => ["core", "mac"].includes(item.module)),
      packageFormat: "encrypted-vendor-zip", launchReady: false, discovered: true };
  } catch { throw new Error(`Public official package version '${version}' is not in the current or cached catalog. Refresh and select an exact version.`); }
}
function packageRoot(userDataDir, version) {
  if (typeof userDataDir !== "string" || !path.isAbsolute(userDataDir)) throw new Error("An absolute launcher data directory is required.");
  getCatalogVersion(version);
  let current = userDataDir;
  for (const part of ["runtimes", "gamemaker-official", "packages", version]) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("Official package cache contains a symlink.");
  }
  return current;
}
function cachedPackages(userDataDir, version) {
  try {
    const build = getCatalogVersion(version, userDataDir);
    if (build.discovered) {
      const root = path.join(userDataDir, "runtimes", "gamemaker-official", "artifacts", version);
      const observed = JSON.parse(fs.readFileSync(path.join(root, `observed-${process.arch}.json`), "utf8"));
      const packages = build.packages.map(pin => {
        const entry = observed[pin.filename];
        if (!pin.sha256 && (!entry || entry.url !== pin.url || entry.bytes !== pin.bytes || entry.signature !== pin.signature || !/^[a-f0-9]{64}$/.test(entry.sha256 || ""))) throw new Error("Official package lacks its recorded feed provenance.");
        const sha256 = pin.sha256 || entry.sha256, localPath = path.join(root, pin.filename);
        require("./official-installer").checkArtifact(localPath, { ...pin, sha256 });
        return { ...pin, sha256, localPath, integrity: pin.sha256 ? "reviewed-sha256" : "official-https-observed-sha256" };
      });
      return { version, packagesRoot: root, packages, packageFormat: build.packageFormat, backend: build.backend,
        downloaded: true, installed: false, launchReady: false, source: build.source,
      qualification: "Official packages downloaded. Runtime installation is still required." };
    }
    const root = packageRoot(userDataDir, version);
    const packages = build.packages.map(item => ({ ...item, localPath: path.join(root, item.filename) }));
    if (packages.some(item => !fs.statSync(item.localPath).isFile() || fs.statSync(item.localPath).size !== item.bytes || hashFile(item.localPath) !== item.sha256)) return null;
    return { version, packagesRoot: root, packages, packageFormat: build.packageFormat, backend: build.backend,
      downloaded: true, installed: false, launchReady: false,
      qualification: "Official ZIPs are encrypted; GameMaker installation is required before runtime import.",
      source: build.source };
  } catch { return null; }
}

async function downloadPublicPackages({ userDataDir, version = CATALOG[0].version, signal, onProgress, download = downloadToFile }) {
  const build = getCatalogVersion(version, userDataDir);
  const existing = cachedPackages(userDataDir, version);
  if (existing) return existing;
  if (build.discovered) {
    await require("./official-installer").cacheArtifacts({ userDataDir, build, signal, onProgress, download });
    const result = cachedPackages(userDataDir, version);
    if (!result) throw new Error("Official package cache did not pass its recorded integrity check.");
    return result;
  }
  const root = packageRoot(userDataDir, version);
  fs.mkdirSync(path.dirname(root), { recursive: true });
  if (fs.existsSync(root)) throw new Error("Remove the incomplete official package cache before retrying.");
  const temporary = fs.mkdtempSync(path.join(path.dirname(root), ".download-"));
  try {
    let completed = 0;
    const totalBytes = build.packages.reduce((sum, item) => sum + item.bytes, 0);
    for (const item of build.packages) {
      throwIfAborted(signal);
      const target = path.join(temporary, item.filename);
      await download(item.url, target, { signal, onProgress: progress => onProgress?.({
        downloaded: completed + progress.downloaded, total: totalBytes
      }) });
      if (fs.statSync(target).size !== item.bytes || hashFile(target) !== item.sha256) throw new Error("Official package size or SHA-256 does not match this release.");
      completed += item.bytes;
    }
    fs.writeFileSync(path.join(temporary, "packages.json"), JSON.stringify({ ...build, downloadedAt: new Date().toISOString(),
      installed: false, launchReady: false, vendorInstallationRequired: true }, null, 2) + "\n");
    throwIfAborted(signal);
    fs.renameSync(temporary, root);
    const result = cachedPackages(userDataDir, version);
    if (!result) throw new Error("Official package cache did not pass its final integrity check.");
    return result;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function downloadOfficialRuntime({ downloads, onProgress, ...options } = {}) {
  const version = options.version || CATALOG[0].version;
  getCatalogVersion(version, options.userDataDir);
  return runDownloadTask(downloads, { label: version === "1.4.9999" ? "Official Studio 1.4 Mac package" : "Official GameMaker Core + macOS packages", detail: `${version} (package cache)`,
    kind: "runtime-package", managerId: "gamemaker-official", sectionId: "default", version,
    dedupeKey: `official-gamemaker-packages:${version}` }, task => downloadPublicPackages({ ...options, version,
      signal: task.signal, onProgress: task.onProgress }), { onProgress });
}

module.exports = { FEED_URL, CATALOG, getCatalogVersion, cachedPackages, downloadPublicPackages, downloadOfficialRuntime };
