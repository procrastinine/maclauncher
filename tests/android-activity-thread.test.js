const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');

test('complete ActivityThread JNI allocator unit reaches Darwin pressure relief without retiring live resources',async t=>{
  const home=process.env.JAVA_HOME,runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  const frameworkSource=process.env.AOSP_FRAMEWORK_SOURCE||path.resolve('src/external/aosp-framework');
  const bionicSource=process.env.AOSP_BIONIC_SOURCE||path.resolve('src/external/aosp-bionic');
  if(process.platform!=='darwin'||!home||!runtime||!fs.existsSync(frameworkSource)||!fs.existsSync(bionicSource))return t.skip('Requires JDK, full runtime and pinned framework/Bionic sources');
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-activity-thread-'));
  t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  const {prepareActivityThread}=await import('../src/modules/android/native/activity-thread/build.mjs');
  const {unit}=prepareActivityThread({frameworkSource,bionicSource,build:output});
  const flags=['-std=c++20','-arch','arm64','-mmacosx-version-min=13.0','-Wno-writable-strings','-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin')];
  const executable=path.join(output,'allocator-probe'),library=path.join(output,'activity-thread.dylib');
  execFileSync('clang++',[...flags,unit,path.resolve('tests/fixtures/android-native/ActivityThreadAllocatorProbe.cpp'),'-o',executable],{stdio:'pipe'});
  assert.match(execFileSync(executable,[],{encoding:'utf8',timeout:10000}),/PASS ActivityThread purge reaches Darwin allocator zones and preserves live storage/);
  execFileSync('clang++',[...flags,'-dynamiclib',unit,'-o',library],{stdio:'pipe'});
  const cp=[output,...['android-host.jar','android-framework.jar'].map(file=>path.resolve(runtime,file))].join(path.delimiter);
  execFileSync(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',output,path.resolve('tests/fixtures/android-framework-services/ActivityThreadPurgeProbe.java'),path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java')],{stdio:'pipe'});
  const result=execFileSync(path.join(home,'bin/java'),['-Xverify:all','-cp',cp,'maclauncher.android.fixture.ActivityThreadPurgeProbe',path.resolve(runtime),output,library],{encoding:'utf8',timeout:20000,env:{...process.env,TMPDIR:output}});
  assert.match(result,/PASS original ActivityThread allocator natives preserve live native resources/);
});
