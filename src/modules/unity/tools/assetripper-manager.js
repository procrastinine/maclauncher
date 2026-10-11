const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createGithubReleaseDiscovery } = require("../../shared/runtime/github-runtime-catalog");
const Native = require("../../shared/runtime/local-native");
const MachO = require("../../shared/runtime/macho-load-commands");
const { systemVersionSync, versionAtLeast } = require("../../shared/runtime/bundled-native");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const exec = promisify(execFile);
const SOURCE = "https://github.com/AssetRipper/AssetRipper/releases";
const EXECUTABLE = "AssetRipper.GUI.Free";
const PINS = [
  { version: "2.0.0", upstreamRevision: "1ac666f47d8e9dedf96afb0b914c70d7656151ea", minimumMacOS: "12.0",
    asset: { filename: "AssetRipper_mac_arm64.tar.xz", url: `${SOURCE}/download/2.0.0/AssetRipper_mac_arm64.tar.xz`, bytes: 27205056,
      sha256: "237a6da404bf089c5e5c71a5a9a698c2ea580872292dfa5ce21e25fd1dbe9045" } },
  { version: "1.3.14", upstreamRevision: "7534ed93857d1ef4464bab6e3c7a13777529f94d",
    asset: { filename: "AssetRipper_mac_arm64.zip", url: `${SOURCE}/download/1.3.14/AssetRipper_mac_arm64.zip`, bytes: 43476939,
      sha256: "680890b97c58be02075438814b3f41ec2a928ae0be8e94fa24ad51faa81078aa" } }
].map(pin => ({ ...pin, hostArchitectures: ["arm64"], localBuild: false }));
const safeRelative = value => typeof value === "string" && value && !path.posix.isAbsolute(value) &&
  !/[\\\x00-\x1f]/.test(value) && value.split("/").every(part => part && part !== "." && part !== "..");
