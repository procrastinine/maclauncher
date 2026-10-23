const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('./helpers/android-java');

test('original Android alarm clients retain main-queue delivery',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
  if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires macOS, JAVA_HOME and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-power-alarm-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const fixtures=path.join(__dirname,'fixtures/android-framework-services'),cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter);
  const env={...process.env};for(const name of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(name)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(name))delete env[name];
  const identities=path.join(temporary,'ids');fs.mkdirSync(identities,{mode:0o700});env.KL_ANDROID_ID_DIRECTORY=fs.realpathSync(identities);
  function run(executable,args){const result=spawnSync(executable,args,{env,encoding:'utf8',timeout:30000,maxBuffer:2<<20});assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);assert.doesNotMatch(result.stdout+result.stderr,/FATAL ERROR in native method/);return result.stdout;}
  // Compile the changed service and lifecycle owners for this focused test; the
  // delivered framework remains complete and is rebuilt as a whole supplier.
  const owned=path.resolve(__dirname,'../src/modules/android/native/java/maclauncher/android/framework');
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,...['HostPowerService.java','HostBatteryService.java','HostActivity.java','HostWindowManager.java'].map(file=>path.join(owned,file)),path.join(fixtures,'PowerAlarmProbe.java'),path.join(fixtures,'SyntheticResources.java'),path.join(fixtures,'../android-window-session/RuntimeFixture.java')]);
  const stdout=run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'maclauncher.android.PowerAlarmProbe',path.resolve(runtime),temporary]);
  assert.match(stdout,/PASS original battery and thermal clients use virtual state/);
  assert.match(stdout,/PASS original mainline bootstrap, alarm delivery and retirement/);
});
