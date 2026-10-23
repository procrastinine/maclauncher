const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('Original ringer clients control the shared application audio owner',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires built Android runtime and Java21');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'android-ringer-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const fixture=path.resolve('tests/fixtures/android-native');
 const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8',timeout:30000});assert.equal(r.error,undefined,r.error?.message);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 const cp=['android-host.jar','android-framework.jar'].map(file=>path.resolve(runtime,file)).join(path.delimiter);
 run(home+'/bin/javac',['--release','21','-cp',cp,'-d',dir,
  path.resolve('tests/fixtures/android-platform-service/MediaServicesFixture.java'),path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java'),fixture+'/RingerModeProbe.java']);
 assert.match(run(home+'/bin/java',['-Xverify:all','-cp',dir+path.delimiter+cp,'maclauncher.android.RingerModeProbe',path.resolve(runtime),dir]),/PASS original ringer APIs/);
});
