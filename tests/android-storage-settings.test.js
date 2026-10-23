const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('./helpers/android-java');
test('Android all-files settings retains actual AppOps decisions and the caller Activity lifecycle',async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires the complete Android runtime and Java21');
 const fixture=path.resolve('tests/fixtures/android-framework-services'),source=path.resolve('src/modules/android/native/java/maclauncher/android/framework');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'android-storage-settings-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true,maxRetries:3,retryDelay:50}));
 const cp=[temp,...['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name))].join(path.delimiter),env={...process.env};
 for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
 Object.assign(env,(await require('../src/modules/android/process-channel').processNamespace(temp,1)).environment);
 const run=(name,args)=>{const result=spawnSync(path.join(home,'bin',name),args,{env,encoding:'utf8',timeout:30000,maxBuffer:4<<20});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 run('javac',['--release','21','-cp',cp,'-d',temp,...['HostStorageSettings','HostPermissions','HostAppOps','HostActivityTasks','HostActivity'].map(name=>path.join(source,name+'.java')),...['StorageSettingsProbe','HostWindowProbe','PackageManifest','SyntheticResources'].map(name=>path.join(fixture,name+'.java')),...['LayoutInflationProbe','ResourceFixtureData'].map(name=>path.join(fixture,'../android-native',name+'.java'))]);
 for(const mode of ['affinity','task','return']){
  const root=path.join(temp,mode+'-caller');fs.mkdirSync(root);
  const result=await require('./helpers/android-platform-window').platformWindow({runtime,home,root:fs.realpathSync(root),classpath:cp,args:['-Xverify:all','-Dandroid.fixture.input=maclauncher.android.StorageSettingsProbe','-Dandroid.fixture.manifest=window-storage','-Dandroid.fixture.storageFinish='+(mode!=='return'),'-Dandroid.fixture.storageTaskRemove='+(mode==='task')],env});
  assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,mode!=='return'?/PASS independent original Settings task survives caller .*requires consent and retires normally/:/PASS original Environment storage toggle, persisted AppOps, main-loop result and resume recheck/);
  t.diagnostic(mode+': '+result.stdout.split('\n').find(line=>line.startsWith('PASS independent original Settings')||line.startsWith('PASS original Environment storage')));
 }
});
