const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('./helpers/android-java');

test('Original Vulkan WSI delivers pixels and source resize through the common Android presenter', async t => {
  const runtime = process.env.KLEPTON_NATIVE_RUNTIME, jdk = process.env.JAVA_HOME;
  const klepton = process.env.KLEPTON_SOURCE, headers = process.env.VULKAN_HEADERS;
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || !runtime || !jdk || !klepton || !headers ||
      !process.env.KL_MVK_DYLIB || !process.env.KLEPTON_FRAME_LIBRARY)
    return t.skip('Requires the Android runtime, JDK, upstream headers, selected Vulkan driver and shared presenter');
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'android-vulkan-presentation-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const native = path.resolve(__dirname, '../src/modules/android/native');
  const fixture = path.join(__dirname, 'fixtures/android-native');
  const run = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60000,
      env: { ...process.env, RESHADE_EXPLICIT_HOST: '1' } });
    assert.equal(result.status, 0, (result.error?.message || '') + result.stdout + result.stderr);
    return result.stdout + result.stderr;
  };
  const { prepareVulkanSource } = await import(pathToFileURL(path.join(native, 'vulkan-sources.mjs')));
  const source = prepareVulkanSource(klepton, output);
  const includes = ['', 'jni', 'libc', 'gfx', 'xr', 'media', 'guest', 'diag'].map(name => '-I' + path.join(klepton, 'runtime', name));
  const flags = ['-arch', 'arm64', '-mmacosx-version-min=13.0', '-O1', '-I' + native, '-I' + headers,
    '-I' + path.join(jdk, 'include'), '-I' + path.join(jdk, 'include/darwin')];
  const adapter = path.join(output, 'vulkan.dylib');
  run('clang', [...flags, ...includes, '-dynamiclib', source, path.join(native, 'eglbridge.c'), path.resolve(runtime, 'native/libklepton-jvm.dylib'),
    '-Wl,-rpath,' + path.resolve(runtime, 'native'), '-lz', '-lc++', '-o', adapter]);
  const probe = path.join(output, 'presentation.dylib');
  run('clang++', [...flags, '-std=c++20', '-fobjc-arc', '-dynamiclib',
    path.join(fixture, 'vulkan-presentation-probe.mm'), path.join(native, 'pixel-copy.mm'), path.join(native, 'overlay.mm'), adapter,
    ...['Foundation', 'Metal', 'QuartzCore', 'IOSurface', 'AppKit'].flatMap(name => ['-framework', name]), '-o', probe]);
  run(path.join(jdk, 'bin/javac'), ['-d', output, path.join(fixture, 'VulkanPresentationProbe.java')]);
  const evidence = run(path.join(jdk, 'bin/java'), ['-XstartOnFirstThread', '-Xcheck:jni', '-Djava.awt.headless=true',
    '-cp', output, 'VulkanPresentationProbe', probe, adapter]);
  assert.match(evidence, /PASS original Vulkan WSI/);
});
