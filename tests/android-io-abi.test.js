const test = require('node:test');
const {androidSource}=require('./helpers/android-sources.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('Linux I/O ABI retains original socket owners and caller buffer bounds', async t => {
  const root = path.resolve(__dirname, '..'), source = path.join(root, 'src/modules/android/native');
  const klepton = process.env.KLEPTON_SOURCE || androidSource('klepton');
  if (process.platform !== 'darwin' || !fs.existsSync(path.join(klepton, 'runtime/libc/kl_shim.c')))
    return t.skip('Requires macOS and the pinned Klepton source');
  // poll-bridge.c delegates to the pollable descriptor bridge built from the pinned epoll-shim.
  const descriptors = process.env.EPOLL_SHIM_SOURCE || androidSource('epoll-shim');
  if (process.arch !== 'arm64' || !fs.existsSync(path.join(descriptors, 'CMakeLists.txt')) ||
      spawnSync(process.env.NINJA || 'ninja', ['--version'], { stdio: 'ignore' }).status !== 0)
    return t.skip('Requires Apple Silicon, the pinned epoll-shim source and Ninja');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'android-io-abi-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const { buildPollableDescriptors } = await import(require('node:url').pathToFileURL(path.join(source, 'pollable-fds/build.mjs')));
  const pollable = buildPollableDescriptors({ checkout: descriptors, output: path.join(temporary, 'pollable') });
  const shim = path.join(temporary, 'shim.c'), slink = path.join(temporary, 'slink.c'), libc = path.join(temporary, 'libc.c');
  fs.copyFileSync(path.join(klepton, 'runtime/libc/kl_shim.c'), shim);
  fs.copyFileSync(path.join(klepton, 'runtime/libc/kl_libc_slink.c'), slink);
  fs.copyFileSync(path.join(klepton, 'runtime/libc/kl_libc.c'), libc);
  const { prepareIoSources } = await import(require('node:url').pathToFileURL(path.join(source, 'io-sources.mjs')));
  prepareIoSources({ shim, slink, libc });
  const adapted = fs.readFileSync(shim, 'utf8');
  let functions = adapted.slice(adapted.indexOf('static socklen_t kl_sa_hostlen('), adapted.indexOf('// A HOST sockaddr, printed.'));
  for (const operation of ['accept', 'getpeername', 'getsockname']) {
    const begin = adapted.indexOf(`static int kl_${operation}(`), end = adapted.indexOf('\n}', begin);
    functions += '\n' + adapted.slice(begin, end + 2);
  }
  fs.writeFileSync(path.join(temporary, 'socket-addresses.c'), functions);
  const binary = path.join(temporary, 'probe');
  for (const [command, args] of [
    ['clang', ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', '-I'+source, '-I'+temporary, '-I'+pollable.include,
      path.join(__dirname, 'fixtures/android-native/io-abi.c'), path.join(source, 'poll-bridge.c'), pollable.object, pollable.archive, '-o', binary]],
    [binary, []]
  ]) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const socket = path.join(temporary, 'socket-timeouts');
  for (const [command, args] of [
    ['clang', ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function', '-Wl,-dead_strip', '-I'+source,
      path.join(__dirname, 'fixtures/android-native/socket-timeouts.c'), '-o', socket]],
    [socket, []]
  ]) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const seekSource = fs.readFileSync(libc, 'utf8');
  let seekFunctions = '';
  for (const name of ['lseek', 'lseek64']) {
    const match = seekSource.match(new RegExp('off_t\\s+klb_' + name + '\\(int fd, off_t o, int w\\)\\s*\\{[^}]+\\}'));
    assert.ok(match, 'Adapted upstream seek wrapper exists: ' + name);
    seekFunctions += '\n' + match[0];
  }
  fs.writeFileSync(path.join(temporary, 'seek-functions.c'), seekFunctions);
  const seek = path.join(temporary, 'seek');
  for (const [command, args] of [
    ['clang', ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', '-I'+source, '-I'+temporary,
      path.join(__dirname, 'fixtures/android-native/seek-abi.c'), '-o', seek]],
    [seek, []]
  ]) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});
