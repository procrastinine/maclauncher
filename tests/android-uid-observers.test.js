const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('original UID observer controller follows the hosted Activity lifecycle',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
  if(!runtime||!home)return t.skip('Requires the Android runtime and Java21');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-uid-observers-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const cp=[directory,...['android-host.jar','android-framework.jar'].map(file=>path.resolve(runtime,file))].join(path.delimiter);
  const run=(name,args)=>{const result=spawnSync(path.join(home,'bin',name),args,{encoding:'utf8',timeout:30000,maxBuffer:8<<20});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  run('javac',['--release','21','-cp',cp,'-d',directory,
    'src/modules/android/native/java/maclauncher/android/ProcessAuthority.java',
    'src/modules/android/native/java/maclauncher/android/framework/HostProcessServices.java',
    'src/modules/android/native/java/com/android/server/am/HostUidObservers.java',
    ...['HostActivityManager','HostActivityService'].map(name=>'src/modules/android/native/java/maclauncher/android/framework/'+name+'.java'),
    'tests/fixtures/android-window-session/RuntimeFixture.java','tests/fixtures/android-framework-services/UidObserversProbe.java']);
  assert.match(run('java',['-Xverify:all','-cp',cp,'UidObserversProbe',path.resolve(runtime),path.join(directory,'data')]),/PASS original UID observer filtering, lifecycle, cutpoint and callback retirement/);
});
