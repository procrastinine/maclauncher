const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Main = require('../src/modules/crossover/main'), D = require('../src/modules/shared/runtime/translator-description');
const Translators = require('../src/modules/shared/runtime/wine-translators');
const { peFixture } = require('./helpers/pe-fixture');
const { image, X64 } = require('./fixtures/macho-image');

test('actual Wine options apply source-declared inspected forms only to new offers and retain saved native selections', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-offer-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, bytes) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
  const executablePath = put('wine/bin/wine', image({ cpu: X64, fileType: 2 }));
  put('wine/lib/wine/x86_64-unix/ntdll.so', image({ cpu: X64 }));
  fs.mkdirSync(path.join(root, 'support/Frameworks/renderer'), { recursive: true });
  const install = { engineRoot: path.join(root, 'wine'), crossoverRoot: path.join(root, 'wine'), templateRoot: path.join(root, 'support'),
    executablePath, architecture: 'x64', version: 'authored-wine' };
  const create = (id, builtin, policy) => {
    const pe = peFixture({ is64: true }); pe.bytes.writeUInt16LE(0x2002, pe.peOffset + 22);
    if (builtin) pe.bytes.write('Wine builtin DLL\0', 64);
    if (id === 'custom') pe.bytes[pe.bytes.length - 1] = 1;
    put(id + '/d3d11.dll', pe.bytes);
    return D.describeTranslator(path.join(root, id), { id, engine: 'dxvk', source: { label: 'Authored source', ...(policy ? { optionsRuntimeForms: policy } : {}) } });
  };
  const builtin = create('builtin', true, { crossover: 'builtin' }), native = create('native', false, { crossover: 'builtin' }), custom = create('custom', false);
  const choices = [builtin, native, custom], runtimeManager = { resolveSelection: () => ({ ready: true, install }) };
  for (const runtimeId of ['crossover', 'sikarugir']) {
    const context = { runtimeId, userDataDir: path.join(root, 'profile'), settings: {}, runtimeSettings: {}, logger: { warn() {} } };
    const before = JSON.stringify(context);
    const output = await Main.__test.translatorOptions({ runtimeId }, {}, context, { runtimeManager, managers: [], choices });
    assert.ok(output.translatorD3D11Options.some(row => row.value === builtin.id));
    assert.equal(output.translatorD3D11Options.some(row => row.value === native.id), runtimeId !== 'crossover');
    assert.ok(output.translatorD3D11Options.some(row => row.value === custom.id), 'unknown custom provenance remains available');
    assert.equal(JSON.stringify(context), before);
    const settings = { translatorRenderer: native.id, translatorD3D11: native.id, dxvkHud: 'fps' }, selectedContext = { ...context, runtimeSettings: settings };
    const saved = JSON.stringify(settings), selected = await Main.__test.translatorOptions({ runtimeId }, {}, selectedContext, { runtimeManager, managers: [], choices });
    assert.ok(selected.translatorRendererOptions.some(row => row.value === native.id));
    assert.ok(selected.translatorD3D11Options.some(row => row.value === native.id));
    const plan = await Translators.resolve(install, runtimeId, selectedContext, { managers: [], choices, host: { macOSVersion: '26.0', physicalAppleGPU: false }, executableArchitecture: 'x86_64' });
    assert.equal(plan.components.d3d11.selected.id, native.id); assert.equal(plan.components.d3d11.used.id, native.id); assert.equal(plan.components.d3d11.fallback, false);
    assert.equal(JSON.stringify(settings), saved);
  }
});

