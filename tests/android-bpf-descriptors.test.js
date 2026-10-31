const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Java = require('./helpers/android-java');

test('Android traffic accounting returns stable mocked values without touching host counters or leaking descriptors', {timeout: 30000}, t => {
  if (process.platform !== 'darwin') return t.skip('Requires macOS');
  const home = Java.javaHome(), runtime = Java.runtimeRoot();
  if (!home || !fs.existsSync(path.join(home, 'bin/javac'))) return t.skip('Requires Java 21 development tools');
  if (!runtime) return t.skip('Requires an Android runtime via KLEPTON_NATIVE_RUNTIME or MACLAUNCHER_TEST_USER_DATA');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'android-traffic-accounting-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const classpath = [directory, path.join(runtime, 'android-host.jar')].join(path.delimiter);
  const run = (command, args) => {
    const result = Java.spawnSync(command, args,
      {encoding: 'utf8', timeout: 15000, maxBuffer: 1 << 20});
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result;
  };
  run(path.join(home, 'bin/javac'), ['--release', '21', '-cp', classpath, '-d', directory,
    path.join(Java.sourceRoot, 'java/maclauncher/android/framework/HostTrafficStats.java'),
    path.join(__dirname, 'fixtures/android-native/MockTrafficStatsProbe.java')]);
  const result = run(path.join(home, 'bin/java'), ['-Xverify:all', '-Dklepton.bridge=' + path.join(directory, 'absent-native-library'),
    '-cp', classpath, 'MockTrafficStatsProbe']);
  assert.match(result.stdout, /PASS mocked device\/interface\/UID counters and usage sessions; 128 descriptor cycles without leaks/);
  t.diagnostic(result.stdout.trim());
});
