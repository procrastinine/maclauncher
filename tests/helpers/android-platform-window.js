const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {once}=require('node:events');
const {spawnSync,frameworkArguments}=require('./android-java');

// Window clients use the original SettingsProvider in its genuine system owner.
// This reuses the normal platform-service adapter and keeps the app unprivileged.
async function platformWindow({runtime,home,root,classpath,args,env,main='maclauncher.android.HostWindowProbe'}){
 const {paths}=require('../../src/modules/android/platform-services/paths');
 const {startProfileService}=require('../../src/modules/android/platform-services/jvm');
 const storage=await paths(root,'system'),lock=await fs.promises.open(storage.lock,'w',0o600);
 const data=path.join(root,'android/apps/window/data'),prepared=path.join(root,'android/apps/window/prepared');
 fs.mkdirSync(data,{recursive:true});fs.mkdirSync(prepared,{recursive:true});
 const apk=path.join(prepared,'window.apk'),key=path.join(root,'fixture-signing.p12');
 const run=(name,values)=>{const result=spawnSync(path.join(home,'bin',name),values,{env,encoding:'utf8',timeout:20000,maxBuffer:2<<20});if(result.error||result.status!==0)throw Error(result.error?.message||result.stdout+result.stderr);};
 const classes=classpath.split(path.delimiter)[0],signer=classes+path.delimiter+path.resolve('src/modules/android/native/tools/apksig.jar');
 run('javac',['-cp',signer,'-d',classes,'tests/fixtures/android-framework-services/SignApkSet.java']);
 run('keytool',['-genkeypair','-alias','owned','-keyalg','RSA','-keysize','2048','-dname','CN=Window Fixture','-validity','2','-storetype','PKCS12','-keystore',key,'-storepass','test-only-password','-keypass','test-only-password','-noprompt']);
 let service,child,completed;
 try{
  const bytes=fs.readFileSync(path.resolve(runtime,'runtime.json')),manifest=JSON.parse(bytes);
  const runtimeIdentity={version:manifest.version,minimumMacOS:manifest.minimumMacOS,manifestSha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex')};
  service=await startProfileService({userDataDir:root,runtimeRoot:path.resolve(runtime),runtimeIdentity,javaPath:path.join(home,'bin/java'),moduleRoot:path.resolve('src/modules/android'),role:'system'},storage,lock.fd);
  await service.ready;
  const identity=await require('../../src/modules/android/process-channel').processNamespace(root,1);
  const options={env:{...env,...identity.environment},stdio:['pipe','pipe','pipe']};
  const query=require('../../src/modules/android/process-channel').prepareProcessQuerySpawn(options,path.resolve(runtime,'native/android-supervisor-send'));
  const parameters=[...args,'-Dandroid.fixture.platformSocket='+service.socketPath,'-Dandroid.fixture.platformPid='+service.identity.pid,'-Dandroid.fixture.apk='+apk,'-cp',classpath,main,path.resolve(runtime),data];
  child=spawn(path.join(home,'bin/java'),frameworkArguments(path.join(home,'bin/java'),parameters),query.options);query.attach(child);
  completed=once(child,'close');let stdout='',stderr='',tail='',readyResolve,readyReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  child.stdout.on('data',bytes=>{stdout=(stdout+bytes).slice(-(4<<20));tail+=bytes;let end;while((end=tail.indexOf('\n'))>=0){const line=tail.slice(0,end).trim();tail=tail.slice(end+1);const match=/^PLATFORM_READY (\d+)$/.exec(line);if(match)readyResolve(Number(match[1]));}});
  child.stderr.on('data',bytes=>stderr=(stderr+bytes).slice(-(4<<20)));
  child.once('error',readyReject);child.once('close',()=>readyReject(Error(stdout+'\n'+stderr)));
  const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
  try{
   const pid=await ready;
   fs.renameSync(apk,apk+'.unsigned');run('java',['-cp',signer,'SignApkSet',key,apk+'.unsigned',apk]);fs.rmSync(apk+'.unsigned');
   const peer={packageName:'org.example.window',processName:'org.example.window',pid,hostPid:child.pid,uid:10031,hostUid:process.getuid(),securityContext:'u:r:untrusted_app:s0'};
   await service.enroll(peer,{packages:[{packageName:peer.packageName,uid:peer.uid,sourceApks:[apk],dataRoot:data,nativeRoot:path.resolve(runtime,'native'),firstInstallTime:1,lastUpdateTime:1}]});
   child.stdin.end('connect\n');const [status,signal]=await completed;await service.retire(peer);
   return {status,signal,stdout,stderr};
  }finally{clearTimeout(timer);}
 }finally{
  if(child&&child.exitCode==null&&child.signalCode==null){child.kill('SIGKILL');await completed?.catch(()=>{});}
  await service?.close();await lock.close();await fs.promises.rm(storage.runRoot,{recursive:true,force:true});
 }
}
module.exports={platformWindow};
