const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const Sandbox = require('../src/modules/android/sandbox');

const fixtures = path.join(__dirname, 'fixtures/android-sandbox');
function jdk() {
  if (process.env.JAVA_HOME && fs.existsSync(path.join(process.env.JAVA_HOME, 'bin/javac'))) return process.env.JAVA_HOME;
  if (process.platform !== 'darwin') return null;
  const result = spawnSync('/usr/libexec/java_home', ['-v', '21'], {encoding: 'utf8'});
  return result.status === 0 ? result.stdout.trim() : null;
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {encoding: 'utf8', timeout: 20000, maxBuffer: 1 << 20, ...options});
  const output = (result.stdout || '') + (result.stderr || '');
  assert.equal(result.error, undefined, result.error?.message + '\n' + output);
  assert.equal(result.signal, null, output);
  assert.equal(result.status, 0, output);
  assert.doesNotMatch(output, /WARNING in native method|FATAL ERROR in native method|WARNING: JNI/);
  return output;
}

function armExecutable(arm32 = false) {
  // Complete minimal Linux ELF image; no source compiler or cross-toolchain is needed.
  const bytes = Buffer.alloc(arm32 ? 92 : 132), header = arm32 ? 52 : 64, program = arm32 ? 32 : 56;
  bytes.writeUInt32LE(0x464c457f); bytes[4] = arm32 ? 1 : 2; bytes[5] = 1; bytes[6] = 1;
  bytes.writeUInt16LE(2, 16); bytes.writeUInt16LE(arm32 ? 40 : 183, 18); bytes.writeUInt32LE(1, 20);
  if (arm32) {
    bytes.writeUInt32LE(0x10000 + header + program, 24); bytes.writeUInt32LE(header, 28);
    bytes.writeUInt16LE(header, 40); bytes.writeUInt16LE(program, 42); bytes.writeUInt16LE(1, 44);
    bytes.writeUInt32LE(1, header); bytes.writeUInt32LE(0x10000, header + 8);
    bytes.writeUInt32LE(bytes.length, header + 16); bytes.writeUInt32LE(bytes.length, header + 20);
    bytes.writeUInt32LE(5, header + 24); bytes.writeUInt32LE(4096, header + 28);
    bytes.writeUInt32LE(0xe3a07001, header + program); bytes.writeUInt32LE(0xef000000, header + program + 4);
  } else {
    bytes.writeBigUInt64LE(0x400000n + BigInt(header + program), 24); bytes.writeBigUInt64LE(BigInt(header), 32);
    bytes.writeUInt16LE(header, 52); bytes.writeUInt16LE(program, 54); bytes.writeUInt16LE(1, 56);
    bytes.writeUInt32LE(1, header); bytes.writeUInt32LE(5, header + 4); bytes.writeBigUInt64LE(0x400000n, header + 16);
    bytes.writeBigUInt64LE(BigInt(bytes.length), header + 32); bytes.writeBigUInt64LE(BigInt(bytes.length), header + 40);
    bytes.writeBigUInt64LE(4096n, header + 48);
    bytes.writeUInt32LE(0xd2800000, header + program); bytes.writeUInt32LE(0xd2800ba8, header + program + 4);
    bytes.writeUInt32LE(0xd4000001, header + program + 8);
  }
  return bytes;
}

test('installed ARM ELF execute capabilities exclude writable paths and file aliases', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'android-native-execute-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const native = path.join(root, 'input/lib/arm64-v8a'), arm32 = path.join(root, 'input/lib/armeabi-v7a');
  const data = path.join(root, 'data'), foreign = path.join(root, 'foreign'), nested = path.join(data, 'nested');
  for (const directory of [native, arm32, data, foreign, nested]) fs.mkdirSync(directory, { recursive: true });
  const put = (directory, name, bytes = armExecutable(), mode = 0o700) => {
    const file = path.join(directory, name); fs.writeFileSync(file, bytes, { mode }); return file;
  };
  const valid = put(native, 'valid.so'), valid32 = put(arm32, 'valid.so', armExecutable(true));
  put(native, 'wrong-abi.so', armExecutable(true)); put(native, 'script.so', '#!/bin/sh\nexit 0\n');
  put(native, 'not-executable.so', armExecutable(), 0o600); put(native, 'truncated.so', armExecutable().subarray(0, 48));
  const hard = put(native, 'hard-linked.so'); fs.linkSync(hard, path.join(data, 'writable-alias'));
  const outside = put(foreign, 'foreign.so'); fs.symlinkSync(outside, path.join(native, 'linked.so'));
  put(nested, 'writable.so'); const linkedRoot = path.join(root, 'linked-root'); fs.symlinkSync(foreign, linkedRoot);
  const writableAlias = path.join(root, 'writable-root'); fs.symlinkSync(data, writableAlias);
  const ancestorAlias = path.join(root, 'ancestor'); fs.symlinkSync(data, ancestorAlias);
  const { installedExecutables } = require('../src/modules/android/native-executables');
  assert.deepEqual(await installedExecutables([native, arm32, nested, linkedRoot, path.join(ancestorAlias, 'nested')], [writableAlias]), [valid, valid32]);
});

