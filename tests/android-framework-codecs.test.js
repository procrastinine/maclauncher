const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nativeMethodDiagnostics, spawnSync } = require('./helpers/android-java');

function javaFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? javaFiles(file) : entry.name.endsWith('.java') ? [file] : [];
  }).sort();
}
function javaHome() {
  if (process.env.JAVA_HOME && fs.existsSync(path.join(process.env.JAVA_HOME, 'bin/javac'))) return process.env.JAVA_HOME;
  if (process.platform !== 'darwin') return null;
  const result = spawnSync('/usr/libexec/java_home', ['-v', '21'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

test('Android codecs stream bounded data and text paint preserves real font state', async t => {
  const home = javaHome();
  if (!home) return t.skip('Requires Java 21 development tools');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'android-framework-codecs-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const name of ['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'CLASSPATH']) delete env[name];
  function run(command, args) {
    const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 30000, maxBuffer: 2 << 20 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, result.stdout + result.stderr);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(nativeMethodDiagnostics(result.stdout + result.stderr), [], result.stdout + result.stderr);
    return result.stdout;
  }
  const classes = path.join(temporary, 'classes');
  fs.mkdirSync(classes);
  run(path.join(home, 'bin/javac'), ['--release', '21', '-d', classes,
    ...javaFiles(path.resolve(__dirname, '../src/modules/android/native/java')),
    ...javaFiles(path.resolve(__dirname, '../src/modules/android/native/java-jvm')),
    ...javaFiles(path.join(__dirname, 'fixtures/android-framework-codecs')).filter(file => path.basename(file) !== 'TextPaintProbe.java')]);
  for (const [name, main] of [
    ['Base64 alphabets, fragmented streams, bounded scratch and close failures', 'Base64Probe'],
    ['Paint copying, TextPaint state and selected font metrics', 'TextPaintProbe']
  ]) {
    await t.test(name, () => {
      if(main==='TextPaintProbe'){
        const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
        assert.ok(runtime,'TextPaint requires the same full native framework runtime used by production');
        const nativeClasses=path.join(temporary,'native-classes');fs.mkdirSync(nativeClasses);
        const jars=['android-host.jar','android-framework.jar'].map(file=>path.resolve(runtime,file)),classpath=[nativeClasses,...jars].join(path.delimiter);
        run(path.join(home,'bin/javac'),['--release','21','-cp',jars.join(path.delimiter),'-d',nativeClasses,
          path.join(__dirname,'fixtures/android-framework-codecs/TextPaintProbe.java'),
          path.join(__dirname,'fixtures/android-window-session/RuntimeFixture.java')]);
        const output=run(path.join(home,'bin/java'),['-Xverify:all','-Xcheck:jni','-Xmx96m','-Djava.awt.headless=true',
          '-cp',classpath,main,path.resolve(runtime),path.join(temporary,'paint-data')]);
        assert.match(output,/PASS TextPaint state and real font contracts/);return;
      }
      const output = run(path.join(home, 'bin/java'), ['-Xverify:all', '-Xcheck:jni', '-Xmx96m',
        '-Djava.awt.headless=true', '-cp', classes, main]);
      assert.match(output, /PASS /);
    });
  }
});
