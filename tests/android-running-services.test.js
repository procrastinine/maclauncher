const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');

test('Original ActivityManager queries existing service lifecycle state and retires it',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
  if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires Java 21 and the Android runtime');
  const output=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'android-running-services-'));
  t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  const cp=[output,...['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name))].join(path.delimiter);
  const fixtures=path.resolve('tests/fixtures'),source=path.resolve('src/modules/android/native/java/maclauncher/android/framework');
  const env={...process.env};for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  const identities=path.join(output,'ids');fs.mkdirSync(identities,{mode:0o700});env.KL_ANDROID_ID_DIRECTORY=identities;
  execFileSync(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',output,
    ...['HostContext','HostApplication','HostLocalServices','HostActivityService','HostRemoteServices','HostJobScheduler'].map(name=>path.join(source,name+'.java')),
    path.join(fixtures,'android-window-session/RuntimeFixture.java'),path.join(fixtures,'android-framework-services/PackageManifest.java'),
    path.join(fixtures,'android-running-services/RunningServicesProbe.java'),path.join(fixtures,'android-running-services/Service.java')],{env,stdio:'pipe'});
  const result=execFileSync(path.join(home,'bin/java'),[...require('../src/modules/android/jvm-options').frameworkJvmOptions,'-Xverify:all','-cp',cp,
    'RunningServicesProbe',path.resolve(runtime),output],{env,encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});
  assert.match(result,/PASS original ActivityManager running-service start, bind, identity, parcel and retirement/);
});
