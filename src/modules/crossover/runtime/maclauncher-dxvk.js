const { readPeExports } = require('../../shared/runtime/pe-exports');
const Bundled = require('../../shared/runtime/bundled-native');
const { createProjectBuildManager } = require('../../shared/runtime/project-build-manager');
const { withDescription } = require('../../shared/runtime/pinned-native-manager');
const {createSourceBackedManager}=require('../../../runtime-sources/manager');
const source=require('../../../runtime-sources/d3d-translator/maclauncher-dxvk.json');
const adapter=require('../../../runtime-adapters/d3d-translator');

// MacLauncher Builds' DXVK package is an ordinary DXVK translator choice in
// DirectX → Vulkan. Its x64 and x32 folders hold the DXVK libraries and the
// paired dcomp.dll, so a selection places them like any managed DXVK.
function create({ dependencies = {} } = {}) {
  const manager = createProjectBuildManager({ projectId: source.manager.id, label: source.label, nativeLibrary: true,
    repository: new URL(source.discover.catalog).pathname.slice(1), upstreamUrl: source.credits.url,
    manifestRelative: 'manifest.json', sourceRelative: 'source.json', executableRelative: source.layout.entry,
    async verifyPayload(selected) { Bundled.verifyPayload(selected.root, selected.declaration, selected.resolveDependency); },
    inspectRuntime({ runtimePath }) {
      if (readPeExports(runtimePath)?.machine !== 0x8664) throw Error('MacLauncher DXVK requires its x64 Direct3D 11 library.');
      return { executablePath: runtimePath, architectures: ['x86_64'], needsRosetta: false };
    }, dependencies });
  manager.translatorEngine = source.manager.engine;
  return createSourceBackedManager({source,adapter,backend:{ ...withDescription(manager, "MacLauncher Builds' DXVK 3.1.1 for Direct3D 8 to 11. It adds DirectComposition presentation in the game's window, KosmicKrisp descriptor heaps, opt-in asynchronous pipeline compilation (DXVK_ASYNC=1) and a shader cache in MacLauncher's cache folder. With the Vulkan driver on Automatic, a game that uses it runs on MacLauncher KosmicKrisp."),
    distributionRequired: false, ui: { sectionLabel: manager.label, memberOrder: source.manager.memberOrder, management: 'managed' } }});
}

module.exports = create();
module.exports.create = create;
