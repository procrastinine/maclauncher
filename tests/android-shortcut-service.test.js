const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('./helpers/android-java');
test('Original ShortcutService keeps its package policy, quota, icon and durable state',{timeout:60000},t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires the built Android runtime and JDK21');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'android-shortcuts-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const source=path.resolve('src/modules/android/native'),fixture=path.resolve('tests/fixtures/android-framework-services');
 const cp=[dir,path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar'),path.resolve(runtime,'apksig.jar'),source+'/tools/*'].join(path.delimiter);
 const run=(name,args)=>{const r=spawnSync(home+'/bin/'+name,args,{encoding:'utf8',timeout:30000,maxBuffer:4<<20});assert.equal(r.error,undefined,[r.error?.message,r.stdout,r.stderr].filter(Boolean).join('\n'));assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 run('javac',['--release','21','-cp',cp,'-d',dir,fixture+'/SignApkSet.java']);
 const key=dir+'/signer.p12';run('keytool',['-genkeypair','-alias','owned','-keyalg','RSA','-keysize','2048','-dname','CN=Shortcut Fixture','-validity','2','-storetype','PKCS12','-keystore',key,'-storepass','test-only-password','-keypass','test-only-password','-noprompt']);
 run('java',['-cp',cp,'SignApkSet',key,path.resolve('tests/fixtures/android-package-metadata/metadata.apk'),dir+'/app.apk']);
 run('javac',['--release','21','-cp',cp,'-d',dir,source+'/framework/ServicePortability.java',source+'/framework/PendingIntentCalls.java',
  ...['HostShortcuts','HostUserService','HostPackages','HostRemoteServices','HostFilesystem','HostActivityManager','HostProcessServices','HostProcessInfo','HostServices','HostServiceDirectory'].map(name=>source+'/java/maclauncher/android/framework/'+name+'.java'),
  source+'/java/com/android/server/am/HostUidObservers.java',
  source+'/java/maclauncher/android/bridge/Graphics.java',
  source+'/java/com/android/server/pm/HostShortcutService.java',source+'/java/com/android/server/usage/HostUsageEvents.java',
  fixture+'/ShortcutBindings.java',fixture+'/OriginalShortcutsProbe.java',fixture+'/../android-window-session/RuntimeFixture.java']);
 run('java',['-cp',cp,'ShortcutBindings',path.resolve(runtime,'android-framework.jar'),dir]);
 for(const mode of ['', 'restore'])assert.match(run('java',['-Xverify:all','-cp',cp,'OriginalShortcutsProbe',path.resolve(runtime),dir,...mode?[mode]:[]]),/PASS original ShortcutManager\/RPC/);
});
