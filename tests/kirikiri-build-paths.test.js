const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sourcePathFlags } = require('../src/modules/kirikiri/build');

test('Kiri compiler path maps remove private __FILE__ paths and preserve quoted build directories', { skip: process.platform !== 'darwin' }, t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "kiri path's fixture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installDir = path.join(root, 'runtime with spaces');
  const source = path.join(installDir, 'build-source', 'fixture.c');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, '#include <stdio.h>\nint main(void) { puts(__FILE__); return 0; }\n');
  const manager = { core: { getInstallDir: () => installDir } };
  const flags = sourcePathFlags(manager, 'snapshot-124bdf8-macos-v3', root);
  const executable = path.join(root, 'fixture');
  // CMake passes this value through a shell. Exercise that same quoting path
  // with an apostrophe and spaces, then inspect the emitted source identity.
  execFileSync('/bin/sh', ['-c', 'exec /usr/bin/clang ' + flags + ' "$1" -o "$2"', 'kiri-build-fixture', source, executable], { stdio: ['ignore', 'pipe', 'pipe'] });
  const identity = execFileSync(executable, [], { encoding: 'utf8' }).trim();
  assert.equal(identity, 'src/external/krkrsdl2/fixture.c');
  assert.equal(fs.readFileSync(executable).includes(Buffer.from(root)), false);
});
