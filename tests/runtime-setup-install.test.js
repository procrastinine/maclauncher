const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Origins = require('../src/core/runtime-install-origins');
const { installSetup } = require('../src/main/runtime-setup-install');

test('automatic setup records the actual installed identity and preserves existing and explicit copies', async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-setup-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const rows = [{ version: 'existing', variant: 'operation:interpolate' }];
  const manager = { id: 'models', getState: () => ({ sections: [{ id: 'default', installed: rows }] }) };
  const settings = { runtimes: { models: { defaultVersions: {} } } }, original = structuredClone(settings);
  const setup = (version, automatic = true) => installSetup({ manager, userDataDir, settings,
    plan: { version: 'upstream-release', automatic, installOptions: { sectionId: 'default' } },
    install: async () => {
      let result = rows.find(row => row.version === version);
      if (!result) rows.push(result = { version, variant: 'operation:interpolate' });
      return result;
    } });
  await setup('existing');
  assert.deepEqual(Origins.read(userDataDir), []);
  const first = await setup('sha256-' + '1'.repeat(64));
  const second = await setup('sha256-' + '2'.repeat(64));
  await setup(second.version);
  await setup('explicit', false);
  assert.deepEqual(Origins.read(userDataDir).map(({ version, variant }) => ({ version, variant })),
    [first, second].map(({ version, variant }) => ({ version, variant })));
  assert.deepEqual(settings, original, 'automatic preparation does not write a default');
});

test('a failed setup records no installation', async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-setup-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  await assert.rejects(installSetup({ userDataDir, manager: { id: 'models', getState: () => ({ installed: [] }) },
    plan: { version: 'release', automatic: true }, install: async () => { throw Error('Download refused'); } }), /Download refused/);
  assert.deepEqual(Origins.read(userDataDir), []);
});

test('a declined or incomplete setup result cannot create an origin for the listed source', async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-setup-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  for (const result of [null, true, {}, { version: 'incomplete', ready: false }]) {
    assert.equal(await installSetup({ userDataDir, manager: { id: 'models', getState: () => ({ installed: [] }) },
      plan: { version: 'listed-source-version', automatic: true }, install: async () => result }), result);
    assert.deepEqual(Origins.read(userDataDir), []);
  }
});
