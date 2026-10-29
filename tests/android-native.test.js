const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('./helpers/android-java');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'src/modules/android/native');
const fixtures = path.join(__dirname, 'fixtures/android-native');
test('Android interval timers translate complete timeval fields at the native boundary',t=>{
  if(process.platform!=='darwin')return t.skip('Requires macOS interval timers');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-interval-timer-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const binary=path.join(temporary,'probe');
  run('clang',['-std=c11','-O2','-Wall','-Wextra','-Werror','-I'+source,path.join(fixtures,'interval-timer.c'),'-o',binary]);
  assert.match(run(binary,[]),/PASS Linux interval timer layout/);
});
test('Complete Bionic pthread attributes retain actual host thread ownership',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!runtime)return t.skip('Requires Apple Silicon and an installed Android native runtime');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-pthread-attributes-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const binary=path.join(temporary,'probe');
  run('clang',['-std=c11','-O2','-Wall','-Wextra','-Werror',path.join(fixtures,'pthread-attributes.c'),'-o',binary]);
  const ids=path.join(temporary,'ids');fs.mkdirSync(ids,{mode:0o700});
  assert.match(run(binary,[path.resolve(runtime,'native/libklepton-jvm.dylib'),fs.realpathSync(ids)]),/PASS complete Bionic pthread attributes, scheduling ABI, supplied stacks, inheritance and live detach state/);
});
test('Android property iteration and raw file calls share native owners',async t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,klepton=process.env.KLEPTON_SOURCE||path.join(root,'src/external/klepton');
  const bionicSource=process.env.BIONIC_SOURCE,include=process.env.ANDROID_NDK_HEADERS,importsDirectory=process.env.ANDROID_IMPORT_DECLARATIONS,python=process.env.PYTHON;
  if(process.platform!=='darwin'||!runtime||!bionicSource||!include||!importsDirectory||!python||!fs.existsSync(path.join(klepton,'runtime/libc/kl_libc.c')))return t.skip('Requires macOS, pinned Bionic/NDK declarations, Klepton and an installed Android native runtime');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-libc-capabilities-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const url=require('node:url').pathToFileURL;
  const {preparePlatformSyscalls}=await import(url(path.join(source,'platform-syscalls.mjs')));
  const {preparePropertySource}=await import(url(path.join(source,'property-sources.mjs')));
  const calls=path.join(temporary,'calls.c'),properties=path.join(temporary,'properties.c');
  fs.writeFileSync(calls,'long klb_syscall(long n, long a1, long a2, long a3, long a4, long a5, long a6) { errno=ENOSYS;return -1; }');
  preparePlatformSyscalls(calls,{bionicSource,include,importsDirectory,python,output:temporary});
  const original=fs.readFileSync(path.join(klepton,'runtime/libc/kl_libc.c'),'utf8');
  fs.writeFileSync(properties,original.slice(original.indexOf('static const struct { const char *prop, *build_field; }'),original.indexOf('int  klb_prctl(')));
  preparePropertySource(properties);
  const binary=path.join(temporary,'probe');
  const {exportSources}=await import('../src/modules/android/native/binder-rpc/build.mjs');
  const pins=JSON.parse(fs.readFileSync(path.join(source,'source-pins.json')));
  const api='libc/include/bits/get_device_api_level_inlines.h';exportSources(bionicSource,pins.aospBionic,[api],temporary);
  run('clang',['-std=gnu11','-Wall','-Wextra','-Werror','-Wno-unused-function','-I'+source,
    '-DKLEPTON_DEVICE_API_SOURCE='+JSON.stringify(path.join(temporary,api)),
    '-DANDROID_SYSCALL_SOURCE='+JSON.stringify(calls),'-DANDROID_PROPERTY_SOURCE='+JSON.stringify(properties),
    path.join(fixtures,'libc-capabilities.c'),path.resolve(runtime,'native/libklepton-jvm.dylib'),'-Wl,-rpath,'+path.resolve(runtime,'native'),'-o',binary]);
  const ids=path.join(temporary,'ids');fs.mkdirSync(ids,{mode:0o700});
  assert.match(run(binary,[path.resolve(runtime,'native/libklepton-jvm.dylib'),fs.realpathSync(ids)]),/PASS shared properties, fortified file ownership and Linux syscall delegates/);
});
test('Android inline Linux syscalls preserve native machine state',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,klepton=process.env.KLEPTON_SOURCE||path.join(root,'src/external/klepton');
  if(process.platform!=='darwin'||process.arch!=='arm64'||!runtime||!fs.existsSync(path.join(klepton,'runtime/kl_x18.h')))return t.skip('Requires Apple Silicon, Klepton headers and an installed Android native runtime');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-inline-syscall-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const binary=path.join(temporary,'probe');
  const identities=path.join(temporary,'identities');fs.mkdirSync(identities,{mode:0o700});
  run('clang',['-std=gnu11','-Wall','-Wextra','-Werror','-I'+source,'-I'+path.join(klepton,'runtime'),
    path.join(fixtures,'inline-syscall.c'),path.join(fixtures,'inline-syscall.S'),path.join(source,'inline-syscall.c'),path.join(source,'inline-syscall.S'),'-o',binary]);
  const args=[path.resolve(runtime,'native/libklepton-jvm.dylib'),identities];
  const ndk=process.env.ANDROID_NDK_TOOLS;
  if(ndk){
    const guest=path.join(temporary,'signal.so');
    run(path.join(ndk,'aarch64-linux-android35-clang'),['-O2','-fPIC','-nostdlib','-shared',path.join(fixtures,'inline-syscall-guest.c'),'-o',guest]);
    args.push(guest);
  }
  const output=run(binary,args);assert.match(output,/PASS inline Linux SVC/);
  assert.match(output,/PASS 512-byte guarded guest stack/);
  if(ndk)assert.match(output,/PASS original signal reentry and Bionic siglongjmp/);
});
test('Android resolver round-trips original native socket addresses',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(process.platform!=='darwin'||!runtime)return t.skip('Requires macOS and an installed Android native runtime');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-resolver-roundtrip-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const binary=path.join(temporary,'probe');
  run('clang',['-std=gnu11','-Wall','-Wextra','-Werror','-Wno-unused-function','-I'+source,path.join(fixtures,'resolver-roundtrip.c'),'-o',binary]);
  assert.match(run(binary,[path.resolve(runtime,'native/libklepton-jvm.dylib')]),/PASS Android IPv4\/IPv6 forward and reverse lookup/);
});
test('Android socket creation preserves nonblocking and close-on-exec flags',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(process.platform!=='darwin'||!runtime)return t.skip('Requires macOS and an installed Android native runtime');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-socket-flags-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const binary=path.join(temporary,'probe');
  run('clang',['-std=gnu11','-Wall','-Wextra','-Werror','-Wno-unused-function','-I'+source,path.join(fixtures,'socket-flags.c'),'-o',binary]);
  assert.match(run(binary,[path.resolve(runtime,'native/libklepton-jvm.dylib')]),/PASS Android socket flags/);
});
test('Android socket options preserve native TCP policy and Linux asynchronous errors',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(process.platform!=='darwin'||!runtime)return t.skip('Requires macOS and an installed Android native runtime');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-socket-options-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const binary=path.join(temporary,'probe');
  run('clang',['-std=gnu11','-Wall','-Wextra','-Werror','-Wno-unused-function','-I'+source,path.join(fixtures,'socket-options.c'),'-o',binary]);
  assert.match(run(binary,[path.resolve(runtime,'native/libklepton-jvm.dylib')]),/PASS Android TCP keepalive without unintended corking/);
});
test('Android binary inputs enforce recorded bytes and directory containment', async t => {
  const {verifyBinaryInputs} = await import(require('node:url').pathToFileURL(path.join(source,'binary-inputs.mjs')).href);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'android-binary-'));
  t.after(() => fs.rmSync(temporary, {recursive: true, force: true}));
  const directory = path.join(temporary, 'input'); fs.mkdirSync(directory);
  const bytes = Buffer.from('recorded release');
  const entry = {path: 'binary', size: bytes.length, sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex')};
  fs.writeFileSync(path.join(directory, entry.path), bytes);
  assert.equal(verifyBinaryInputs(directory, [entry])[0].sha256, entry.sha256);
  assert.throws(() => verifyBinaryInputs(directory, [{...entry, path: '../binary'}]), /Invalid binary input/);
  assert.throws(() => verifyBinaryInputs(directory, [{...entry, size: bytes.length + 1}]), /does not match/);
  fs.writeFileSync(path.join(directory, entry.path), Buffer.from('different bytes!'));
  assert.throws(() => verifyBinaryInputs(directory, [entry]), /does not match/);
  fs.unlinkSync(path.join(directory, entry.path));
  fs.writeFileSync(path.join(temporary, 'outside'), bytes);
  fs.symlinkSync(path.join(temporary, 'outside'), path.join(directory, entry.path));
  assert.throws(() => verifyBinaryInputs(directory, [entry]), /leaves its directory/);
});
function jdk() {
  if (process.env.JAVA_HOME && fs.existsSync(path.join(process.env.JAVA_HOME, 'bin/javac'))) return process.env.JAVA_HOME;
  if (process.platform !== 'darwin') return null;
  const result = spawnSync('/usr/libexec/java_home', ['-v', '21'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}
function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 30000, ...options });
  assert.equal(result.error, undefined, [result.error?.message,result.stdout,result.stderr].filter(Boolean).join('\n'));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}
