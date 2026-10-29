const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Modules = require('../src/modules/registry');
const { composeRuntimeProviders } = require('../src/modules/shared/runtime/providers');
const { createLauncher } = require('../src/core/launcher');
const { canLaunchEntry, resolveRuntimeSupportForEntry } = require('../src/core/launch-capability');

const external = ['mac32', 'crossover', 'sikarugir', 'prosper'];
for (const [id, expected] of [
  ['crossover', ['crossover', 'sikarugir']], ['mv', ['crossover', 'sikarugir']],
  ['rgss', ['crossover', 'sikarugir']], ['bgi', ['crossover', 'sikarugir']],
  ['catsystem2', ['crossover', 'sikarugir']], ['haxe', ['crossover', 'sikarugir']],
  ['nxnative', []], ['anyps5', ['prosper']],
  ['android', []], ['generic-app', ['mac32']], ['flash', []], ['java', []], ['video', []]
]) test(`${id} advertises backends for its input formats`, () => {
  const manifest = Modules.getModuleInfo(id);
  assert.deepEqual(manifest.runtime.supported.filter(id => external.includes(id)).sort(), expected.sort());
});

test('new provider identities use declared input formats without module or backend name cases', () => {
  const provider = { runtimeId: 'future-provider', runtime: { input: { binaryFormats: ['future-format'] } },
    supportsEntry: entry => entry.actualFormat === 'future-format', launchRuntime() {} };
  const create = formats => composeRuntimeProviders({ id: 'future-engine',
    manifest: { detection: { binaryFormats: formats }, runtime: { supported: ['own'] } } }, [provider]);
  assert.deepEqual(create(['other']).manifest.runtime.supported, ['own']);
  const mod = create(['future-format']);
  assert.deepEqual(mod.manifest.runtime.supported, ['own', 'future-provider']);
  assert.deepEqual(resolveRuntimeSupportForEntry(mod, mod.manifest, { actualFormat: 'other' }, {}), ['own']);
  assert.deepEqual(resolveRuntimeSupportForEntry(mod, mod.manifest, { actualFormat: 'future-format' }, {}), ['own', 'future-provider']);
});

test('saved inapplicable provider choices remain readable and execution refuses them', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-applicability-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launcher = createLauncher({ userDataDir: root, registry: Modules });
  for (const moduleId of ['nxnative', 'anyps5', 'mv']) {
    const mod = Modules.getModule(moduleId), info = Modules.getModuleInfo(moduleId);
    for (const runtimeId of external) {
      const entry = { gameId: 'saved', gamePath: path.join(root, moduleId), moduleId, runtimeId, networkAccess: false,
        moduleData: { inspectionOnly: false, format: moduleId === 'anyps5' ? 'elf' : 'nso' } };
      if (resolveRuntimeSupportForEntry(mod, info, entry, {}).includes(runtimeId)) continue;
      const before = JSON.stringify(entry);
      assert.equal(mod.normalizeRuntimeId?.(runtimeId) || runtimeId, runtimeId);
      assert.equal(launcher.resolveRuntimeForEntry(runtimeId, mod, info, entry, {}, {}), runtimeId);
      assert.equal(canLaunchEntry({ mod, info, entry, runtimeId }), false);
      assert.throws(() => launcher.resolveRuntimeForEntry(runtimeId, mod, info, entry, {}, {}, { strict: true }), /not supported/);
      await assert.rejects(launcher.launchEntry(entry, { settings: {} }), /cannot launch/);
      assert.equal(JSON.stringify(entry), before);
      assert.ok(info.runtime.entries[runtimeId].label, 'Saved provider retains descriptive metadata');
    }
  }
});

test('saved module defaults remain unchanged when provider applicability narrows', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-default-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settings = { modules: { nxnative: { defaultRuntime: 'mac32' } } };
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(settings));
  const launcher = createLauncher({ userDataDir: root, registry: Modules });
  assert.equal(launcher.getResolvedModuleSettings(settings).nxnative.defaultRuntime, 'mac32');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'settings.json'))), settings);
});

test('Settings shows a saved incompatible default and compatible alternatives', async () => {
  const { build } = require('vite'), Module = require('node:module');
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
  const bundle = await build({ configFile: false, logLevel: 'silent', build: {
    ssr: path.join(__dirname, '../src/renderer/src/ui/components/SettingsView.tsx'), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs' } }
  } });
  const compiled = new Module(path.join(__dirname, 'backend-settings.cjs'), module);
  compiled.paths = module.paths;
  compiled._compile(bundle.output.find(chunk => chunk.type === 'chunk').code, compiled.id);
  const html = renderToStaticMarkup(React.createElement(compiled.exports.SettingsView, {
    state: { modules: [Modules.getModuleInfo('nxnative')], moduleSettings: { nxnative: { defaultRuntime: 'mac32' } },
      runtimeDefaults: {}, recents: [] }, sectionId: 'nxnative', showIcons: false, showNonDefaultTags: false,
    onSetLauncherSettings() {}, onSetModuleSettings() {}
  }));
  assert.match(html, /<option value="mac32" selected="">32-bit Mac \(saved; choose a compatible runtime\)<\/option>/);
  assert.match(html, /<option value="nxnative">Switch \(nxnative\)<\/option>/);
  assert.doesNotMatch(html, /settings-runtime-tab-nxnative-(?:mac32|prosper|sikarugir|crossover)/);
});
