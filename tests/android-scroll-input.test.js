const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('./helpers/android-java');
test('wheel input retains original scroll handling and translates unhandled streams into bounded touch gestures',async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires actual Android native runtime and JDK21');
 const source=path.resolve('src/modules/android/native'),fixture=path.resolve('tests/fixtures/android-framework-services'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'android-scroll-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const asm=JSON.parse(fs.readFileSync(path.join(source,'asm-binary.json'))).files.map(f=>path.join(source,'tools',f.path));
 const framework=path.resolve(runtime,'android-framework.jar'),host=path.resolve(runtime,'android-host.jar'),cp=[temp,...asm,host,framework].join(path.delimiter),env={...process.env};
 for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
 const identities=path.join(temp,'ids');fs.mkdirSync(identities,{mode:0o700});env.KL_ANDROID_ID_DIRECTORY=fs.realpathSync(identities);
 function run(name,args){const result=spawnSync(path.join(home,'bin',name),args,{encoding:'utf8',env,timeout:30000,maxBuffer:4<<20});assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;}
 const integrated=process.env.ANDROID_SCROLL_INTEGRATED==='1';
 const adapters=integrated?[]:[...['UiPortability','UiHooks','UiHookClassFiles'].map(name=>path.join(source,'framework',name+'.java')),...['HostInput','HostScrollInput','HostWindowManager','HostWindowService'].map(n=>path.join(source,'java/maclauncher/android/framework',n+'.java')),path.join(fixture,'ScrollInputTransform.java')];
 run('javac',['--release','21','-cp',cp,'-d',temp,...adapters,...['ScrollInputProbe','HostWindowProbe','PackageManifest','SyntheticResources'].map(n=>path.join(fixture,n+'.java')),...['LayoutInflationProbe','ResourceFixtureData'].map(n=>path.join(fixture,'../android-native',n+'.java'))]);
 if(!integrated)run('java',['-cp',cp,'ScrollInputTransform',framework,temp]);
 const result=await require('./helpers/android-platform-window').platformWindow({runtime,home,root:fs.realpathSync(temp),classpath:cp,args:['-Xverify:all','-Dandroid.fixture.input=maclauncher.android.ScrollInputProbe'],env});
 assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/PASS original ViewRoot scroll handling, coalesced two-axis touch fallback/);
});
