const path = require("node:path");
const execute = require("node:util").promisify(require("node:child_process").execFile);
const Bundled = require("../runtime/bundled-native");
const { createProjectBuildManager } = require("../runtime/project-build-manager");
const repository = "procrastinine/maclauncher-builds";

const projectId = "maclauncher-kosmickrisp";
const formerProjectId = "vulkan-kosmickrisp-gles32";
const selectionId = "kosmickrisp:maclauncher";
const prefix = projectId + ":";

function normalizeSelection(value, logger = console) {
  if (value === "kosmickrisp:maclauncher-gles32") return selectionId;
  if (typeof value === "string") {
    if (!value.startsWith("kosmickrisp-gles32:")) return value;
    try { return prefix + manager.core.normalizeVersion(value.slice("kosmickrisp-gles32:".length)); } catch {}
  }
  logger?.warn?.("[runtimes] The saved MacLauncher KosmicKrisp choice could not be read; using Automatic.");
  return "auto";
}

function createManager(dependencies = {}) {
  const formerIds = [formerProjectId];
  const manager = createProjectBuildManager({ projectId, formerIds, label: "MacLauncher KosmicKrisp", repository, sourceLabel: "Source", upstreamUrl: "https://gitlab.freedesktop.org/mesa/mesa", nativeLibrary: true,
    manifestRelative: "manifest.json", sourceRelative: null, filesPrefix: "files/",
    executableRelative: manifest => manifest.executableRelative,
    validateManifest(manifest, record) {
      Bundled.validateRuntimeManifest(manifest, { managerId: record.id, version: record.version, arch: record.arch });
      if (Bundled.isManagedDeclaration(manifest)) return;
      if (manifest.executableRelative !== "libvulkan_kosmickrisp.dylib" || manifest.runtimeFiles?.loader !== "libvulkan.1.dylib")
        throw new Error("The MacLauncher KosmicKrisp package has no Vulkan driver or loader.");
    },
    async verifyPayload(selected, { signal } = {}) {
      Bundled.verifyPayload(selected.root, selected.declaration, selected.resolveDependency);
      await Bundled.verifySignatures(selected.root,selected.declaration,{signal});
    }, dependencies });
  function previousSettings(runtimes, logger = dependencies.logger || console) {
    const previous = runtimes?.[formerProjectId];
    if (previous === undefined) return undefined;
    if (previous && typeof previous === "object" && !Array.isArray(previous) &&
        (previous.defaultVersion == null || typeof previous.defaultVersion === "string")) try {
      const normalized = manager.normalizeSettings(previous);
      if (normalized.defaultVersion) manager.core.normalizeVersion(normalized.defaultVersion);
      return normalized;
    } catch {}
    logger?.warn?.("[runtimes] The saved MacLauncher KosmicKrisp settings could not be read; using the manager default.");
    return undefined;
  }
  const withPreviousSettings = settings => settings?.runtimes?.[projectId] !== undefined ? settings :
    { ...settings, runtimes: { ...settings?.runtimes, [projectId]: previousSettings(settings?.runtimes) } };
  const withPreviousEntry = entry => entry?.runtimeData?.[projectId] !== undefined || entry?.runtimeData?.[formerProjectId] === undefined ? entry :
    { ...entry, runtimeData: { ...entry.runtimeData, [projectId]: entry.runtimeData[formerProjectId] } };
  function resolveSelection(entry, settings, data, options = {}) {
    entry = withPreviousEntry(entry);
    const effective = withPreviousSettings(settings);
    const result = manager.resolveSelection(entry, effective, data, options);
    if (effective.runtimes?.[projectId]?.defaultVersion && !settings?.runtimes?.[projectId] &&
        !options.version && !result.ready && result.discoveryRequired) {
      (dependencies.logger || console).warn?.("[runtimes] The saved MacLauncher KosmicKrisp version is unavailable; using the manager default.");
      return manager.resolveSelection(entry, settings, data, options);
    }
    return result;
  }
  return { ...manager, formerIds, translatorEngine: "kosmickrisp", distributionRequired: false,
    chooseArchitecture: (entry, settings, data, options) => manager.chooseArchitecture(withPreviousEntry(entry), withPreviousSettings(settings), data, options),
    resolveSelection,
    getState: (options = {}) => manager.getState({ ...options,
      settings: options.settings ?? options.runtimeSettings?.[projectId] ?? previousSettings(options.runtimeSettings, options.logger) }),
    installRuntime: (options = {}) => manager.installRuntime({ ...options, settings: withPreviousSettings(options.settings) }),
    ui: { groupId: "vulkan-drivers", sectionLabel: manager.label, memberOrder: 22, management: "managed", hostFeature: "METAL4" } };
}

