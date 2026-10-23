const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('./helpers/android-java');

test('Local services follow the active LoadedApk Application after an original record handoff', t => {
  const runtime = process.env.KLEPTON_NATIVE_RUNTIME;
  let home = process.env.JAVA_HOME;
  if (!home && process.platform === 'darwin') {
    const result = spawnSync('/usr/libexec/java_home', ['-v', '21'], {encoding: 'utf8'});
    if (result.status === 0) home = result.stdout.trim();
  }
  if (process.platform !== 'darwin' || !runtime || !home) return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const source = path.resolve(__dirname, '../src/modules/android/native/java/maclauncher/android/framework');
  const fixtures = path.join(__dirname, 'fixtures/android-framework-services');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'android-service-application-'));
  t.after(() => fs.rmSync(temporary, {recursive: true, force: true}));
  const classes = path.join(temporary, 'classes'), data = path.join(temporary, 'data'), ids = path.join(temporary, 'ids');
  for (const directory of [classes, data, ids]) fs.mkdirSync(directory, {mode: 0o700});
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(DYLD_|KL_|RESHADE_|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$|_JAVA_OPTIONS$|CLASSPATH$)/.test(key)) delete env[key];
  env.TMPDIR = temporary + path.sep;
  env.KL_ANDROID_ID_DIRECTORY = fs.realpathSync(ids);
  const cp = [classes, ...['android-host.jar', 'android-framework.jar'].map(name => path.resolve(runtime, name))].join(path.delimiter);
  const run = (command, args) => {
    const result = spawnSync(command, args, {env, cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 30000, maxBuffer: 2 << 20});
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, result.stdout + result.stderr);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  run(path.join(home, 'bin/javac'), ['--release', '21', '-proc:none', '-cp', cp, '-d', classes,
    ...['HostApplication', 'HostLocalServices'].map(name => path.join(source, name + '.java')),
    ...['ServiceApplicationHandoffProbe', 'JobSchedulerProbe', 'PackageManifest'].map(name => path.join(fixtures, name + '.java'))]);
  assert.match(run(path.join(home, 'bin/java'), ['-Xverify:all', '-cp', cp, 'maclauncher.android.fixture.ServiceApplicationHandoffProbe', path.resolve(runtime), data]),
    /PASS original ART-shaped instantiate\/create, LoadedApk Application handoff, attach\/onCreate queued binds, exact active instance guards and retirement/);
});
