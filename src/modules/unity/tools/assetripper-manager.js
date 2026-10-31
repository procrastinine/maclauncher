const fs = require("node:fs");
const path = require("node:path");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const Upstream = require("../../shared/runtime/upstream");
const { macDownloads } = require("../../shared/runtime/release-files");
const Native = require("../../shared/runtime/local-native");
const Architecture = require("../../shared/runtime/architecture");
const MachO = require("../../shared/runtime/macho-load-commands");
const { systemVersionSync, versionAtLeast } = require("../../shared/runtime/bundled-native");
const Archive = require("../../shared/runtime/archive");
const SOURCE = "https://github.com/AssetRipper/AssetRipper/releases";
const EXECUTABLE = "AssetRipper.GUI.Free";
const safeRelative = value => typeof value === "string" && value && !path.posix.isAbsolute(value) &&
  !/[\\\x00-\x1f]/.test(value) && value.split("/").every(part => part && part !== "." && part !== "..");
function compatibleVersion(value) {
  const match = /^(?:v)?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(value || "");
  if (!match) return null;
  const [major, minor, patch = 0] = match.slice(1).map(Number);
  return major > 1 || major === 1 && (minor > 3 || minor === 3 && patch >= 10) ? value.replace(/^v/, "") : null;
}
// Releases from 1.3.10, one Mac archive per CPU. Each CPU build shares the
// release version; the macOS floor is read from the installed binaries.
const upstream = Upstream.github({ repository: "AssetRipper/AssetRipper", allArchitectures: true,
  recognize: release => {
    const version = compatibleVersion(release.tag_name);
    if (!version) return null;
    const downloads = macDownloads(release.assets, { preferred: ["arm64", "x64"].map(cpu => `AssetRipper_mac_${cpu}.zip`) });
    return downloads.length ? downloads.map(({ asset, architecture }) => ({ version, architecture, assets: [asset] }))
      : { version, installReason: "This release has no macOS download." };
  } });
function inventory(root) {
  const files = {}; let bytes = 0;
  function walk(directory, prefix = "", depth = 0) {
    if (depth > 16) throw new Error("AssetRipper package nesting exceeds its limit.");
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix + item.name, file = path.join(directory, item.name);
      if (!safeRelative(relative) || item.isSymbolicLink()) throw new Error("AssetRipper package contains an unsafe file.");
      if (item.isDirectory()) walk(file, relative + "/", depth + 1);
      else if (item.isFile()) {
        const stat = fs.statSync(file);
        if (Object.keys(files).length >= 4000 || (bytes += stat.size) > 2 * 1024 ** 3) throw new Error("AssetRipper package exceeds its size limit.");
        files[relative] = { size: stat.size, sha256: Native.hashFile(file), mode: stat.mode & 0o777 };
      }
    }
  }
  walk(root); return files;
}
// A package that moved its files into a folder is flattened, so the
// installation keeps the application at its root.
function packageRoot(unpacked) {
  const executable = Archive.findEntry(unpacked, (file, item) => item.isFile() && item.name === EXECUTABLE);
  if (!executable) throw new Error("AssetRipper package is missing its native application.");
  const directory = path.dirname(executable);
  if (directory === unpacked) return;
  const moved = path.join(path.dirname(unpacked), `.assetripper-${process.pid}-${Date.now()}`);
  fs.renameSync(directory, moved);
  for (const item of fs.readdirSync(unpacked)) fs.rmSync(path.join(unpacked, item), { recursive: true, force: true });
  for (const item of fs.readdirSync(moved)) fs.renameSync(path.join(moved, item), path.join(unpacked, item));
  fs.rmdirSync(moved);
}
function prepareInstall({ unpacked, signal, pin }, dependencies = {}) {
  const architecture = ["arm64", "x64"].includes(pin?.architecture) ? pin.architecture : dependencies.architecture || Architecture.selectedArchitecture();
  packageRoot(unpacked);
  const files = inventory(unpacked);
  if (!files[EXECUTABLE]) throw new Error("AssetRipper package is missing its native application.");
  let minimumMacOS = "0.0";
  for (const relative of Object.keys(files).filter(name => name === EXECUTABLE || name.endsWith(".dylib"))) {
    const image = MachO.readMachOLoadCommands(path.join(unpacked, relative), { signal, architecture });
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
  return { files, minimumMacOS, architecture };
}
function createManager({ dependencies = {} } = {}) {
  const core = createPinnedNativeManager({ id: "assetripper", label: "AssetRipper", supportsDefault: true,
    upstream, sourceUrl: SOURCE, resolveExecutable: root => path.join(root, EXECUTABLE),
    prepareInstall: options => prepareInstall(options, dependencies), dependencies });
  const checked = new Map();
  function verifyInstall(install) {
    try {
      const metadata = install?.installationMetadata;
      if (!metadata?.files?.[EXECUTABLE] || !["arm64", "x64"].includes(metadata.architecture) ||
        Object.keys(metadata.files).length > 4000 || !versionAtLeast((dependencies.systemVersionSync || systemVersionSync)(), metadata.minimumMacOS)) return null;
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
    __test: { createManager, upstream, compatibleVersion, inventory, prepareInstall, packageRoot, verifyInstall, EXECUTABLE }
  };
}
module.exports = createManager();
