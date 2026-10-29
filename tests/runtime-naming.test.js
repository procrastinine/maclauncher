const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const Sources = require('../src/modules/video/plugin-sources');
const Plugins = require('../src/modules/video/plugins');

async function rendererExports(file) {
  const { build } = require('vite');
  const result = await build({ configFile: false, logLevel: 'silent', build: {
    ssr: path.resolve(__dirname, '../src/renderer/src/ui', file), write: false,
    rollupOptions: { output: { format: 'cjs', codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, 'runtime-naming-render.cjs'), module);
  compiled.paths = module.paths;
  compiled._compile(result.output.find(chunk => chunk.type === 'chunk').code, compiled.id);
  return compiled.exports;
}

test('runtime menu and Runtimes navigation consume matching manifest project names', async () => {
  const registry = require('../src/modules/registry');
  const helpers = await rendererExports('ui-helpers.ts');
  const { groupRuntimeManagers } = await rendererExports('components/runtime-tabs-model.ts');
  for (const [moduleId, runtimeId, managerId] of [
    ['java', 'java', 'java'], ['nxnative', 'nxnative', 'nxnative'], ['anyps5', 'anyps5', 'anyps5'], ['easyrpg', 'easyrpg', 'easyrpg'],
    ['siglus', 'siglus', 'siglus'], ['siglus', 'rlvm', 'rlvm'], ['video', 'mpv', 'mpv'],
    ['mac32', 'mac32', 'mac32'], ['nitroplus', 'npengine', 'npengine']
  ]) {
    const manifest = registry.getModuleInfo(moduleId), ui = registry.getRuntimeManagerUi(managerId);
    const groups = groupRuntimeManagers([{ id: managerId, label: 'Old cached manager name', ui }]);
    assert.equal(groups[0].label, helpers.formatRuntimeOption(runtimeId, manifest), moduleId);
    assert.equal(manifest.runtime.entries[runtimeId].label, ui.tabLabel);
  }
  for (const id of ['mv', 'mz', 'rgss', 'easyrpg', 'nxnative', 'anyps5']) {
    const manifest = registry.getModuleInfo(id);
    assert.equal(helpers.formatModuleLabel(manifest.label, manifest.shortLabel, id),
      helpers.formatModuleBadge(manifest.shortLabel, manifest.label, id));
  }
  assert.equal(registry.getModuleInfo('alicesoft').runtime.entries.xsystem4.label, 'System 4');
});

test('graphics helper choices keep automatic first and descend by version without changing IDs', () => {
  const manifest = require('../src/modules/gamemaker/manifest.json');
  const field = Object.values(manifest.runtime.entries).flatMap(entry => entry.settings?.fields || [])
    .find(field => field.key === 'graphicsHelperVersion');
  assert.equal(field.options[0].value, 'auto');
  assert.deepEqual(field.options.slice(1).map(option => option.label), ['v5', 'v4', 'v3', 'v2', 'v1']);
  assert.deepEqual(new Set(field.options.slice(1).map(option => option.value)),
    new Set([1, 2, 3, 4, 5].map(n => `software-gl-v${n}-universal`)));
});

test('pinned plugin catalog displays a source date while retaining its exact installation identity', t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-naming-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const state = Plugins.manager.getState({ userDataDir });
  const section = state.sections.find(section => section.id === 'thumbfast');
  const pin = Plugins.packages.thumbfast;
  assert.equal(section.plugin.version, pin.upstreamRevision);
  assert.equal(section.versionLabels[pin.version], '2026-06-28 snapshot');
  assert.equal(section.plugin.versionLabel, section.versionLabels[pin.version]);
  assert.equal(section.catalog.versionLabels[pin.version], section.versionLabels[pin.version]);
  assert.match(pin.assets[0].url, new RegExp(pin.upstreamRevision));
  assert.deepEqual(fs.readdirSync(userDataDir), []);
});

test('new plugin snapshots use commit dates with exact download revisions and safe metadata fallback', async () => {
  const sha = 'a'.repeat(40), date = '2026-10-28T23:30:00Z';
  const result = await Sources.resolveKnownSource(Sources.THUMBFAST_SOURCE, {}, {
    request: async url => {
      assert.equal(url, 'https://api.github.com/repos/po5/thumbfast/commits/HEAD');
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ sha, commit: { committer: { date } } })) };
    }
  });
  assert.equal(result.versionLabel, '2026-10-28 snapshot');
  assert.equal(result.upstreamRevision, sha);
  assert.equal(result.url, `https://raw.githubusercontent.com/po5/thumbfast/${sha}/thumbfast.lua`);
  assert.equal(Sources.snapshotVersionLabel({}), 'Source snapshot');
  assert.equal(Sources.snapshotVersionLabel({ commit: { author: { date } } }), '2026-10-28 snapshot');
});
