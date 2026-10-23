const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');

test('original alarm JNI shares timer delivery and descriptor lifetime',{skip:!process.env.KLEPTON_NATIVE_RUNTIME||!process.env.ANDROID_ALARM_LIBRARY},t=>{
  const runtime=path.resolve(process.env.KLEPTON_NATIVE_RUNTIME),source=path.resolve(process.env.ANDROID_ALARM_LIBRARY);
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'android-alarm-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const library=path.join(temp,'libalarm_jni.dylib');fs.copyFileSync(source,library);
  for(const file of fs.readdirSync(path.join(runtime,'native')))if(file.endsWith('.dylib'))fs.symlinkSync(path.join(runtime,'native',file),path.join(temp,file));
  const cp=[temp,path.join(runtime,'android-host.jar'),path.join(runtime,'android-framework.jar')].join(path.delimiter);
  const run=(name,args)=>execFileSync(path.join(process.env.JAVA_HOME,'bin',name),args,{encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
  run('javac',['--release','21','-cp',cp,'-d',temp,'tests/fixtures/android-window-session/RuntimeFixture.java','tests/fixtures/android-platform/AlarmNativeProbe.java']);
  assert.match(run('java',['-Xverify:all','-cp',cp,'maclauncher.android.fixture.AlarmNativeProbe',runtime,path.join(temp,'data'),library]),/PASS original alarm JNI clocks, masks, errno and descriptor lifetime/);
});
