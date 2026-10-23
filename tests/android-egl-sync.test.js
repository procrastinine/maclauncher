const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

test('ANGLE Metal EGL fences submit before producer pacing and wait without global locks', t => {
  if (process.platform !== 'darwin' || !process.env.KLEPTON_ANGLE_RUNTIME) return t.skip('Requires macOS and KLEPTON_ANGLE_RUNTIME');
  const source = path.resolve(__dirname, '../src/modules/android/native');
  const headers = path.resolve(__dirname, '../', JSON.parse(fs.readFileSync(path.join(source, 'gles-headers.json'))).directory, 'include');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'android-egl-sync-'));
  t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
  const run = (cmd,args) => {
    const result = spawnSync(cmd,args,{encoding:'utf8',timeout:30000});
    assert.equal(result.error,undefined);
    assert.equal(result.status,0,result.stdout+result.stderr);
    return result.stdout;
  };
  const executable = path.join(directory,'probe');
  run('clang++',['-std=c++20','-fobjc-arc','-I'+headers,'-framework','Metal','-framework','Foundation',path.join(__dirname,'fixtures/android-egl-window/SyncWorkerProbe.mm'),'-o',executable]);
  assert.match(run(executable,[path.resolve(process.env.KLEPTON_ANGLE_RUNTIME)]),/PASS context-free EGL fence and shared-event workers/);
});
