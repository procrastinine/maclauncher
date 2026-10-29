const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('./helpers/android-java');
test('both VM entries preserve original Application factory behavior through the shared owner',{timeout:120000},async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires built Android runtime and Java21');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-application-factory-')));let service,child,storage,lock;
 t.after(async()=>{if(child&&child.exitCode==null&&child.signalCode==null)child.kill('SIGKILL');await service?.close();await lock?.close();if(service)await new Promise(resolve=>setTimeout(resolve,3000));if(storage)fs.rmSync(storage.runRoot,{recursive:true,force:true});fs.rmSync(root,{recursive:true,force:true});});
 const output=path.join(root,'classes');fs.mkdirSync(output);const native=path.resolve(process.env.ANDROID_NATIVE_SOURCE||'src/modules/android/native'),source=path.join(native,'java/maclauncher/android/');
 const ids=path.join(root,'ids');fs.mkdirSync(ids,{mode:0o700});
 const cp=[output,path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar'),path.resolve(runtime,'apksig.jar')].join(path.delimiter);
 const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:20000,env:{...process.env,KL_ANDROID_ID_DIRECTORY:ids}});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',output,...['LocalProviders','framework/HostContext','framework/HostApplication','framework/HostLocalServices','framework/HostJobScheduler','framework/HostSystemFonts','framework/HostActivity','framework/HostContextServices','framework/HostFilesystem','Host'].map(name=>source+name+'.java'),path.join(native,'java-jvm/maclauncher/android/framework/JvmNativeMemory.java'),...['ArtActivity','ArtPlatform','ArtWebKit','ArtFilesystem','ArtLibraryCompatibility'].map(name=>'src/modules/android/art/java/maclauncher/android/'+name+'.java'),'tests/fixtures/android-framework-services/PackageManifest.java','tests/fixtures/android-framework-services/ApplicationFactoryProbe.java','tests/fixtures/android-framework-services/SignApkSet.java']);
 fs.copyFileSync('src/modules/android/native/resources/storage-namespace.json',path.join(output,'maclauncher/android/framework/storage-namespace.json'));
 const prepared=path.join(root,'android/apps/factory/prepared');fs.mkdirSync(prepared,{recursive:true});
 fs.copyFileSync('tests/fixtures/android-framework-services/manifests/application-factory.xml.bin',path.join(prepared,'AndroidManifest.xml'));
 const apk=path.join(prepared,'base.apk'),key=path.join(root,'signer.p12');
 run(path.join(home,'bin/jar'),['--create','--file',apk+'.unsigned','-C',prepared,'AndroidManifest.xml']);
 run(path.join(home,'bin/keytool'),['-genkeypair','-alias','owned','-keyalg','RSA','-keysize','2048','-dname','CN=Factory Fixture','-validity','2','-storetype','PKCS12','-keystore',key,'-storepass','test-only-password','-keypass','test-only-password','-noprompt']);
 const signer=cp+path.delimiter+path.resolve(runtime,'apksig.jar');run(path.join(home,'bin/java'),['-cp',signer,'SignApkSet',key,apk+'.unsigned',apk]);
 const {paths}=require('../src/modules/android/platform-services/paths'),{startProfileService}=require('../src/modules/android/platform-services/jvm');
 const {prepareSandbox}=require('../src/modules/android/sandbox'),{send,processIdentity}=require('../src/modules/android/process-channel');
 const {spawn}=require('node:child_process'),{once}=require('node:events');
 storage=await paths(root,'system');lock=await fs.promises.open(storage.lock,'w',0o600);
 service=await startProfileService({userDataDir:root,runtimeRoot:path.resolve(runtime),runtimeIdentity:require('./helpers/android-java').runtimeIdentity(path.resolve(runtime)),javaPath:path.join(home,'bin/java'),moduleRoot:path.resolve('src/modules/android'),role:'system'},storage,lock.fd);await service.ready;
 const profile=JSON.parse(fs.readFileSync(path.resolve(runtime,'runtime.json'))).profile;
 for(const mode of ['declared','default','loader','context','partial']){
  const data=path.join(root,'android/apps/factory-'+mode+'/data');fs.mkdirSync(data,{recursive:true});
  const files=path.join(data,'files'),cache=path.join(data,'cache');fs.mkdirSync(files);fs.mkdirSync(cache);
  const fixture=path.join(data,'fixture.jar');run(path.join(home,'bin/jar'),['--create','--file',fixture,'-C',output,'.']);
  const config={runtimeRoot:path.resolve(runtime),filesRoot:files,cacheRoot:cache,sourceApk:apk},configFile=path.join(data,'launch.json');fs.writeFileSync(configFile,'{}');
  const isolated=await prepareSandbox({javaPath:path.join(home,'bin/java'),config,configFile,dataRoot:data,userDataDir:root,processIdentityVersion:profile.processIdentityVersion,blockNetwork:true,localSockets:{connect:[service.socketPath]}});
  child=spawn(isolated.command,[...isolated.prefix,...isolated.javaArguments,...require('../src/modules/android/jvm-options').frameworkJvmOptions,'-cp',[fixture,path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar')].join(path.delimiter),'maclauncher.android.framework.ApplicationFactoryProbe',path.resolve(runtime),data,mode,apk],{cwd:files,env:isolated.environment,stdio:['ignore','pipe','pipe','ignore','ignore','pipe']});
  let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);const ended=once(child,'exit'),timer=setTimeout(()=>child.kill('SIGKILL'),30000);
  try{
   await once(child,'spawn');const identity=await processIdentity(child,{version:profile.processIdentityVersion}),peer={packageName:'org.example.permissions',processName:'org.example.permissions',...identity,uid:10023,hostUid:process.getuid()};
   await service.enroll(peer,{packages:[{packageName:peer.packageName,uid:peer.uid,sourceApks:[apk],dataRoot:data,nativeRoot:path.resolve(runtime,'native'),firstInstallTime:1,lastUpdateTime:1,...(identity.androidId?{androidId:identity.androidId}:{})}]});
   await send(child.stdio[5],{schemaVersion:2,self:peer,system:{identity:service.identity,socketPath:service.socketPath}});
   const [code,signal]=await ended;assert.equal(code,0,signal+'\n'+stdout+'\n'+stderr);assert.match(stdout,new RegExp('PASS original application factory '+mode));await service.retire(peer);
  }finally{clearTimeout(timer);if(child.exitCode==null&&child.signalCode==null){child.kill('SIGKILL');await ended;}}
 }
});
