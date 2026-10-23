const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

test('Shared producer presentation registers before GPU completion and preserves cancellation', t => {
  const build = process.env.RESHADE_NATIVE_BUILD;
  if (process.platform !== 'darwin' || !build || process.env.RESHADE_GRAPHICS_RUN !== '1')
    return t.skip('Requires an explicit Metal check and a built shared graphics runtime');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reshade-scheduling-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const binary = path.join(directory, 'scheduling');
  const native = path.resolve(build);
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(RESHADE_|DYLD_|KLEPTON_|KL_)/.test(key)) delete env[key];
  env.RESHADE_EXPLICIT_HOST = '1';
  function run(command, args) {
    const result = spawnSync(command, args, {encoding: 'utf8', env, timeout: 20000});
    assert.ifError(result.error);assert.equal(result.status, 0, result.stdout + result.stderr);return result.stdout;
  }
  run('/usr/bin/c++', ['-std=c++17', '-fobjc-arc', '-mmacosx-version-min=13.0',
    '-I' + path.join(native, 'source/src'), path.join(__dirname, 'fixtures/reshade-presentation/scheduling.mm'),
    '-L' + native, '-lreshade-macos', '-Wl,-rpath,' + native, '-framework', 'Cocoa', '-framework', 'Metal', '-framework', 'QuartzCore', '-o', binary]);
  assert.match(run(binary, []), /PASS actual GPU-work presentation schedules before completion/);
});