function commonProbeEnvironment(temporary) {
  const directory = path.join(temporary, 'identities');
  fs.mkdirSync(directory, {recursive:true, mode:0o700});
  return {...process.env, KL_ANDROID_ID_DIRECTORY: fs.realpathSync(directory)};
}
function commonRuntimeClasspath(temporary) {
  const runtime = process.env.KLEPTON_NATIVE_RUNTIME || path.resolve(root, 'src/resources/native-runtimes',
    require('../src/modules/android/managed-packages.json')[0].directoryRelative);
  return [temporary, process.env.ANDROID_HOST_CLASSES, ...['android-host.jar', 'android-framework.jar'].map(name => path.resolve(runtime, name))]
    .filter(Boolean).join(path.delimiter);
}
function commonProbeSources() {
  return [path.join(fixtures,'NativeProbeFixture.java'), path.join(fixtures,'../android-window-session/RuntimeFixture.java'),
    path.join(fixtures,'../android-framework-services/SyntheticResources.java')];
}
function runCommonProbe(home, temporary, name) {
  const classpath=commonRuntimeClasspath(temporary),runtime=path.dirname(classpath.split(path.delimiter).at(-1));
  const result=spawnSync(path.join(home,'bin/java'),['-Xverify:all','-Xcheck:jni','-Xmx256m','-Djava.awt.headless=true',
    '-cp',classpath,'maclauncher.android.NativeProbeFixture',name,runtime,path.join(temporary,name)],{env:commonProbeEnvironment(temporary),encoding:'utf8',timeout:30000});
  assert.equal(result.error,undefined,[result.error?.message,result.stdout,result.stderr].filter(Boolean).join('\n'));
  assert.equal(result.status,0,result.stdout+result.stderr);
  return result;
}
test('AOSP native registry uses actual free callbacks and the JVM memory budget',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=jdk();
  if(process.platform!=='darwin'||process.arch!=='arm64'||!home||!runtime||!fs.existsSync(path.join(runtime,'native/libandroid_runtime.dylib')))
    return t.skip('Requires an Apple Silicon runtime with the current shared native registration and Java 21');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-framework-allocation-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const library=path.join(temporary,'allocation.dylib'),framework=[path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar')].join(path.delimiter);
  run('clang',['-dynamiclib','-std=c11','-Wall','-Wextra','-Wno-unused-parameter','-Wno-unused-function','-Werror',
    '-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),'-I'+source,
    path.join(fixtures,'framework-allocation.c'),'-L'+path.resolve(runtime,'native'),'-lklepton-jvm','-Wl,-rpath,'+path.resolve(runtime,'native'),'-o',library]);
  run(path.join(home,'bin/javac'),['--release','21','-cp',framework,'-d',temporary,path.join(fixtures,'FrameworkAllocationProbe.java'),path.join(__dirname,'fixtures/android-window-session/RuntimeFixture.java')]);
  const {frameworkJvmOptions}=require('../src/modules/android/jvm-options');
  const result=spawnSync(path.join(home,'bin/java'),[...frameworkJvmOptions,'-Xverify:all','-Xcheck:jni','-XX:MaxDirectMemorySize=128m','-cp',temporary+path.delimiter+framework,'FrameworkAllocationProbe',path.resolve(runtime),path.join(temporary,'data'),library],{encoding:'utf8',timeout:30000});
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/PASS actual upstream native free, JDK accounting, concurrent cleanup, OOM cleanup and collection/);
  // Retain upstream initialization diagnostics separately from the operations
  // under test; full initialization may register additional original modules.
  const [initialization,operations]=result.stdout.split('BEGIN native allocation operations');
  assert.ok(operations,'Full native initialization completed');
  assert.doesNotMatch(operations,/^WARNING/m,'Native allocation/free emitted a checked-JNI warning');
  assert.doesNotMatch(result.stderr,/^WARNING.*JNI/m,'Native allocation/free emitted a checked-JNI warning');
  const warnings=initialization.split('\n').filter(line=>line.startsWith('WARNING'));
  if(warnings.length)t.diagnostic(`Original native initialization emitted ${warnings.length} checked-JNI warnings before allocation operations`);
});
test('Original VMRuntime collection requests reach the JVM without accumulating workers',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=jdk();
  if(process.platform!=='darwin'||!home||!runtime)return t.skip('Requires macOS, Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-concurrent-gc-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const library=path.join(temporary,'collection.dylib');
  const cp=[temporary,path.resolve(runtime,'android-framework.jar'),path.resolve(runtime,'android-host.jar')].join(path.delimiter);
  run('clang',['-dynamiclib','-std=c11','-Wall','-Wextra','-Werror','-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),path.join(source,'framework-memory.c'),'-o',library]);
  // Exercise the packaged runtime, including its nested implementation classes.
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'ConcurrentGcProbe.java')]);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-Xcheck:jni','-cp',cp,'ConcurrentGcProbe',library]),
    /PASS original VMRuntime reaches JVM collection with coalesced requests and idle cleanup/);
});
test('Original AudioManager uses actual CoreAudio native ports and retires the event owner',t=>{
  const home=jdk(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||!runtime||process.platform!=='darwin')return t.skip('Requires macOS, Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-audio-routes-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=[temporary,...['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name))].join(path.delimiter);
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.resolve('tests/fixtures/android-platform-service/MediaServicesFixture.java'),path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java'),path.join(fixtures,'AudioRoutesProbe.java')]);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-Xcheck:jni','-cp',cp,'maclauncher.android.media.AudioRoutesProbe',path.resolve(runtime),temporary]),/PASS original AudioManager CoreAudio ports/);
});



