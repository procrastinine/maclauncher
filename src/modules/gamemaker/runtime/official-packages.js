const fs = require("node:fs");
const path = require("node:path");
const { downloadToFile } = require("../../shared/runtime/download-utils");
const { runDownloadTask } = require("../../shared/runtime/download-manager");

function getCatalogVersion(version, userDataDir) {
  try {
    const release = require("./official-installer").resolveBuild({ userDataDir, version });
    return { ...release, packages: release.packages.filter(item => ["core", "mac"].includes(item.module)),
    packageFormat: "encrypted-vendor-zip", launchReady: false, discovered: true };
  } catch { throw new Error(`Public official package version '${version}' is not in the current or cached catalog. Refresh and select an exact version.`); }
}
function cachedPackages(userDataDir, version) {
  try {
    const build = getCatalogVersion(version, userDataDir);
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
  } catch { return null; }
}

async function downloadPublicPackages({ userDataDir, version, signal, onProgress, download = downloadToFile }) {
  const build = getCatalogVersion(version, userDataDir);
  const existing = cachedPackages(userDataDir, version);
  if (existing) return existing;
  await require("./official-installer").cacheArtifacts({ userDataDir, build, signal, onProgress, download });
  const result = cachedPackages(userDataDir, version);
  if (!result) throw new Error("Official package cache did not pass its recorded integrity check.");
  return result;
}

function downloadOfficialRuntime({ downloads, onProgress, ...options } = {}) {
  const version = options.version;
  const build = getCatalogVersion(version, options.userDataDir);
  return runDownloadTask(downloads, { label: build.family === "studio-1.4" ? "Official Studio 1.4 Mac package" : "Official GameMaker Core + macOS packages", detail: `${version} (package cache)`,
    kind: "runtime-package", managerId: "gamemaker-official", sectionId: "default", version,
    dedupeKey: `official-gamemaker-packages:${version}` }, task => downloadPublicPackages({ ...options, version,
    signal: task.signal, onProgress: task.onProgress }), { onProgress });
}

module.exports = { getCatalogVersion, cachedPackages, downloadPublicPackages, downloadOfficialRuntime };
