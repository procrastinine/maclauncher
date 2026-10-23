const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');

test('Original shared-memory cache invalidation and read-only descriptor ownership',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(process.platform!=='darwin'||!runtime)return t.skip('Requires macOS and KLEPTON_NATIVE_RUNTIME');
  const home=process.env.JAVA_HOME||spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout.trim();
  if(!home||!fs.existsSync(path.join(home,'bin/javac')))return t.skip('Requires Java 21 development tools');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-application-memory-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const fixtures=path.join(__dirname,'fixtures');
  const classpath=[temporary,path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar')].join(path.delimiter);
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:20000});assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  run(path.join(home,'bin/javac'),['--release','21','-cp',classpath,'-d',temporary,
    path.join(fixtures,'android-native/ApplicationSharedMemoryProbe.java'),path.join(fixtures,'android-native/ResourceFixtureData.java'),
    path.join(fixtures,'android-window-session/RuntimeFixture.java'),path.join(fixtures,'android-window-session/FixtureApk.java')]);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',classpath,'maclauncher.android.fixture.ApplicationSharedMemoryProbe',path.resolve(runtime),temporary]),
    /PASS original cache invalidation, shared mappings, read-only descriptors and process lifetime/);
});
