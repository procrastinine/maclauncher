const path = require("node:path");
const execute = require("node:util").promisify(require("node:child_process").execFile);
const Bundled = require("../runtime/bundled-native");
const { createProjectBuildManager } = require("../runtime/project-build-manager");
const source = require("./native/kosmickrisp-source.json");

const projectId = "vulkan-kosmickrisp-gles32";
const selectionId = "kosmickrisp:maclauncher-gles32";

function createManager(dependencies = {}) {
  const manager = createProjectBuildManager({ projectId, label: "KosmicKrisp GLES 3.2", fallbackVersion: "MCLv1-1024",
    repository: "procrastinine/maclauncher-builds", upstreamUrl: "https://gitlab.freedesktop.org/mesa/mesa", nativeLibrary: true,
    manifestRelative: "manifest.json", sourceRelative: null, filesPrefix: "files/",
    executableRelative: manifest => manifest.executableRelative,
    validateManifest(manifest, record) {
      Bundled.validateManifest(manifest, { managerId: projectId, version: record.version,
        arch: record.arch });
      if (![source.revision, "af2f67b2b3671ce4d5f95bba611a01e7eae3c84f"].includes(manifest.upstreamRevision))
        throw new Error("The KosmicKrisp package has an unsupported source revision.");
      if (manifest.executableRelative !== source.library || manifest.runtimeFiles?.loader !== "libvulkan.1.dylib" ||
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
module.exports = { manager, provider: createProvider(manager), createManager, createProvider, selectionId, projectId };
