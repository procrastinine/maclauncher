const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('Original permission clients retain a denied request instead of repeating an undecided result',async t=>{
 let runtime=process.env.KLEPTON_NATIVE_RUNTIME;const home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires built Android runtime and Java21');
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-permissions-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const identity=await require('../src/modules/android/process-channel').processNamespace(dir,1);
 let lastStderr='';const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8',timeout:10000,env:{...process.env,...identity.environment,TMPDIR:dir}});assert.equal(r.error,undefined,[r.error?.message,r.stdout,r.stderr].filter(Boolean).join('\n'));assert.equal(r.status,0,r.stdout+r.stderr);lastStderr=r.stderr;return r.stdout;};
 const cp=['android-host.jar','android-framework.jar'].map(file=>path.resolve(runtime,file)).join(path.delimiter);
 run(home+'/bin/javac',['--release','21','-cp',cp,'-d',dir,
  path.resolve('src/modules/android/native/java/maclauncher/android/framework/HostPermissions.java'),
  path.resolve('src/modules/android/native/java/maclauncher/android/framework/HostPermissionController.java'),
  ...['HostAudioPermissions','HostAudioPolicy','HostPackages','HostUserService'].map(name=>path.resolve('src/modules/android/native/java/maclauncher/android/framework/'+name+'.java')),
  path.resolve('src/modules/android/native/java/maclauncher/android/media/HostAudioService.java'),
  path.resolve('tests/fixtures/android-framework-services/PackageManifest.java'),path.resolve('tests/fixtures/android-native/PermissionDecisionProbe.java')]);
 assert.match(run(home+'/bin/java',['-Xverify:all','-cp',dir+path.delimiter+cp,'maclauncher.android.framework.PermissionDecisionProbe',path.resolve(runtime),dir]),/PASS original permission clients/);
 const repeated=lastStderr.split('PLATFORM_PERMISSION_REPEAT_BEGIN')[1]?.split('PLATFORM_PERMISSION_REPEAT_END')[0];
 assert.notEqual(repeated,undefined,'Repeated original client checks ran');
 assert.doesNotMatch(repeated,/SystemConfig is being accessed/,'The retained platform owner avoids repeated caller diagnostics');
});