test('Android built shim preserves assertion varargs and fortified positioned I/O aliases', t => {
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!runtime)
    return t.skip('Requires Apple Silicon and KLEPTON_NATIVE_RUNTIME pointing to a built Android runtime');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-shim-closure-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const binary=path.join(temporary,'shim-probe');
  run('clang',['-arch','arm64','-mmacosx-version-min=13.0','-Wall','-Wextra','-Werror',
    path.join(fixtures,'shim-closure.c'),path.join(fixtures,'shim-closure.S'),'-o',binary]);
  const result=spawnSync(binary,[path.resolve(runtime,'native/libklepton-jvm.dylib'),path.join(temporary,'data')],
    {encoding:'utf8',timeout:15000});
  assert.equal(result.error,undefined,result.error?.message);assert.equal(result.signal,null,result.stderr);
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stderr,/\[7\/ShimProbe\] integer=-17 hex=123456789abcdef0 text=value float=1\.50 second=-2\.25 ints=21,22,23 tail=3,4,5,6,7,8,9\.5/);
  assert.equal((result.stderr.match(/DELIVERED_SIGABRT/g)||[]).length,1,result.stderr);
  assert.match(result.stdout,/PASS actual shim AAPCS64 assertion and fortified positioned I\/O aliases/);
});

test('Android alternate signal stacks translate layout and flags without changing ownership',t=>{
  if(process.platform!=='darwin'||process.arch!=='arm64')return t.skip('Requires Apple Silicon');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-signal-stack-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const binary=path.join(temporary,'signal-stack');
  run('clang',['-std=c11','-Wall','-Wextra','-Werror','-I'+source,path.join(fixtures,'signal-stack.c'),'-o',binary]);
  assert.match(run(binary,[]),/PASS Android stack layout, actual alternate-stack delivery, query, disable and restoration/);
});

test('Android native one-argument signal handlers recover CPU probes and restore native handlers',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!runtime)return t.skip('Requires Apple Silicon and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-signals-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const binary=path.join(temporary,'signal-probe');
  run('clang',['-std=c11','-Wall','-Wextra','-Werror',path.join(fixtures,'signal-probe.c'),'-o',binary]);
  assert.match(run(binary,[path.resolve(runtime,'native/libklepton-jvm.dylib')]),/PASS recoverable instruction probes and restored native signal-context ownership/);
});

test('Android built libc preserves positions and OBB directory ownership', t => {
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!runtime)
    return t.skip('Requires Apple Silicon and KLEPTON_NATIVE_RUNTIME pointing to a built Android runtime');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-native-io-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const binary=path.join(temporary,'io-probe');
  run('clang',['-arch','arm64','-mmacosx-version-min=13.0','-Wall','-Wextra','-Werror',
    path.join(fixtures,'native32-io.c'),'-lz','-o',binary]);
  const result=spawnSync(binary,[path.resolve(runtime,'native/libklepton-jvm.dylib'),path.join(temporary,'data')],
    {encoding:'utf8',timeout:15000});
  assert.equal(result.error,undefined,result.error?.message);assert.equal(result.signal,null,result.stderr);
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/PASS actual Klepton positions\/OBB descriptor ownership:/);
});

