const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('./helpers/android-java');

test('ANGLE Vulkan executes GLES compute and presents through the native GPU carrier',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,jdk=process.env.JAVA_HOME,provider=process.env.ANDROID_ANGLE_VULKAN;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!runtime||!jdk||!provider||!process.env.KL_MVK_DYLIB||!process.env.KLEPTON_FRAME_LIBRARY)return t.skip('Requires ANGLE Vulkan, an Android runtime, selected managed driver and common presenter');
 const root=path.resolve(__dirname,'..'),native=path.join(root,'src/modules/android/native'),fixture=path.join(__dirname,'fixtures/android-native');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-angle-vulkan-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:60000,env:{...process.env,KL_ANGLE_DIR:path.resolve(provider),RESHADE_EXPLICIT_HOST:'1'}});assert.equal(result.status,0,(result.error?.message||'')+result.stdout+result.stderr);return result.stdout+result.stderr;};
 const library=path.join(temporary,'probe.dylib');
 run('clang++',['-arch','arm64','-mmacosx-version-min=13.0','-O1','-std=c++20','-fobjc-arc','-dynamiclib','-I'+native,'-I'+path.resolve(provider,'source/include'),'-I'+path.join(jdk,'include'),'-I'+path.join(jdk,'include/darwin'),path.join(fixture,'angle-vulkan-probe.mm'),path.join(native,'pixel-copy.mm'),path.join(native,'overlay.mm'),path.resolve(runtime,'native/libklepton-graphics.dylib'),'-Wl,-rpath,'+path.resolve(runtime,'native'),...['Foundation','Metal','QuartzCore','IOSurface','AppKit'].flatMap(name=>['-framework',name]),'-o',library]);
 run(path.join(jdk,'bin/javac'),['-d',temporary,path.join(fixture,'AngleVulkanProbe.java')]);
 const evidence=run(path.join(jdk,'bin/java'),['-XstartOnFirstThread','-Xcheck:jni','-Djava.awt.headless=true','-cp',temporary,'AngleVulkanProbe',library]);
 for(const line of evidence.split('\n').filter(line=>/Default Metal|Real ANGLE|Real GLES3.2|ANGLE native pixels/.test(line)))t.diagnostic(line);
 assert.match(evidence,/PASS ANGLE Vulkan: GLES compute and native-layer GPU presentation/);
});
