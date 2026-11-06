const test = require('node:test');
const assert = require('node:assert/strict');
const Setup = require('../scripts/setup-development.cjs');

test('CI postinstall defers all acquisition while explicit setup and invalid arguments retain their behavior', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-setup-no-inputs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, 'scripts/setup-development.cjs');
  fs.mkdirSync(path.dirname(entry));
  fs.copyFileSync(require.resolve('../scripts/setup-development.cjs'), entry);
  const isolated = require(entry), env = { CI: '1', npm_lifecycle_event: 'postinstall' };
  const expected = { skipped: true, reason: 'CI configure and fetch prepare the selected app inputs.' };
  assert.deepEqual(await Setup.main([], { env }), expected);
  assert.deepEqual(await isolated.main([], { env }), expected, 'No input modules exist in this isolated checkout');
  await assert.rejects(isolated.main(['--invalid'], { env }), /Usage:/);
  await assert.rejects(isolated.main([], { env: { CI: '1', npm_lifecycle_event: 'setup:dev' } }), /Cannot find module/);
  await assert.rejects(isolated.main([], { env: { npm_lifecycle_event: 'postinstall' } }), /Cannot find module/);
});

function fixture(overrides = {}) {
  const calls = [], lock = { arch: 'arm64', packages: [{ id: 'graphics', version: '0.3.1' }] };
  const step = (name, result) => async options => { calls.push({ name, options }); return result; };
  const options = {
    repoRoot: '/source', platform: 'darwin', arch: 'arm64',
    installElectron: step('electron'),
    readLock: options => { calls.push({ name: 'lock', options }); return lock; },
    preparePython: step('python', { python: 'arm64', installed: false }),
    prepareSevenZip: step('7zip', { version: '26.00', architecture: 'universal' }),
    prepareDeclaredPublishers: step('publishers', { files: 1 }),
    prepareCp932: step('cp932', { generated: false }),
    buildActivation: options => { calls.push({ name: 'activation', options }); },
    fetchPackages: step('packages', { packages: lock.packages.length }),
    ...overrides
  };
  return { calls, lock, options };
}

test('developer installation uses the app lock and the existing publisher and sealed-package preparation paths', async () => {
  const f = fixture();
  const result = await Setup.prepareDevelopmentInputs(f.options);
  assert.deepEqual(f.calls.map(row => row.name), ['electron', 'cp932', 'activation', 'lock', 'python', '7zip', 'publishers', 'packages']);
  assert.deepEqual(f.calls.find(row=>row.name==='lock').options, { repoRoot: '/source', arch: 'arm64' });
  assert.deepEqual(f.calls.find(row=>row.name==='cp932').options, { repoRoot: '/source' });
  assert.deepEqual(f.calls.find(row=>row.name==='python').options, { repoRoot: '/source', arch: 'arm64' });
  assert.deepEqual(f.calls.at(-1).options, { repoRoot: '/source', lock: f.lock });
  assert.deepEqual(result, { electron: true, arch: 'arm64', nativePackages: 1, python: 'arm64', installed: false,
    sevenZip: { version: '26.00', architecture: 'universal' }, publishers: { files: 1 }, cp932: { generated: false } });
});

test('an explicit Intel setup selects the Intel lock and Python without rewriting the selection', async () => {
  const f = fixture({ arch: 'x64' });
  await Setup.prepareDevelopmentInputs(f.options);
  assert.equal(f.calls.find(row => row.name === 'lock').options.arch, 'x64');
  assert.equal(f.calls.find(row => row.name === 'python').options.arch, 'x64');
  assert.equal(f.calls.at(-1).options.lock, f.lock);
});

test('other platforms install Electron without acquiring Mac packages or publisher inputs', async () => {
  const f = fixture({ platform: 'linux', arch: 'x64' });
  assert.deepEqual(await Setup.prepareDevelopmentInputs(f.options), { electron: true, nativePackages: 0, platform: 'linux', cp932: { generated: false } });
  assert.deepEqual(f.calls.map(row => row.name), ['electron', 'cp932']);
});

test('a failed included download remains an installation failure rather than a successful partial setup', async () => {
  const f = fixture({ fetchPackages: async () => { throw new Error('Locked graphics checksum differs'); } });
  await assert.rejects(Setup.prepareDevelopmentInputs(f.options), /Locked graphics checksum differs/);
});

test('setup options reject unknown architectures and arguments before installing', async () => {
  for (const args of [['--arch'], ['--arch', 'universal'], ['--force'], ['--arch', 'arm64', '--extra']])
    await assert.rejects(Setup.main(args), /Usage:/);
});