test('Android memory relocation and resolver preserve native ownership', t => {
  if(process.platform!=='darwin')return t.skip('Requires macOS Mach VM');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-memory-resolver-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const binary=path.join(temporary,'probe');
  run('clang',['-std=gnu11','-Wall','-Wextra','-Werror','-Wno-unused-function','-I'+source,path.join(fixtures,'memory-resolver.c'),'-o',binary]);
  const result=run(binary,[]);
  assert.match(result,/PASS Mach remap data\/neighbor\/protection ownership and thread-local real resolver/);
  assert.match(result,/PASS shared mremap backing offset, alias lifetime, protections and fork visibility/);
  assert.match(result,/PASS shared Linux msync flags, mapped-file writeback and mincore residency ABI/);
});

test('Android x18 scan reuses its survey without changing decoder or emitted bytes', async t => {
  const klepton=process.env.KLEPTON_SOURCE||path.join(root,'src/external/klepton');
  if(process.platform!=='darwin'||process.arch!=='arm64'||!fs.existsSync(path.join(klepton,'runtime/kl_x18.c')))
    return t.skip('Requires Apple Silicon and the pinned Klepton source');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-x18-survey-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const {prepareX18Source}=await import(require('node:url').pathToFileURL(path.join(source,'x18-source.mjs')).href);
  const modified=prepareX18Source(klepton,temporary),binary=path.join(temporary,'probe');
  run('clang',['-O2','-std=gnu11','-I'+path.join(klepton,'runtime'),'-DKL_X18_SOURCE='+JSON.stringify(modified),
    path.join(fixtures,'x18-survey.c'),path.join(klepton,'runtime/kl_env.c'),'-o',binary]);
  assert.match(run(binary,[]),/PASS original decoder candidates, data classification and byte-identical surveyed veneers/);
});

test('Android ELF instruction context preserves unsectioned functions and typed data',async t=>{
  const klepton=process.env.KLEPTON_SOURCE||path.join(root,'src/external/klepton');
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!runtime||!fs.existsSync(path.join(klepton,'runtime/kl_image.c')))return t.skip('Requires Apple Silicon, the pinned Klepton source and Android native runtime');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-image-code-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const {prepareX18Source,prepareX18Core}=await import(require('node:url').pathToFileURL(path.join(source,'x18-source.mjs')));
  const {prepareImageSource}=await import(require('node:url').pathToFileURL(path.join(source,'image-source.mjs')));
  const x18=prepareX18Source(klepton,temporary),image=fs.readFileSync(prepareImageSource(klepton,temporary),'utf8');
  const original=fs.readFileSync(path.join(klepton,'runtime/kl_image.c'),'utf8');
  fs.writeFileSync(path.join(temporary,'image-elf-types.h'),original.slice(original.indexOf('typedef struct { uint8_t e_ident[16]'),original.indexOf('struct kl_image {')));
  fs.writeFileSync(path.join(temporary,'image-tls-source.h'),image.slice(image.indexOf('static void rewrite_tls('),image.indexOf('// ---------- symbol lookup')));
  const binary=path.join(temporary,'probe');
  run('clang',['-O2','-std=gnu11','-Wall','-Wextra','-Werror','-Wno-unused-function','-I'+temporary,'-I'+source,'-I'+path.join(klepton,'runtime'),'-DKL_X18_SOURCE='+JSON.stringify(x18),path.join(fixtures,'image-code.c'),path.join(source,'inline-syscall.c'),path.join(klepton,'runtime/kl_env.c'),'-o',binary]);
  assert.match(run(binary,[path.resolve(runtime,'native/libklepton-jvm.dylib')]),/PASS shared ELF function\/unwind\/frame context/);
  const parityFixture=path.join(fixtures,'elf-instruction-evidence.c'),reference=path.join(temporary,'jvm-evidence');
  run('clang',['-O1','-g','-fsanitize=address,undefined','-std=gnu11','-Wall','-Wextra','-Werror','-Wno-unused-function','-I'+temporary,'-I'+source,'-I'+path.join(klepton,'runtime'),'-DKL_X18_SOURCE='+JSON.stringify(x18),parityFixture,path.join(klepton,'runtime/kl_env.c'),'-o',reference]);
  const referenceState=path.join(temporary,'jvm-evidence.bin');
  assert.match(run(reference,[referenceState]),/PASS whole-ELF shortened\/stripped initializer discovery/);
  const coreRoot=path.join(temporary,'core'),core=prepareX18Core(klepton,coreRoot),coreProbe=path.join(temporary,'core-evidence');
  run('clang',['-O1','-g','-fsanitize=address,undefined','-std=gnu11','-Wall','-Wextra','-Werror','-Wno-unused-function','-I'+coreRoot,'-DKL_X18_CORE_SOURCE='+JSON.stringify(core),parityFixture,'-o',coreProbe]);
  const coreState=path.join(temporary,'core-evidence.bin');
  assert.match(run(coreProbe,[coreState]),/PASS whole-ELF shortened\/stripped initializer discovery/);
  assert.deepEqual(fs.readFileSync(coreState),fs.readFileSync(referenceState),'Whole-ELF discovery must agree with the original JVM metadata and code-range owners');
});

test('Android x18 ADR veneer preserves the original address and live registers', async t => {
  const klepton=process.env.KLEPTON_SOURCE||path.join(root,'src/external/klepton');
  if(process.platform!=='darwin'||process.arch!=='arm64'||!fs.existsSync(path.join(klepton,'runtime/kl_x18.c')))
    return t.skip('Requires Apple Silicon and the pinned Klepton source');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-x18-adr-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const {prepareX18Source}=await import(require('node:url').pathToFileURL(path.join(source,'x18-source.mjs')).href);
  const modified=prepareX18Source(klepton,temporary);
  for(const [file,adapted] of [[path.join(klepton,'runtime/kl_x18.c'),'0'],[modified,'1']]){
    const binary=path.join(temporary,'probe-'+adapted);
    run('clang',['-std=gnu11','-I'+path.join(klepton,'runtime'),'-DKL_X18_SOURCE='+JSON.stringify(file),path.join(fixtures,'x18-adr.c'),path.join(klepton,'runtime/kl_env.c'),'-o',binary]);
    assert.match(run(binary,[adapted]),adapted==='1'?/PASS actual ADR veneer target, live scratch registers and thread slot/:/PASS original ADR refusal preserved/);
  }
});

