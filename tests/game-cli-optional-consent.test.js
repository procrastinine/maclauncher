const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');

test('non-TTY CLI continues an optional bridge plan without a prompt and honors --yes', async () => {
  const file = require.resolve('../src/core/game-cli'), load = createRequire(file);
  for (const [args, licenseRequired, expected] of [[[], false, false], [['--yes'], false, true], [['--yes'], true, false],
    [['--yes', '--accept-runtime-licenses'], true, true]]) {
    let answer, calls = 0;
    const errors = [], processState = { env: {}, argv: [], stdin: { isTTY: false }, stderr: {}, exitCode: 0 };
    const stubs = {
      './game-cli-environment': { initializeCommandEnvironment: () => ({ appPath: '/test/source', createApp: () => ({}) }) },
      './launcher': { createLauncher: options => ({ userDataDir: '/test/profile', loadSettings: () => ({}),
        resolveEntry: async () => ({ gameId: 'test', gamePath: '/test/game', name: 'Test' }),
        launchEntry: async () => { calls++; answer = await options.confirmRuntimeInstall({ optional: true, label: 'Steam client bridge', licenseRequired }); return { kind: 'cancelled' }; } }) },
      './game-store': {}, './electron-binary': {}, '../modules/registry': {}, './process-lifecycle': {},
      '../main/game-command': { resolveGameCommandPath: (_data, game) => game },
      'node:readline/promises': { createInterface: () => assert.fail('No terminal prompt without a TTY') }
    };
    const mockedRequire = id => Object.hasOwn(stubs, id) ? stubs[id] : load(id);
    const context = { require: mockedRequire, module: { exports: {} }, process: processState,
      console: { error: message => errors.push(message), log() {} }, __dirname: path.dirname(file) };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    await context.module.exports.runGameCli(['--game', '/test/game', '--user-data', '/test/profile', ...args]);
    assert.equal(calls, 1); assert.equal(answer === true || answer?.approved === true, expected);
    if (licenseRequired && expected) assert.equal(answer.licenseAccepted, true); assert.equal(processState.exitCode, 0);
    assert.deepEqual(errors, ['Launch cancelled.']);
  }
});