test('Android sandbox preserves installed native ELF execute checks without host execution grants', {
  skip: process.platform !== 'darwin',
}, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'android-native-xok-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime'), native = path.join(root, 'prepared/input/lib/arm64-v8a');
  const app = path.join(root, 'app'), data = path.join(app, 'data'), files = path.join(data, 'files'), cache = path.join(data, 'cache');
  const foreign = path.join(root, 'foreign'), java = path.join(runtime, 'bin/java');
  for (const directory of [native, files, cache, foreign, path.dirname(java), path.join(runtime, 'lib')]) fs.mkdirSync(directory, { recursive: true });
  run('/usr/bin/clang', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=13.0',
    path.join(fixtures, 'native-execute-probe.c'), '-o', java]);
  fs.writeFileSync(path.join(runtime, 'lib/jspawnhelper'), 'unused');
  const put = (directory, name, bytes) => { const file = path.join(directory, name); fs.writeFileSync(file, bytes, { mode: 0o700 }); return file; };
  const elf = put(native, 'helper.so', armExecutable()), macho = path.join(native, 'host.so'); fs.copyFileSync(java, macho);
  const script = put(native, 'script.so', '#!/bin/sh\nexit 0\n'), outside = put(foreign, 'foreign.so', armExecutable());
  const writable = put(files, 'writable.so', armExecutable()), linked = path.join(native, 'linked.so'); fs.symlinkSync(outside, linked);
  const configFile = path.join(app, 'launch.json'); fs.writeFileSync(configFile, '{}');
  const sandbox = await Sandbox.prepareSandbox({ javaPath: java, configFile, dataRoot: data, blockNetwork: true,
    config: { runtimeRoot: runtime, nativeRoot: native, resourcesRoot: foreign, filesRoot: files, cacheRoot: cache } });
  const grants = sandbox.profile.split('(allow process-exec ')[1].split('(allow process-fork)')[0];
  assert.ok(grants.includes('(literal "' + elf + '")'));
  for (const file of [macho, script, outside, writable, linked]) assert.ok(!grants.includes(file));
  assert.ok(!grants.includes('(subpath '), 'Native code grants remain exact files');
  const output = run(sandbox.command, [...sandbox.prefix, elf, macho, script, outside, writable, linked, path.join(files, 'new-hard-link')],
    { env: sandbox.environment, cwd: files });
  assert.match(output, /PASS installed ARM ELF X_OK; Mach-O, script, foreign, writable and linked inputs denied; writable hard-link alias denied/);
});