test('Android x18 literal loads preserve live memory and register width across distant pools', async t => {
  const klepton=process.env.KLEPTON_SOURCE||path.join(root,'src/external/klepton');
  if(process.platform!=='darwin'||process.arch!=='arm64'||!fs.existsSync(path.join(klepton,'runtime/kl_x18.c')))
    return t.skip('Requires Apple Silicon and the pinned Klepton source');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-x18-literal-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const {prepareX18Source}=await import(require('node:url').pathToFileURL(path.join(source,'x18-source.mjs')).href);
  const modified=prepareX18Source(klepton,temporary),binary=path.join(temporary,'probe');
  run('clang',['-std=gnu11','-I'+path.join(klepton,'runtime'),'-DKL_X18_SOURCE='+JSON.stringify(modified),
    path.join(fixtures,'x18-literal.c'),path.join(klepton,'runtime/kl_env.c'),'-o',binary]);
  assert.match(run(binary,[]),/PASS 12 literal veneers: live memory, W\/X extension, original PC, scratch and NZCV/);
});

test('Android x18 stack writeback preserves native frame and register semantics', async t => {
  const klepton=process.env.KLEPTON_SOURCE||path.join(root,'src/external/klepton');
  if(process.platform!=='darwin'||process.arch!=='arm64'||!fs.existsSync(path.join(klepton,'runtime/kl_x18.c')))
    return t.skip('Requires Apple Silicon and the pinned Klepton source');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-x18-stack-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const {prepareX18Source}=await import(require('node:url').pathToFileURL(path.join(source,'x18-source.mjs')).href);
  const modified=prepareX18Source(klepton,temporary),binary=path.join(temporary,'probe');
  run('clang',['-std=gnu11','-I'+path.join(klepton,'runtime'),'-DKL_X18_SOURCE='+JSON.stringify(modified),
    path.join(fixtures,'x18-stack.c'),path.join(klepton,'runtime/kl_env.c'),'-o',binary]);
  assert.match(run(binary,[]),/PASS 58 actual stack-writeback veneers: memory, SP, shadow x18, scratch and NZCV/);
});

test('Android PixelCopy transfers real GPU pixels and retires callback ownership', t => {
  const home=jdk();
  if(!home||process.platform!=='darwin'||process.env.KLEPTON_GRAPHICS_RUN!=='1')return t.skip('Requires explicit Metal checks and Java 21');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-pixel-copy-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const library=path.join(temporary,'copy.dylib');
  run('clang++',['-std=c++20','-fobjc-arc','-mmacosx-version-min=13.0','-dynamiclib',
    '-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),'-I'+source,
    path.join(source,'pixel-copy.mm'),path.join(fixtures,'pixel-copy.mm'),
    '-framework','Foundation','-framework','Metal','-framework','QuartzCore','-o',library]);
  run(path.join(home,'bin/javac'),['--release','21','-d',temporary,path.join(fixtures,'PixelCopyProbe.java')]);
  const result=spawnSync(path.join(home,'bin/java'),['-Xcheck:jni','-Djava.awt.headless=true','-cp',temporary,'PixelCopyProbe',library],{encoding:'utf8',timeout:8000});
  assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/PixelCopy GPU\/regions\/lifetime PASS/);
  assert.match(result.stdout,/quiescent source and pooled reuse PASS/);
  assert.doesNotMatch(result.stderr,/WARNING in native method|FATAL ERROR|Exception/);
});