function createProvider(manager) {
  function selected(version, context, verification) {
    const result = manager.resolveSelection(null, context.settings, context.userDataDir, { version, verification });
    if (!result.ready || !result.install) return null;
    const install = result.install;
    return { id: prefix + result.version, backend: "kosmickrisp", version: result.version,
      projectId, label: manager.label + " " + result.version, minimumMacOS: install.manifest.minimumMacOS,
      library: path.join(install.payloadRoot, install.manifest.runtimeFiles.loader), driver: install.executablePath,
      readable: install.manifest.files.filter(file => file.architectures).map(file => path.join(install.payloadRoot, file.path)) };
  }
  return {
    installed(context) {
      const state = manager.getState({ userDataDir: context.userDataDir,
        settings: context.settings?.runtimes?.[manager.id], runtimeSettings: context.settings?.runtimes, logger: context.logger });
      return [...state.installed].sort((a, b) => Number(b.version === state.defaultVersion) - Number(a.version === state.defaultVersion)).flatMap(item => {
        try { const row = selected(item.version, context, "status"); return row ? [row] : []; }
        catch { return []; }
      });
    },
    resolve(item, context) {
      const result = selected(item.version, context, "full");
      if (!result) throw new Error("The selected MacLauncher KosmicKrisp package is unavailable. Install this version in Runtimes.");
      return result;
    }
  };
}

const manager = createManager();
const sceneProjectId = "vulkan-moltenvk-scene", sceneSelectionId = "moltenvk:maclauncher-scene";
function sceneDescriptor(manifest) {
  const provider = manifest.provider, library = manifest.files?.find(file => file.path === "libMoltenVK-scene.dylib");
  if (Bundled.isManagedDeclaration(manifest)) return provider || {};
  if (provider?.schema !== 1 || provider.provider !== "moltenvk" ||
      provider.sceneOperationAPI !== 1 || ![undefined, 0, 1].includes(provider.sceneStagingAPI) || provider.sceneOperationResources !== "prepared-tracked-boundary" ||
      provider.originalOutputRetained !== true || provider.library !== "libMoltenVK-scene.dylib" || provider.minimumMacOS !== manifest.minimumMacOS ||
      manifest.executableRelative !== provider.library || !Array.isArray(provider.architectures) ||
      !provider.architectures.includes(manifest.arch === "x64" ? "x86_64" : "arm64") || !library ||
      !provider.files?.some(file => file.path === provider.library && file.sha256 === library.sha256))
    throw new Error("The MoltenVK package differs from its scene recording profile.");
  return provider;
}
function createSceneManager(dependencies = {}) {
  const result = createProjectBuildManager({ projectId: sceneProjectId, label: "MoltenVK scene support",
    repository, sourceLabel: "Source", upstreamUrl: "https://github.com/KhronosGroup/MoltenVK", nativeLibrary: true,
    manifestRelative: "manifest.json", sourceRelative: null, executableRelative: manifest => manifest.executableRelative,
    validateManifest(manifest, record) {
      Bundled.validateRuntimeManifest(manifest, { managerId: sceneProjectId, version: record.version, arch: record.arch });
      sceneDescriptor(manifest);
    },
    async verifyPayload(selected, { signal } = {}) {
      Bundled.verifyPayload(selected.root, selected.declaration, selected.resolveDependency);
      await Bundled.verifySignatures(selected.root, selected.declaration, { signal });
    }, dependencies });
  return { ...result, translatorEngine: "moltenvk", distributionRequired: false,
    ui: { groupId: "vulkan-drivers", sectionLabel: "MoltenVK scene support", memberOrder: 25, management: "managed" } };
}
function createSceneProvider(selectedManager) {
  function selected(version, context, verification) {
    const result = selectedManager.resolveSelection(null, context.settings, context.userDataDir, { version, verification });
    if (!result.ready || !result.install) return null;
    const install = result.install, descriptor = sceneDescriptor(install.manifest);
    if (!descriptor.library || descriptor.sceneOperationAPI !== 1) return null;
    if (verification === "full") Bundled.verifyPayload(install.root, install.declaration);
    const library = path.join(install.payloadRoot, Bundled.relativeFile(descriptor.library));
    return { id: "moltenvk-scene:" + result.version, backend: "moltenvk", version: result.version, projectId: sceneProjectId,
      label: "MoltenVK · Scene support · " + result.version, minimumMacOS: install.manifest.minimumMacOS,
      library, driver: library, readable: [library], sceneOnly: true,
      capabilities: { sceneOperationAPI: descriptor.sceneOperationAPI, sceneStagingAPI: descriptor.sceneStagingAPI,
        originalOutputRetained: true, activationReady: false },
      install, descriptor };
  }
  return { installed(context) {
    return selectedManager.getState(context).installed.flatMap(item => {
      try { const row = selected(item.version, context, "status");return row ? [row] : []; } catch { return []; }
    });
  }, resolve(item, context) {
    const result = selected(item.version, context, "full");
    if (!result) throw new Error("The selected MoltenVK scene package is unavailable. Install this version in Runtimes.");
    return result;
  } };
}
const provider = createProvider(manager), sceneManager = createSceneManager(), sceneProvider = createSceneProvider(sceneManager);
const providers = Object.freeze([{ manager, provider, projectId, selectionId, prefix },
  { manager: sceneManager, provider: sceneProvider, projectId: sceneProjectId, selectionId: sceneSelectionId, prefix: "moltenvk-scene:" }]);
module.exports = { manager, provider, createManager, createProvider, selectionId, projectId, formerProjectId, normalizeSelection,
  sceneManager, sceneProvider, sceneProjectId, sceneSelectionId, sceneDescriptor, createSceneManager, createSceneProvider, providers };
