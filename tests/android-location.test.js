const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('./helpers/android-java');

test('Android location needs an explicit request and manual decision, with cancellable session-only callbacks', t => {
  const selected = spawnSync('/usr/libexec/java_home', ['-v', '21'], { encoding: 'utf8' });
  const home = process.env.JAVA_HOME || (selected.status === 0 && selected.stdout.trim());
  if (!home || process.platform !== 'darwin') return t.skip('Requires macOS and Java 21 development tools');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'android-location-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of ['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'CLASSPATH']) delete env[key];
  const files = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : entry.name.endsWith('.java') ? [file] : [];
  });
  const run = (binary, args) => {
    const result = spawnSync(binary === 'clang' ? binary : path.join(home, 'bin', binary), args, { env, encoding: 'utf8', timeout: 30000, maxBuffer: 2 << 20 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  run('javac', ['--release', '21', '-d', temporary,
    ...files(path.resolve(__dirname, '../src/modules/android/native/java')),
    path.join(__dirname, 'fixtures/android-location/LocationProbe.java')]);
  const bridge = path.join(temporary, 'clock.dylib');
  run('clang', ['-std=c11', '-dynamiclib', '-I' + path.join(home, 'include'), '-I' + path.join(home, 'include/darwin'),
    path.resolve(__dirname, '../src/modules/android/native/native-clock/clock-bridge.c'),
    path.resolve(__dirname, '../src/modules/android/native/thread-identity.c'), '-o', bridge]);
  for (const mode of ['grant', 'deny']) assert.match(run('java', ['-Xverify:all', '-Xmx96m', '-Djava.awt.headless=true', '-Dklepton.bridge=' + bridge, '-cp', temporary, 'LocationProbe', mode]), /PASS requested manual location/);
});
