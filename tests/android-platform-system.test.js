const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn,execFileSync}=require('node:child_process'),{once}=require('node:events');
const {acquire}=require('../src/modules/android/platform-services/client');
const {paths}=require('../src/modules/android/platform-services/paths');
const {send}=require('../src/modules/android/process-channel');
const {prepareSandbox}=require('../src/modules/android/sandbox');
const {frameworkJvmOptions}=require('../src/modules/android/jvm-options');

test('Original system service has one profile owner, persistent entries and original read permissions',{timeout:90000},async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires built Android runtime and Java21');
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'android-system-owner-'))),children=new Set();
 let lease,keyStore;const storage=await paths(root,'system'),keyStorage=await paths(root,'keystore');
 t.after(async()=>{lease?.close();keyStore?.close();for(const child of children)child.kill('SIGKILL');await new Promise(r=>setTimeout(r,3000));await fs.rm(root,{recursive:true,force:true});await fs.rm(storage.runRoot,{recursive:true,force:true});await fs.rm(keyStorage.runRoot,{recursive:true,force:true});});
 const privateRuntime=path.join(root,'runtime'),classes=path.join(root,'classes');await fs.mkdir(classes);
 await fs.cp(runtime,privateRuntime,{recursive:true,dereference:true,mode:require('node:fs').constants.COPYFILE_FICLONE,
  filter:file=>!['build','source','build-source.json','build-receipt.json'].includes(path.relative(runtime,file).split(path.sep)[0])});
 const source=path.resolve('src/modules/android/native/java/maclauncher/android'),cp=['android-host.jar','android-framework.jar'].map(f=>path.join(privateRuntime,f)).join(path.delimiter);
 const changed=['ProcessAuthority.java','PlatformServiceHost.java','PlatformServiceConfig.java','framework/HostSystemServices.java','framework/HostStartupTiming.java','framework/HostUsb.java','framework/HostServices.java','framework/HostApplication.java','framework/HostAccounts.java','framework/HostProcessServices.java','framework/HostProcessInfo.java','framework/HostContext.java'];
 execFileSync(home+'/bin/javac',['--release','21','-cp',cp,'-d',classes,path.resolve('src/modules/android/native/java/com/android/server/HostSchedulingPolicy.java'),...changed.map(f=>path.join(source,f)),...['RemoteSystemStoreProbe','ProfileApplicationProbe'].map(name=>path.resolve('tests/fixtures/android-platform-service/'+name+'.java')),...['HostWindowProbe','PackageManifest','SyntheticResources'].map(name=>path.resolve('tests/fixtures/android-framework-services/'+name+'.java')),...['LayoutInflationProbe','ResourceFixtureData'].map(name=>path.resolve('tests/fixtures/android-native/'+name+'.java'))]);
 execFileSync(home+'/bin/jar',['--update','--file',path.join(privateRuntime,'android-host.jar'),'-C',classes,'.']);
 const options={userDataDir:root,runtimeRoot:privateRuntime,javaPath:home+'/bin/java',moduleRoot:path.resolve('src/modules/android'),role:'system'};
 async function client(mode,uid){
  const data=path.join(root,'app-'+uid),name=mode==='activity'?'org.example.window':uid===1000?'android':'example.diagnostics.u'+uid;
  const config={runtimeRoot:privateRuntime,filesRoot:path.join(data,'files'),cacheRoot:path.join(data,'cache')};
  await fs.mkdir(config.filesRoot,{recursive:true});await fs.mkdir(config.cacheRoot,{recursive:true});
  if(mode==='activity'){const manifests=path.join(config.filesRoot,'tests/fixtures/android-framework-services/manifests');await fs.mkdir(manifests,{recursive:true});await fs.copyFile(path.resolve('tests/fixtures/android-framework-services/manifests/window.xml.bin'),path.join(manifests,'window.xml.bin'));}
  const configFile=path.join(data,'launch.json');await fs.writeFile(configFile,'{}');
  const isolated=await prepareSandbox({javaPath:options.javaPath,config,configFile,dataRoot:data,blockNetwork:true,localSockets:{connect:[lease.socketPath,keyStore.socketPath]}});
  const child=spawn(isolated.command,[...isolated.prefix,...isolated.javaArguments,...frameworkJvmOptions,'-cp',cp,'maclauncher.android.'+(mode==='activity'?'ProfileApplicationProbe':'RemoteSystemStoreProbe'),privateRuntime,data,name,mode,path.join(storage.root,'data'),String(lease.identity.bootCount)],
   {cwd:config.filesRoot,env:isolated.environment,stdio:['ignore','pipe','pipe','ignore','ignore','pipe']});
  children.add(child);child.once('exit',()=>children.delete(child));let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);
  const completion=once(child,'exit');
  try{await once(child,'spawn');const peer={packageName:name,processName:name,pid:child.pid,uid,hostUid:process.getuid(),...(uid===1000?{securityContext:'u:r:system_server:s0'}:{})};
   await Promise.all([lease.enroll(peer),keyStore.enroll(peer)]);await send(child.stdio[5],{schemaVersion:2,self:peer,system:{identity:lease.identity,socketPath:lease.socketPath},platform:{identity:keyStore.identity,socketPath:keyStore.socketPath}});
   const [code,signal]=await completion;assert.equal(code,0,signal+'\n'+stdout+'\n'+stderr);assert.match(stdout,mode==='activity'?/PASS original application Settings, ActivityManager and PhoneWindow/:/PASS original remote diagnostic store/);if(mode==='activity')for(const line of stdout.split('\n'))if(/^(early activity endpoint=|prepared activity local=)/.test(line))t.diagnostic(line);await Promise.all([lease.retire(peer),keyStore.retire(peer)]);
  }finally{if(child.exitCode==null&&child.signalCode==null)child.kill('SIGKILL');}
 }
 [lease,keyStore]=await Promise.all([acquire(options),acquire({...options,role:'keystore'})]);const first=lease.identity.pid,bootCount=lease.identity.bootCount;assert.equal(bootCount,1);
 await t.test('normal application provider and Activity ownership survives connecting profile system and KeyStore directories',()=>client('activity',10023));
 await Promise.all([client('write',10021),client('write',10022)]);await client('read',1000);
 lease.close();lease=null;
 const deadline=Date.now()+10000;
 while(Date.now()<deadline){try{await fs.access(storage.metadata);}catch(e){if(e.code==='ENOENT')break;throw e;}await new Promise(r=>setTimeout(r,25));}
 await assert.rejects(fs.access(storage.metadata),{code:'ENOENT'});
 lease=await acquire(options);assert.notEqual(lease.identity.pid,first);assert.equal(lease.identity.bootCount,bootCount,'Service restart is not a host boot');await client('read',1000);await client('activity',10024);
});
