const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('./helpers/android-java');
test('shared Android windows preserve resource touch mode and original keyboard/pointer focus transitions',async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires actual Android native runtime and JDK21');
 const source=path.resolve('src/modules/android/native'),fixture=path.resolve('tests/fixtures/android-framework-services'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'android-touch-mode-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const framework=path.resolve(runtime,'android-framework.jar'),host=path.resolve(runtime,'android-host.jar'),cp=[temp,host,framework].join(path.delimiter),env={...process.env};
 for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
 const identities=path.join(temp,'ids');fs.mkdirSync(identities,{mode:0o700});env.KL_ANDROID_ID_DIRECTORY=fs.realpathSync(identities);
 const adapters=process.env.ANDROID_TOUCH_MODE_INTEGRATED==='1'?[]:[path.join(source,'java/maclauncher/android/framework/HostWindowService.java')];
 const sources=[...adapters,...['TouchModeProbe','HostWindowProbe','PackageManifest','SyntheticResources'].map(n=>path.join(fixture,n+'.java')),...['LayoutInflationProbe','ResourceFixtureData'].map(n=>path.join(fixture,'../android-native',n+'.java'))];
 const compiled=spawnSync(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temp,...sources],{encoding:'utf8',env,timeout:30000,maxBuffer:4<<20});
 assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
 const result=await require('./helpers/android-platform-window').platformWindow({runtime,home,root:fs.realpathSync(temp),classpath:cp,args:['-Xverify:all','-Dandroid.fixture.input=maclauncher.android.TouchModeProbe'],env});
 assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/PASS original resource touch mode, keyboard focus highlight and pointer transition/);
});
