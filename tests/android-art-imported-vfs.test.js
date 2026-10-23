const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');

test('imported VFS roots reuse canonical paths before metadata and visibility checks', { timeout: 30000 }, t => {
  const rustc = process.env.RUSTC || 'rustc';
  const compiler = spawnSync(rustc, ['--version'], { encoding: 'utf8', timeout: 20000 });
  if (compiler.error?.code === 'ENOENT') return t.skip('Requires Rust or RUSTC');
  assert.ifError(compiler.error);
  assert.equal(compiler.status, 0, compiler.stdout + compiler.stderr);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'android-imported-vfs-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, 'probe');
  const run = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 20000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  run(rustc, ['--edition=2024', '-Dwarnings', 'tests/fixtures/android-art-storage/imported-vfs.rs', '-o', executable]);
  const output = run(executable, [root]);
  assert.equal(output.split('\n').filter(line => line.startsWith('PASS ')).length, 11, output);
  assert.match(output, /PASS 64 ordinary and 64 declared warmed image roots avoid canonicalization, declarations and visibility scans for a foreign inode/);
  assert.match(output, /PASS host symlink retarget is observed/);
  assert.match(output, /PASS declaration errors retain a successful canonical fallback/);
  assert.match(output, /PASS matching declaration errors do not grant imported defaults/);
});