test('Android sandbox environment excludes launcher secrets and JVM injection settings', () => {
  assert.deepEqual(Sandbox.environment({HOME: '/private/home', TMPDIR: '/private/tmp', PATH: '/unsafe',
    LANG: 'en_US.UTF-8', LC_CTYPE: 'UTF-8', API_TOKEN: 'secret', DYLD_INSERT_LIBRARIES: '/unsafe.dylib',
    JAVA_TOOL_OPTIONS: '-javaagent:unsafe.jar', JDK_JAVA_OPTIONS: '-cp unsafe', _JAVA_OPTIONS: '-Dunsafe=1', CLASSPATH: '/unsafe'}),
  {PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', LC_CTYPE: 'UTF-8'});
});

test('Android installed-code attribute access preserves adjacent file and peer denial', {
  skip: process.platform !== 'darwin',
}, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'android-code-attributes-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const runtime = path.join(root, 'runtime'), java = path.join(runtime, 'bin/java');
  const helper = path.join(runtime, 'lib/jspawnhelper'), prepared = path.join(root, 'prepared');
  const native = path.join(prepared, 'input/lib/arm64-v8a'), peer = path.join(root, 'peer');
  const app = path.join(root, 'app'), data = path.join(app, 'data');
  const files = path.join(data, 'files'), cache = path.join(data, 'cache');
  for (const directory of [path.dirname(java), path.dirname(helper), native, peer, files, cache])
    fs.mkdirSync(directory, {recursive: true});
  run('/usr/bin/clang', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=13.0',
    path.join(fixtures, 'installed-code-attributes.c'), '-o', java]);
  fs.writeFileSync(helper, 'unused');
  const attribute = 'dev.maclauncher.test-owner', adjacent = path.join(prepared, 'prepared.txt');
  fs.writeFileSync(adjacent, 'unadmitted prepared metadata');
  for (const directory of [prepared, path.dirname(native), peer]) {
    fs.chmodSync(directory, 0o700);
    run('/usr/bin/xattr', ['-w', attribute, 'installed-code', directory]);
  }
  // Supply only the native preparation's authenticated mount declarations;
  // the real Android sandbox must apply their exact operation and selectors.
  const Bootstrap = require('../src/modules/android/bionic-bootstrap'), original = Bootstrap.prepare;
  Bootstrap.prepare = async () => ({readXattrs: [prepared, path.dirname(native)]});
  t.after(() => { Bootstrap.prepare = original; });
  const configFile = path.join(app, 'launch.json'); fs.writeFileSync(configFile, '{}');
  const sandbox = await Sandbox.prepareSandbox({javaPath: java, configFile, dataRoot: data,
    config: {runtimeRoot: runtime, nativeRoot: native, filesRoot: files, cacheRoot: cache}, blockNetwork: true});
  run(sandbox.command, [...sandbox.prefix, 'attribute', attribute, prepared], {env: sandbox.environment});
  for (const args of [[...sandbox.prefix, 'attribute', attribute, peer], [...sandbox.prefix, 'read', adjacent]]) {
    const denied = spawnSync(sandbox.command, args, {env: sandbox.environment, encoding: 'utf8', timeout: 10000});
    assert.ifError(denied.error); assert.equal(denied.signal, null); assert.notEqual(denied.status, 0);
  }
  for (const directory of [prepared, path.dirname(native), peer]) assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
});

