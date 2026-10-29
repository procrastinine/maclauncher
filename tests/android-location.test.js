const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('./helpers/android-java');

test('Android location needs an explicit request and manual decision, with cancellable session-only callbacks', t => {
  const selected = spawnSync('/usr/libexec/java_home', ['-v', '21'], { encoding: 'utf8' });
  const home = process.env.JAVA_HOME || (selected.status === 0 && selected.stdout.trim());
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if (!home || !runtime || process.platform !== 'darwin') return t.skip('Requires macOS, Java21 and the complete Android runtime');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'android-location-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of ['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'CLASSPATH']) delete env[key];
  const cp=[temporary,path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar')].join(path.delimiter);
  const run = (binary, args) => {
    const result = spawnSync(binary === 'clang' ? binary : path.join(home, 'bin', binary), args, { env, encoding: 'utf8', timeout: 30000, maxBuffer: 2 << 20 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  run('javac', ['--release','21','-cp',cp,'-d',temporary,
    path.join(__dirname,'fixtures/android-window-session/RuntimeFixture.java'),
    path.join(__dirname,'fixtures/android-framework-services/PackageManifest.java'),
    path.join(__dirname,'fixtures/android-location/LocationProbe.java')]);
  for (const mode of ['grant', 'deny']) assert.match(run('java', ['-Xverify:all','-Xmx96m','-Djava.awt.headless=true','-cp',cp,'LocationProbe',path.resolve(runtime),path.join(temporary,mode),mode]), /PASS requested manual location/);
});