test('MacLauncher DXVK and vkd3d-proton pair an automatic Vulkan driver with KosmicKrisp, or keep the runtime\'s automatic choice where they cannot run on MoltenVK', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-vulkan-pairing-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, bytes) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
  const executablePath = put('wine/bin/wine', image({ cpu: X64, fileType: 2 }));
  put('wine/lib/wine/x86_64-unix/ntdll.so', image({ cpu: X64 }));
  fs.mkdirSync(path.join(root, 'support/Frameworks/renderer'), { recursive: true });
  const install = { engineRoot: path.join(root, 'wine'), crossoverRoot: path.join(root, 'wine'), templateRoot: path.join(root, 'support'),
    executablePath, architecture: 'x64', version: 'authored-wine' };
  const pe = () => { const value = peFixture({ is64: true }); value.bytes.writeUInt16LE(0x2002, value.peOffset + 22); value.bytes.write('Wine builtin DLL\0', 64); return value.bytes; };
  const translator = (id, engine, names, extra) => {
    for (const name of names) put(`${id}/${name}`, pe());
    return { ...D.describeTranslator(path.join(root, id), { id, engine, source: { label: 'Runtimes' } }), ...extra };
  };
  const driver = (id, engine, library, carrier, extra) => {
    put(`${id}/${library}`, Buffer.concat([image({ cpu: X64 }), Buffer.from(carrier ? ' temporal-sr\0' : 'stock\0')]));
    return { ...D.describeTranslator(path.join(root, id), { id, engine, component: 'vulkan-driver', source: { label: 'Runtimes' } }), ...extra };
  };
  const ours = { managerId: 'dxvk', runtimeVersion: '3.1.1' };
  const dxvk = translator('dxvk', 'dxvk', ['d3d10core.dll', 'd3d11.dll', 'dxgi.dll'], ours);
  const proton = translator('proton', 'vkd3d-proton', ['d3d12.dll', 'd3d12core.dll'], { managerId: 'vkd3d-proton', runtimeVersion: '3.1' });
  const own = translator('runtime-dxvk', 'dxvk', ['d3d10core.dll', 'd3d11.dll', 'dxgi.dll'], { included: true });
  const kk = driver('kk', 'kosmickrisp', 'libvulkan_kosmickrisp.dylib', true, { managerId: 'maclauncher-kosmickrisp', runtimeVersion: '27.0.0' });
  const scene = driver('scene', 'moltenvk', 'libMoltenVK-scene.dylib', true, { managerId: 'vulkan-moltenvk-scene', runtimeVersion: '1.4.2-MCLv10' });
  const stock = driver('stock', 'moltenvk', 'libMoltenVK.dylib', false, { managerId: 'vulkan-moltenvk', runtimeVersion: '1.4.1' });
  const capable = { platform: 'darwin', hardwareArch: 'arm64', macOSVersion: '26.0', physicalAppleGPU: true };
  const resolve = (runtimeId, settings, choices, host = capable, extra = {}) => Translators.resolve(install, runtimeId, { runtimeId, userDataDir: path.join(root, 'profile'),
    settings: {}, runtimeSettings: settings, logger: { warn() {} }, ...extra }, { managers: [], choices: [...choices, own], host, executableArchitecture: 'x86_64' });
  // DXVK 1.x builds made for MoltenVK, such as DXVK-macOS.
  const dxvkMac = translator('dxvk-macos', 'dxvk', ['d3d10core.dll', 'd3d11.dll', 'dxgi.dll'], { managerId: 'translator-dxvk', runtimeVersion: 'v1.10.3-20230507' });
  const row = plan => plan.components['vulkan-driver'];
  for (const runtimeId of ['crossover', 'sikarugir']) {
    const paired = await resolve(runtimeId, { translatorD3D11: dxvk.id }, [dxvk, kk, scene]);
    assert.equal(row(paired).used.id, kk.id, `${runtimeId}: automatic Vulkan uses installed KosmicKrisp with MacLauncher's DXVK`);
    assert.equal(row(paired).reasonCode, 'vulkan-pairing'); assert.match(row(paired).reason, /MacLauncher's DXVK uses MacLauncher KosmicKrisp/);
    assert.equal(paired.vulkanPending, null);
    assert.match(Translators.inspectorRows(paired).find(item => item.component === 'vulkan-driver').reason, /KosmicKrisp/);
    // DXVK 3.1.1 cannot start on MoltenVK: until KosmicKrisp is installed, the carrier MoltenVK build is not used for it.
    const offered = await resolve(runtimeId, { translatorD3D11: dxvk.id }, [dxvk, scene]);
    assert.notEqual(row(offered).used?.id, scene.id, 'DXVK 3.1.1 is never paired with the MoltenVK build');
    assert.deepEqual(offered.vulkanPending, { architecture: 'x64', kosmicKrisp: true, vkd3d: false, carrier: false, moltenVK: false });
    assert.match(row(offered).reason, /installs after consent/);
    assert.deepEqual((await resolve(runtimeId, { translatorD3D11: dxvk.id }, [dxvk])).vulkanPending, { architecture: 'x64', kosmicKrisp: true, vkd3d: false, carrier: false, moltenVK: false });
    // A KosmicKrisp download declined in this Play keeps the runtime's automatic choice and driver.
    const declined = await resolve(runtimeId, { translatorD3D11: dxvk.id }, [dxvk, scene], capable, { declinedChoices: new Set(['kosmickrisp-pairing']) });
    const d3d11 = declined.components.d3d11;
    assert.ok(![dxvk.id, own.id].includes(d3d11.used?.id), "the runtime's automatic choice, not MacLauncher's or the runtime's DXVK");
    assert.equal(d3d11.selected.id, dxvk.id); assert.equal(d3d11.fallback, true);
    assert.equal(d3d11.reason, 'This DXVK version needs MacLauncher KosmicKrisp, which is not installed.');
    assert.notEqual(row(declined).reasonCode, 'vulkan-pairing'); assert.notEqual(row(declined).used?.id, scene.id); assert.equal(declined.vulkanPending, null);
    assert.ok(declined.warnings.some(line => /needs MacLauncher KosmicKrisp, which is not installed\. Using /.test(line)));
    for (const host of [{ ...capable, physicalAppleGPU: false }, { ...capable, macOSVersion: '15.7' }]) {
      const fallback = await resolve(runtimeId, { translatorD3D11: dxvk.id, translatorD3D12: proton.id }, [dxvk, proton, kk, scene], host);
      for (const [role, item] of [['d3d11', dxvk], ['d3d12', proton]]) {
        assert.ok(![item.id, own.id].includes(fallback.components[role].used?.id), `${role}: without Metal 4 or a physical Apple GPU the runtime's automatic choice is used`);
        assert.match(fallback.components[role].reason, /needs MacLauncher KosmicKrisp, which needs Metal 4 and a physical Apple GPU\./);
      }
      assert.notEqual(row(fallback).used?.id, scene.id); assert.equal(fallback.vulkanPending, null);
      // A DXVK build made for MoltenVK keeps the carrier MoltenVK build.
      const mac = await resolve(runtimeId, { translatorD3D11: dxvkMac.id }, [dxvkMac, kk, scene], host);
      assert.equal(mac.components.d3d11.used.id, dxvkMac.id); assert.equal(row(mac).used.id, scene.id);
      assert.equal(row(mac).reason, "KosmicKrisp needs Metal 4 and a physical Apple GPU, so MacLauncher's DXVK uses MacLauncher's MoltenVK build.");
    }
    const macOffered = await resolve(runtimeId, { translatorD3D11: dxvkMac.id }, [dxvkMac, scene]);
    assert.equal(row(macOffered).used.id, scene.id, 'a DXVK 1.x pairing offers KosmicKrisp and keeps the carrier MoltenVK build');
    assert.deepEqual(macOffered.vulkanPending, { architecture: 'x64', kosmicKrisp: true, vkd3d: false, carrier: false, moltenVK: true });
    const explicitStock = await resolve(runtimeId, { translatorD3D11: dxvk.id, translatorVulkan: stock.id }, [dxvk, kk, scene, stock]);
    assert.equal(row(explicitStock).used.id, stock.id, 'a selected driver always wins');
    assert.equal(row(explicitStock).reasonCode, 'dlss-forwarding'); assert.equal(row(explicitStock).reason, 'This Vulkan driver does not forward DLSS frames.');
    const explicitKK = await resolve(runtimeId, { translatorD3D11: dxvk.id, translatorVulkan: kk.id }, [dxvk, kk, scene]);
    assert.equal(row(explicitKK).used.id, kk.id); assert.equal(row(explicitKK).reasonCode, null);
    const runtimeOwn = await resolve(runtimeId, { translatorD3D11: own.id }, [kk, scene]);
    assert.notEqual(row(runtimeOwn).used?.managerId, 'maclauncher-kosmickrisp', "the runtime's own DXVK keeps the runtime's driver");
    assert.notEqual(row(runtimeOwn).reasonCode, 'vulkan-pairing'); assert.equal(runtimeOwn.vulkanPending, null);
  }
});