test('Android sandbox passes only the selected ANGLE backend and Vulkan supplier', {
  skip: process.platform !== 'darwin',
}, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'android-renderer-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const runtime = path.join(root, 'runtime'), data = path.join(root, 'app/data');
  const files = path.join(data, 'files'), cache = path.join(data, 'cache');
  const javaRoot = path.join(root, 'jdk'), java = path.join(javaRoot, 'bin/java');
  for (const directory of [runtime, files, cache, path.dirname(java), path.join(javaRoot, 'lib')])
    fs.mkdirSync(directory, {recursive: true});
  fs.writeFileSync(java, 'fixture'); fs.writeFileSync(path.join(javaRoot, 'lib/jspawnhelper'), 'fixture');
  const configFile = path.join(root, 'app/launch.json'); fs.writeFileSync(configFile, '{}');
  const options = {javaPath: java, configFile, dataRoot: data,
    config: {runtimeRoot: runtime, filesRoot: files, cacheRoot: cache}};
  const metal = await Sandbox.prepareSandbox(options);
  assert.equal(metal.environment.KL_ANGLE_BACKEND, 'metal');
  assert.equal(metal.environment.KL_MVK_DYLIB, undefined);
  assert.ok(!metal.prefix.some(value => value.startsWith('DYLD_INSERT_LIBRARIES=')));
  const processLibrary = path.join(runtime, 'native/libandroid-jvm-process.dylib');
  fs.mkdirSync(path.dirname(processLibrary), {recursive: true});
  fs.writeFileSync(processLibrary, 'installed JVM process owner');
  const selectedJvm = path.join(javaRoot, 'lib/server/libjvm.dylib');
  fs.mkdirSync(path.dirname(selectedJvm));fs.writeFileSync(selectedJvm, 'selected JVM image');
  const withProcessOwner = await Sandbox.prepareSandbox(options);
  assert.equal(withProcessOwner.prefix.find(value => value.startsWith('DYLD_INSERT_LIBRARIES=')),
    'DYLD_INSERT_LIBRARIES=' + selectedJvm + ':' + processLibrary);
  const selected = path.join(root, 'selected/core.dylib'), audio = path.join(root, 'selected/audio.dylib');
  fs.mkdirSync(path.dirname(selected));fs.writeFileSync(selected, 'graphics');fs.writeFileSync(audio, 'audio');
  const alias = path.join(root, 'selected-alias.dylib');fs.symlinkSync(selected, alias);
  const injected = await Sandbox.prepareSandbox({...options, graphics: {DYLD_INSERT_LIBRARIES: alias+':'+audio+':'+selected}});
  assert.equal(injected.graphics.DYLD_INSERT_LIBRARIES, selected+':'+audio);
  assert.equal(injected.prefix.find(value => value.startsWith('DYLD_INSERT_LIBRARIES=')),
    'DYLD_INSERT_LIBRARIES='+selectedJvm+':'+processLibrary+':'+selected+':'+audio);
  for (const file of [selected, audio]) assert.ok(injected.profile.includes('(literal "'+file+'")'));
  assert.ok(!injected.profile.includes('(subpath "'+path.dirname(selected)+'")'));
  const driver = path.join(root, 'libMoltenVK.dylib'); fs.writeFileSync(driver, 'fixture');
  const vulkan = await Sandbox.prepareSandbox({...options, angleBackend: 'vulkan',
    vulkan: {backend: 'moltenvk', library: driver, readable: [driver]}});
  assert.equal(vulkan.environment.KL_ANGLE_BACKEND, 'vulkan');
  assert.equal(vulkan.environment.KL_MVK_DYLIB, driver);
  assert.ok(vulkan.profile.includes('(literal "' + driver + '")'));
  await assert.rejects(Sandbox.prepareSandbox({...options, angleBackend: 'vulkan'}), /No Vulkan implementation is installed/);
});

