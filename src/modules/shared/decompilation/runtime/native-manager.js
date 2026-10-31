const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createPinnedNativeManager, hashFile } = require("../../runtime/pinned-native-manager");
const Upstream = require("../../runtime/upstream");
const MachO = require("../../runtime/macho-load-commands");
const Architecture = require("../../runtime/architecture");
const { systemVersionSync, versionAtLeast } = require("../../runtime/bundled-native");
const { excludedReason } = require("../../runtime/runtime-content");
const { macDownloads, locatePackaged } = require("../../runtime/release-files");
const exec = promisify(execFile);
const SOURCE = "https://github.com/rizinorg/cutter/releases";
const PLUGIN = "lib/rizin/plugins/core_ghidra.dylib";
const safe = name => typeof name === "string" && name && !path.isAbsolute(name) && !/[\\\x00-\x1f]/.test(name) && name.split("/").every(p => p && p !== "." && p !== "..");

// Releases from 2.0.0. Each CPU build shares the release version; the macOS
// floor is read from the installed binaries.
function recognize(release) {
  const version = /^v?(\d+\.\d+\.\d+)$/.exec(release.tag_name || "")?.[1];
  if (!version || Number(version.split(".")[0]) < 2) return null;
  const current = ["arm64", "x86_64"].map(cpu => `Cutter-v${version}-macOS-${cpu}.dmg`);
  const downloads = macDownloads((release.assets || []).filter(item => /cutter/i.test(item?.name || "")), { preferred: current });
  return downloads.length ? downloads.map(({ asset, architecture }) => ({ version, architecture, assets: [asset] }))
    : { version, installReason: "This release has no macOS download." };
}
const upstream = Upstream.github({ repository: "rizinorg/cutter", allArchitectures: true, recognize });

// The shared installer unpacks the disk image or archive. Only the command-line
// tools leave Cutter's app bundle, which a publisher may move into a folder.
const appResources = root => locatePackaged(root, "Cutter.app/Contents/Resources");
function selectPayload(unpacked) {
  const resources = appResources(unpacked);
  if (!resources) throw new Error("The Cutter package does not contain Cutter.app.");
  const source = fs.realpathSync(resources), payload = fs.mkdtempSync(path.join(unpacked, ".payload-"));
  const copy = relative => {
    const file = path.join(source, relative), real = fs.realpathSync(file);
    if (!real.startsWith(source + path.sep)) throw new Error("Native tool payload contains an external link.");
    const target = path.join(payload, relative), stat = fs.statSync(real);
    if (stat.isDirectory()) {
      fs.mkdirSync(target, { recursive: true });
      for (const name of fs.readdirSync(real)) if (!excludedReason(relative + "/" + name)) copy(relative + "/" + name);
    } else if (stat.isFile()) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(real, target); }
  };
  for (const relative of ["bin/rizin", "bin/rz-bin", PLUGIN, "lib/rizin/plugins/rz_ghidra_sleigh", "share/rizin"]) copy(relative);
  for (const name of fs.readdirSync(path.join(source, "lib"))) if (/^librz_.*\.\d+\.\d+\.dylib$/.test(name)) copy("lib/" + name);
  for (const name of fs.readdirSync(unpacked)) if (path.join(unpacked, name) !== payload) fs.rmSync(path.join(unpacked, name), { recursive: true, force: true });
  for (const name of fs.readdirSync(payload)) fs.renameSync(path.join(payload, name), path.join(unpacked, name));
  fs.rmdirSync(payload);
  fs.cpSync(path.join(__dirname, "..", "resources", "native-notices"), path.join(unpacked, "notices"), { recursive: true });
}

function inventory(root) {
  const files = {}; let bytes = 0;
  function walk(directory, prefix = "") {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix + item.name, file = path.join(directory, item.name);
      if (!safe(relative) || item.isSymbolicLink()) throw new Error("Native tool payload contains an unsafe path.");
      if (item.isDirectory()) walk(file, relative + "/");
      else if (item.isFile()) {
        const size = fs.statSync(file).size;
        if (Object.keys(files).length >= 10000 || (bytes += size) > 512 * 1024 * 1024) throw new Error("Native tool payload exceeds its size limit.");
        files[relative] = { size, sha256: hashFile(file) };
      }
    }
  }
  walk(root); return files;
}

