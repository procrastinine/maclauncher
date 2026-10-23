const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('./helpers/android-java');

test('Original MediaPlayer services retain FD ranges and own reset and release events',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(process.platform!=='darwin'||!runtime)return t.skip('Requires macOS and KLEPTON_NATIVE_RUNTIME');
  const home=process.env.JAVA_HOME||spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout.trim();
  if(!home||!fs.existsSync(path.join(home,'bin/javac')))return t.skip('Requires Java 21 development tools');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-media-preparation-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const fixtures=path.join(__dirname,'fixtures/android-native');
  const classpath=[temporary,path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar')].join(path.delimiter);
  const run=(command,args)=>{
    const result=spawnSync(command,args,{encoding:'utf8',timeout:45000});
    assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stdout+result.stderr);
    assert.doesNotMatch(result.stdout+result.stderr,/FATAL ERROR in native method/);return result.stdout;
  };
  run(path.join(home,'bin/javac'),['--release','21','-cp',classpath,'-d',temporary,
    path.join(fixtures,'MediaPreparationProbe.java'),
    path.join(fixtures,'../android-window-session/RuntimeFixture.java'),
    path.join(fixtures,'../android-platform-service/MediaServicesFixture.java')]);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',classpath,'maclauncher.android.media.MediaPreparationProbe',
    path.resolve(runtime),temporary]),/PASS original MediaPlayer services, retained FD ranges/);
});
