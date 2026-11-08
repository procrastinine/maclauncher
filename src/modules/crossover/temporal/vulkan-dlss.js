const fs = require('node:fs'), path = require('node:path');
const { usedForApi } = require('../../shared/runtime/translator-roles');
const { readPeExports } = require('../../shared/runtime/pe-exports');
const { fileDigest, fileIdentity } = require('../../shared/runtime/verified-identity');
const Bundled = require('../../shared/runtime/bundled-native');
const { createPinnedNativeManager, upstreamPins, withDescription } = require('../../shared/runtime/pinned-native-manager');
const { createProjectBuildManager } = require('../../shared/runtime/project-build-manager');
const Upstream = require('../../shared/runtime/upstream');
const { archiveFormat } = require('../../shared/runtime/release-files');

// Resolve ordinary managed packages. Refresh/consented Install owns network I/O.
function findLibrary(root, name, inspect = readPeExports) {
  if (!path.isAbsolute(root || '')) return null;
  const matches = [];
  function visit(directory) {
    for (const row of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, row.name);
      if (row.isDirectory()) visit(file);
      else if (row.isFile() && row.name.toLowerCase() === name) {
        const pe = inspect(file);
        if (pe?.machine === 0x8664) matches.push(file);
      }
    }
  }
  visit(root);
  if (matches.length !== 1) return null;
  return matches[0];
}
function createManagers(dependencies = {}) {
  const source = Upstream.github({ repository: 'jp7677/dxvk-nvapi', allArchitectures: true,
    recognize: release => (release.assets || []).filter(asset => archiveFormat(asset.name)).map(asset => ({
      version: release.tag_name.replace(/^v/, ''), architecture: 'universal', assets: [asset]
    })) });
  const nvapi = createPinnedNativeManager({ id: 'dxvk-nvapi', label: 'DXVK-NVAPI', nativeLibrary: true, customRuntime: false,
    sourceUrl: 'https://github.com/jp7677/dxvk-nvapi/releases', upstreamUrl: 'https://github.com/jp7677/dxvk-nvapi',
    discoverCatalog: async options => upstreamPins(await source.discover(options)),
    resolveExecutable(root) { const file = findLibrary(root, 'nvapi64.dll'); if (!file) throw Error('The DXVK-NVAPI package has no unique x64 library.'); return file; },
    inspectRuntime({ runtimePath, runtimeVersion, upstreamRevision }) {
      if (readPeExports(runtimePath)?.machine !== 0x8664) throw Error('DXVK-NVAPI requires its x64 Windows library.');
      return { executablePath: runtimePath, architectures: ['x86_64'], runtimeVersion, upstreamRevision, needsRosetta: false };
    }, dependencies });
  const ngx = createProjectBuildManager({ projectId: 'vkd3d-proton', label: 'Vulkan DLSS forwarding', nativeLibrary: true,
    repository: 'procrastinine/maclauncher-builds', upstreamUrl: 'https://github.com/metalsharp/VKD3D-Proton-MacOS',
    manifestRelative: 'manifest.json', sourceRelative: 'source.json', executableRelative: 'x64/nvngx.dll',
    async verifyPayload(selected) { Bundled.verifyPayload(selected.root, selected.declaration, selected.resolveDependency); },
    inspectRuntime({ runtimePath }) { if (readPeExports(runtimePath)?.machine !== 0x8664) throw Error('The NGX core requires x64.'); return { executablePath: runtimePath, architectures: ['x86_64'], needsRosetta: false }; }, dependencies });
  ngx.translatorEngine='vkd3d-proton'; // The managed package also supplies its matched carrier producer as a normal translator choice.
  // Both rows sit beside DXVK and vkd3d-proton in DirectX → Vulkan.
  const info = {
    'dxvk-nvapi': "DXVK-NVAPI's nvapi64.dll. It presents an NVIDIA adapter to a Windows game that uses DXVK, so that the game's DLSS integration can start. Play offers it, after consent, with Vulkan DLSS forwarding.",
    'vkd3d-proton': "The NGX core, nvngx.dll, from MacLauncher Builds' VKD3D-Proton-MacOS package. It forwards a Windows game's DLSS inputs to the selected Vulkan driver's temporal carrier. Play offers it, after consent, with DXVK-NVAPI."
  };
  return [nvapi, ngx].map((manager, index) => ({ ...withDescription(manager, info[manager.id]), distributionRequired: false,
    ui: { groupId: 'directx-vulkan', sectionLabel: manager.label, memberOrder: 5 + index, management: 'managed' } }));
}
const managers = createManagers();
const carrierFiles=new Map();
function carrierDriver(plan, hasCarrier = file => {
  // Passive transport detection; actual device/provider admission remains the
  // NGX core's driverInfo query. Stock MoltenVK has no carrier declaration.
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 512 * 1024 * 1024) return false;
  const identity=JSON.stringify(fileIdentity(file)),cached=carrierFiles.get(file);
  if(cached?.identity===identity)return cached.capable;
  const capable=fs.readFileSync(file).includes(Buffer.from(' temporal-sr'));
  if(carrierFiles.size>16)carrierFiles.clear();carrierFiles.set(file,{identity,capable});return capable;
}) {
  const driver = plan?.components?.['vulkan-driver']?.used;
  if (!['kosmickrisp', 'moltenvk'].includes(driver?.engine)) return null;
  return driver.files?.some(file => file.format === 'macho' && hasCarrier(file.path)) ? driver : null;
}
// Forwarding needs no setting: a 64-bit game whose Direct3D 11 or 12 renders
// through DXVK or vkd3d-proton, with DXVK's own DXGI placed and an explicitly
// selected carrier driver, always forwards its DLSS frames. The runtime's own
// driver has no carrier, and DXVK-NVAPI reaches the device through DXVK's DXGI.
function requested(plan, architecture, hasCarrier) {
  if (architecture !== 'x86_64') return false;
  if (!['d3d11', 'd3d12'].some(api => ['dxvk', 'vkd3d-proton'].includes(usedForApi(plan, api)?.engine))) return false;
  if (!(plan.placements || []).some(item => item.description.engine === 'dxvk' && path.basename(item.file.path).toLowerCase() === 'dxgi.dll' && item.file.machine === 0x8664)) return false;
  return Boolean(carrierDriver(plan, hasCarrier));
}
function selection(manager, entry, context) { return manager.resolveSelection(entry, context.settings, context.userDataDir, { verification: 'status' }); }
async function requirements(entry, context, { translatorPlan = context.translatorPlan, architecture, runtimeManagers = managers, hasCarrier } = {}) {
  architecture ||= require('../detect').cachedWindowsExecutable(entry)?.executableArchitecture;
  if (architecture !== 'x86_64') return [];
  if (!translatorPlan) {
    const runtimeId=context.runtimeId || entry.runtimeId || 'crossover';
    const manager=require(runtimeId==='sikarugir'?'../sikarugir/runtime/manager':'../runtime/manager');
    const selected=manager.resolveSelection(entry,context.settings,context.userDataDir,context.runtimeSettings);
    if(selected.ready){
      const translators=require('../../shared/runtime/wine-translators');
      const environment=translators.environmentContext(context,selected.install);
      translatorPlan=await translators.resolve(environment.wineEnvironment?.install || selected.install,runtimeId,context,{entry,executableArchitecture:architecture});
    }
  }
  if (!requested(translatorPlan, architecture, hasCarrier)) return [];
  return runtimeManagers.flatMap(manager => {
    const selected = selection(manager, entry, context);
    return selected.ready ? [] : [{ managerId: manager.id, version: selected.version || null, requiresDownload: true,
      ...(!selected.version || selected.discoveryRequired ? { discoveryRequired: true } : {}), installOptions: { sectionId: 'default' },
      detail: 'Installs the NVIDIA API bridge and temporal-input forwarding libraries for the selected Vulkan renderer.' }];
  });
}
async function prepare(entry, context, settings, plan, architecture, view, { runtimeManagers = managers, hasCarrier, inspect = readPeExports } = {}) {
  if (!requested(plan, architecture, hasCarrier)) return { view, enabled: false };
  const selected = runtimeManagers.map(manager => ({ manager, value: selection(manager, entry, context) }));
  if (selected.some(item => !item.value.ready)) throw Error('Install the requested Vulkan DLSS forwarding packages before Play.');
  const nvapi = selected[0].value.install.executablePath, core = selected[1].value.install.executablePath;
  for (const [file, names] of [[nvapi, ['nvapi_QueryInterface']], [core, ['NVSDK_NGX_D3D11_EvaluateFeature', 'NVSDK_NGX_D3D12_EvaluateFeature']]]) {
    const pe = inspect(file);
    if (pe?.machine !== 0x8664 || names.some(name => !pe.exports?.get(name)?.executable)) throw Error('The selected DLSS forwarding package has no matching caller exports.');
  }
  const native = [...(view?.native || []).filter(file => !['nvapi64.dll', 'nvngx.dll', '_nvngx.dll'].includes(file.name.toLowerCase())),
    ...[[nvapi, 'nvapi64.dll'], [core, 'nvngx.dll'], [core, '_nvngx.dll']].map(([source, name]) => ({ source, name, machine: 0x8664 }))];
  for (const item of selected) await context.useRuntime?.({ managerId: item.manager.id, version: item.value.version, sourcePath: item.value.install.root || item.value.install.installDir });
  const identity = require('node:crypto').createHash('sha256').update(JSON.stringify([view?.identity, native.map(file => [file.source, fileDigest(file.source).sha256])])).digest('hex');
  return { enabled: true, driver: carrierDriver(plan, hasCarrier).engine, view: { ...view, identity, native,
    dllOverrides: [...(view?.dllOverrides || []), 'nvapi64,nvngx,_nvngx=n,b'] } };
}
function environment(enabled, values = {}) {
  if (!enabled) return {};
  const config = typeof values.DXVK_CONFIG === 'string' ? values.DXVK_CONFIG : '';
  // This is the virtual DXVK/NVAPI identity used to admit the owned NGX core,
  // not a physical NVIDIA device or an advertisement of native NVIDIA work.
  return { DXVK_ENABLE_NVAPI: '1', DXVK_NVAPI_ALLOW_OTHER_DRIVERS: '1', DXVK_NVAPI_GPU_ARCH: 'TU100',
    DXVK_CONFIG: [config, 'dxgi.customVendorId = 10de', 'dxgi.customDeviceId = 1e07', 'dxgi.hideNvidiaGpu = False'].filter(Boolean).join('; ') };
}
module.exports = { managers, createManagers, findLibrary, carrierDriver, requested, requirements, prepare, environment };