async function prepareInstall({ unpacked, signal, pin }, dependencies = {}) {
  if (!fs.existsSync(path.join(unpacked, "bin", "rizin"))) selectPayload(unpacked);
  const architecture = ["arm64", "x64"].includes(pin?.architecture) ? pin.architecture : dependencies.architecture || Architecture.selectedArchitecture();
  const run = dependencies.run || exec, files = inventory(unpacked); let minimumMacOS = "0.0";
  for (const relative of Object.keys(files).filter(p => p.startsWith("bin/") || p.endsWith(".dylib"))) {
    const file = path.join(unpacked, relative), image = MachO.readMachOLoadCommands(file, { architecture });
    for (const slice of image.slices) {
      if (!versionAtLeast(minimumMacOS, slice.minimumMacOS)) minimumMacOS = slice.minimumMacOS;
      for (const dependency of slice.dependencies) {
        const name = dependency.path;
        if (name.startsWith("/usr/lib/") || name.startsWith("/System/Library/")) continue;
        if (!name.startsWith("@rpath/") || !files["lib/" + path.basename(name)] && name !== "@rpath/core_ghidra.dylib")
          throw new Error("Native tool package has an unavailable library: " + name);
      }
    }
    fs.chmodSync(file, 0o755);
    // The packaged CLI uses an ELF-style run path. A local signature permits
    // the explicit owned library directory without compiler or linker tools.
    await run("/usr/bin/codesign", ["--force", "--sign", "-", file], { signal });
    await run("/usr/bin/codesign", ["--verify", "--strict", file], { signal });
    files[relative].sha256 = hashFile(file);
    files[relative].size = fs.statSync(file).size;
  }
  if (!versionAtLeast((dependencies.systemVersionSync || systemVersionSync)(), minimumMacOS)) throw new Error(`Native inspection requires macOS ${minimumMacOS} or later.`);
  fs.writeFileSync(path.join(unpacked, "payload.json"), JSON.stringify(files));
  return { manifestSha256: hashFile(path.join(unpacked, "payload.json")), minimumMacOS };
}

function createManager({ dependencies = {} } = {}) {
  const core = createPinnedNativeManager({ id: "native-inspector", label: "Rizin / Ghidra", supportsDefault: true, sourceUrl: SOURCE, upstream,
    resolveExecutable: root => path.join(root, "bin", "rizin"), prepareInstall: options => prepareInstall(options, dependencies), dependencies });
  const checked = new Map();
  function verify(install) {
    try {
      const manifest = path.join(install.installDir, "payload.json");
      if (hashFile(manifest) !== install.installationMetadata?.manifestSha256) return null;
      const files = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (!files[PLUGIN] || !files["bin/rz-bin"] || Object.keys(files).length > 10000) return null;
      const identity = JSON.stringify(Object.entries(files).map(([relative, item]) => {
        if (!safe(relative) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error("Invalid tool inventory.");
        const stat = fs.lstatSync(path.join(install.installDir, relative));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.size) throw new Error("Native tool payload changed.");
        return [relative, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
      }));
      if (checked.get(install.installDir) !== identity) {
        for (const [relative, item] of Object.entries(files)) if (hashFile(path.join(install.installDir, relative)) !== item.sha256) return null;
        checked.set(install.installDir, identity);
      }
      return install;
    } catch { return null; }
  }
  return { ...core, ui: { groupId: "tools", tabLabel: "Tools", sectionLabel: "Rizin / Ghidra", order: 200, memberOrder: 300, management: "managed" },
    getState: options => { const state = core.getState(options), catalog = { ...state.catalog,
      installReason: state.catalog.versions.length ? state.catalog.installReason : "Refresh versions or choose Inspect binary to download the native tools." };
      return { ...state, catalog, sections: [{ ...state.sections[0], label: "Rizin / Ghidra", catalog }] }; },
    resolveSelection: (...args) => { const selected = core.resolveSelection(...args), install = verify(selected.install);
      return { ...selected, install, ready: Boolean(install), reason: install ? null : selected.reason || "Native inspection files changed. Reinstall the selected tool." }; },
    __test: { createManager, recognize, appResources, selectPayload, inventory, prepareInstall, verify } };
}
module.exports = createManager();