test('Android graphics diagnostics keep the shared bounded history inside private storage', {
  skip: process.platform !== 'darwin',
}, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'android graphics storage ')));
  try {
    const runtime = path.join(root, 'runtime'), javaRoot = path.join(root, 'jdk');
    const data = path.join(root, 'app/data'), files = path.join(data, 'files'), cache = path.join(data, 'cache');
    const output = path.join(cache, 'graphics'), java = path.join(javaRoot, 'bin/java');
    for (const directory of [runtime, path.dirname(java), path.join(javaRoot, 'lib'), files, output])
      fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(java, 'unused'); fs.writeFileSync(path.join(javaRoot, 'lib/jspawnhelper'), 'unused');
    const configFile = path.join(root, 'app/launch.json'); fs.writeFileSync(configFile, '{}');
    for (let i = 0; i < 35; i++) fs.writeFileSync(path.join(output,
      `diagnostics-00000000-0000-0000-0000-${String(i).padStart(12, '0')}.9999999.jsonl`), 'completed');
    const prefix = 'diagnostics-01234567-89ab-cdef-0123-456789abcdef';
    const serviceCode = path.join(root, 'service/code'), serviceData = path.join(root, 'service/private');
    fs.mkdirSync(serviceCode, { recursive: true }); fs.mkdirSync(serviceData, { recursive: true });
    const serviceApk = path.join(serviceCode, 'service.apk'); fs.writeFileSync(serviceApk, 'apk');
    const serviceClasses = path.join(root, 'service/converted.jar'); fs.writeFileSync(serviceClasses, 'classes');
    const packetDirectory=path.join(root,'profile-ipc');fs.mkdirSync(packetDirectory,{mode:0o700});
    fs.mkdirSync(path.join(packetDirectory,'sockets'),{mode:0o700});
    const sandbox = await Sandbox.prepareSandbox({ javaPath: java, configFile, dataRoot: data,
      config: { runtimeRoot: runtime, filesRoot: files, cacheRoot: cache },
      installedPackages: [{sourceApks: [serviceApk], convertedJar: serviceClasses, nativeRoot: serviceCode, dataRoot: serviceData}],
      blockNetwork: true,
      graphics: { RESHADE_DIAGNOSTICS: path.join(root, prefix), RESHADE_GPU_TIMING: path.join(root, 'timing') } });
    for (const service of ['com.apple.window_proxies', 'com.apple.windowmanager.dragserver', 'com.apple.windowmanager.server',
      'com.apple.CoreDisplay.master', 'com.apple.CoreDisplay.Notification', 'com.apple.dock.server'])
      assert.ok(sandbox.profile.includes('(global-name "' + service + '")'), service);
    assert.match(sandbox.profile, /\(deny default\)/);
    assert.match(sandbox.profile, /\(deny network\*\)/);
    assert.ok(!sandbox.profile.includes('(subpath "'+packetDirectory+'")'),'Application cannot access adjacent system IPC files');
    const syncSocket=sandbox.environment.MACLAUNCHER_ANDROID_SYNC_SOCKET;
    assert.match(syncSocket,/\/s-[0-9a-f]{32}\.ml-sync-file$/);
    assert.ok(Buffer.byteLength(syncSocket)<104,'The device socket fits Darwin sockaddr_un');
    assert.ok(sandbox.profile.includes('(allow network-bind network-inbound (local unix-socket (literal "'+syncSocket+'")))'));
    assert.ok(sandbox.profile.includes('(regex #"^/dev/fd/[0-9]+$")'), 'Only existing numeric descriptors can be reopened for APK verification');
    assert.ok(sandbox.profile.includes('(literal "' + serviceApk + '")'));
    assert.ok(sandbox.profile.includes('(literal "' + serviceClasses + '")'));
    assert.ok(!sandbox.profile.includes(serviceData), 'Peer appdata is not granted through its metadata');
    // AppKit's text-UI XPC service is part of the shared profile; opening other applications and sending Apple events stay denied.
    assert.doesNotMatch(sandbox.profile, /com\.apple\.lsd\.open|appleevent-send/);
    assert.match(sandbox.profile, /xpc-service-name "com\.apple\.hiservices-xpcservice"/);
    assert.equal(sandbox.graphics.RESHADE_DIAGNOSTICS, path.join(output, prefix));
    assert.equal(path.dirname(sandbox.graphics.RESHADE_GPU_TIMING), output);
    assert.match(path.basename(sandbox.graphics.RESHADE_GPU_TIMING), /^gpu-timing-[a-f0-9-]{36}$/);
    assert.equal(fs.existsSync(sandbox.graphics.RESHADE_DIAGNOSTICS), false);
    assert.equal(fs.existsSync(sandbox.graphics.RESHADE_GPU_TIMING), false);
    assert.equal(fs.readdirSync(output).length, 32);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const home = jdk();
test('Android JVM sandbox seeds the shared namespace for original native getenv and Java without inheriting host secrets', {
  skip: process.platform !== 'darwin' || !home ? 'Requires macOS and Java 21 development tools' : false,
}, async t => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android environment namespace ')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const declared=require('../src/modules/android/managed-packages.json')[0];
  const runtime=path.resolve(process.env.KLEPTON_NATIVE_RUNTIME||path.join(__dirname,'../src/resources/native-runtimes',declared.directoryRelative));
  const data=path.join(root,'app/data'),files=path.join(data,'files'),cache=path.join(data,'cache'),inputs=path.join(root,'inputs'),classes=path.join(inputs,'classes');
  for(const directory of [files,cache,path.join(data,'obb'),classes])fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(data,'obb/retained.obb'),'retained expansion bytes');
  const cp=[classes,path.join(runtime,'android-host.jar'),path.join(runtime,'android-framework.jar')].join(path.delimiter);
  const buildEnvironment={...Sandbox.environment(process.env)};
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',classes,
    'src/modules/android/native/java/maclauncher/android/framework/HostFilesystem.java',path.join(fixtures,'StorageNamespaceProbe.java')],{env:buildEnvironment});
  fs.copyFileSync('src/modules/android/native/resources/storage-namespace.json',path.join(classes,'maclauncher/android/framework/storage-namespace.json'));
  const library=path.join(inputs,'namespace-probe.dylib');
  run('/usr/bin/clang',['-std=c11','-Wall','-Wextra','-Werror','-dynamiclib','-mmacosx-version-min=13.0',
    '-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),path.join(fixtures,'sandbox-probe.c'),'-o',library],{env:buildEnvironment});
  const {namespace}=require('../src/modules/android/storage-namespace');
  const expected=namespace({packageName:'org.example.namespace',dataRoot:data,filesRoot:files,cacheRoot:cache,partitionsRoot:path.join(runtime,'android-root')});
  const expectedFile=path.join(inputs,'expected.json');fs.writeFileSync(expectedFile,JSON.stringify(expected));
  const config={runtimeRoot:runtime,filesRoot:files,cacheRoot:cache,resourcesRoot:inputs,packageName:'org.example.namespace'};
  const configFile=path.join(root,'app/launch.json');fs.writeFileSync(configFile,JSON.stringify(config));
  const previous=process.env.MACLAUNCHER_NAMESPACE_SECRET;process.env.MACLAUNCHER_NAMESPACE_SECRET='host-only-value';
  let sandbox;
  try{sandbox=await Sandbox.prepareSandbox({javaPath:path.join(home,'bin/java'),config,configFile,dataRoot:data,userDataDir:root,blockNetwork:true});}
  finally{if(previous===undefined)delete process.env.MACLAUNCHER_NAMESPACE_SECRET;else process.env.MACLAUNCHER_NAMESPACE_SECRET=previous;}
  assert.equal(sandbox.environment.MACLAUNCHER_NAMESPACE_SECRET,undefined);
  assert.match(sandbox.profile,/\(deny network\*\)/);
  const probe=run(sandbox.command,[...sandbox.prefix,...sandbox.javaArguments,'-Xcheck:jni','-cp',cp,
    'maclauncher.android.framework.StorageNamespaceProbe','jvm',runtime,data,expectedFile,library],{env:sandbox.environment,cwd:files});
  assert.match(probe,/PASS common storage namespace jvm/);
  for(const [key,value]of Object.entries(expected.environment))assert.equal(sandbox.environment[key],value,key);
  assert.equal(Object.values(expected.environment).some(value=>!value.startsWith(runtime+path.sep)&&!value.startsWith(data+path.sep)&&value!==data),false);
});