test('Android EGL keeps submitted images immutable across buffer reuse and idle PixelCopy', t => {
  const home=jdk(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime||process.env.KLEPTON_GRAPHICS_RUN!=='1')return t.skip('Requires explicit Metal checks, Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-egl-copy-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const native=path.resolve(runtime,'native');let graphics=path.join(native,'libklepton-graphics.dylib');
  if(process.env.KLEPTON_PIXEL_COPY_GRAPHICS){
    // A component rebuild keeps the selected complete native dependency
    // closure. Loader-relative dependencies must resolve beside that image.
    const projected=path.join(temporary,'native');fs.mkdirSync(projected);
    for(const name of fs.readdirSync(native))fs.symlinkSync(path.join(native,name),path.join(projected,name));
    graphics=path.join(projected,'libklepton-graphics.dylib');fs.unlinkSync(graphics);
    try{fs.linkSync(path.resolve(process.env.KLEPTON_PIXEL_COPY_GRAPHICS),graphics);}catch{fs.copyFileSync(path.resolve(process.env.KLEPTON_PIXEL_COPY_GRAPHICS),graphics);}
  }
  const binary=path.join(temporary,'egl-copy'),headers=path.resolve(root,'src/external/krkrsdl2/external/krkrz/external/angle/include');
  run(path.join(home,'bin/javac'),['--release','21','-d',temporary,path.join(fixtures,'EglPixelCopyProbe.java')]);
  run('clang++',['-std=c++20','-fobjc-arc','-mmacosx-version-min=13.0','-I'+source,'-I'+headers,'-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),
    path.join(fixtures,'egl-pixel-copy.mm'),'-L'+path.join(home,'lib/server'),'-ljvm','-Wl,-rpath,'+path.join(home,'lib/server'),'-Wl,-rpath,'+native,
    '-framework','Cocoa','-framework','QuartzCore','-framework','Metal','-framework','IOSurface','-o',binary]);
  const angle=path.join(native,'angle');assert.ok(fs.statSync(path.join(angle,'libEGL.dylib')).isFile());
  const result=run(binary,[path.resolve(graphics),angle,temporary],{timeout:15000,env:{...process.env,DYLD_LIBRARY_PATH:'',DYLD_FRAMEWORK_PATH:'',
    KLEPTON_FRAME_LIBRARY:require('../src/modules/shared/reshade').resolvePresentationLibrary(),RESHADE_EXPLICIT_HOST:'1'}});
  assert.match(result,/Original EGL: stable window, three-buffer reuse, quiescent PixelCopy, swap behavior and resize PASS/);
});

test('Android native C++ guards reuse actual host synchronization and abort semantics', t => {
  if(process.platform!=='darwin'||process.arch!=='arm64')return t.skip('Requires Apple Silicon');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-cxx-guard-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const binary=path.join(temporary,'guards');
  run('clang++',['-std=c++17','-mmacosx-version-min=13.0','-I'+source,path.join(fixtures,'cxx-guards.cpp'),'-o',binary]);
  assert.match(run(binary,[]),/PASS native C\+\+ guard synchronization, publication and retry/);
});

test('Android display teardown retains the bound window until producers and callbacks retire', t => {
  const home = jdk();
  if (!home || process.platform !== 'darwin') return t.skip('Requires macOS and Java 21 development tools');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'android-display-retirement-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const library = path.join(temporary, 'display.dylib');
  const runtime = process.env.KLEPTON_NATIVE_RUNTIME || path.dirname(commonRuntimeClasspath(temporary).split(path.delimiter).at(-1));
  run('clang', ['-std=c11', '-mmacosx-version-min=13.0', '-dynamiclib',
    '-I' + path.join(home, 'include'), '-I' + path.join(home, 'include/darwin'), '-I' + source,
    path.join(source, 'display-adapter.c'), path.join(fixtures, 'display-retirement-jni.c'),
    '-L' + path.resolve(runtime, 'native'), '-lklepton-jvm', '-Wl,-rpath,' + path.resolve(runtime, 'native'), '-o', library]);
  const classpath = commonRuntimeClasspath(temporary);
  run(path.join(home, 'bin/javac'), ['--release', '21', '-cp', classpath, '-d', temporary,
    path.join(fixtures, 'DisplayRetirementProbe.java'), path.join(fixtures, '../android-window-session/RuntimeFixture.java')]);
  for (const mode of ['query', 'inflight', 'pending', 'partial']) {
    const result = spawnSync(path.join(home, 'bin/java'), ['-Xverify:all', '-Xcheck:jni',
      '-cp', classpath, 'DisplayRetirementProbe', library, mode, path.resolve(runtime), path.join(temporary, mode)], { env:commonProbeEnvironment(temporary), encoding: 'utf8', timeout: 15000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /PASS/);
    assert.doesNotMatch(result.stderr, /WARNING in native method|FATAL ERROR in native method/);
  }
});

test('Android launch configuration validates bounds, text and runtime containment', t => {
  const home = jdk();
  if (!home) return t.skip('Java 21 development tools are not installed');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'android-config-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  run(path.join(home, 'bin/javac'), ['--release', '21', '-d', temporary,
    path.join(source, 'java/maclauncher/android/LaunchConfig.java'), path.join(source, 'java/maclauncher/android/ApplicationSettings.java'), path.join(fixtures, 'LaunchConfigProbe.java')]);
  const input=path.join(temporary,'wire.apk');fs.writeFileSync(input,'fixture');
  const prepared={metadata:{packageName:'example.game',versionName:'1',versionCode:1,launchers:[{activity:'example.game.Activity'}]},sourceApk:input,convertedJar:input};
  for(const name of ['nativeRoot','assetsRoot','resourcesRoot','filesRoot','cacheRoot'])prepared[name]=temporary;
  const wire=path.join(temporary,'wire.json');
  fs.writeFileSync(wire,JSON.stringify(require('../src/modules/android/host').launchConfig({},prepared,{root:temporary,profile:{}},{}))+'\n');
  assert.match(run(path.join(home, 'bin/java'), ['-Xverify:all', '-cp', temporary,
    'maclauncher.android.LaunchConfigProbe', temporary,wire]), /PASS Android launch config/);
});

test('Android JNI adapter preserves ARM64 integer, floating and packed stack arguments', t => {
  const home = jdk();
  if (!home || process.platform !== 'darwin' || process.arch !== 'arm64') return t.skip('Requires Apple Silicon and Java 21 development tools');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'android-native-abi-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const library = path.join(temporary, 'abi.dylib');
  run('clang', ['-arch', 'arm64', '-mmacosx-version-min=13.0', '-dynamiclib', '-I' + path.join(home, 'include'),
    '-I' + path.join(home, 'include/darwin'), path.join(source, 'nativeabi.c'), path.join(source, 'nativeabi.S'), path.join(source, 'jni-invocation.c'),
    path.join(fixtures, 'nativeabi-test.c'), path.join(fixtures, 'nativeabi-capture.S'), '-o', library]);
  run(path.join(home, 'bin/javac'), ['--release', '21', '-d', temporary, path.join(fixtures, 'NativeAbiProbe.java')]);
  assert.match(run(path.join(home, 'bin/java'), ['-Dklepton.abi.test=' + library, '-Xcheck:jni', '-Xverify:all', '-cp', temporary,
    'probe.NativeAbiProbe']), /PASS/);
});


