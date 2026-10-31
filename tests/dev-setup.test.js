const test = require('node:test');
const assert = require('node:assert/strict');
const Setup = require('../scripts/setup-development.cjs');

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
    fetchPackages: step('packages', { packages: lock.packages.length }),
    ...overrides
  };
  return { calls, lock, options };
}

test('developer installation uses the app lock and the existing publisher and sealed-package preparation paths', async () => {
  const f = fixture();
  const result = await Setup.prepareDevelopmentInputs(f.options);
  assert.deepEqual(f.calls.map(row => row.name), ['electron', 'lock', 'python', '7zip', 'publishers', 'packages']);
  assert.deepEqual(f.calls[1].options, { repoRoot: '/source', arch: 'arm64' });
  assert.deepEqual(f.calls[2].options, { repoRoot: '/source', arch: 'arm64' });
  assert.deepEqual(f.calls.at(-1).options, { repoRoot: '/source', lock: f.lock });
  assert.deepEqual(result, { electron: true, arch: 'arm64', nativePackages: 1, python: 'arm64', installed: false,
    sevenZip: { version: '26.00', architecture: 'universal' }, publishers: { files: 1 } });
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
  assert.deepEqual(await Setup.prepareDevelopmentInputs(f.options), { electron: true, nativePackages: 0, platform: 'linux' });
  assert.deepEqual(f.calls.map(row => row.name), ['electron']);
});

test('a failed included download remains an installation failure rather than a successful partial setup', async () => {
  const f = fixture({ fetchPackages: async () => { throw new Error('Locked graphics checksum differs'); } });
  await assert.rejects(Setup.prepareDevelopmentInputs(f.options), /Locked graphics checksum differs/);
});

test('setup options reject unknown architectures and arguments before installing', async () => {
  for (const args of [['--arch'], ['--arch', 'universal'], ['--force'], ['--arch', 'arm64', '--extra']])
    await assert.rejects(Setup.main(args), /Usage:/);
});