test('the paired Vulkan driver downloads after consent: optional KosmicKrisp for DXVK, required for vkd3d-proton, carrier MoltenVK otherwise', async t => {
  const Managed = require('../src/modules/shared/vulkan/managed'), Vulkan = require('../src/modules/shared/vulkan');
  t.mock.method(Managed.sceneManager, 'resolveSelection', () => ({ ready: false, version: '1.4.2-MCLv10' }));
  const offer = { managerId: Managed.projectId, version: '27.0.0', requiresDownload: true, installOptions: { architecture: 'x64' }, optional: true, cancelLabel: 'Use MoltenVK', label: 'KosmicKrisp (Intel)' };
  const offered = t.mock.method(Vulkan, 'kosmicKrispOffer', () => offer);
  const capable = { platform: 'darwin', hardwareArch: 'arm64', macOSVersion: '26.0', physicalAppleGPU: true };
  const context = pending => ({ settings: {}, userDataDir: '/profile', translatorPlan: { vulkanPending: pending } });
  const carrier = { managerId: Managed.sceneProjectId, version: '1.4.2-MCLv10', requiresDownload: true, installOptions: { sectionId: 'default' } };
  const dxvk = await Translators.driverRequirements(context({ architecture: 'x64', kosmicKrisp: true, vkd3d: false, carrier: true, moltenVK: true }), { host: capable });
  assert.equal(dxvk.length, 1); assert.equal(dxvk[0].optional, true); assert.equal(dxvk[0].cancelLabel, 'Use MoltenVK');
  assert.deepEqual({ ...dxvk[0].fallback, detail: undefined }, { ...carrier, detail: undefined });
  // DXVK 2.0 and later: skipping names the runtime's automatic choice, installs nothing and marks the decline for this Play.
  for (const [runtimeId, label] of [['crossover', "Use CrossOver's Automatic Choice"], ['sikarugir', "Use Sikarugir's Automatic Choice"]]) {
    const modern = await Translators.driverRequirements({ ...context({ architecture: 'x64', kosmicKrisp: true, vkd3d: false, carrier: false, moltenVK: false }), runtimeId }, { host: capable });
    assert.equal(modern.length, 1); assert.equal(modern[0].optional, true); assert.equal(modern[0].cancelLabel, label);
    assert.equal(modern[0].fallback, undefined); assert.deepEqual(modern[0].declines, ['kosmickrisp-pairing']);
    assert.match(modern[0].detail, /Skipping uses .+'s automatic choice instead of MacLauncher's DXVK\./);
  }
  assert.equal(offered.mock.calls[0].arguments[1].architecture, 'x64');
  const vkd3d = await Translators.driverRequirements(context({ architecture: 'x64', kosmicKrisp: true, vkd3d: true, carrier: true }), { host: capable });
  assert.equal(vkd3d[0].optional, undefined); assert.equal(vkd3d[0].cancelLabel, undefined); assert.equal(vkd3d[0].fallback, undefined);
  const incapable = await Translators.driverRequirements(context({ architecture: 'x64', kosmicKrisp: false, vkd3d: false, carrier: true, moltenVK: true }), { host: { ...capable, physicalAppleGPU: false } });
  assert.deepEqual(incapable.map(item => item.managerId), [Managed.sceneProjectId]);
  assert.deepEqual(await Translators.driverRequirements({ translatorPlan: { vulkanPending: null } }), []);
});

