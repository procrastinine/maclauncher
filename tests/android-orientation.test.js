const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('./helpers/android-java');
test('Activity orientation follows the current native output owner across queued task handoffs',async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires actual Android native runtime and JDK21');
 const source=path.resolve('src/modules/android/native'),fixture=path.resolve('tests/fixtures/android-framework-services'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'android-orientation-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const cp=[temp,...['android-host.jar','android-framework.jar'].map(n=>path.resolve(runtime,n))].join(path.delimiter),env={...process.env};
 for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
 function run(exe,args){const r=spawnSync(exe,args,{encoding:'utf8',env,timeout:30000,maxBuffer:4<<20});assert.equal(r.error,undefined,r.error?.message);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;}
 const adapters=process.env.ANDROID_ORIENTATION_INTEGRATED==='1'?[]:['HostActivity','HostWindowManager','HostWindowService'].map(n=>path.join(source,'java/maclauncher/android/framework',n+'.java'));
 run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temp,...adapters,...['OrientationProbe','HostWindowProbe','PackageManifest','SyntheticResources'].map(n=>path.join(fixture,n+'.java')),...['LayoutInflationProbe','ResourceFixtureData'].map(n=>path.join(fixture,'../android-native',n+'.java'))]);
 const native=path.join(temp,'orientation.dylib');run('clang',['-std=c11','-Wall','-Wextra','-Werror','-dynamiclib','-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),path.join(fixture,'orientation-output.c'),'-o',native]);
 const window=async(name,args)=>{const root=path.join(temp,name);fs.mkdirSync(root);const result=await require('./helpers/android-platform-window').platformWindow({runtime,home,root:fs.realpathSync(root),classpath:cp,args:['-Xverify:all',...args,'-Dandroid.fixture.input=maclauncher.android.OrientationProbe'],env});assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 assert.match(await window('native',['-Dorientation.probe='+native]),/PASS original Activity orientation ownership, coalescing, return and retirement/);
 assert.match(await window('callback',['-Dandroid.fixture.orientation.callback=true']),/PASS shared physical orientation output without a JVM window session/);
});
