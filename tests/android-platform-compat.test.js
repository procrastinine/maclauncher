const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');

test('Original platform compatibility precedes package policy and preserves SDK defaults and permissions',async t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(process.platform!=='darwin'||!runtime)return t.skip('Requires macOS and KLEPTON_NATIVE_RUNTIME');
  const home=process.env.JAVA_HOME||spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout.trim();
  if(!home||!fs.existsSync(path.join(home,'bin/javac')))return t.skip('Requires Java 21 development tools');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-platform-compat-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const source=path.resolve(__dirname,'../src/modules/android/native/java'),fixtures=path.join(__dirname,'fixtures');
  const classpath=[temporary,path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar')].join(path.delimiter);
  const identity=await require('../src/modules/android/process-channel').processNamespace(temporary,1);
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',env:{...process.env,...identity.environment},timeout:20000});assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stdout+result.stderr);assert.doesNotMatch(result.stderr,/Failed to get a response from PLATFORM_COMPAT_SERVICE|Service could not be found: platform_compat/);return result.stdout;};
  run(path.join(home,'bin/javac'),['--release','21','-cp',classpath,'-d',temporary,
    path.join(source,'com/android/server/compat/HostPlatformCompat.java'),path.join(source,'maclauncher/android/framework/HostSharedLibraries.java'),path.join(source,'maclauncher/android/framework/HostContextServices.java'),path.join(source,'maclauncher/android/framework/HostWindowManager.java'),
    path.join(source,'maclauncher/android/framework/HostApplication.java'),
    path.join(fixtures,'android-native/PlatformCompatProbe.java'),path.join(fixtures,'android-package-metadata/EarlyPackageCompatProbe.java'),path.join(fixtures,'android-native/ResourceFixtureData.java'),
    path.join(fixtures,'android-window-session/RuntimeFixture.java'),path.join(fixtures,'android-window-session/FixtureApk.java')]);
  for(const sdk of [29,36])assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',classpath,'com.android.server.compat.PlatformCompatProbe',path.resolve(runtime),temporary,String(sdk)]),
    /PASS original PlatformCompat generated metadata, target SDK defaults and override permissions/);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',classpath,'com.android.server.compat.PlatformCompatProbe',path.resolve(runtime),temporary,'36','shared']),
    /PASS original PlatformCompat generated metadata, target SDK defaults and override permissions/);
});
