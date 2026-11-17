const fs = require('node:fs');
const path = require('node:path');
const Binary = require('../../../core/binary-arch');
const Bundled = require('../../shared/runtime/bundled-native');
const { readPeExports } = require('../../shared/runtime/pe-exports');
const { readMachOLoadCommands } = require('../../shared/runtime/macho-load-commands');
const { createProjectBuildManager } = require('../../shared/runtime/project-build-manager');
const Custom = require('../../shared/runtime/custom-runtime');
const { createSourceBackedManager } = require('../../../runtime-sources/manager');
const source = require('../../../runtime-sources/d3d-translator/maclauncher-dxmt.json');
const adapter = require('../../../runtime-adapters/d3d-translator');

const PRIMARY = 'wine/aarch64-unix/winemetal.so';
const REQUIRED = Object.freeze({
  [PRIMARY]: null,
  'wine/aarch64-windows/d3d11.dll': 'D3D11CreateDevice',
  'wine/aarch64-windows/dxgi.dll': 'CreateDXGIFactory1',
  'wine/aarch64-windows/winemetal.dll': null
});

function packageRoot(file) {
  for (let root = fs.statSync(file).isDirectory() ? file : path.dirname(file), depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(root, 'manifest.json'))) return root;
    if (path.dirname(root) === root) break;
    root = path.dirname(root);
  }
  throw Error('Select the complete MacLauncher DXMT package containing manifest.json.');
}

function inspect(root) {
  const manifest = JSON.parse(Bundled.readRegular(path.join(root, 'manifest.json'), Bundled.LIMITS.manifestBytes).bytes);
  if (manifest.id !== 'dxmt' || manifest.engine !== 'dxmt' || manifest.platform !== 'darwin' || manifest.executableRelative !== PRIMARY ||
      manifest.nativeArchitecture !== 'arm64' || manifest.windowsArchitecture !== 'arm64ec')
    throw Error('The package does not describe the MacLauncher DXMT renderer.');
  const files = new Map((manifest.files || []).map(file => [file.path, file]));
  for (const [relative, requiredExport] of Object.entries(REQUIRED)) {
    const row = files.get(relative), file = path.join(root, relative);
    if (!row || !fs.statSync(file).isFile()) throw Error('MacLauncher DXMT is missing a required library: ' + relative);
    if (relative === PRIMARY) {
      const facts = Binary.inspectBinary(file);
      if (facts?.format !== 'macho' || !facts.architectures?.includes('arm64'))
        throw Error('MacLauncher DXMT requires an arm64 native renderer.');
      if (!readMachOLoadCommands(file).slices.some(slice => slice.architecture === 'arm64' && slice.fileType === 6))
        throw Error('MacLauncher DXMT requires a native dynamic library.');
    } else {
      const facts = Binary.inspectBinary(file);
      const architectures = facts?.hybrid?.codeArchitectures || [facts?.machine];
      if (facts?.format !== 'pe' || !architectures.some(cpu => ['arm64ec', 'arm64x'].includes(cpu)))
        throw Error('MacLauncher DXMT requires its complete 64-bit Windows library: ' + relative);
      const exports = readPeExports(file);
      if (!exports?.isDll) throw Error('MacLauncher DXMT requires a Windows dynamic library: ' + relative);
      if (requiredExport && !exports.exports.get(requiredExport)?.executable)
        throw Error('MacLauncher DXMT is missing its Windows API: ' + requiredExport);
    }
  }
  return {
    executablePath: path.join(root, PRIMARY), architectures: ['arm64'], needsRosetta: false,
    root, payloadRoot: root, translatorRoot: root, baseRoot: path.join(root, 'wine'), runtimeVersion: manifest.version
  };
}

function create({ dependencies = {} } = {}) {
  const manager = createProjectBuildManager({
    projectId: 'dxmt', label: 'MacLauncher DXMT', repository: 'procrastinine/maclauncher-builds',
    upstreamUrl: 'https://github.com/3Shain/dxmt', manifestRelative: 'manifest.json', sourceRelative: null,
    executableRelative: PRIMARY, nativeLibrary: true,
    verifyPayload(selected) { Bundled.verifyPayload(selected.root, selected.declaration, selected.resolveDependency); },
    inspectRuntime({ runtimePath }) { return inspect(packageRoot(runtimePath)); }, dependencies
  });
  const inspectCustom = manager.customRuntime.inspect;
  Custom.configure(manager, { inspect(input, options) {
    const selected = inspectCustom(input, options);
    return { ...selected, ...inspect(selected.root) };
  } });
  manager.translatorEngine = 'dxmt';
  manager.ui = { groupId: 'directx-metal', sectionLabel: manager.label, memberOrder: 0.5, management: 'managed' };
  return createSourceBackedManager({ id: manager.id, source, adapter, backend: manager });
}

module.exports = create();
module.exports.create = create;
module.exports.inspect = inspect;
