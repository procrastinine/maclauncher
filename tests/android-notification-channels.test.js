const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');

test('Notification channel settings from the earlier store layout remain the application settings',{timeout:30000},t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires built Android runtime and Java21');
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-notification-channels-')));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const source=path.resolve(__dirname,'../src/modules/android/native/java/maclauncher/android/framework');
 const cp=[temp,...['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name))].join(path.delimiter);
 const run=(tool,args)=>{const result=spawnSync(tool,args,{encoding:'utf8',timeout:20000,maxBuffer:2<<20});assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 run(home+'/bin/javac',['--release','21','-cp',cp,'-d',temp,source+'/HostNotificationChannels.java',
  path.join(__dirname,'fixtures/android-platform-service/NotificationMigrationProbe.java'),path.join(__dirname,'fixtures/android-window-session/RuntimeFixture.java')]);
 assert.match(run(home+'/bin/java',['-Xverify:all','-cp',cp,'maclauncher.android.framework.NotificationMigrationProbe',path.resolve(runtime),temp]),
  /PASS retained notification settings and read-only migration validation/);
});
