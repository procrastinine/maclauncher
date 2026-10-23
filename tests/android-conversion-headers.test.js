const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('conversion declarations retain every type and member while ignoring implementation-only changes', t => {
  const home = process.env.JAVA_HOME || (process.platform === 'darwin'
    ? spawnSync('/usr/libexec/java_home', ['-v', '21'], { encoding: 'utf8' }).stdout.trim() : '');
  if (!home) return t.skip('Requires Java 21');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-conversion-headers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const native = path.resolve(__dirname, '../src/modules/android/native');
  const asm = path.join(native, 'tools', JSON.parse(fs.readFileSync(path.join(native, 'asm-binary.json'))).files[0].path);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(DYLD_|RESHADE_|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$|_JAVA_OPTIONS$|CLASSPATH$)/.test(key)) delete env[key];
  const run = (tool, args) => {
    const result = spawnSync(path.join(home, 'bin', tool), args, { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  const tools = path.join(root, 'tools'), cp = [tools, asm].join(path.delimiter);
  run('javac', ['--release', '21', '-cp', asm, '-d', tools,
    path.join(native, 'framework/ConversionHeaders.java'),
    path.join(__dirname, 'fixtures/android-framework-services/ConversionHeadersCheck.java')]);
  const build = (name, value, declaration = '') => {
    const directory = path.join(root, name); fs.mkdirSync(directory);
    const source = path.join(directory, 'Example.java'), classes = path.join(directory, 'classes');
    fs.writeFileSync(source, `public class Example implements java.io.Serializable {
      public static final int VALUE = 7; private int hidden; public Example() {}
      protected String result(int number) throws java.io.IOException { return "${value}" + number; }
      private void hiddenMethod() {} public native long nativeMethod(); ${declaration}
      public interface Nested { default int number() { return ${value.length}; } }
    }`);
    run('javac', ['--release', '21', '-d', classes, source]);
    const jar = path.join(directory, 'input.jar'), headers = path.join(directory, 'headers.jar');
    run('jar', ['--create', '--file', jar, '-C', classes, '.']);
    run('java', ['-cp', cp, 'ConversionHeaders', headers, jar]);
    run('java', ['-cp', cp, 'ConversionHeadersCheck', jar, headers]);
    return { jar, headers, bytes: fs.readFileSync(headers) };
  };
  const original = build('original', 'one'), changedBody = build('body', 'different implementation');
  assert.deepEqual(original.bytes, changedBody.bytes, 'method bodies must not invalidate converted APKs');
  const changedApi = build('api', 'one', 'public void added(double number) {}');
  assert.notDeepEqual(original.bytes, changedApi.bytes, 'member changes must invalidate conversion metadata');
  const merged = path.join(root, 'merged.jar');
  run('java', ['-cp', cp, 'ConversionHeaders', merged, original.jar, changedApi.jar]);
  assert.deepEqual(fs.readFileSync(merged), original.bytes, 'ordered classpath precedence is preserved');
});
