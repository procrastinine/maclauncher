const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { createProjectBuildManager } = require("../../shared/runtime/project-build-manager");
const Bundled = require("../../shared/runtime/bundled-native");
const { createGithubReleaseDiscovery } = require("../../shared/runtime/github-runtime-catalog");
const { extractArchive } = require("../sikarugir/runtime/archive");
const Catalog = require("./catalog");
const { identifiedAsset } = require("../sikarugir/runtime/catalog");
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
function createManager({ runtimeId = "crossover", dependencies = {}, catalog = [], recommendedVersion = "1.0.21" } = {}) {
  if (!["crossover", "sikarugir"].includes(runtimeId)) throw Error("Unsupported graphics bridge runtime.");
  const base = createPinnedNativeManager({ id: runtimeId + "-graphics-bridge", label: (runtimeId === "crossover" ? "CrossOver" : "Sikarugir") + " DXMT support", nativeLibrary: true,
    sourceUrl: Catalog.SOURCE_URL, catalog, recommendedVersion,
    discoverCatalog: createGithubReleaseDiscovery({ owner: "Sikarugir-App", repo: "Template", dependencies,
      mapRelease: release => release.draft || typeof release.tag_name !== "string" ? [] : (release.assets || []).flatMap(asset => {
        const match = /^Template-(\d+\.\d+\.\d+)\.tar\.xz$/.exec(asset.name || ""),
          identified = match && identifiedAsset(asset, "Template", release.tag_name);
        return identified ? [{ version: match[1], versionLabel: `DXMT · support ${match[1]}`, minimumMacOS: "14.0", hostArchitectures: ["arm64"],
          upstreamRevision: `Template-${match[1]}:sha256:${identified.sha256}`, localBuild: false, asset: identified }] : [];
      }) }),
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
    core: { ...base.core, get catalog() { return base.core.catalog; },
      resolveInstalled: options => verified(base.core.resolveInstalled(options), options), listInstalled: userDataDir => base.core.listInstalled(userDataDir).map(item => verified(item)).filter(Boolean) }
  };
}
const WineVulkan = Catalog.VULKAN_PROFILE, FidelityFX = Catalog.FIDELITYFX_PROFILE;
const API_PROJECTS = Object.freeze({
  "winevulkan-scene": { label: "WineVulkan scene adapter", source: "https://www.codeweavers.com/crossover/source" },
  "fidelityfx-api": { label: "FidelityFX API adapter", source: "https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK" }
});
const apiVerified = new Map();
function apiDescriptor(manifest, projectId) {
  const provider = manifest.provider;
  if (provider?.schema !== 1) throw Error("The graphics API package has no supported provider profile.");
  const required = projectId === "winevulkan-scene"
    ? ["x86_64-unix/winevulkan.so", "x86_64-windows/winevulkan.dll", "i386-windows/winevulkan.dll"]
    : [FidelityFX.library, FidelityFX.original];
  if (required.some(name => !manifest.files.some(file => file.path === name))) throw Error("The graphics API package is incomplete.");
  for (const name of required) {
    const file = manifest.files.find(item => item.path === name), architecture = name.startsWith("i386-windows/") ? "x86" : "x86_64";
    if (name.endsWith(".dll") && file.format !== "pe" || !file.architectures?.includes(architecture))
      throw Error("The graphics API package has no matching declared binary format and architecture.");
  }
  if (projectId === "winevulkan-scene") {
    const runtime = provider.runtimeProfile;
    if (provider.profile !== WineVulkan.id || provider.version !== manifest.version || provider.sceneInteropAPI !== 1 || provider.sceneContextAPI !== 1 ||
        provider.wineVulkanDriverVersion !== WineVulkan.driverVersion || provider.originalUnixCallCount !== WineVulkan.unixCallCount ||
        provider.originalGpuWorkRetained !== true || required.some(name => provider.libraries?.[name.split("/")[0]] !== name) ||
        runtime?.id !== WineVulkan.id || runtime.driverVersion !== WineVulkan.driverVersion || runtime.unixCallCount !== WineVulkan.unixCallCount ||
        !Array.isArray(runtime.files) || ["lib/wine/x86_64-unix/win32u.so", "lib/wine/x86_64-unix/winemac.so", ...required.map(name => "lib/wine/" + name)]
          .some(name => !runtime.files.some(file => file.relative === name && /^[a-f0-9]{64}$/.test(file.sha256))))
      throw Error("The WineVulkan package differs from its matched source profile.");
    if (required.some(name => !provider.files?.some(file => file.path === name && file.sha256 === manifest.files.find(row => row.path === name).sha256)))
      throw Error("The WineVulkan provider inventory differs from its package.");
  } else if (provider.profile !== FidelityFX.id || provider.backend !== "vk" || provider.library !== FidelityFX.library ||
      provider.originalLibrary !== FidelityFX.original || provider.referenceSha256 !== FidelityFX.referenceSha256 ||
      provider.observationAPI !== 1 || provider.execution?.originalApiForwarding !== true || provider.execution?.originalGpuWorkRetained !== true ||
      !Array.isArray(provider.sourceExports) || provider.sourceExports.length !== FidelityFX.exports.length ||
      FidelityFX.exports.some(name => !provider.sourceExports.some(item => item.name === name)) ||
      provider.sha256 !== manifest.files.find(file => file.path === FidelityFX.library).sha256 ||
      provider.referenceSha256 !== manifest.files.find(file => file.path === FidelityFX.original).sha256)
    throw Error("The FidelityFX package differs from its original-preserving Vulkan profile.");
  return provider;
}
function verifyAPI(install, projectId, verification = "full") {
  const key = install.root, stamp = install.declaration.files.map(file => Bundled.fileIdentity(path.join(key, file.path), { maximum: file.size })).join("|");
  if (verification !== "status" || apiVerified.get(key) !== stamp) {
    Bundled.verifyPayload(key, install.declaration);
    if (projectId === "fidelityfx-api") {
      const provider = apiDescriptor(install.manifest, projectId), PE = require("./streamline/pe-exports");
      const same = (actual, expected) => actual?.length === expected?.length && actual.every(item => expected.some(row => row.name === item.name && row.ordinal === item.ordinal));
      if (!same(PE.inspect(path.join(install.payloadRoot, provider.library)), provider.exports) ||
          !same(PE.inspect(path.join(install.payloadRoot, provider.originalLibrary)), provider.sourceExports))
        throw Error("The FidelityFX package exports differ from its declared profile.");
    }
    if (apiVerified.size > 16) apiVerified.clear();apiVerified.set(key, stamp);
  }
  return install;
}
function createAPIManager(projectId, dependencies = {}) {
  const definition = API_PROJECTS[projectId];if (!definition) throw Error("Unknown graphics API project.");
  const inspectRuntime = projectId === "fidelityfx-api" ? ({ runtimePath, runtimeVersion, upstreamRevision, expectedSha256 }) => {
    const stat = fs.lstatSync(runtimePath), exports = require("./streamline/pe-exports").inspect(runtimePath);
    if (!stat.isFile() || stat.isSymbolicLink() || !exports || exports.length !== FidelityFX.exports.length + 1 ||
        FidelityFX.exports.some((name, index) => !exports.some(item => item.name === name && item.ordinal === index + 1)) ||
        !exports.some(item => item.name === "MacLauncherFFXObservationAPI1" && item.ordinal === 6))
      throw Error("The FidelityFX runtime is not the complete supported PE adapter.");
    const sha256 = hash(runtimePath);
    if (expectedSha256 && sha256 !== expectedSha256) throw Error("The FidelityFX adapter checksum changed.");
    return { executablePath: runtimePath, architectures: ["x86_64"], needsRosetta: false, runtimeVersion, upstreamRevision, sha256 };
  } : undefined;
  const manager = createProjectBuildManager({ projectId, label: definition.label,
    repository: "procrastinine/maclauncher-builds", upstreamUrl: definition.source, nativeLibrary: true,
    ...(inspectRuntime ? { inspectRuntime } : {}),
    manifestRelative: "manifest.json", sourceRelative: null, executableRelative: manifest => manifest.executableRelative,
    validateManifest: manifest => {
      const provider = apiDescriptor(manifest, projectId);
      if (manifest.executableRelative !== (projectId === "winevulkan-scene" ? provider.libraries["x86_64-unix"] : provider.library))
        throw Error("The graphics API package has an unexpected primary library.");
    },
    verifyPayload: async (selected, { signal } = {}) => {
      verifyAPI(selected, projectId);
      await Bundled.verifySignatures(selected.root, selected.declaration, { signal });
    }, dependencies });
  return { ...manager, distributionRequired: false,
    ui: { groupId: "graphics", tabLabel: "Graphics", sectionLabel: definition.label, memberOrder: projectId === "winevulkan-scene" ? 23 : 24, management: "managed" },
    resolvePayload(entry, context = {}, options = {}) {
      const selected = manager.resolveSelection(entry, context.settings, context.userDataDir, options);
      if (!selected.ready || !selected.install) return selected;
      try {
        const install = verifyAPI(selected.install, projectId, options.verification || "status");
        return { ...selected, install, provider: apiDescriptor(install.manifest, projectId) };
      } catch (error) { return { ...selected, ready: false, install: null, reason: error.message }; }
    }
  };
}
const apiManagers = Object.freeze(Object.fromEntries(Object.keys(API_PROJECTS).map(id => [id, createAPIManager(id)])));
const managers = Object.freeze({ crossover: createManager(), sikarugir: createManager({ runtimeId: "sikarugir" }), ...apiManagers });
module.exports = { ...managers.crossover, managers, apiManagers, forRuntime: runtimeId => ["crossover", "sikarugir"].includes(runtimeId) ? managers[runtimeId] : null,
  createManager, createAPIManager, apiDescriptor, verifyAPI, FILES, prepareInstall, verified };
