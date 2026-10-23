const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const FSR = require('../src/modules/shared/reshade/temporal/fsr');
const source = require('../src/modules/shared/reshade/temporal/fsr/source.json');

test('FSR provider discovery keeps installed algorithms independent and stays offline', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsr-temporal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'temporal/fsr');
  fs.mkdirSync(directory, { recursive: true });
  const options = { platform: 'darwin', macOSVersion: '13.0' };
  assert.equal(FSR.resolve(root, options), null);
  for (const method of ['fsr2', 'fsr3']) {
    fs.mkdirSync(path.join(directory, method));
    fs.writeFileSync(path.join(directory, `libmaclauncher-${method}.dylib`), 'provider');
    fs.writeFileSync(path.join(directory, `${method}-build.json`), JSON.stringify({ providerABI: 1, commit: source[method].commit, shaderVariants: 16 }));
  }
  assert.deepEqual(FSR.resolve(root, options).methods, ['fsr2', 'fsr3']);
  const environment = FSR.prepare(root, options);
  assert.equal(environment.RESHADE_FSR_SHADER_DIRECTORY, fs.realpathSync(directory));
  assert.equal(environment.RESHADE_FSR2_LIBRARY, path.join(fs.realpathSync(directory), 'libmaclauncher-fsr2.dylib'));
  fs.rmSync(path.join(directory, 'libmaclauncher-fsr3.dylib'));
  assert.deepEqual(FSR.resolve(root, options).methods, ['fsr2']);
  assert.equal(FSR.prepare(root, options).RESHADE_FSR3_LIBRARY, undefined);
  fs.writeFileSync(path.join(directory, 'fsr2-build.json'), JSON.stringify({ providerABI: 1, commit: 'another-source', shaderVariants: 16 }));
  assert.deepEqual(FSR.prepare(root, options), {});
  assert.equal(FSR.resolve(root, { ...options, macOSVersion: '12.7' }), null);
  assert.equal(FSR.resolve(root, { ...options, platform: 'linux' }), null);
});
