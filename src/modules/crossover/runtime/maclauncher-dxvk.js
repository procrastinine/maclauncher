const { readPeExports } = require('../../shared/runtime/pe-exports');
const Bundled = require('../../shared/runtime/bundled-native');
const { createProjectBuildManager } = require('../../shared/runtime/project-build-manager');
const { withDescription } = require('../../shared/runtime/pinned-native-manager');

// MacLauncher Builds' DXVK package is an ordinary DXVK translator choice in
// DirectX → Vulkan. Its x64 and x32 folders hold the DXVK libraries and the
// paired dcomp.dll, so a selection places them like any managed DXVK.
function create({ dependencies = {} } = {}) {
  const manager = createProjectBuildManager({ projectId: 'dxvk', label: 'MacLauncher DXVK', nativeLibrary: true,
    repository: 'procrastinine/maclauncher-builds', upstreamUrl: 'https://github.com/doitsujin/dxvk',
    manifestRelative: 'manifest.json', sourceRelative: 'source.json', executableRelative: 'x64/d3d11.dll',
    async verifyPayload(selected) { Bundled.verifyPayload(selected.root, selected.declaration, selected.resolveDependency); },
    inspectRuntime({ runtimePath }) {
      if (readPeExports(runtimePath)?.machine !== 0x8664) throw Error('MacLauncher DXVK requires its x64 Direct3D 11 library.');
      return { executablePath: runtimePath, architectures: ['x86_64'], needsRosetta: false };
    }, dependencies });
  manager.translatorEngine = 'dxvk';
  return { ...withDescription(manager, "MacLauncher Builds' DXVK 3.1.1 for Direct3D 8 to 11. It adds DirectComposition presentation in the game's window, KosmicKrisp descriptor heaps, opt-in asynchronous pipeline compilation (DXVK_ASYNC=1) and a shader cache in MacLauncher's cache folder. With the Vulkan driver on Automatic, a game that uses it runs on MacLauncher KosmicKrisp."),
    distributionRequired: false, ui: { groupId: 'directx-vulkan', sectionLabel: manager.label, memberOrder: 2.5, management: 'managed' } };
}

module.exports = create();
module.exports.create = create;