test('declining the paired KosmicKrisp download continues Play and marks the decline for the launch plan', async () => {
  const { prepareForLaunch } = require('../src/core/runtime-preparation');
  const offer = { managerId: 'maclauncher-kosmickrisp', version: '27.0.0', requiresDownload: true, optional: true,
    cancelLabel: "Use CrossOver's Automatic Choice", declines: ['kosmickrisp-pairing'], label: 'KosmicKrisp' };
  const run = async answer => {
    const installs = [], context = { runtimeId: 'crossover', settings: { runtimes: {} }, userDataDir: '/profile', confirmRuntimeInstall: async () => answer };
    const manager = { id: 'maclauncher-kosmickrisp', label: 'MacLauncher KosmicKrisp', getState: () => ({ installed: [] }), installRuntime() {} };
    const result = await prepareForLaunch({ entry: { name: 'Fixture' }, mod: { getRuntimeRequirements: async () => [offer] }, info: {}, context,
      registry: { listModuleIds: () => [], listSharedRuntimeManagers: () => [manager] }, install: async (item, payload) => { installs.push(payload.version); } });
    return { result, installs, declined: context.declinedChoices };
  };
  const skipped = await run(false);
  assert.equal(skipped.result, true, 'Play continues'); assert.deepEqual(skipped.installs, []);
  assert.deepEqual([...skipped.declined], ['kosmickrisp-pairing']);
  const accepted = await run(true);
  assert.deepEqual(accepted.installs, ['27.0.0']); assert.equal(accepted.declined, undefined);
});
