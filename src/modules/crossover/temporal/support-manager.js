const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createGithubReleaseDiscovery } = require("../../shared/runtime/github-runtime-catalog");
const { extractArchive } = require("../sikarugir/runtime/archive");
const Catalog = require("./catalog"), VERSION = Catalog.RECOMMENDED_VERSION;
const PIN = Catalog.CATALOG.find(pin => pin.version === VERSION), BASE = PIN.cameraBridge;
const FILES = Object.freeze(["wine/x86_64-unix/winemetal.so", "wine/x86_64-windows/winemetal.dll", "wine/x86_64-windows/nvapi64.dll", "wine/x86_64-windows/d3d10core.dll", "LICENSE", "version"]);
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const verifiedCache = new Map();
async function prepareInstall({ unpacked, pin, signal }) {
  const original = path.join(unpacked, `Template-${pin.version}.app`), source = path.join(original, "Contents/Frameworks/renderer/dxmt"), target = path.join(unpacked, "dxmt"), files = {};
  for (const relative of FILES) {
    signal?.throwIfAborted();const file = path.join(source, relative), stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 128 * 1024 * 1024 || !fs.realpathSync(file).startsWith(fs.realpathSync(source) + path.sep)) throw Error("The DXMT support archive is incomplete.");
    const destination = path.join(target, relative);fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file, destination, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL);files[relative] = hash(destination);
  }
  fs.rmSync(original, { recursive: true });return { schema: 1, files };
}
function verified(install, { verification = "full" } = {}) {
  if (!install?.installDir || install.installationMetadata?.schema !== 1) return null;
  try {
    const directory = path.join(install.installDir, "dxmt");
    const stamp = JSON.stringify([install.installationMetadata, FILES.map(file => {
      const value = fs.statSync(path.join(directory, file));return [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs];
    })]);
    if (verification === "status" && verifiedCache.get(directory) === stamp) return { ...install, baseRoot: path.join(directory, "wine") };
    if (FILES.some(file => hash(path.join(directory, file)) !== install.installationMetadata.files?.[file])) return null;
    if (verifiedCache.size > 16) verifiedCache.clear();verifiedCache.set(directory, stamp);
    return { ...install, baseRoot: path.join(directory, "wine") };
  } catch { return null; }
}
function createManager({ runtimeId = "crossover", dependencies = {}, catalog = Catalog.CATALOG, recommendedVersion = Catalog.RECOMMENDED_VERSION } = {}) {
  if (!["crossover", "sikarugir"].includes(runtimeId)) throw Error("Unsupported graphics bridge runtime.");
  const base = createPinnedNativeManager({ id: runtimeId + "-graphics-bridge", label: (runtimeId === "crossover" ? "CrossOver" : "Sikarugir") + " DXMT support", nativeLibrary: true,
    sourceUrl: Catalog.SOURCE_URL, catalog, recommendedVersion,
    discoverCatalog: createGithubReleaseDiscovery({ owner: "Sikarugir-App", repo: "Template", dependencies,
      mapRelease: (release, { githubAssetDigest }) => catalog.filter(pin => release.assets?.some(asset =>
        asset.name === pin.asset.filename && asset.browser_download_url === pin.asset.url &&
        githubAssetDigest(asset) === pin.asset.sha256 && asset.size === pin.asset.bytes)) }),
    resolveExecutable: root => path.join(root, "dxmt/wine/x86_64-unix/winemetal.so"), prepareInstall,
    dependencies: { ...dependencies, extractArchive: dependencies.extractArchive || extractArchive } });
  const resolveSelection = (entry, settings, userDataDir, options = {}) => {
    const selected = base.resolveSelection(entry, settings, userDataDir, options);
    if (!selected.install) return selected;
    const install = verified(selected.install, options);return { ...selected, install, ready: Boolean(install), reason: install ? null : "The DXMT camera libraries changed. Reinstall this version." };
  };
  return { ...base, ui: { groupId: runtimeId, tabLabel: runtimeId === "crossover" ? "CrossOver" : "Sikarugir", sectionLabel: "DXMT support", order: runtimeId === "crossover" ? 200 : 201, memberOrder: 1, management: "managed" }, resolveSelection,
    getState(options = {}) {
      const state = base.getState(options), installed = state.installed.map(item => verified(item, { verification: "status" }) ? item : { ...item, ready: false, status: "damaged" });
      return { ...state, installed, sections: state.sections.map(section => ({ ...section, installed, label: "DXMT support", description: "DXMT libraries for temporal upscaling. The camera adapter is included with MacLauncher; matching support libraries are reused from Wine or downloaded after consent." })) };
    },
    core: { ...base.core, resolveInstalled: options => verified(base.core.resolveInstalled(options), options), listInstalled: userDataDir => base.core.listInstalled(userDataDir).map(item => verified(item)).filter(Boolean) }
  };
}
const managers = Object.freeze({ crossover: createManager(), sikarugir: createManager({ runtimeId: "sikarugir" }) });
module.exports = { ...managers.crossover, managers, forRuntime: runtimeId => managers[runtimeId] || null, createManager, VERSION, PIN, BASE, FILES, prepareInstall, verified };
