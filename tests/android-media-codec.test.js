const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('./helpers/android-java');

test(process.env.ANDROID_MEDIA_DISCOVERY_ONLY
  ? 'Original MediaCodec discovery selects shared native decoders with real NDK decoding'
  : 'Original MediaCodec decodes through shared Java and NDK ownership', async t => {
  const runtime = process.env.KLEPTON_NATIVE_RUNTIME, headers = process.env.ANDROID_NDK_HEADERS;
  if (process.platform !== 'darwin' || !runtime || !headers) return t.skip('Requires macOS, KLEPTON_NATIVE_RUNTIME and ANDROID_NDK_HEADERS');
  const home = process.env.JAVA_HOME || spawnSync('/usr/libexec/java_home', ['-v', '21'], { encoding: 'utf8' }).stdout.trim();
  if (!home || !fs.existsSync(path.join(home, 'bin/javac'))) return t.skip('Requires Java 21 development tools');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'android-media-codec-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const identity = await require('../src/modules/android/process-channel').processNamespace(temporary, 1);
  const fixtures = path.join(__dirname, 'fixtures/android-native');
  const javaRoot = process.env.ANDROID_SHARED_JAVA_ROOT || runtime;
  const classpath = [temporary, path.resolve(javaRoot, 'android-host.jar'), path.resolve(javaRoot, 'android-framework.jar')].join(path.delimiter);
  const {frameworkJvmOptions}=require('../src/modules/android/jvm-options');
  const mediaLibrary = path.resolve(runtime, 'native/libklepton-jvm.dylib');
  const run = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60000,
      env: { ...process.env, ...identity.environment } });
    assert.equal(result.error, undefined, (result.error?.message || "") + result.stdout + result.stderr);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /FATAL ERROR in native method/);
    return result.stdout;
  };

  const generator = path.join(temporary, 'movie');
  const movie = path.join(temporary, 'sample.mp4');
  run('clang', [path.join(fixtures, 'media-data-source.m'), '-Wno-deprecated-declarations',
    '-framework', 'AVFoundation', '-framework', 'Foundation', '-framework', 'CoreMedia', '-framework', 'CoreVideo', '-o', generator]);
  assert.match(run(generator, ['--movie', movie]), /PASS generated local four-frame movie/);

  const ndkInclude = path.resolve(headers);
  const originalHeader = fs.readFileSync(path.join(ndkInclude, 'media/NdkMediaCodec.h'), 'utf8');
  const androidInclude = '#include <android/api-level.h>';
  assert.equal(originalHeader.split(androidInclude).length, 2, 'Pinned codec header has one Android API-level include');
  const adaptedInclude = path.join(temporary, 'include');
  fs.cpSync(path.join(ndkInclude, 'media'),path.join(adaptedInclude,'media'),{recursive:true});
  fs.writeFileSync(path.join(adaptedInclude, 'media/NdkMediaCodec.h'), originalHeader.replace(androidInclude,
    '#if defined(__ANDROID__)\n#include <android/api-level.h>\n#endif'));
  const probeLibrary = path.join(temporary, 'libmedia-codec-probe.dylib');
  run('clang++', ['-std=c++23', '-dynamiclib', '-Wall', '-Wextra', '-Werror',
    '-I' + adaptedInclude,
    '-I' + path.join(home, 'include'), '-I' + path.join(home, 'include/darwin'),
    path.join(fixtures, 'media-codec-ndk.cpp'), '-o', probeLibrary]);
  run(path.join(home, 'bin/javac'), ['--release', '21', '-cp', classpath, '-d', temporary,
    path.join(fixtures, 'MediaCodecProbe.java'), path.join(fixtures, '../android-window-session/RuntimeFixture.java'), path.join(fixtures, '../android-platform-service/MediaServicesFixture.java')]);
  assert.match(run(path.join(home, 'bin/java'), [...frameworkJvmOptions,'-Xverify:all', '-Xcheck:jni',
    '-Dandroid.media.discoveryOnly=' + Boolean(process.env.ANDROID_MEDIA_DISCOVERY_ONLY), '-cp', classpath,
    'maclauncher.android.media.MediaCodecProbe', path.resolve(runtime), temporary, movie, mediaLibrary, probeLibrary]),
  process.env.ANDROID_MEDIA_DISCOVERY_ONLY
    ? /PASS original MediaCodec discovery, named creation, capability matching and NDK decode/
    : /PASS original MediaCodec sync decode, independent inputs, flush, async callbacks, retirement and NDK ownership/);
});
