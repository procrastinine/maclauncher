const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync,spawn}=require('node:child_process');

test('Binder adaptation headers preserve original translation-unit macro configuration',async t=>{
  const {includeDependencies}=await import('../src/modules/android/native/upstream/source-includes.mjs');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-binder-headers-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  fs.writeFileSync(path.join(directory,'original.h'),'#pragma once\n');
  fs.writeFileSync(path.join(directory,'device.h'),'#ifndef LOG_TAG\n#define LOG_TAG nullptr\n#endif\nconstexpr auto deviceLogTag=LOG_TAG;\n');
  const source='/* Original source license. */\n#define LOG_TAG "Original"\n#include "original.h"\nstatic_assert(sizeof(deviceLogTag)==sizeof(const char*));\n';
  const file=path.join(directory,'source.cpp');
  fs.writeFileSync(file,includeDependencies(source,'#include "device.h"'));
  execFileSync('clang++',['-std=c++20','-Werror','-fsyntax-only',file],{stdio:'pipe'});
});

test('private Binder ABI channels preserve callers without trusting external envelope identity',t=>{
  const build=process.env.ANDROID_BINDER_BUILD;
  if(process.platform!=='darwin'||!build)return t.skip('Requires the current original Binder build');
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-binder-abi-identity-'));
  t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  const recipe=JSON.parse(fs.readFileSync(build,'utf8')),executable=path.join(output,'check');
  execFileSync('clang++',[...recipe.flags,path.resolve('tests/fixtures/android-native/BinderAbiIdentityProbe.cpp'),
    recipe.library,'-Wl,-rpath,'+path.dirname(recipe.library),'-o',executable],{stdio:'pipe'});
  const result=execFileSync(executable,[],{encoding:'utf8',timeout:10000});
  assert.match(result,/PASS private ABI caller identity, nested callbacks, clear\/restore and untrusted envelope rejection/);
});

