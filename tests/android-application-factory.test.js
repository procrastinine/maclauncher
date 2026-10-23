const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('./helpers/android-java');
test('both VM entries preserve original Application factory behavior through the shared owner',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires built Android runtime and Java21');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-application-factory-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const output=path.join(root,'classes');fs.mkdirSync(output);const source='src/modules/android/native/java/maclauncher/android/';
 const ids=path.join(root,'ids');fs.mkdirSync(ids,{mode:0o700});
 const cp=[output,path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar')].join(path.delimiter);
 const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:20000,env:{...process.env,KL_ANDROID_ID_DIRECTORY:ids}});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',output,...['LocalProviders','framework/HostContext','framework/HostApplication','framework/HostLocalServices','framework/HostJobScheduler','framework/HostSystemFonts','framework/HostActivity','framework/HostContextServices','framework/HostFilesystem','Host'].map(name=>source+name+'.java'),'src/modules/android/native/java-jvm/maclauncher/android/framework/JvmNativeMemory.java',...['ArtActivity','ArtPlatform','ArtWebKit','ArtFilesystem','ArtLibraryCompatibility'].map(name=>'src/modules/android/art/java/maclauncher/android/'+name+'.java'),'tests/fixtures/android-framework-services/PackageManifest.java','tests/fixtures/android-framework-services/ApplicationFactoryProbe.java']);
 fs.copyFileSync('src/modules/android/native/resources/storage-namespace.json',path.join(output,'maclauncher/android/framework/storage-namespace.json'));
 for(const mode of ['declared','default','loader','context','partial']){const data=path.join(root,mode);fs.mkdirSync(data);assert.match(run(path.join(home,'bin/java'),['-cp',cp,'maclauncher.android.framework.ApplicationFactoryProbe',path.resolve(runtime),data,mode]),new RegExp('PASS original application factory '+mode));}
});
