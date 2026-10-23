const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');

test('original native and Java fences preserve their descriptor and reference ownership',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME,recipeFile=process.env.ANDROID_SYNC_FENCE_BUILD;
 if(process.platform!=='darwin'||!runtime||!home||!recipeFile)return t.skip('Requires original Fence build, Android runtime and Java21');
 const recipe=JSON.parse(fs.readFileSync(recipeFile,'utf8'));
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-sync-fence-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
 const native=path.resolve(runtime,'native'),exe=path.join(output,'native-check');
 const identities=path.join(output,'ids');fs.mkdirSync(identities,{mode:0o700});
 const run=(command,args)=>execFileSync(command,args,{encoding:'utf8',timeout:20000,env:{...process.env,TMPDIR:output,KL_ANDROID_ID_DIRECTORY:fs.realpathSync(identities)}});
 run('clang++',['-std=c++23',...recipe.flags,'tests/fixtures/android-native/SyncFenceProbe.cpp',recipe.library,path.join(native,'libandroid-binder-rpc.dylib'),path.join(native,'libklepton-jvm.dylib'),'-Wl,-rpath,'+native,'-o',exe]);
 assert.match(run(exe,[]),/PASS original Fence: real wait, flatten\/unflatten, merge, descriptor duplication and last-reference closure/);
 const cp=[output,path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar')].join(path.delimiter);
 run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',output,'tests/fixtures/android-framework-services/SyncFenceProbe.java','tests/fixtures/android-window-session/RuntimeFixture.java']);
 assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',cp,'maclauncher.android.fixture.SyncFenceProbe',path.resolve(runtime),output,recipe.library]),/PASS original SyncFence: all JNI entries/);
});