test('Android sandbox confines Java and JNI file access and inherited child JVMs', {
  skip: process.platform !== 'darwin' || !home ? 'Requires macOS and Java 21 development tools' : false,
  timeout: 45000,
}, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'android isolation.[scope]+ ')));
  try {
    const runtime = path.join(root, 'runtime'), app = path.join(root, 'apps/selected'), data = path.join(app, 'data');
    const files = path.join(data, 'files'), cache = path.join(data, 'cache'), otherApp = path.join(root, 'apps/other/data');
    const classes = path.join(root, 'classes');
    for (const directory of [runtime, files, cache, otherApp, classes]) fs.mkdirSync(directory, {recursive: true});
    const outside = path.join(root, 'outside.canary'), other = path.join(otherApp, 'other.canary');
    const runtimeCanary = path.join(runtime, 'runtime.canary'), link = path.join(files, 'outside-link');
    const canaries = new Map([[outside, 'outside canary'], [other, 'other app canary'], [runtimeCanary, 'runtime canary']]);
    for (const [file, contents] of canaries) fs.writeFileSync(file, contents);
    fs.symlinkSync(outside, link);
    const library = path.join(runtime, 'sandbox-probe.dylib'), jar = path.join(runtime, 'sandbox-probe.jar');
    const buildEnvironment = {...process.env};
    for (const key of Object.keys(buildEnvironment))
      if (key.startsWith('DYLD_') || ['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'CLASSPATH'].includes(key)) delete buildEnvironment[key];
    run(path.join(home, 'bin/javac'), ['--release', '21', '-d', classes, path.join(fixtures, 'SandboxProbe.java')], {env: buildEnvironment});
    run(path.join(home, 'bin/jar'), ['--create', '--file', jar, '-C', classes, '.'], {env: buildEnvironment});
    run('/usr/bin/clang', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-dynamiclib', '-mmacosx-version-min=13.0',
      '-I' + path.join(home, 'include'), '-I' + path.join(home, 'include/darwin'),
      path.join(fixtures, 'sandbox-probe.c'), '-o', library], {env: buildEnvironment});
    fs.mkdirSync(path.join(runtime, 'native'));
    const storageLibrary = path.join(runtime, 'native/libandroid-storage.dylib');
    run('/usr/bin/clang', ['-dynamiclib', '-mmacosx-version-min=13.0',
      path.join(__dirname, '../src/modules/android/native/native-storage.c'), '-o', storageLibrary], {env: buildEnvironment});
    const processProduct = process.env.ANDROID_JVM_PROCESS_PRODUCT;
    const processLibrary = path.join(runtime, 'native/libandroid-jvm-process.dylib');
    if (processProduct) fs.copyFileSync(processProduct, processLibrary);
    const config = {runtimeRoot: runtime, filesRoot: files, cacheRoot: cache, title: "Android Sandbox Probe"};
    const configFile = path.join(app, 'launch.json');fs.writeFileSync(configFile, JSON.stringify(config));
    const sandbox = await Sandbox.prepareSandbox({javaPath: path.join(home, 'bin/java'), config, configFile, dataRoot: data});
    assert.match(sandbox.executablePath, /Android Sandbox Probe\.app\/Contents\/MacOS\/java$/);
    const applicationBundle = path.resolve(sandbox.executablePath, '../../..');
    assert.ok(sandbox.profile.includes('(allow file-issue-extension (require-all (extension-class "com.apple.app-sandbox.read") (subpath "' + applicationBundle + '")))'),
      'LaunchServices can receive the whole owned application bundle');
    assert.ok(!sandbox.profile.includes('(extension-class "com.apple.app-sandbox.read-write") (subpath "' + applicationBundle + '"'),
      'Application bundle delegation remains read-only');
    const expectedPreloads = [storageLibrary, ...(processProduct ? [fs.realpathSync(path.join(home, 'lib/server/libjvm.dylib')), processLibrary] : [])];
    assert.deepEqual(sandbox.prefix.slice(2, 4), ['/usr/bin/env', 'DYLD_INSERT_LIBRARIES=' + expectedPreloads.join(':')]);
    const output = run(sandbox.command, [...sandbox.prefix, ...sandbox.javaArguments, '-Dprobe.expected.java.home=' + fs.realpathSync(home), '-Xcheck:jni', '-Xmx64m',
      '-cp', jar, 'SandboxProbe', '--probe', 'parent', files, outside, other, runtimeCanary, link, library],
    {env: sandbox.environment, cwd: files});
    assert.match(output, /PASS sandbox parent checks=21/);
    assert.match(output, /PASS sandbox child checks=19/);
    const codeRoot=path.join(root,'apps'),installedCode=path.join(codeRoot,'later/prepared/key/code.canary');
    fs.mkdirSync(path.dirname(installedCode),{recursive:true});fs.writeFileSync(installedCode,'runtime canary');
    const accountConfig={...config,accountService:1,packageName:'android'};
    const accountSandbox=await Sandbox.prepareSandbox({javaPath:path.join(home,'bin/java'),config:accountConfig,configFile,dataRoot:data,accountCodeRoot:codeRoot});
    const accountOutput=run(accountSandbox.command,[...accountSandbox.prefix,...accountSandbox.javaArguments,'-Dprobe.expected.java.home='+fs.realpathSync(home),'-Xcheck:jni','-Xmx64m','-cp',jar,'SandboxProbe','--probe','parent',files,outside,other,installedCode,link,library],{env:accountSandbox.environment,cwd:files});
    assert.match(accountOutput,/PASS sandbox parent checks=21/);assert.match(accountOutput,/PASS sandbox child checks=19/);
    await assert.rejects(Sandbox.prepareSandbox({javaPath:path.join(home,'bin/java'),config,configFile,dataRoot:data,accountCodeRoot:codeRoot}),/requires an Android system service/);
    for (const [file, contents] of canaries) assert.equal(fs.readFileSync(file, 'utf8'), contents, file);
    assert.equal(fs.readFileSync(path.join(files, 'parent-owned'), 'utf8'), 'Nwned');
    assert.equal(fs.readFileSync(path.join(files, 'child-owned'), 'utf8'), 'Nwned');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