function compatibleVersion(value) {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)$/.exec(value || "");
  if (!match) return null;
  const [, major, minor, patch] = match.map(Number);
  return major > 1 || major === 1 && (minor > 3 || minor === 3 && patch >= 10) ? value.replace(/^v/, "") : null;
}
async function mapRelease(release, { resolveRevision, githubAssetDigest, sourceUrl }) {
  const version = compatibleVersion(release.tag_name);
  if (!version || release.draft || release.prerelease) return null;
  const asset = release.assets?.find(item => /^AssetRipper_mac_arm64\.(?:tar\.xz|zip)$/.test(item.name || ""));
  if (!asset || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 128 * 1024 * 1024) return null;
  const sha256 = githubAssetDigest(asset);
  return { version, upstreamRevision: await resolveRevision(release), sourceUrl, hostArchitectures: ["arm64"], localBuild: false,
    asset: { filename: asset.name, url: asset.browser_download_url, bytes: asset.size, assetId: asset.id,
      ...(sha256 ? { sha256 } : { integrity: "recorded-local" }) } };
}
async function extractArchive(archive, destination, signal) {
  throwIfAborted(signal);
  if (archive.endsWith(".zip")) {
    const { readZipEntries } = require("../../shared/runtime/zip");
    const zip = readZipEntries(archive);
    if (!zip?.entries?.length || zip.entries.length > 128 || zip.entries.some(item => !safeRelative(item.name.replace(/\/$/, ""))))
      throw new Error("AssetRipper archive contains invalid paths.");
    await exec("/usr/bin/ditto", ["-x", "-k", archive, destination], { signal, maxBuffer: 1024 * 1024 });
  } else if (archive.endsWith(".tar.xz")) {
    const { stdout } = await exec("/usr/bin/tar", ["-tf", archive], { signal, maxBuffer: 65536 });
    const names = stdout.trim().split("\n");
    if (!names.length || names.length > 128 || names.some(name => !safeRelative(name.replace(/\/$/, ""))))
      throw new Error("AssetRipper archive contains invalid paths.");
    await exec("/usr/bin/tar", ["-xf", archive, "-C", destination], { signal, maxBuffer: 1024 * 1024 });
  } else throw new Error("Unsupported AssetRipper archive.");
}
function inventory(root) {
  const files = {}; let bytes = 0;
  function walk(directory, prefix = "", depth = 0) {
    if (depth > 5) throw new Error("AssetRipper package nesting exceeds its limit.");
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix + item.name, file = path.join(directory, item.name);
      if (!safeRelative(relative) || item.isSymbolicLink()) throw new Error("AssetRipper package contains an unsafe file.");
      if (item.isDirectory()) walk(file, relative + "/", depth + 1);
      else if (item.isFile()) {
        const stat = fs.statSync(file);
        if (Object.keys(files).length >= 128 || (bytes += stat.size) > 512 * 1024 * 1024) throw new Error("AssetRipper package exceeds its size limit.");
        files[relative] = { size: stat.size, sha256: Native.hashFile(file), mode: stat.mode & 0o777 };
      }
    }
  }
  walk(root); return files;
}
function prepareInstall({ unpacked, signal }, dependencies = {}) {
  const files = inventory(unpacked);
  if (!files[EXECUTABLE] || !files["libcapstone.dylib"]) throw new Error("AssetRipper package is missing its native application or Capstone library.");
  let minimumMacOS = "0.0";
  for (const relative of Object.keys(files).filter(name => name === EXECUTABLE || name.endsWith(".dylib"))) {
    const image = MachO.readMachOLoadCommands(path.join(unpacked, relative), { signal, architecture: "arm64" });
    MachO.assertSystemLibraryClosure(image, { fileType: relative === EXECUTABLE ? 2 : 6 });
    for (const slice of image.slices) if (!versionAtLeast(minimumMacOS, slice.minimumMacOS)) minimumMacOS = slice.minimumMacOS;
  }
  const actual = (dependencies.systemVersionSync || systemVersionSync)();
  if (!versionAtLeast(actual, minimumMacOS)) throw new Error(`AssetRipper requires macOS ${minimumMacOS} or later.`);
  // Per-game workspaces share these native files with hard links. Keep the
  // shared payload read-only; settings and temporary output use private files.
  for (const relative of Object.keys(files).filter(name => name === EXECUTABLE || name.endsWith(".dylib"))) {
    files[relative].mode = (files[relative].mode | (relative === EXECUTABLE ? 0o111 : 0)) & ~0o222;
    fs.chmodSync(path.join(unpacked, relative), files[relative].mode);
  }
  return { files, minimumMacOS, architecture: "arm64" };
}
function createManager({ dependencies = {} } = {}) {
  const discoverCatalog = createGithubReleaseDiscovery({ owner: "AssetRipper", repo: "AssetRipper", mapRelease, dependencies });
  const core = createPinnedNativeManager({ id: "assetripper", label: "AssetRipper", catalog: PINS, recommendedVersion: "2.0.0",
    discoverCatalog, sourceUrl: SOURCE, resolveExecutable: root => path.join(root, EXECUTABLE),
    prepareInstall: options => prepareInstall(options, dependencies),
    dependencies: { ...dependencies, extractArchive: dependencies.extractArchive || extractArchive } });
  const checked = new Map();
  function verifyInstall(install) {
    try {
      const metadata = install?.installationMetadata;
      if (!metadata?.files?.[EXECUTABLE] || !metadata.files["libcapstone.dylib"] || metadata.architecture !== "arm64" ||
        Object.keys(metadata.files).length > 128 || !versionAtLeast((dependencies.systemVersionSync || systemVersionSync)(), metadata.minimumMacOS)) return null;
      const identities = Object.entries(metadata.files).map(([relative, record]) => {
        if (!safeRelative(relative) || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error("Invalid AssetRipper inventory.");
        const stat = fs.lstatSync(path.join(install.installDir, relative));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== record.size || (stat.mode & 0o777) !== record.mode) throw new Error("AssetRipper package changed.");
        return [relative, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
      });
      const identity = JSON.stringify([metadata, identities]);
      if (checked.get(install.installDir) !== identity) {
        for (const [relative, record] of Object.entries(metadata.files))
          if (relative !== EXECUTABLE && Native.hashFile(path.join(install.installDir, relative)) !== record.sha256) return null;
        if (checked.size >= 64) checked.delete(checked.keys().next().value);
        checked.set(install.installDir, identity);
      }
      return { ...install, minimumMacOS: metadata.minimumMacOS };
    } catch { return null; }
  }
  return { ...core,
    ui: { groupId: "tools", tabLabel: "Tools", sectionLabel: "AssetRipper", order: 200, memberOrder: 230, management: "managed" },
    resolveSelection: (...args) => {
      const selection = core.resolveSelection(...args), install = verifyInstall(selection.install);
      return { ...selection, install, ready: Boolean(install), reason: install ? null : selection.reason || "AssetRipper files changed. Reinstall the selected version in Runtimes." };
    },
    getState: options => {
      const state = core.getState(options), installed = state.installed.map(install => {
        const verified = install.ready !== false && verifyInstall(install);
        return verified ? { ...install, ...verified } : { ...install, ready: false, error: install.error || "AssetRipper files changed. Reinstall the selected version." };
      });
      const catalog = { ...state.catalog,
        ...(state.catalog.status === "idle" && !state.catalog.versions.length ? {
          installReason: "Refresh versions or start an asset action to download AssetRipper." } : {}) };
      return { ...state, catalog, installed, sections: [{ ...state.sections[0], catalog, label: "AssetRipper", installed }] };
    },
    installRuntime: async options => {
      const installed = await core.installRuntime(options), verified = verifyInstall(installed);
      if (!verified) throw new Error("AssetRipper installation failed its native payload integrity check.");
      return verified;
    },
    __test: { createManager, mapRelease, compatibleVersion, extractArchive, inventory, prepareInstall, verifyInstall, PINS, EXECUTABLE }
  };
}
module.exports = createManager();