test('original native service clients retain callbacks and descriptors through the process directory',async t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME,build=process.env.ANDROID_BINDER_BUILD;
  if(process.platform!=='darwin'||!runtime||!home||!build)return t.skip('Requires the original Binder build, macOS and JAVA_HOME');
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-native-directory-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  const recipe=JSON.parse(fs.readFileSync(build,'utf8'));
  const library=path.join(output,'libnative-directory-probe.dylib');
  execFileSync('clang++',[...recipe.flags,'-dynamiclib',path.resolve('tests/fixtures/android-native/BinderNativeDirectoryProbe.cpp'),recipe.library,
    '-Wl,-rpath,'+path.dirname(recipe.library),'-o',library],{stdio:'pipe'});
  execFileSync('codesign',['--force','--sign','-',library],{stdio:'pipe'});
  const cp=[output,...['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name))].join(path.delimiter);
  execFileSync(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',output,
    path.resolve('src/modules/android/native/java/maclauncher/android/framework/HostBinderRpc.java'),
    path.resolve('tests/fixtures/android-framework-services/BinderNativeDirectoryProbe.java'),
    path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java')],{stdio:'pipe'});
  const identity=await require('../src/modules/android/process-channel').processNamespace(output,1);
  const executable=path.join(output,'binder-vm-lifetime');
  execFileSync('clang++',['-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),...recipe.flags,path.resolve('tests/fixtures/android-native/binder-vm-lifetime.cpp'),'-L'+path.join(home,'lib/server'),'-ljvm','-Wl,-rpath,'+path.join(home,'lib/server'),'-o',executable],{stdio:'pipe'});
  const result=execFileSync(executable,[cp,path.resolve(runtime),output,library],
    {encoding:'utf8',timeout:20000,env:{...process.env,...identity.environment,TMPDIR:output}});
  assert.match(result,/PASS native Binder directory: original AIDL, cross-session identity, nested callback, file descriptor and retirement/);
  assert.match(result,/PASS original Binder logical process identity, debug PID and permission self shortcut/);
  assert.match(result,/PASS real JVM destruction: Java permission controller retirement and dead-VM attachment rejection/);
});

test('original Binder references retain identity and callbacks across provider RPC sessions',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
  if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires macOS, JAVA_HOME and KLEPTON_NATIVE_RUNTIME');
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-binder-relay-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  const cp=[output,...['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name))].join(path.delimiter);
  execFileSync(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',output,path.resolve('tests/fixtures/android-framework-services/BinderRelayProbe.java'),path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java')],{stdio:'pipe'});
  const result=execFileSync(path.join(home,'bin/java'),['-Xverify:all','-cp',cp,'maclauncher.android.fixture.BinderRelayProbe',path.resolve(runtime),output],{encoding:'utf8',timeout:20000,env:{...process.env,TMPDIR:output}});
  assert.match(result,/PASS Binder relay: original identity, nested callbacks, result payloads and session retirement/);
});

test('AOSP Binder RPC exchanges callbacks and owned file descriptors between processes',async t=>{
  if(process.platform!=='darwin'||process.arch!=='arm64')return t.skip('Apple Silicon native transport');
  const nativeSource=process.env.AOSP_NATIVE_SOURCE||path.resolve('src/external/aosp-native');
  const systemCore=process.env.AOSP_SYSTEM_CORE_SOURCE||path.resolve('src/external/aosp-system-core');
  if(!fs.existsSync(path.join(nativeSource,'.git'))||!fs.existsSync(path.join(systemCore,'.git')))return t.skip('Pinned AOSP native and system/core checkouts are required');
  const python=process.env.PYTHON,ninja=process.env.NINJA;
  if(!python||!ninja||!process.env.ANDROID_BLUEPRINT_PARSER)return t.skip('Requires the configured Python, Ninja and original Blueprint parser');
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-binder-rpc-'));
  t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  const {buildBinderRpc}=await import('../src/modules/android/native/binder-rpc/build.mjs');
  const options={nativeSource,systemCore,output,python,ninja};
  const built=buildBinderRpc(options),{library,flags}=built;
  const retained=[library,path.join(built.output,'source/native/libs/binder/RpcSession.cpp'),path.join(built.output,'FdTrigger-darwin.cpp')];
  const timestamps=retained.map(file=>fs.statSync(file,{bigint:true}).mtimeNs);
  buildBinderRpc(options);
  assert.deepEqual(retained.map(file=>fs.statSync(file,{bigint:true}).mtimeNs),timestamps);
  const executable=path.join(output,'binder-rpc-probe');
  execFileSync('clang++',[...flags,path.resolve('tests/fixtures/android-native/BinderRpcProbe.cpp'),library,
    '-Wl,-rpath,'+output,'-o',executable],{stdio:'pipe'});
  const child=spawn(executable,[],{detached:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);
  const cleanup=()=>{try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}};
  t.after(cleanup);const deadline=setTimeout(cleanup,15000);
  const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));}).finally(()=>clearTimeout(deadline));
  assert.equal(result.code,0,JSON.stringify(result)+'\n'+stderr);
  assert.match(stdout,/PASS AOSP Binder RPC: separate processes, callback, transferred FD lifetime and shutdown/);
});

test('original Java Binder and Parcel use native reference ownership and sealed shared memory',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
  if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires macOS, JAVA_HOME and KLEPTON_NATIVE_RUNTIME');
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-binder-jni-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  const cp=[output,...['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name))].join(path.delimiter);
  execFileSync(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',output,path.resolve('tests/fixtures/android-framework-services/BinderParcelProbe.java'),path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java')],{stdio:'pipe'});
  const result=execFileSync(path.join(home,'bin/java'),['-Xverify:all','-cp',cp,'maclauncher.android.fixture.BinderParcelProbe',path.resolve(runtime),output],{encoding:'utf8',timeout:30000,env:{...process.env,TMPDIR:output}});
  assert.match(result,/PASS original native Parcel: primitives, direct buffers, Binder identity, retained descriptors and sealed large blobs/);
});

