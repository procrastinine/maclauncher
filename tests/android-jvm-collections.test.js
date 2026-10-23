const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { frameworkJvmOptions } = require('../src/modules/android/jvm-options');
const { frameworkArguments } = require('./helpers/android-java');

test('Original Android SystemCleaner retains the JVM shared resource lifecycle', t => {
  const home = process.env.JAVA_HOME;
  if (!home) return t.skip('Requires JAVA_HOME for Java 21');
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'android-cleaner-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const framework = frameworkArguments('javac', [])[1];
  execFileSync(path.join(home, 'bin/javac'), ['--release', '21', '-cp', framework, '-d', output,
    path.resolve('tests/fixtures/android-framework-services/SharedCleanerProbe.java')], { stdio: 'pipe' });
  const cp = [output, framework].join(path.delimiter);
  const env = { ...process.env };
  for (const key of ['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS']) delete env[key];
  const launch = options => spawnSync(path.join(home, 'bin/java'), [...options, '-Xverify:all',
    '-cp', cp, 'SharedCleanerProbe'], { encoding: 'utf8', timeout: 10000, env });
  const negative = launch(frameworkJvmOptions.filter(value => !value.includes('/jdk.internal.ref=')));
  assert.equal(negative.status, 1, negative.stdout + negative.stderr);
  assert.match(negative.stderr, /IllegalAccessError.*jdk.internal.ref/s);
  const positive = launch(frameworkJvmOptions);
  assert.equal(positive.error, undefined);
  assert.equal(positive.status, 0, positive.stdout + positive.stderr);
  assert.match(positive.stdout, /PASS original Android SystemCleaner shares JDK cleanup ownership/);
});

test('Android collection wrappers retain JDK delegates and monitor ownership', t => {
  const home = process.env.JAVA_HOME;
  if (!home) return t.skip('Requires JAVA_HOME for Java 21');
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'android-collections-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  execFileSync(path.join(home, 'bin/javac'), ['--release', '21', '-d', output,
    path.resolve('tests/fixtures/android-framework-services/DesugaredCollectionsProbe.java')], { stdio: 'pipe' });
  const desugared = process.env.ANDROID_TEST_DESUGARED_JAR;
  const cp = [output, ...(desugared ? [path.resolve(desugared)] : [])].join(path.delimiter);
  const result = execFileSync(path.join(home, 'bin/java'), [...frameworkJvmOptions, '-Xverify:all',
    '-cp', cp, 'DesugaredCollectionsProbe', ...(desugared ? ['original'] : [])],
  { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(result, /PASS shared JDK collection delegate and monitor ownership/);
  if (desugared) assert.match(result, /PASS original Android desugared collection operations/);
});
