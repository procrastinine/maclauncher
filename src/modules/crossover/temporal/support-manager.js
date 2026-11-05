const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { createProjectBuildManager } = require("../../shared/runtime/project-build-manager");
const Bundled = require("../../shared/runtime/bundled-native");
const Catalog = require("./catalog");
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function createManager(options) { return require("../../shared/runtime/translator-managers").createManager("dxmt", options); }

const WineVulkan = Catalog.VULKAN_PROFILE, FidelityFX = Catalog.FIDELITYFX_PROFILE;
const API_PROJECTS = Object.freeze({
  "winevulkan-scene": { label: "WineVulkan scene adapter", source: "https://www.codeweavers.com/crossover/source" },
  "fidelityfx-api": { label: "FidelityFX API adapter", source: "https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK" }
});
const apiVerified = new Map();
function apiDescriptor(manifest, projectId) {
  const provider = manifest.provider;
  if (Bundled.isManagedDeclaration(manifest)) return provider || {};
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
  if (Bundled.isManagedDeclaration(install.declaration)) {
    Bundled.verifyPayload(install.root,install.declaration,install.resolveDependency);
    return install;
  }
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
    if (!stat.isFile() || stat.isSymbolicLink() || !exports)
      throw Error("The FidelityFX runtime is not a readable PE library.");
    const sha256 = hash(runtimePath);
    if (expectedSha256 && sha256 !== expectedSha256) throw Error("The FidelityFX adapter checksum changed.");
    return { executablePath: runtimePath, architectures: ["x86_64"], needsRosetta: false, runtimeVersion, upstreamRevision, sha256 };
  } : undefined;
  const manager = createProjectBuildManager({ projectId, label: definition.label,
    repository: "procrastinine/maclauncher-builds", upstreamUrl: definition.source, nativeLibrary: true,
    ...(inspectRuntime ? { inspectRuntime } : {}),
    manifestRelative: "manifest.json", sourceRelative: null, executableRelative: manifest => manifest.executableRelative,
    validateManifest: manifest => {
      if (Bundled.isManagedDeclaration(manifest)) return;
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
const support = createManager(), managers = Object.freeze({ [support.id]: support, ...apiManagers });
module.exports = { ...support, managers, apiManagers, forRuntime: runtimeId => ["crossover", "sikarugir"].includes(runtimeId) ? support : null,
  createManager, createAPIManager, apiDescriptor, verifyAPI };