test('optional Android provider loss preserves game startup and transport validation',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
  if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires macOS, JAVA_HOME and KLEPTON_NATIVE_RUNTIME');
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-optional-service-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  const cp=[output,...['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name))].join(path.delimiter);
  execFileSync(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',output,path.resolve('tests/fixtures/android-framework-services/OptionalServiceProbe.java'),path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java')],{stdio:'pipe'});
  const result=execFileSync(path.join(home,'bin/java'),['-Xverify:all','-cp',cp,'maclauncher.android.fixture.OptionalServiceProbe',path.resolve(runtime),output],{encoding:'utf8',timeout:15000,env:{...process.env,TMPDIR:output}});
  assert.match(result,/PASS optional Binder transport loss does not hide invalid descriptors or arguments/);
});

test('original Java Binder RPC preserves process identity, callbacks and descriptor ownership',async t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
  if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires macOS, JAVA_HOME and KLEPTON_NATIVE_RUNTIME');
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-binder-processes-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  const cp=[output,...['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name))].join(path.delimiter);
  execFileSync(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',output,path.resolve('tests/fixtures/android-framework-services/BinderRpcJavaProbe.java'),path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java')],{stdio:'pipe'});
  const executable=path.join(output,'processes');execFileSync('clang',[path.resolve('tests/fixtures/android-native/BinderRpcJavaProcesses.c'),'-o',executable],{stdio:'pipe'});
  const identity=await require('../src/modules/android/process-channel').processNamespace(output,1);
  const child=spawn(executable,[path.join(home,'bin/java'),cp,path.resolve(runtime),output],{detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,...identity.environment,TMPDIR:output}});
  let stdout='',stderr='';child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);
  const cleanup=()=>{try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}};
  t.after(cleanup);const deadline=setTimeout(cleanup,30000);
  const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));}).finally(()=>clearTimeout(deadline));
  assert.equal(result.code,0,JSON.stringify(result)+'\n'+stderr);
  assert.match(stdout,/PASS original Java Binder RPC: isolated processes, nested callbacks, caller identity, FD transfer and asynchronous shutdown/);
});

test('system-service clients use the provider process identity and restore the original application caller',async t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
  if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires macOS, JAVA_HOME and KLEPTON_NATIVE_RUNTIME');
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-system-service-hop-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  const cp=[output,...['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name))].join(path.delimiter);
  execFileSync(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',output,path.resolve('tests/fixtures/android-framework-services/SystemServiceIdentityProbe.java'),path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java')],{stdio:'pipe'});
  const executable=path.join(output,'processes');execFileSync('clang',[path.resolve('tests/fixtures/android-native/BinderRpcJavaProcesses.c'),'-o',executable],{stdio:'pipe'});
  const result=execFileSync(executable,[path.join(home,'bin/java'),cp,path.resolve(runtime),output,'maclauncher.android.fixture.SystemServiceIdentityProbe'],{encoding:'utf8',timeout:20000,env:{...process.env,TMPDIR:output}});
  assert.match(result,/PASS system-service caller hop: provider identity, original incoming identity, strict checks and exceptional restoration/);
});

test('original AIDL dispatch exposes existing services and retires directory callbacks',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
  if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires macOS, JAVA_HOME and KLEPTON_NATIVE_RUNTIME');
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-service-dispatch-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  const cp=[output,...['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name))].join(path.delimiter);
  execFileSync(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',output,...['ServiceDispatchProbe','SyntheticResources'].map(name=>path.resolve('tests/fixtures/android-framework-services',name+'.java')),path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java')],{stdio:'pipe'});
  const result=execFileSync(path.join(home,'bin/java'),['-Xverify:all','-cp',cp,'maclauncher.android.ServiceDispatchProbe',path.resolve(runtime),output],{encoding:'utf8',timeout:20000,env:{...process.env,TMPDIR:output}});
  assert.match(result,/PASS original AIDL service dispatch, metadata, registration callbacks and callback retirement/);
});
