const fs = require('node:fs');
const path = require('node:path');
const Binary = require('../../../core/binary-arch');
const Bundled = require('../../shared/runtime/bundled-native');
const { requiresRosetta } = require('../../shared/runtime/architecture');
const { readPeExports } = require('../../shared/runtime/pe-exports');
const { readMachOLoadCommands } = require('../../shared/runtime/macho-load-commands');
const { createProjectBuildManager } = require('../../shared/runtime/project-build-manager');
const Custom = require('../../shared/runtime/custom-runtime');
const { createSourceBackedManager } = require('../../../runtime-sources/manager');
const source = require('../../../runtime-sources/d3d-translator/maclauncher-dxmt.json');
const adapter = require('../../../runtime-adapters/d3d-translator');

const ABIS = Object.freeze({
  arm64: { folder: 'aarch64', windows: 'arm64ec', machines: ['arm64ec', 'arm64x'] },
  x86_64: { folder: 'x86_64', windows: 'x86_64', machines: ['x86_64'] }
});
const REQUIRED = Object.freeze({
  'd3d11.dll': 'D3D11CreateDevice',
  'dxgi.dll': 'CreateDXGIFactory1',
  'winemetal.dll': null
});

function packageAbi(manifest) {
  const cpu = manifest.nativeArchitecture;
  const abi = Object.hasOwn(ABIS, cpu) && ABIS[cpu];
  const primary = abi && `wine/${abi.folder}-unix/winemetal.so`;
  if (manifest.id !== 'dxmt' || manifest.engine !== 'dxmt' || manifest.platform !== 'darwin' ||
      !abi || manifest.executableRelative !== primary || manifest.windowsArchitecture !== abi.windows)
    throw Error('The package does not describe the MacLauncher DXMT renderer.');
  return { ...abi, cpu, primary };
}

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
  const { cpu, folder, primary, machines } = packageAbi(manifest);
  const files = new Set((manifest.files || []).map(file => file.path));
  function requiredFile(relative) {
    const file = path.join(root, relative);
    if (!files.has(relative) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile())
      throw Error('MacLauncher DXMT is missing a required library: ' + relative);
    return file;
  }
  const executablePath = requiredFile(primary), native = Binary.inspectBinary(executablePath);
  if (native?.format !== 'macho' || !native.architectures?.includes(cpu))
    throw Error(`MacLauncher DXMT requires a ${cpu} native renderer.`);
  if (!readMachOLoadCommands(executablePath).slices.some(slice => slice.architecture === cpu && slice.fileType === 6))
    throw Error('MacLauncher DXMT requires a native dynamic library.');
  for (const [name, requiredExport] of Object.entries(REQUIRED)) {
    const relative = `wine/${folder}-windows/${name}`, file = requiredFile(relative);
    const facts = Binary.inspectBinary(file);
    const architectures = facts?.hybrid?.codeArchitectures || [facts?.machine];
    if (facts?.format !== 'pe' || !machines.some(machine => architectures.includes(machine)))
      throw Error('MacLauncher DXMT requires its complete 64-bit Windows library: ' + relative);
    const exports = readPeExports(file);
    if (!exports?.isDll) throw Error('MacLauncher DXMT requires a Windows dynamic library: ' + relative);
    if (requiredExport && !exports.exports.get(requiredExport)?.executable)
      throw Error('MacLauncher DXMT is missing its Windows API: ' + requiredExport);
  }
  return {
    executablePath, architectures: [cpu], needsRosetta: requiresRosetta(cpu),
    root, payloadRoot: root, translatorRoot: root, baseRoot: path.join(root, 'wine'), runtimeVersion: manifest.version
  };
}

function create({ dependencies = {} } = {}) {
  const manager = createProjectBuildManager({
    projectId: 'dxmt', label: 'MacLauncher DXMT', repository: 'procrastinine/maclauncher-builds',
    upstreamUrl: 'https://github.com/3Shain/dxmt', manifestRelative: 'manifest.json', sourceRelative: null,
    executableRelative: manifest => packageAbi(manifest).primary, nativeLibrary: true,
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
