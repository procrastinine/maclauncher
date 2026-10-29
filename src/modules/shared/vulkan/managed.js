const path = require("node:path");
const execute = require("node:util").promisify(require("node:child_process").execFile);
const Bundled = require("../runtime/bundled-native");
const { createProjectBuildManager } = require("../runtime/project-build-manager");

const projectId = "vulkan-kosmickrisp-gles32";
const selectionId = "kosmickrisp:maclauncher-gles32";

function createManager(dependencies = {}) {
  const manager = createProjectBuildManager({ projectId, label: "KosmicKrisp GLES 3.2", repository: "procrastinine/maclauncher-builds", upstreamUrl: "https://gitlab.freedesktop.org/mesa/mesa", nativeLibrary: true,
    manifestRelative: "manifest.json", sourceRelative: null, filesPrefix: "files/",
    executableRelative: manifest => manifest.executableRelative,
    validateManifest(manifest, record) {
      Bundled.validateManifest(manifest, { managerId: projectId, version: record.version,
        arch: record.arch, upstreamRevision: record.source?.revision });
      if (manifest.executableRelative !== "libvulkan_kosmickrisp.dylib" || manifest.runtimeFiles?.loader !== "libvulkan.1.dylib" ||
          manifest.provenance.verifiedBuild !== true || manifest.provenance.capabilities?.openglES !== "3.2")
        throw new Error("The KosmicKrisp package differs from its GLES 3.2 profile.");
    },
    async verifyPayload(selected, { signal } = {}) {
      Bundled.verifyPayload(selected.root, selected.declaration);
      for (const file of selected.manifest.files.filter(file => file.architectures))
        await execute("/usr/bin/codesign", ["--verify", "--strict", path.join(selected.payloadRoot, file.path)],
          { signal, timeout: 30000, maxBuffer: 1024 * 1024 });
    }, dependencies });
  return { ...manager, distributionRequired: false,
    ui: { groupId: "graphics", tabLabel: "Graphics", sectionLabel: "KosmicKrisp GLES 3.2", memberOrder: 22, management: "managed" } };
}

function createProvider(manager) {
  function selected(version, context, verification) {
    const result = manager.resolveSelection(null, context.settings, context.userDataDir, { version, verification });
    if (!result.ready || !result.install) return null;
    const install = result.install;
    return { id: "kosmickrisp-gles32:" + result.version, backend: "kosmickrisp", version: result.version,
      projectId, label: "KosmicKrisp · GLES 3.2 · " + result.version, minimumMacOS: install.manifest.minimumMacOS,
      library: path.join(install.payloadRoot, install.manifest.runtimeFiles.loader), driver: install.executablePath,
      readable: install.manifest.files.filter(file => file.architectures).map(file => path.join(install.payloadRoot, file.path)) };
  }
  return {
    installed(context) {
      const state = manager.getState(context);
      return state.installed.flatMap(item => {
        try { const row = selected(item.version, context, "status"); return row ? [row] : []; }
        catch { return []; }
      });
    },
    resolve(item, context) {
      const result = selected(item.version, context, "full");
      if (!result) throw new Error("The selected KosmicKrisp GLES 3.2 package is unavailable. Install this version in Runtimes.");
      return result;
    }
  };
}

const manager = createManager();
const sceneProjectId = "vulkan-moltenvk-scene", sceneSelectionId = "moltenvk:maclauncher-scene";
function sceneDescriptor(manifest) {
  const provider = manifest.provider, library = manifest.files?.find(file => file.path === "libMoltenVK-scene.dylib");
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
    repository: "procrastinine/maclauncher-builds", upstreamUrl: "https://github.com/KhronosGroup/MoltenVK", nativeLibrary: true,
    manifestRelative: "manifest.json", sourceRelative: null, executableRelative: manifest => manifest.executableRelative,
    validateManifest(manifest, record) {
      Bundled.validateManifest(manifest, { managerId: sceneProjectId, version: record.version, arch: record.arch,
        upstreamRevision: record.source?.revision });
      sceneDescriptor(manifest);
    },
    async verifyPayload(selected, { signal } = {}) {
      Bundled.verifyPayload(selected.root, selected.declaration);
      await Bundled.verifySignatures(selected.root, selected.declaration, { signal });
    }, dependencies });
  return { ...result, distributionRequired: false,
    ui: { groupId: "graphics", tabLabel: "Graphics", sectionLabel: "MoltenVK scene support", memberOrder: 25, management: "managed" } };
}
function createSceneProvider(selectedManager) {
  function selected(version, context, verification) {
    const result = selectedManager.resolveSelection(null, context.settings, context.userDataDir, { version, verification });
    if (!result.ready || !result.install) return null;
    const install = result.install, descriptor = sceneDescriptor(install.manifest);
    if (verification === "full") Bundled.verifyPayload(install.root, install.declaration);
    const library = path.join(install.payloadRoot, descriptor.library);
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
const providers = Object.freeze([{ manager, provider, projectId, selectionId, prefix: "kosmickrisp-gles32:" },
  { manager: sceneManager, provider: sceneProvider, projectId: sceneProjectId, selectionId: sceneSelectionId, prefix: "moltenvk-scene:" }]);
module.exports = { manager, provider, createManager, createProvider, selectionId, projectId,
  sceneManager, sceneProvider, sceneProjectId, sceneSelectionId, sceneDescriptor, createSceneManager, createSceneProvider, providers };
