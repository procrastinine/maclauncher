const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const Sandbox=require('../src/modules/shared/runtime/macos-sandbox');
test('Native pollable counters and timers work with network disabled and preserve descriptor ownership',async t=>{
 if(process.platform!=='darwin'||process.arch!=='arm64'||!process.env.KLEPTON_NATIVE_RUNTIME||!process.env.EPOLL_SHIM_SOURCE)return t.skip('Requires Apple Silicon runtime and pinned epoll-shim source');
 const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-pollable-')));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const {buildPollableDescriptors}=await import('../src/modules/android/native/pollable-fds/build.mjs');
 const built=buildPollableDescriptors({checkout:path.resolve(process.env.EPOLL_SHIM_SOURCE),output:path.join(directory,'supplier')});
 const native=fs.realpathSync(path.resolve(process.env.KLEPTON_NATIVE_RUNTIME,'native')),binary=path.join(directory,'probe'),delivered=path.join(directory,'delivered-probe');
 const run=(command,args,extra={})=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:30000,...extra});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 const flags=['-std=gnu11','-arch','arm64','-mmacosx-version-min=13.0','-Wall','-Wextra','-Werror','-I'+path.resolve(__dirname,'../src/modules/android/native'),path.join(__dirname,'fixtures/android-native/pollable-descriptors.c')];
 const runtime=[path.join(native,'libklepton-jvm.dylib'),'-Wl,-rpath,'+native];
 run('clang',[...flags,built.object,built.archive,...runtime,'-o',binary]);
 // A delivered resolver and descriptor operations must use its one registry.
 // Linking a second fresh supplier here would mix native descriptor owners.
 run('clang',[...flags,...runtime,'-o',delivered]);
 for(const blockNetwork of [true,false]){
  const policy=path.join(directory,'profile-'+blockNetwork+'.sb');
  fs.writeFileSync(policy,Sandbox.profile({readDirectories:[native,directory],readFiles:[],writeDirectories:[directory],executables:[binary,delivered],blockNetwork}));
  for(const [executable,args]of [[binary,[]],[delivered,['delivered-imports']]])
   assert.match(run('/usr/bin/sandbox-exec',['-f',policy,executable,...args],{env:{...process.env,TMPDIR:directory}}),/PASS original eventfd\/timerfd\/epoll/);
 }
});