test('SoundPool releases native samples and collected owners',t=>{
 const home=jdk(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;if(!home||!runtime||process.platform!=='darwin')return t.skip('Requires macOS, Java 21 and KLEPTON_NATIVE_RUNTIME');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-media-owners-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const classpath=[temporary,path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar')].join(path.delimiter);
 run(path.join(home,'bin/javac'),['--release','21','-cp',classpath,'-d',temporary,path.join(fixtures,'SoundPoolLifetimeProbe.java'),
  path.join(fixtures,'../android-window-session/RuntimeFixture.java'),path.join(fixtures,'../android-platform-service/MediaServicesFixture.java')]);
 assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-Xcheck:jni','-cp',classpath,'android.media.SoundPoolLifetimeProbe',path.resolve(runtime),temporary]),/PASS native references/);
});

// Original Activity lifecycle is covered by HostWindowProbe and the window-session
// failure fixtures; original queue/Messenger ownership by NativeMessageQueueProbe.

test('Android viewport metadata follows original window state without a GPU', t => {
 const home=jdk();if(!home)return t.skip('Java 21 development tools unavailable');
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'android-platform-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 run(path.join(home,'bin/javac'),['--release','21','-cp',commonRuntimeClasspath(tmp),'-d',tmp,...commonProbeSources(),path.join(fixtures,'VisibleDisplayFrameProbe.java')]);
 assert.match(runCommonProbe(home,tmp,'VisibleDisplayFrameProbe').stdout,/PASS/);
});

test('Android reverse JNI preserves guest register, va_list, A calls and bounded descriptor caching', async t=>{
 const home=jdk();if(!home||process.platform!=='darwin'||process.arch!=='arm64')return t.skip('Requires Apple Silicon and Java21');
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'android-jni-calls-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const {generate}=await import(require('node:url').pathToFileURL(path.join(source,'loader-generate-jni-calls.mjs')).href);generate(tmp,home);const library=path.join(tmp,'jni-calls.dylib');
 const generated=['jni-forward-generated.h','jni-calls-generated.h','jni-calls.S'].map(name=>path.join(tmp,name));
 const originalTimes=generated.map(file=>fs.statSync(file,{bigint:true}).mtimeNs);generate(tmp,home);
 assert.deepEqual(generated.map(file=>fs.statSync(file,{bigint:true}).mtimeNs),originalTimes,'Unchanged JNI generation must not force bridge recompilation');
 const {emitNdkJniImports}=await import(require('node:url').pathToFileURL(path.join(source,'ndk-jni/build.mjs')).href);
 const ndkTypes={'JNIEnv *':{kind:'Pointer',element:'JNIEnv',size:8},jobject:{kind:'Pointer',size:8},fixture:{parameters:['JNIEnv *','jobject'],variadic:false}};
 const ndkRows=emitNdkJniImports({types:ndkTypes,functions:{fixture:{symbol:'AFileDescriptor_getFd',type:'fixture'},future:{symbol:'FutureNDKEnvironmentFunction',type:'fixture'}}},tmp);
 assert.deepEqual(ndkRows,[{name:'AFileDescriptor_getFd',argument:0},{name:'FutureNDKEnvironmentFunction',argument:0}]);
 const compile=(destination,loader=path.join(source,'loader-jni-calls.c'))=>run('clang',['-arch','arm64','-mmacosx-version-min=13.0','-dynamiclib','-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),'-I'+tmp,'-I'+source,loader,path.join(source,'nativeabi.c'),path.join(source,'nativeabi.S'),path.join(source,'jni-invocation.c'),path.join(source,'ndk-jni/adapter.c'),path.join(tmp,'jni-calls.S'),path.join(fixtures,'jni-calls-test.c'),path.join(fixtures,'jni-calls-test.S'),'-o',destination]);
 compile(library);
 const methods=path.join(tmp,'JniManyMethods.java');fs.writeFileSync(methods,'package probe;public final class JniManyMethods{'+Array.from({length:1050},(_,i)=>`public static int m${i}(int value){return value;}`).join('\n')+'}\n');
 run(path.join(home,'bin/javac'),['--release','21','-d',tmp,path.join(fixtures,'JniCallsProbe.java'),methods]);
 const args=['-Xcheck:jni','-Xverify:all','-Xmx64m','-Djni.calls.test='+library,'-cp',tmp,'probe.JniCallsProbe'];assert.match(run(path.join(home,'bin/java'),args),/PASS/);
 const negative=spawnSync(path.join(home,'bin/java'),args,{env:{...process.env,JNI_CALLS_NEGATIVE:'1'},encoding:'utf8',timeout:10000});assert.equal(negative.status,1,negative.stderr);assert.match(negative.stderr,/Unadapted guest scalar mismatch/);
 // This previous boundary mistake must be observable in a real active Android
 // stack-protected frame, not accepted by a source-text assertion alone.
 const unsafe=path.join(tmp,'full-thread-init.c'),unsafeLibrary=path.join(tmp,'full-thread-init.dylib');
 fs.writeFileSync(unsafe,'#define klj_enter_guest_thread kl_thread_init\n'+fs.readFileSync(path.join(source,'loader-jni-calls.c'),'utf8'));compile(unsafeLibrary,unsafe);
 const canary=spawnSync(path.join(home,'bin/java'),args.map(value=>value==='-Djni.calls.test='+library?'-Djni.calls.test='+unsafeLibrary:value),{encoding:'utf8',timeout:10000});
 assert.equal(canary.status,1,canary.stdout+canary.stderr);assert.match(canary.stderr,/Guest attach\/detach environment ownership must precede host attachment/);
});

test('Original libcore environment uses UTF-8 independently of graphics',t=>{
 const home=jdk(),core=process.env.ANDROID_CORE_LIBRARY;
 if(!home||process.platform!=='darwin'||!core)return t.skip('Requires macOS, Java21 and the built Android core for errno translation');
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'android-environment-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const object=path.join(tmp,'filesystem.o'),binary=path.join(tmp,'environment');
 run('clang',['-c','-ffunction-sections','-fdata-sections','-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),path.join(source,'framework-filesystem.c'),'-o',object]);
 run('clang++',['-std=c++17','-Wl,-dead_strip','-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),path.join(fixtures,'environment-jni.cpp'),object,path.resolve(core),'-Wl,-rpath,'+path.dirname(path.resolve(core)),'-L'+path.join(home,'lib/server'),'-ljvm','-Wl,-rpath,'+path.join(home,'lib/server'),'-o',binary]);
 assert.match(run(binary,[]),/PASS original libcore JNI environment UTF-8, enumeration, overwrite, NUL rejection and removal/);
});

test('Android native surfaces preserve real buffer ownership, pointer state and typed metadata', t=>{
 const home=jdk();if(!home||process.platform!=='darwin')return t.skip('Requires macOS and Java21');
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'android-surfaces-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const probes=['SurfaceLifecycle','Environment','Pointer','ProcessIdentity','CustomPointer','Capture','FirstFailureProbe','MetadataProbe'];
 run(path.join(home,'bin/javac'),['--release','21','-cp',commonRuntimeClasspath(tmp),'-d',tmp,...commonProbeSources(),...probes.map(n=>path.join(fixtures,n+'.java'))]);
 for(const name of probes){
  const cls=name==='FirstFailureProbe'?'maclauncher.android.'+name:name==='MetadataProbe'?'maclauncher.android.bridge.'+name:'maclauncher.android.tests.'+name;
  // The early-failure fallback and ELF parser intentionally precede native bootstrap.
  if(name==='FirstFailureProbe'||name==='MetadataProbe'){
   assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-Xcheck:jni','-Xmx64m','-cp',commonRuntimeClasspath(tmp),cls]),/PASS/);
  }else{
   const result=runCommonProbe(home,tmp,cls);assert.match(result.stdout,/PASS|checks=/);
   if(name==='SurfaceLifecycle')assert.match(result.stderr,/java\.lang\.IllegalStateException: intentional callback/);
  }
 }
});

test('Android unavailable services and SDK worker diagnostics do not poison the host owner', t => {
 const home=jdk();if(!home||process.platform!=='darwin')return t.skip('Requires macOS and Java21');
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'android-optional-api-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 run(path.join(home,'bin/javac'),['--release','21','-cp',commonRuntimeClasspath(tmp),'-d',tmp,...commonProbeSources(),path.join(fixtures,'FirstFailureProbe.java'),path.join(fixtures,'UnavailableServicesProbe.java')]);
 const args=['-Xverify:all','-Xcheck:jni','-Xmx64m','-Djava.awt.headless=true','-cp',commonRuntimeClasspath(tmp)];
 assert.match(run(path.join(home,'bin/java'),[...args,'maclauncher.android.FirstFailureProbe']),/PASS primary/);
 assert.match(run(path.join(home,'bin/java'),[...args,'maclauncher.android.FirstFailureProbe','workers']),/PASS worker diagnostics/);
 assert.match(runCommonProbe(home,tmp,'maclauncher.android.tests.UnavailableServicesProbe').stdout,/PASS unavailable services/);
});

test('Android native heap statistics reflect real allocations without retaining samples',t=>{
 const home=jdk();if(!home||process.platform!=='darwin')return t.skip('Requires macOS and Java21');
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'android-heap-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));const library=path.join(tmp,'heap.dylib');
 run('clang',['-dynamiclib','-Wall','-Wextra','-Werror','-mmacosx-version-min=13.0','-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),path.join(source,'native-heap.c'),path.join(fixtures,'heap-test.c'),'-o',library]);
 run(path.join(home,'bin/javac'),['--release','21','-d',tmp,path.join(fixtures,'HeapProbe.java')]);
 assert.match(run(path.join(home,'bin/java'),['-Xmx64m','-Xcheck:jni','-Xverify:all','-cp',tmp,'HeapProbe',library]),/PASS actual native heap statistics/);
});

test('Android GLES header inputs reject revision, byte and containment mismatches',async t=>{
 const headers=process.env.ANDROID_GLES_HEADERS||path.join(root,'src/external/maclauncher-android/src/external/android-gles-headers');
 if(!fs.existsSync(path.join(headers,'include/GLES3/gl3.h')))return t.skip('Pinned GLES build headers are not initialized');
 const {verifyGlesHeaders}=await import(require('node:url').pathToFileURL(path.join(source,'gles-headers.mjs')).href);
 const manifest=verifyGlesHeaders(headers);for(const file of ['include/GLES/gl.h','include/GLES2/gl2ext.h','include/GLES3/gl32.h','include/EGL/egl.h','include/KHR/khrplatform.h'])assert.ok(manifest.files.some(entry=>entry.path===file),file);
 assert.throws(()=>verifyGlesHeaders(headers,{...manifest,revision:'0'.repeat(40)}),/revision does not match/);
 const changed=structuredClone(manifest);changed.files[0].sha256='0'.repeat(64);assert.throws(()=>verifyGlesHeaders(headers,changed),/does not match its recorded source/);
 const registry=structuredClone(manifest);registry.registry.sha256='0'.repeat(64);assert.throws(()=>verifyGlesHeaders(headers,registry),/does not match its recorded source/);
 const escaped=structuredClone(manifest);escaped.files[0].path='../escape';assert.throws(()=>verifyGlesHeaders(headers,escaped),/Invalid GLES header path/);
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'android-header-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 for(const entry of manifest.files){const target=path.join(tmp,entry.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(headers,entry.path),target);}
 const file=path.join(tmp,manifest.files[0].path);fs.unlinkSync(file);fs.symlinkSync(path.resolve(headers,manifest.files[0].path),file);
 assert.throws(()=>verifyGlesHeaders(tmp,manifest),/leaves its source directory/);
});

test('Android bitmap options decode real pixels, retain descriptor ownership and generate independent view IDs', t => {
  const home=jdk(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires macOS, Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-bitmap-options-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const jars=['android-host.jar','android-framework.jar'].map(file=>path.resolve(runtime,file)),classpath=[temporary,...jars].join(path.delimiter);
  run(path.join(home,'bin/javac'),['--release','21','-cp',jars.join(path.delimiter),'-d',temporary,
    path.join(fixtures,'../android-framework-services/NativeResourceSupport.java'),path.join(fixtures,'ResourceFixtureData.java'),path.join(fixtures,'BitmapDecodeProbe.java')]);
  assert.match(run(path.join(home,'bin/java'),['-Xcheck:jni','-Xverify:all','-Xmx192m','-Djava.awt.headless=true',
    '-Dandroid.test.runtime='+path.resolve(runtime),'-cp',classpath,'android.content.res.BitmapDecodeProbe']),/PASS.*bitmap option/);
});
