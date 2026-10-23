const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {execFileSync}=require('node:child_process');
test('VM memory accounting shares ActivityManager threshold and boundary semantics',t=>{
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-memory-info-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
 const executable=path.join(output,'memory-info');execFileSync(process.env.CC||'clang',['-std=c11','-Wall','-Wextra','-Werror','-I'+path.resolve('src/modules/android/native'),'tests/fixtures/android-native/memory-info.c','-o',executable]);execFileSync(executable);
});
test('original Debug memory family measures native VM pages without substituting heap allocation for PSS',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,jdk=process.env.JAVA_HOME;
  if(process.platform!=='darwin'||!runtime||!jdk)return t.skip('macOS, JAVA_HOME and KLEPTON_NATIVE_RUNTIME are required');
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-debug-memory-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  const library=path.join(output,'debug-memory.dylib');
  const installed=process.env.ANDROID_DEBUG_MEMORY_RUNTIME==='1';
  execFileSync('clang',['-arch','arm64','-mmacosx-version-min=13.0','-O2','-Wall','-Wextra','-Werror','-I'+path.join(jdk,'include'),'-I'+path.join(jdk,'include/darwin'),'-dynamiclib',...installed?[]:[path.resolve('src/modules/android/native/native-heap.c')],path.resolve('tests/fixtures/android-native/DebugMemoryPages.c'),'-o',library],{stdio:'pipe'});
  const cp=[output,path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar')].join(path.delimiter);
  execFileSync(path.join(jdk,'bin/javac'),['--release','21','-cp',cp,'-d',output,path.resolve('src/modules/android/native/java/maclauncher/android/framework/HostActivityManager.java'),path.resolve('src/modules/android/native/java/maclauncher/android/framework/HostActivityService.java'),path.resolve('tests/fixtures/android-framework-services/DebugMemoryProbe.java'),path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java')],{stdio:'pipe'});
  const result=execFileSync(path.join(jdk,'bin/java'),['-Xverify:all','-cp',cp,'maclauncher.android.fixture.DebugMemoryProbe',path.resolve(runtime),output,library,...installed?['runtime']:[]],{encoding:'utf8',timeout:20000,env:{...process.env,TMPDIR:output}});
  assert.match(result,/PASS original Debug: tagged\/touched\/released Mach pages/);
});
