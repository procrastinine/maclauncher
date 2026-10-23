const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('./helpers/android-java');

test('Android Canvas applies Porter–Duff pixel composition and Paint transfer state', t => {
  const home = process.env.JAVA_HOME || (process.platform === 'darwin'
    ? spawnSync('/usr/libexec/java_home', ['-v', '21'], { encoding: 'utf8' }).stdout.trim() : null);
  if (!home || !fs.existsSync(path.join(home, 'bin/javac'))) return t.skip('Requires Java 21 development tools');
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!runtime||process.platform!=='darwin')return t.skip('Requires a built macOS Android runtime');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'android-transfer-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const classpath=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter);
  const run = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 20000, maxBuffer: 1 << 20 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  run(path.join(home, 'bin/javac'), ['--release', '21', '-cp',classpath,'-d', temporary,
    path.join(__dirname, 'fixtures/android-framework-services/TransferModeProbe.java')]);
  assert.match(run(path.join(home, 'bin/java'), ['-Xverify:all', '-Xmx64m', '-Djava.awt.headless=true', '-cp', temporary+path.delimiter+classpath, 'android.graphics.TransferModeProbe',path.resolve(runtime)]), /PASS Canvas transfer modes/);
});
