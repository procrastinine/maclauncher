const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('./helpers/android-java');

test('Original manifest SettingsProvider retains mutations, aliases and profile persistence',async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home||!['platform/packages.json','art/config/platform-packages.json'].some(file=>fs.existsSync(path.join(runtime,file))))return t.skip('Requires Java 21 and a supplied platform-provider catalog');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-original-settings-'));
 t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const env={...process.env};
 for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
 const namespace=await require('../src/modules/android/process-channel').processNamespace(temporary,1);
 Object.assign(env,namespace.environment);
 const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter);
 function run(command,args){
  const result=spawnSync(command,args,{env,encoding:'utf8',timeout:60000,maxBuffer:2<<20});
  assert.equal(result.error,undefined,[result.error?.message,result.stdout,result.stderr].filter(Boolean).join('\n'));
  assert.equal(result.signal,null,result.stdout+result.stderr);
  assert.equal(result.status,0,result.stdout+result.stderr);
  return result.stdout;
 }
 run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,
  path.resolve('src/modules/android/native/java/maclauncher/android/framework/HostPlatformPackages.java'),
  path.resolve('src/modules/android/native/java/maclauncher/android/framework/HostActivityService.java'),
  path.resolve('src/modules/android/native/java/maclauncher/android/framework/HostServices.java'),
  path.resolve('src/modules/android/native/java/maclauncher/android/framework/HostSystemServices.java'),
  path.join(__dirname,'fixtures/android-platform-settings/PlatformProviderDemandProbe.java'),
  path.join(__dirname,'fixtures/android-platform-settings/OriginalSettingsProviderProbe.java')]);
 const args=['-Djava.awt.headless=true','-XX:-UsePerfData','-cp',temporary+path.delimiter+cp,'maclauncher.android.OriginalSettingsProviderProbe',path.resolve(runtime),path.join(temporary,'data'),String(os.userInfo().uid)];
 for(const suffix of [[],['read']]){
  const output=run(path.join(home,'bin/java'),[...args,...suffix]);
  assert.match(output,/PASS concurrent platform provider demand/);
  assert.match(output,/PASS original settings provider CRUD, aliases, generations and persistence/);
 }
});
