const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn,execFileSync}=require('node:child_process'),{once}=require('node:events');
const Catalog=require('../src/modules/android/service-packages'),Storage=require('../src/modules/android/storage');
const {acquire}=require('../src/modules/android/platform-services/client'),{paths}=require('../src/modules/android/platform-services/paths');
const {send}=require('../src/modules/android/process-channel'),{prepareSandbox}=require('../src/modules/android/sandbox');
const {frameworkJvmOptions}=require('../src/modules/android/jvm-options');

test('framework-only shared owner grants and restores original URI access without Google services',{timeout:120000},async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires native runtime with original statistics and URI services');
 const runtimeRoot=fs.realpathSync(runtime),root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-profile-uri-'))),children=new Set();let lease;
 const moduleRoot=path.join(root,'module'),classes=path.join(root,'classes');fs.mkdirSync(moduleRoot);fs.mkdirSync(classes);
 const production=path.resolve('src/modules/android'),storage=await paths(root,'accounts');
 t.after(async()=>{lease?.close();for(const child of children)if(child.exitCode==null&&child.signalCode==null)child.kill('SIGKILL');await new Promise(r=>setTimeout(r,3500));for(const role of ['accounts','system','keystore']){const state=await paths(root,role);fs.rmSync(state.runRoot,{recursive:true,force:true});}fs.rmSync(root,{recursive:true,force:true});});
 const pins=JSON.parse(fs.readFileSync(path.join(runtimeRoot,'source/native/source-pins.json'))),profile=require('../src/modules/android/profile').runtimeProfile({...pins,frameworkServicesVersion:1});
 const payload={root:runtimeRoot,version:'fixture',profile,converterClasspath:['converter-overlay.jar','dex2jvm.jar','apksig.jar'].map(f=>path.join(runtimeRoot,f)),metadataClasspath:[path.join(runtimeRoot,'android-api-metadata.jar')]};
 // The ordinary broker and account JVM are unchanged. Only build metadata is
 // supplied explicitly so this test need not select a development runtime.
 fs.writeFileSync(path.join(moduleRoot,'account-owner.js'),'exports.startProfileService=(c,s,f)=>require('+JSON.stringify(path.join(production,'account-owner'))+').startProfileService(c,s,f,{payload:'+JSON.stringify(payload)+'});');
 for(const name of ['sandbox','jvm-options'])fs.writeFileSync(path.join(moduleRoot,name+'.js'),'module.exports=require('+JSON.stringify(path.join(production,name))+');');
 const cp=[classes,path.join(runtimeRoot,'android-host.jar'),path.join(runtimeRoot,'android-framework.jar'),path.join(runtimeRoot,'apksig.jar')].join(path.delimiter);
 function run(tool,args){return execFileSync(path.join(home,'bin',tool),args,{encoding:'utf8',timeout:30000,maxBuffer:2<<20});}
 run('javac',['--release','21','-cp',cp,'-d',classes,'tests/fixtures/android-framework-services/SignApkSet.java','tests/fixtures/android-platform-service/ProfileUriGrantsProbe.java']);
 const key=path.join(root,'signer.p12');run('keytool',['-genkeypair','-alias','owned','-keyalg','RSA','-keysize','2048','-dname','CN=Profile URI Fixture','-validity','2','-storetype','PKCS12','-keystore',key,'-storepass','test-only-password','-keypass','test-only-password','-noprompt']);
 const prepared=[];
 for(const [gameId,name,manifest,letter]of[['provider','fixture.grants','uri-grants','a'],['client','fixture.client','remote-provider-client','b']]){
  const dirs=Storage.storagePaths(root,gameId),key=letter.repeat(64),directory=path.join(dirs.preparedRoot,key),nativeRoot=path.join(directory,'lib');fs.mkdirSync(nativeRoot,{recursive:true});fs.mkdirSync(dirs.filesRoot,{recursive:true});fs.mkdirSync(dirs.cacheRoot,{recursive:true});
  const staging=path.join(root,gameId);fs.mkdirSync(staging);fs.copyFileSync(path.resolve('tests/fixtures/android-framework-services/manifests',manifest+'.xml.bin'),path.join(staging,'AndroidManifest.xml'));
  const unsigned=path.join(staging,'unsigned.apk'),sourceApk=path.join(directory,'base.apk');run('jar',['--create','--file',unsigned,'-C',staging,'AndroidManifest.xml']);run('java',['-cp',cp,'SignApkSet',path.join(root,'signer.p12'),unsigned,sourceApk]);
  const value={root:directory,key,sourceApk,sourceApks:[sourceApk],nativeRoot,apkSha256:letter.repeat(64),metadata:{packageName:name,applicationProcessName:name,versionCode:1}};
  fs.writeFileSync(path.join(directory,'prepared.json'),JSON.stringify({schemaVersion:2,key,apkSha256:value.apkSha256,metadata:value.metadata,files:[]}));
  const installed=await Catalog.prepareInstalled({gameId},value,{userDataDir:root},payload,{});await installed.release();prepared.push({...value,gameId,uid:installed.uid,dirs});
 }
 const retained=await Catalog.retainApplications(root);t.after(()=>retained.release());
 const options={userDataDir:root,runtimeRoot,javaPath:path.join(home,'bin/java'),moduleRoot,role:'accounts',access:'game'};
 async function client(value,mode){
  const data=value.dirs.dataRoot,fixture=path.join(data,'fixture.jar');run('jar',['--create','--file',fixture,'-C',classes,'.']);
  const config={runtimeRoot,filesRoot:value.dirs.filesRoot,cacheRoot:value.dirs.cacheRoot},configFile=path.join(data,'launch.json');fs.writeFileSync(configFile,'{}');
  const isolated=await prepareSandbox({javaPath:options.javaPath,config,configFile,dataRoot:data,blockNetwork:true,installedPackages:retained.packages,localSockets:{connect:[lease.socketPath]}});
  const child=spawn(isolated.command,[...isolated.prefix,...isolated.javaArguments,...frameworkJvmOptions,'-cp',[fixture,path.join(runtimeRoot,'android-host.jar'),path.join(runtimeRoot,'android-framework.jar')].join(path.delimiter),'maclauncher.android.ProfileUriGrantsProbe',runtimeRoot,data,value.sourceApk,value.metadata.packageName,mode],{cwd:config.filesRoot,env:isolated.environment,stdio:['ignore','pipe','pipe','ignore','ignore','pipe']});
  children.add(child);child.once('exit',()=>children.delete(child));let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);const completion=once(child,'exit');
  await once(child,'spawn');const peer={packageName:value.metadata.packageName,processName:value.metadata.packageName,pid:child.pid,uid:value.uid,hostUid:process.getuid()};
  await lease.enroll(peer,{packages:retained.packages,account:null,networkAllowed:false});
  await send(child.stdio[5],{schemaVersion:2,self:peer,accounts:{identity:lease.identity,socketPath:lease.socketPath}});
  const [code,signal]=await completion;assert.equal(code,0,signal+'\n'+out+'\n'+err);assert.match(out,/PASS shared original URI service/);await lease.retire(peer);
 }
 lease=await acquire(options);const first=lease.identity.pid;await client(prepared[0],'grant');await client(prepared[1],'read');lease.close();lease=null;
 const deadline=Date.now()+10000;while(fs.existsSync(storage.metadata)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));assert.equal(fs.existsSync(storage.metadata),false,'original owner must retire before reopening persistence');
 lease=await acquire(options);assert.notEqual(lease.identity.pid,first);assert.equal(lease.identity.frameworkServicesVersion,1);await client(prepared[1],'restore');
 const manager=await acquire({...options,access:'manage'});
 try{await manager.request('removePackages',{packages:['fixture.grants']});}finally{manager.close();}
 await client(prepared[1],'denied');
});
